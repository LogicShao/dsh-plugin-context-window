// dsh-plugin-context-window — 按 provider/model 封顶上下文窗口与输出上限（宿主侧）。
//
// 为什么需要：模型目录给的是「理论最大窗口」和「理论最大输出」，而真实有效注意力
// 往往远小于目录值。DSH 的自动压缩按 `min(0.8·W, W − O − headroom)` 触发，目录值越大
// 压缩越晚，模型会长时间在低质量区间工作；输出额度预留过大时，长会话还会直接顶穿上游
// 上下文被 400 拒绝。
//
// 怎么做：包装 `llm.normalizeModelInfo`（DSH 里所有容量解析的唯一出口），把命中的
// provider/model 的 `context.contextWindow` 与 `defaultMaxTokens` 改小。压缩阈值、
// agent loop、token meter（UI 上下文环）都从这个出口取值，所以一处改动全覆盖。
//
// 可逆性：只在运行时打补丁，`dispose` 时还原原方法；bundle 层不改动任何模型配置，
// 因此「停用/卸载插件 = 立刻回到目录默认」。

export const name = 'context-window-governor'

/** 等 `llm` 服务就绪后再打补丁。 */
export const inject = ['llm']

/** 进程内防重复打补丁的标记。 */
const PATCHED = Symbol.for('dsh-plugin-context-window.patched')

/** 与 `dsh-compaction-basic` 的默认 headroomTokens 保持一致。 */
const HEADROOM_TOKENS = 65536

/** 与 `dsh-compaction-basic` 的默认阈值/保留比例保持一致，用于加载期校验。 */
const THRESHOLD_RATIO = 0.8
const RETAIN_RATIO = 0.16

// 当前推荐参数：512K 窗口 + 64K 输出 → 压缩触发 393,216（窗口的 75%），
// 压缩后保留约 73,400，两次压缩之间约有 32 万 tokens 的增量空间。
// 注意：这里的数字只是缺省参考；规则必须显式写 contextWindow / maxTokens 才会生效。
const DEFAULTS = {
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  contextWindow: 524288,
  maxTokens: 65536,
  allowRaise: false,
}

/** 宿主 Config：插件页表单只显示 `.volatile()` 字段。 */
export const Config = await loadConfigSchema()

/** 构造插件页表单 schema；任何一步失败都返回 undefined，绝不拖垮插件加载。 */
async function loadConfigSchema() {
  let z
  try {
    const module = await import('@deepseek-ai/schemastery')
    z = module.default ?? module
  } catch {
    return undefined
  }
  if (typeof z?.object !== 'function') return undefined
  const loose = (schema) => (typeof schema.loose === 'function' ? schema.loose() : schema)
  try {
    return loose(
      z.object({
        provider: z.string().volatile(),
        model: z.string().volatile(),
        contextWindow: z.number().volatile(),
        maxTokens: z.number().volatile(),
        allowRaise: z.boolean().volatile(),
        // 高级用法：多条规则只在配置文件里写，不进表单。
        rules: z.any(),
      }),
    )
  } catch {
    return undefined
  }
}

/** 把 schemastery 的 volatile 访问器（带 `get()`）还原成普通值。 */
function unwrap(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') {
    try {
      return unwrap(value.get())
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map(unwrap)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrap(child)]))
}

/** 单条规则的字段归一：只保留认识的键，数字非法就当没写。 */
function normalizeRule(raw, fallback) {
  const input = typeof raw === 'object' && raw !== null ? raw : {}
  const provider = typeof input.provider === 'string' && input.provider.length > 0 ? input.provider : fallback.provider
  const model = typeof input.model === 'string' && input.model.length > 0 ? input.model : fallback.model
  return {
    provider,
    model,
    contextWindow: Number.isInteger(input.contextWindow) && input.contextWindow > 0 ? input.contextWindow : undefined,
    maxTokens: Number.isInteger(input.maxTokens) && input.maxTokens > 0 ? input.maxTokens : undefined,
    allowRaise: input.allowRaise === true,
  }
}

