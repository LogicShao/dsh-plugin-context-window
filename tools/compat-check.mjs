#!/usr/bin/env node
// 兼容性自检：确认当前 DSH 安装里，本插件依赖的宿主契约仍然存在。
//
// 只读安装包（app.asar）或解包目录，不启动 DSH、不修改任何文件。
//
// 用法：
//   node tools/compat-check.mjs                          # 自动找常见安装位置
//   node tools/compat-check.mjs <app.asar>               # 指定安装包
//   node tools/compat-check.mjs <解包目录>                # 目录下含 dsh/node_modules
//   DSH_APP_ASAR=... node tools/compat-check.mjs
//
// 退出码：0 = 全部契约都在；1 = 有缺失或找不到安装包。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PATHS = {
  llm: 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
  llmPkg: 'dsh/node_modules/@deepseek-ai/dsh-llm/package.json',
  compaction: 'dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js',
  compactionPkg: 'dsh/node_modules/@deepseek-ai/dsh-compaction-basic/package.json',
  tokenMeter: 'dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js',
}

const CANDIDATES = [
  process.argv[2],
  process.env.DSH_APP_ASAR,
  'D:\\software\\ai\\dsh\\resources\\app.asar',
  'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar',
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  join(process.cwd(), 'resources', 'app.asar'),
].filter((value) => typeof value === 'string' && value.length > 0)

function openAsar(file) {
  const buffer = readFileSync(file)
  const headerSize = buffer.readUInt32LE(4)
  const jsonLen = buffer.readUInt32LE(12)
  const base = 8 + headerSize
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLen).toString('utf8'))
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = `${prefix}${name}`
      if (child.files) walk(child, `${path}/`)
      else entries.set(path, { offset: Number(child.offset), size: Number(child.size) })
    }
  }
  walk(header, '')
  return {
    label: `asar ${file}`,
    exists: (path) => entries.has(path),
    read: (path) => {
      const entry = entries.get(path)
      return entry === undefined
        ? undefined
        : buffer.subarray(base + entry.offset, base + entry.offset + entry.size).toString('utf8')
    },
  }
}

function openDir(root) {
  return {
    label: `dir ${root}`,
    exists: (path) => existsSync(join(root, path)),
    read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined),
  }
}

const source = CANDIDATES.find((candidate) => existsSync(candidate))
if (source === undefined) {
  console.error('找不到 DSH 安装包（app.asar）。用参数或 DSH_APP_ASAR 指定路径。')
  process.exit(1)
}

const archive = statSync(source).isDirectory() ? openDir(source) : openAsar(source)
const read = (path) => archive.read(path) ?? ''
const packageVersion = (path) => {
  try {
    return JSON.parse(read(path)).version ?? '?'
  } catch {
    return '?'
  }
}

const llm = read(PATHS.llm)
const compaction = read(PATHS.compaction)
const tokenMeter = read(PATHS.tokenMeter)

const checks = [
  ['llm', 'normalizeModelInfo', llm.includes('normalizeModelInfo')],
  ['llm', 'prepareCall', llm.includes('prepareCall')],
  ['llm', 'adapterStream', llm.includes('adapterStream')],
  ['compaction', 'resolveCompactSpec', compaction.includes('resolveCompactSpec')],
  ['compaction', 'headroomTokens', compaction.includes('headroomTokens')],
  ['compaction', 'thresholdRatio', compaction.includes('thresholdRatio')],
  ['compaction', 'retainRatio', compaction.includes('retainRatio')],
  ['token-meter', 'contextWindow', tokenMeter.includes('contextWindow')],
]

console.log(archive.label)
console.log(
  `dsh-llm ${packageVersion(PATHS.llmPkg)} / compaction-basic ${packageVersion(PATHS.compactionPkg)}`,
)
console.log('')

let failed = 0
for (const [area, contract, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${area.padEnd(11)} ${contract}`)
  if (!ok) failed += 1
}

console.log('')
if (failed === 0) {
  console.log(`结论：${checks.length}/${checks.length} 项契约仍在，当前 DSH 版本可直接用本插件。`)
  process.exit(0)
}
console.log(`结论：${checks.length - failed}/${checks.length} 项仍在；缺失项会让插件降级或失效。`)
console.log('处理：确认 DSH 版本；必要时改用 compatible 的插件版本，或调整 lib/index.js 的补丁点。')
process.exit(1)
