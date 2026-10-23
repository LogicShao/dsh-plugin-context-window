# dsh-plugin-context-window

[![test](https://github.com/LogicShao/dsh-plugin-context-window/actions/workflows/test.yml/badge.svg)](https://github.com/LogicShao/dsh-plugin-context-window/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DSH 插件：按 `provider/model` 封顶上下文窗口和输出上限，让自动压缩在指定位置触发。停用插件即恢复模型目录默认值。

## 安装

DSH Desktop → 侧栏 **插件** → **添加插件** → **安装第三方插件**，粘贴：

```text
github:LogicShao/dsh-plugin-context-window
```

装完启用，重启 DSH。

命令行：

```bash
dsh plugin --profile desktop add github:LogicShao/dsh-plugin-context-window
```

要求 DSH 44.7.0（runtime 0.2.1-rc.2）或兼容版本。

## 配置

默认规则：`opencode-go / deepseek-v4.1-flash`，窗口 524,288，输出 65,536。

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 覆盖：

```yaml
- id: context-window-governor
  name: 'dsh-plugin-context-window'
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    contextWindow: 524288
    maxTokens: 65536
```

| 字段 | 说明 |
|---|---|
| `provider` | provider id，`*` 全匹配 |
| `model` | model id，`*` 或末尾 `*` 前缀；`chat:` 前缀自动忽略 |
| `contextWindow` | 封顶后的窗口，只降不升 |
| `maxTokens` | 封顶后的输出上限，落成请求的 `max_tokens` |
| `allowRaise` | `true` 时允许把窗口调大，默认 `false` |
| `rules` | 追加多条规则，按顺序匹配 |

多条规则用 `rules:` 数组，每个元素字段同上，按顺序匹配。改完重启 DSH。

## 触发点

`dsh-compaction-basic` 0.2.1 的阈值公式：

```text
threshold = min(0.8 × 窗口, 窗口 − 输出 − 65536)
保留量    = 0.16 × (窗口 − 输出)
```

默认 524,288 / 65,536 → **393,216 触发**，保留 **73,400**。

窗口不是可用上下文；`maxTokens` 也会移动触发点。

## 验证

重启后新建会话，上下文环分母应为 **524,288**；`~/.dsh/storages/session_projcache/sessions/<id>.json` 里 `contextPressure.contextWindow = 524288`。

## 兼容性

依赖 `llm.normalizeModelInfo` 和 `dsh-compaction-basic` 的 `headroomTokens` / `thresholdRatio` / `retainRatio`。升级 DSH 后运行：

```bash
node tools/compat-check.mjs
```

## 测试

```bash
node test/mechanism.test.mjs
```

## License

MIT