/**
 * 生效规则 = 表单式单条规则（顶层字段）+ 可选 `rules` 数组追加。
 * 只保留至少能改一个值的规则；顺序即优先级（先匹配先生效）。
 */
function resolveRules(config) {
  const input = unwrap(typeof config === 'object' && config !== null ? config : {})
  const simple = normalizeRule(input, DEFAULTS)
  const rules = []
  if (simple.contextWindow !== undefined || simple.maxTokens !== undefined) rules.push(simple)
  const extra = Array.isArray(input.rules) ? input.rules : []
  for (const raw of extra) {
    const rule = normalizeRule(unwrap(raw), DEFAULTS)
    if (rule.contextWindow !== undefined || rule.maxTokens !== undefined) rules.push(rule)
  }
  return rules
}

/** provider 精确匹配（`*` 全匹配）；model 支持 `*` 与末尾 `*` 前缀。 */
function matches(rule, provider, model) {
  if (typeof rule?.provider !== 'string' || typeof provider !== 'string') return false
  if (rule.provider !== '*' && rule.provider !== provider) return false
  if (typeof rule.model !== 'string' || typeof model !== 'string') return false
  // 目录里的键可能是 `chat:<id>`，请求里是 `<id>`；两边都归一化再比。
  const wanted = rule.model.replace(/^chat:/u, '')
  const actual = model.replace(/^chat:/u, '')
  if (wanted === '*') return true
  if (wanted === actual) return true
  return wanted.endsWith('*') && actual.startsWith(wanted.slice(0, -1))
}

/** 只降不升（除非 allowRaise）；当前值不是正整数时直接用目标值。 */
function clamp(current, target, allowRaise) {
  if (!Number.isInteger(target) || target <= 0) return current
  if (!Number.isInteger(current) || current <= 0) return target
  return allowRaise === true ? target : Math.min(current, target)
}

/** 1234567 → 1,234,567（只加千分位，不跟随系统区域）。 */
function formatTokens(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

/**
 * 按 `dsh-compaction-basic`（0.2.1-rc.2）的公式推算压缩预算：
 *
 *   messageBudget  = W − O
 *   pressureBudget = messageBudget − headroomTokens
 *   threshold      = floor(min(W × thresholdRatio, pressureBudget))
 *   retain         = floor(messageBudget × retainRatio)
 *
 * `cycle` = threshold − retain，即一次压缩之后还能再装多少 tokens 才触发下一次。
 * 参数不合法时返回 undefined；`pressureBudget <= 0` 表示没有压缩预算。
 */
export function resolveBudget(contextWindow, maxTokens) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return undefined
  const messageBudget = contextWindow - maxTokens
  const pressureBudget = messageBudget - HEADROOM_TOKENS
  const threshold = Math.floor(Math.min(contextWindow * THRESHOLD_RATIO, pressureBudget))
  const retain = Math.floor(messageBudget * RETAIN_RATIO)
  return { messageBudget, pressureBudget, threshold, retain, cycle: threshold - retain }
}

/**
 * 加载期校验：按 `dsh-compaction-basic` 的公式推演一遍，无法自洽的组合提前告警，
 * 免得跑起来才抛 `TargetPressureConfigError`。
 */
function validateRules(rules, warn) {
  for (const rule of rules) {
    if (rule.contextWindow === undefined) continue
    const window = rule.contextWindow
    const reserved = rule.maxTokens
    if (reserved === undefined) {
      warn(`规则 ${rule.provider}/${rule.model} 只封顶了窗口 ${window}，没有封顶输出上限；请确认目录里的 maxTokens 足够小`)
      continue
    }
    const budget = resolveBudget(window, reserved)
    if (budget === undefined || budget.pressureBudget <= 0) {
      warn(
        `规则 ${rule.provider}/${rule.model} 的窗口 ${window} 扣掉输出 ${reserved} 与 headroom ${HEADROOM_TOKENS} 后没有剩余压缩预算，` +
          '`dsh-compaction-basic` 会抛 TargetPressureConfigError，请调大窗口或调小 maxTokens',
      )
      continue
    }
    if (budget.retain >= budget.threshold) {
      warn(
        `规则 ${rule.provider}/${rule.model} 的保留量 ${budget.retain} ≥ 压缩阈值 ${budget.threshold}，压缩会因「没有可丢弃内容」失败，请调大窗口`,
      )
    }
  }
}

