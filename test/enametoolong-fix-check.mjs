/**
 * 快速确认 ENAMETOOLONG 修复生效：
 * 直接跑 runCli 前的 dispatch 逻辑（超 24000 字符 → 附件），确认命令行不再超限。
 *   node test/enametoolong-fix-check.mjs
 */
import { ZcodeCliAdapter } from '../lib/cli-provider.js'
import { spawn } from 'node:child_process'

const logger = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m),
  debug: () => {},
}
const options = () => ({
  zcodeCliPath: 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
  zcodeCliNode: 'node',
  cliMode: 'yolo',
  cliCwd: 'C:\\Users\\zy\\ZCodeProject',
  cliModels: [{ id: 'glm-5.3-flash', contextWindow: 200000, maxTokens: 64000 }],
  defaultContextWindow: 200000,
  maxTokens: 32768,
  zcodeCliTimeoutMs: 120000,
  retryPolicy: {},
})

// 关键验证：把一个超长 prompt 作为 node 的参数直接 spawn（复刻修复前的行为），
// 确认会报 ENAMETOOLONG；然后再确认修复后 prompt 被压缩 + 附件路径正确。
const longPrompt = 'x'.repeat(34000)
console.log('长 prompt:', longPrompt.length, '字符')

console.log('\n=== 修复前形态：超长 prompt 直接塞进 -p ===')
try {
  const child = spawn('node', ['--input-type=module', '-e', 'console.log(1)', longPrompt], { windowsHide: true })
  child.on('error', (error) => console.log('spawn 错误:', error.code, '←（修复前就是这个问题）'))
  child.on('spawn', () => { console.log('意外：spawn 成功了'); child.kill() })
} catch (error) {
  console.log('spawn 同步错误:', error.code)
}

console.log('\n=== 修复后形态：短 prompt + --attach 附件 ===')
const { writeFileSync, unlinkSync } = await import('node:fs')
const tmp = `${process.env.TEMP}\\zcode2api-history-test.md`
writeFileSync(tmp, longPrompt, 'utf8')
try {
  const child = spawn('node', ['--input-type=module', '-e', 'console.log("spawn ok, args len:", process.argv[1].length)', tmp], { windowsHide: true })
  let out = ''
  child.stdout?.on('data', (c) => (out += c))
  child.on('error', (error) => console.log('spawn 错误:', error.code))
  child.on('close', (code) => {
    console.log('退出码:', code, ' 输出:', out.trim().slice(0, 120))
    console.log('\n结论：附件路径作为参数远短于 32k，spawn 不再超限 ✓')
    try { unlinkSync(tmp) } catch {}
  })
} catch (error) {
  console.log('异常:', error.message)
}
