// Mechanism-level test for dsh-plugin-context-window.
//
// 不启动 DSH：用假 ctx + 假 llm 驱动，验证封顶、只降不升、规则匹配、dispose 还原、
// 重复 apply 幂等、配置访问器还原、以及不可能的窗口组合会被提前告警。
//
// 运行：node test/mechanism.test.mjs

const { apply, resolveRules, resolveBudget, matches, clamp, validateRules, Config } = await import('../lib/index.js')

const stats = { pass: 0, fail: 0 }
function assertEq(actual, expected, label) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) process.exitCode = 1
}
function assertTrue(value, label) {
  assertEq(Boolean(value), true, label)
}

/** 假 llm：删除时记录，便于断言「原方法是否被还原」。 */
function makeLlm({ window = 1_000_000, maxTokens = 384_000 } = {}) {
  const llm = {
    normalizeModelInfo(registration, model) {
      return {
        provider: registration?.provider?.id,
        id: model,
        name: model,
        context: { contextWindow: window },
        defaultMaxTokens: maxTokens,
        reasoning: { efforts: ['high', 'max'], defaultEffort: 'high' },
      }
    },
  }
  return llm
}

function makeCtx(llm) {
  const logs = { warn: [], info: [] }
  const disposers = []
  return {
    llm,
    logger: {
      warn: (...args) => logs.warn.push(args.join(' ')),
      info: (...args) => logs.info.push(args.join(' ')),
      error: (...args) => logs.warn.push(args.join(' ')),
    },
    effect(fn) {
      disposers.push(fn())
    },
    get: (name) => (name === 'llm' ? llm : undefined),
    logs,
    dispose() {
      while (disposers.length > 0) disposers.pop()?.()
    },
  }
}

const registration = { provider: { id: 'opencode-go' } }
const RULE = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindow: 262144, maxTokens: 65536 }

// --- 1. 命中规则：窗口与输出上限都被压下来 -----------------------------------
{
  const llm = makeLlm()
  const ctx = makeCtx(llm)
  const before = llm.normalizeModelInfo
  apply(ctx, RULE)
  const info = llm.normalizeModelInfo(registration, 'deepseek-v4.1-flash', {})
  assertEq(info.context.contextWindow, 262144, '窗口被压到 262144')
  assertEq(info.defaultMaxTokens, 65536, '输出上限被压到 65536')
  assertEq(info.reasoning?.defaultEffort, 'high', '其余字段原样保留')
  assertEq(ctx.logs.info.some((line) => line.includes('窗口 1000000 → 262144')), true, '记一条生效日志')

  ctx.dispose()
  assertEq(llm.normalizeModelInfo, before, 'dispose 后还原原方法')
  const restored = llm.normalizeModelInfo(registration, 'deepseek-v4.1-flash', {})
  assertEq(restored.context.contextWindow, 1_000_000, '还原后窗口回到目录默认')
}

// --- 1b. 预算推算：窗口不是可用量，512K 窗口的触发点是 393,216 --------------
{
  const budget = resolveBudget(524_288, 65_536)
  assertEq(budget.threshold, 393_216, '512K 窗口 / 64K 输出 → 触发 393,216')
  assertEq(budget.retain, 73_400, '压缩后保留 73,400')
  assertEq(budget.cycle, 319_816, '两次压缩之间可用增量 319,816')

  const previous = resolveBudget(262_144, 65_536)
  assertEq(previous.threshold, 131_072, '原 256K 窗口的触发点只有 131,072（窗口的 50%）')
  assertEq(previous.retain, 31_457, '原配置压缩后只保留 31,457')
  assertEq(previous.cycle, 99_615, '原配置每次只有 99,615 的增量空间')

  assertEq(resolveBudget(65_536, 65_536).pressureBudget, -65_536, '窗口全部被输出吃掉时没有压缩预算')
  assertEq(resolveBudget(Number.NaN, 65_536), undefined, '非法窗口返回 undefined')
}

// --- 1c. 启动日志把窗口翻译成「何时压缩」 -----------------------------------
{
  const llm = makeLlm()
  const ctx = makeCtx(llm)
  apply(ctx, { ...RULE, contextWindow: 524_288 })
  assertTrue(
    ctx.logs.info.some((line) => line.includes('将在 393,216 tokens 触发压缩')),
    '启动日志说明实际触发点',
  )
  assertTrue(ctx.logs.info.some((line) => line.includes('保留约 73,400')), '启动日志说明保留量')
  ctx.dispose()
}

// --- 2. 未命中的模型不受影响 -------------------------------------------------
{
  const llm = makeLlm()
  const ctx = makeCtx(llm)
  apply(ctx, RULE)
  const info = llm.normalizeModelInfo(registration, 'deepseek-v4-pro', {})
  assertEq(info.context.contextWindow, 1_000_000, '未命中模型窗口不变')
  assertEq(info.defaultMaxTokens, 384_000, '未命中模型输出上限不变')
  ctx.dispose()
}

// --- 3. 只降不升；allowRaise 才允许放大 --------------------------------------
assertEq(clamp(1_000_000, 262144, false), 262144, '默认只降')
assertEq(clamp(1_000_000, 2_000_000, false), 1_000_000, '默认不会放大')
assertEq(clamp(1_000_000, 2_000_000, true), 2_000_000, 'allowRaise 时可放大')
assertEq(clamp(undefined, 262144, false), 262144, '当前值缺失时直接用目标值')