/** 从 registration 里取 provider id（不同版本字段形状不同，都兼容）。 */
function providerId(registration) {
  const provider = registration?.provider
  if (typeof provider === 'string') return provider
  if (typeof provider?.id === 'string') return provider.id
  return undefined
}

export function apply(ctx, config = {}) {
  const rules = resolveRules(config)
  const warn = (message) => ctx.logger?.warn?.(`context-window-governor: ${message}`)
  validateRules(rules, warn)

  if (rules.length === 0) {
    ctx.logger?.info?.('context-window-governor: 没有可用规则，不接管模型容量')
    return
  }

  // 把「窗口」翻译成用户真正关心的数字：什么时候压缩、压缩后保留多少。
  for (const rule of rules) {
    if (rule.contextWindow === undefined || rule.maxTokens === undefined) continue
    const budget = resolveBudget(rule.contextWindow, rule.maxTokens)
    if (budget === undefined || budget.pressureBudget <= 0 || budget.retain >= budget.threshold) continue
    ctx.logger?.info?.(
      `context-window-governor: 规则 ${rule.provider}/${rule.model} 将在 ${formatTokens(budget.threshold)} tokens 触发压缩，` +
        `压缩后保留约 ${formatTokens(budget.retain)}，两次压缩之间可用增量约 ${formatTokens(budget.cycle)}`,
    )
  }

  ctx.effect(() => {
    const llm = ctx.llm ?? ctx.get?.('llm')
    if (llm === undefined || llm === null) {
      warn('llm 服务不可用，跳过容量接管')
      return () => {}
    }
    if (llm[PATCHED] === true) {
      warn('llm.normalizeModelInfo 已被本插件包装过，跳过重复包装')
      return () => {}
    }
    const original = llm.normalizeModelInfo
    if (typeof original !== 'function') {
      warn('llm.normalizeModelInfo 不存在（DSH 版本可能变了），跳过容量接管')
      return () => {}
    }

    const reported = new Set()
    const wrapped = function normalizeModelInfo(registration, model, resolved) {
      const info = original.call(this, registration, model, resolved)
      if (info === null || typeof info !== 'object') return info
      const provider = providerId(registration)
      const rule = rules.find((candidate) => matches(candidate, provider, model))
      if (rule === undefined) return info

      const contextWindow = clamp(info.context?.contextWindow, rule.contextWindow, rule.allowRaise)
      const defaultMaxTokens = clamp(info.defaultMaxTokens, rule.maxTokens, rule.allowRaise)
      const key = `${provider}/${model}`
      if (!reported.has(key)) {
        reported.add(key)
        ctx.logger?.info?.(
          `context-window-governor: ${key} 窗口 ${String(info.context?.contextWindow ?? '默认')} → ${String(contextWindow ?? '默认')}，` +
            `输出上限 ${String(info.defaultMaxTokens ?? '默认')} → ${String(defaultMaxTokens ?? '默认')}`,
        )
      }
      return {
        ...info,
        ...(contextWindow === undefined ? {} : { context: { ...(info.context ?? {}), contextWindow } }),
        ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
      }
    }

    llm.normalizeModelInfo = wrapped
    llm[PATCHED] = true
    ctx.logger?.info?.(`context-window-governor: 已接管 ${rules.length} 条规则下的模型容量（停用插件即还原）`)

    return () => {
      if (llm.normalizeModelInfo === wrapped) llm.normalizeModelInfo = original
      delete llm[PATCHED]
    }
  }, 'context-window: patch normalizeModelInfo')
}

export { resolveRules, matches, clamp, validateRules, HEADROOM_TOKENS }
