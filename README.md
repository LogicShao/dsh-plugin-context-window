# dsh-plugin-context-window

[![test](https://github.com/LogicShao/dsh-plugin-context-window/actions/workflows/test.yml/badge.svg)](https://github.com/LogicShao/dsh-plugin-context-window/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**按 provider/model 封顶上下文窗口与输出上限**的宿主侧插件。

解决的问题：模型目录给的是「理论最大窗口 / 理论最大输出」，而真实有效注意力往往远小于目录值。DSH 的自动压缩按 `min(0.8·W, W − O − headroom)` 触发，目录值越大压缩越晚，模型会长时间在低质量区间工作；输出额度预留过大时，长会话还会直接顶穿上游上下文（例如 `680,245 + 384,000 = 1,064,245 > 1,048,576` → 400）。

默认规则把 `opencode-go / deepseek-v4.1-flash` 封在 **512K 窗口 / 64K 输出**：压缩在 **393,216** 触发（窗口的 75%），压缩后保留约 73,400，两次压缩之间还有约 32 万 tokens 的增量空间。目录默认则是 1M 窗口 → 838,860 才压缩，那是另一个极端。别的 provider/model 可以在 profile 里覆盖（见「配置」）。

## 快速开始

DSH Desktop：侧栏 **插件** → **添加插件** → **安装第三方插件**，粘贴：

```text
github:LogicShao/dsh-plugin-context-window
```

装完点 **立即启用**，**重启 DSH**。默认规则直接生效；换 provider/model 看 [安装](#安装) 里的「安装后」。
命令行等价写法：

```bash
dsh plugin --profile desktop add github:LogicShao/dsh-plugin-context-window
```

## 它改什么

只包装 `llm.normalizeModelInfo` —— DSH 里所有容量解析的唯一出口（`resolveModelInfo` / `prepareCall` / `adapterStream` 都经过它），因此一处改动同时覆盖：

- **自动压缩的触发点**（`dsh-compaction-basic` 从这里取 `contextWindow` 与 `defaultMaxTokens`）；
- **agent loop 的请求预算**（`defaultMaxTokens` 会落成请求的 `max_tokens`）；
- **UI 上下文环的分母**（`dsh-token-meter` 读同一个值）。

**不改**模型真实能力、不代理请求、不写 settings、不改任何模型行。

## 可逆性（关键设计）

- 补丁只存在于运行时：`apply` 里 `ctx.effect` 包装，`dispose` 时还原原方法（且只在仍是自己的包装时还原）；
- 插件 bundle 层**不写** `llm-pi-ai` 或任何模型配置，只插入自己这一行；
- 因此**停用/卸载插件 = 立刻回到目录默认**，不需要清理任何残留配置。

## 安装

### 前置条件

- DSH Desktop **44.7.0**（runtime `0.2.1-rc.2`）或兼容版本。升级过 DSH 就先跑一次 `node tools/compat-check.mjs`（见「兼容性」）。
- 目标模型在 DSH 的模型目录里；默认规则是 `opencode-go / deepseek-v4.1-flash`。
- 不需要单独装 Node/pnpm：DSH 自带运行时，安装由 DSH 的插件管理器完成。

### 方式 A：Web 插件页（推荐）

1. 侧栏 **插件** → **添加插件** → **安装第三方插件**。
2. 粘贴：

   ```text
   github:LogicShao/dsh-plugin-context-window
   ```

3. 安装完成点 **立即启用**，然后**完全退出并重启 DSH**（bundle 层只在启动时读取）。

### 方式 B：`dsh plugin` CLI

```bash
dsh plugin --profile desktop add github:LogicShao/dsh-plugin-context-window
```

### 方式 C：本地源码

```bash
git clone https://github.com/LogicShao/dsh-plugin-context-window.git
dsh plugin --profile desktop add ./dsh-plugin-context-window
```

本地 `link:` 安装时，改 `lib/index.js` 后重启 DSH 即生效。

包声明了 `dsh.bundle.patch`，安装命令会自动把它登记进 profile 的 `dsh.profile.bundles`；不需要手工编辑
`package.json`。**bundle 层在启动时读取，装完需要重启 DSH。**

### 安装后：换成你的 provider/model

插件 bundle 里的默认规则是 `opencode-go / deepseek-v4.1-flash`。换模型或换窗口，在
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里按 id `context-window-governor` 覆盖
`config`（完整示例和字段表见下文「配置」）。改完重启 DSH。

## 配置

插件 bundle 层自带一条默认规则；改配置**不要改插件包**，在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: context-window-governor
  name: 'dsh-plugin-context-window'
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    contextWindow: 524288
    maxTokens: 65536
    # allowRaise: false          # 默认只降不升
    # rules:                     # 高级：多条规则，顺序即优先级
    #   - provider: deepseek-account
    #     model: '*'
    #     contextWindow: 131072
    #     maxTokens: 32768
```

| 字段 | 含义 |
|---|---|
| `provider` | 精确 provider id；`*` 全匹配 |
| `model` | 精确 model id、`*` 或末尾 `*` 前缀；`chat:` 前缀会自动忽略 |
| `contextWindow` | 封顶后的窗口，只降不升（除非 `allowRaise`） |
| `maxTokens` | 封顶后的输出上限，会落成请求的 `max_tokens` |
| `allowRaise` | 默认 `false`；`true` 时才允许把窗口调大 |
| `rules` | 追加多条规则，支持 `provider` / `model` 通配；只在配置文件里写 |

### 没有插件页表单

本包只在宿主半侧工作，**不提供插件页配置入口**：DSH 插件页只渲染由浏览器半侧（`dsh.client` + `exports["./client"]`）注册的 slot，而本包没有浏览器半侧。所有字段都按上面的 YAML 写，改完重启 DSH 生效。

（`Config` 仍然声明了，所以 `dsh-settings` 会投影出字段描述符并做校验；但官方说明里「按 schema 自动生成页面」至今没有已发布的客户端实现，所以没有对应的界面。）

## 为什么是这两个数

`dsh-compaction-basic`（0.2.1-rc.2）的默认值：`thresholdRatio 0.8`、`headroomTokens 65536`、`retainRatio 0.16`。

```
messageBudget  = W − O
pressureBudget = messageBudget − 65536
threshold      = floor(min(W × 0.8, pressureBudget))
retain         = floor(messageBudget × 0.16)
```

关键点：**窗口不是可用上下文**。输出上限和 headroom 先被扣掉，剩下的才是压缩触发点；触发点又直接决定压缩频率。

代入 `W = 524,288`、`O = 65,536`：

```
messageBudget  = 458,752
pressureBudget = 393,216
threshold      = min(419,430, 393,216) = 393,216   ← 压力到 ~39 万触发压缩（75%）
retain         = 73,400                            ← 压缩后保留最近 ~7.3 万原文
cycle          = 319,816                           ← 两次压缩之间可再装 ~32 万 tokens
```

原先的 `W = 262,144` / `O = 65,536` 算出来是 `threshold 131,072`、`retain 31,457`、`cycle 99,615` —— 名义上 256K 窗口，实际只有 131K 可用（50%）。实测一个 223 步的会话在这种配置下压缩了 **6 次**，每次触发压力都在 132K 左右；改成 512K 后同样的产出量约压缩 2 次。

**代价**：每步请求的上下文从 ~13 万涨到 ~39 万，延迟和输入费用随之上升，且模型在 39 万压力下的注意力弱于 13 万。512K 是「压缩次数可接受、又没越过 512K 质量拐点」的折中；更保守可以用 458,752（触发 327,680），更激进可以上 655,360，但请先确认长上下文质量能接受。

### 调参速查（`maxTokens = 65536`）

| `contextWindow` | 触发压缩 | 占窗口 | 压缩后保留 | 两次压缩间增量 | 相对原配置 |
|---:|---:|---:|---:|---:|---:|
| 262,144（原） | 131,072 | 50% | 31,457 | 99,615 | 1.0× |
| 393,216 | 262,144 | 67% | 52,428 | 209,716 | 2.1× |
| 458,752 | 327,680 | 71% | 62,914 | 264,766 | 2.7× |
| **524,288（当前）** | **393,216** | **75%** | **73,400** | **319,816** | **3.2×** |
| 655,360 | 524,288 | 80% | 94,371 | 429,917 | 4.3× |
| 1,048,576（目录默认） | 838,860 | 80% | 157,286 | 681,574 | 6.8× |

最后一行就是插件存在的原因：1M 窗口要到 80 万才压缩，模型早就在低质量区间工作了。

**约束**（插件加载时会校验并告警）：

1. `W ≤ O + 65536` → 没有压缩预算，`dsh-compaction-basic` 会抛 `TargetPressureConfigError`；
2. 在默认 `retainRatio` 下 `retain ≥ threshold`（约 `W − O < 78,019`）→ 压缩会因「没有可丢弃内容」失败。

插件启动时会把每条规则翻译成一行日志，例如：`将在 393,216 tokens 触发压缩，压缩后保留约 73,400，两次压缩之间可用增量约 319,816`。改完参数看这行就能确认实际行为，不用自己套公式。

## 验收

重启后新建会话：

1. UI 上下文环分母是 **524,288**（不是 1,000,000）；
2. `~/.dsh/storages/session_projcache/sessions/<id>.json` 里 `contextPressure.contextWindow = 524288`；
3. 压力到 ~393,216 时出现一次压缩（`<compacted-summary>`），压缩后回到 ~7 万 + 摘要；
4. 停用插件并重启：分母回到 1,000,000；
5. 未匹配的模型（如 `deepseek-v4-pro`）行为不变。

快速验证压缩链路：临时把规则改成 `contextWindow: 131072, maxTokens: 32768`（触发点 ~32,768），重启后发几轮长消息。

## 兼容性

依赖两处宿主契约：`llm.normalizeModelInfo(registration, model, resolved)` 与它返回的 `context.contextWindow` / `defaultMaxTokens`，以及 `dsh-compaction-basic` 的阈值公式（`headroomTokens` / `thresholdRatio` / `retainRatio`）。已在 **DSH 44.7.0 / runtime 0.2.1-rc.2** 核对。

升级 DSH 后先跑自检：

```bash
node tools/compat-check.mjs                    # 自动找常见安装位置
node tools/compat-check.mjs /path/to/app.asar  # 指定安装包（或解包目录）
DSH_APP_ASAR=/path/to/app.asar node tools/compat-check.mjs
```

它只读安装包，不启动 DSH；逐条打印 8 项契约的 ✅/❌，有缺失就以退出码 1 结束。当前安装上的结果：

```text
dsh-llm 0.2.1-rc.2 / compaction-basic 0.2.1-rc.2
✅ llm         normalizeModelInfo
...
结论：8/8 项契约仍在，当前 DSH 版本可直接用本插件。
```

升级后若 `normalizeModelInfo` 消失，插件会**只告警不接管**（`normalizeModelInfo 不存在（DSH 版本可能变了）`），不会让 DSH 起不来。

## 测试

```bash
node test/mechanism.test.mjs   # 46 项断言，无需安装任何依赖
node tools/compat-check.mjs    # 宿主契约自检（需要本机 DSH）
```

覆盖：命中规则压窗口/输出、未命中不变、只降不升与 `allowRaise`、通配与 `chat:` 前缀、`dispose` 还原、重复 `apply` 幂等、配置访问器还原、多条规则、压缩预算推算（512K → 393,216）、启动日志、非法窗口组合告警、缺少目标方法降级。

## License

[MIT](LICENSE)