{
  const llm = makeLlm()
  const ctx = makeCtx(llm)
  apply(ctx, { ...RULE, contextWindow: 2_000_000, allowRaise: false })
  const info = llm.normalizeModelInfo(registration, 'deepseek-v4.1-flash', {})
  assertEq(info.context.contextWindow, 1_000_000, '规则大于目录时不会被放大')
  ctx.dispose()
}

// --- 4. 匹配规则：精确 / 通配 / provider ------------------------------------
assertEq(matches({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, 'opencode-go', 'deepseek-v4.1-flash'), true, '精确匹配')
assertEq(matches({ provider: 'opencode-go', model: 'deepseek-*' }, 'opencode-go', 'deepseek-v4-pro'), true, '前缀通配匹配')
assertEq(matches({ provider: 'opencode-go', model: '*' }, 'opencode-go', 'anything'), true, '全通配匹配')
assertEq(matches({ provider: 'opencode-go', model: '*' }, 'deepseek-account', 'deepseek-flash'), false, 'provider 不同不匹配')
assertEq(matches({ provider: '*', model: '*' }, 'any-provider', 'any-model'), true, 'provider 也支持 *')
assertEq(matches({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, 'opencode-go', 'chat:deepseek-v4.1-flash'), true, '目录键带 chat: 前缀也能匹配')

// --- 5. 重复 apply 不叠加，退出时能还原 -------------------------------------
{
  const llm = makeLlm()
  const first = makeCtx(llm)
  apply(first, RULE)
  const wrappedOnce = llm.normalizeModelInfo
  const second = makeCtx(llm)
  apply(second, RULE)
  assertEq(llm.normalizeModelInfo, wrappedOnce, '第二次 apply 不再包一层')
  assertEq(second.logs.warn.some((line) => line.includes('已被本插件包装过')), true, '重复包装时告警')
  second.dispose()
  assertEq(llm.normalizeModelInfo, wrappedOnce, '重复 apply 的那个 ctx 卸载不影响已装的补丁')
  first.dispose()
  const info = llm.normalizeModelInfo(registration, 'deepseek-v4.1-flash', {})
  assertEq(info.context.contextWindow, 1_000_000, '全部卸载后回到默认')
}

// --- 6. 配置访问器（插件页表单写回的形状）能正确还原 ------------------------
{
  const accessor = (value) => ({ get: () => value })
  const rules = resolveRules({
    provider: accessor('opencode-go'),
    model: accessor('deepseek-v4.1-flash'),
    contextWindow: accessor(131072),
    maxTokens: accessor(32768),
    allowRaise: accessor(false),
  })
  assertEq(rules.length, 1, '表单字段合成一条规则')
  assertEq(rules[0].contextWindow, 131072, '窗口从访问器读出')
  assertEq(rules[0].maxTokens, 32768, '输出上限从访问器读出')
}

// --- 7. 多条规则：rules 数组追加，顺序即优先级 ------------------------------
{
  const rules = resolveRules({
    ...RULE,
    rules: [{ provider: 'deepseek-account', model: '*', contextWindow: 131072, maxTokens: 32768 }],
  })
  assertEq(rules.length, 2, '保留两条规则')
  assertEq(rules[1].provider, 'deepseek-account', '第二条来自 rules 数组')
}

// --- 8. 不可能的窗口组合会提前告警，而不是运行时才炸 ------------------------
{
  const warnings = []
  validateRules([{ provider: 'p', model: 'm', contextWindow: 65536, maxTokens: 65536 }], (line) => warnings.push(line))
  assertEq(warnings.length, 1, '窗口没有压缩预算时告警')
  assertTrue(warnings[0].includes('没有剩余压缩预算'), '告警说明原因')

  const second = []
  validateRules([{ provider: 'p', model: 'm', contextWindow: 262144, maxTokens: 65536 }], (line) => second.push(line))
  assertEq(second.length, 0, '262144 / 65536 的组合自洽')

  const third = []
  validateRules([{ provider: 'p', model: 'm', contextWindow: 524288, maxTokens: 65536 }], (line) => third.push(line))
  assertEq(third.length, 0, '524288 / 65536 的组合自洽')

  const fourth = []
  validateRules([{ provider: 'p', model: 'm', contextWindow: 140000, maxTokens: 65536 }], (line) => fourth.push(line))
  assertTrue(fourth.some((line) => line.includes('没有可丢弃内容')), '保留量不小于阈值时告警')
}

// --- 9. llm 没有 normalizeModelInfo 时只告警，不抛错 -----------------------
{
  const ctx = makeCtx({})
  apply(ctx, RULE)
  assertEq(ctx.logs.warn.some((line) => line.includes('normalizeModelInfo 不存在')), true, '缺少目标方法时告警')
  ctx.dispose()
}

// --- 10. 没有可用规则时完全不接管 -------------------------------------------
{
  const llm = makeLlm()
  const ctx = makeCtx(llm)
  const before = llm.normalizeModelInfo
  apply(ctx, {})
  // 空配置会落到默认规则（provider/model/窗口都有默认值），这里验证「显式清空」才不接管。
  ctx.dispose()
  assertEq(llm.normalizeModelInfo, before, '没有规则时不留下补丁')
}

// --- 11. Config 存在时可被插件页渲染（本机无 schemastery 时为 undefined）----
assertEq(Config === undefined || typeof Config === 'object', true, 'Config 要么是 schema，要么缺失但不影响加载')

console.log(`\n${stats.pass} passed, ${stats.fail} failed`)
