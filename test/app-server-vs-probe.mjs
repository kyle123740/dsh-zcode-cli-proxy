/**
 * 对比测试：同一个 app-server 进程上
 *   (1) 探测脚本的内联流程（已知能跑通）
 *   (2) ZcodeAppServerAdapter.stream()
 * 看 (2) 卡在哪一段。
 *   node test/app-server-vs-probe.mjs
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

const CLI = 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const WORKSPACE = 'C:\\Users\\zy\\ZCodeProject'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: process.env.USERPROFILE, env, windowsHide: true,
})

let nextId = 1
const pending = new Map()
let received = 0

function send(m) { child.stdin.write(JSON.stringify(m) + '\n') }
function request(method, params) {
  const id = nextId++
  const p = new Promise((resolve) => pending.set(id, resolve))
  send({ id, method, params })
  return p
}

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let m
  try { m = JSON.parse(text) } catch { return }
  received += 1
  if (m.id !== undefined && m.method === undefined) {
    const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m) }
    return
  }
  if (m.method !== undefined && m.id !== undefined) {
    send({ id: m.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' } })
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])
async function call(method, params, timeout = 12000) {
  const res = await race(request(method, params), timeout)
  if (res.timeout) { console.log(`✗ ${method}: 超时`); return undefined }
  if (res.error) { console.log(`✗ ${method}: ${String(res.error.message ?? '').slice(0, 200)}`); return undefined }
  return res.result
}

const logger = { info: (m) => console.log('  [info]', m), warn: (m) => console.log('  [warn]', m), error: (m) => console.log('  [error]', m), debug: () => {} }
const options = () => ({
  zcodeCliPath: CLI,
  zcodeCliNode: 'node',
  cliMode: 'yolo',
  cliCwd: WORKSPACE,
  cliModels: [{ id: 'glm-5.3-flash', contextWindow: 200000, maxTokens: 64000 }],
  defaultContextWindow: 200000,
  maxTokens: 32768,
  appServerTimeoutMs: 120000,
  zcodeCliTimeoutMs: 240000,
  retryPolicy: {},
})

;(async () => {
  console.log('--- (1) 探测脚本的内联流程 ---')
  await sleep(2500)
  const created = await call('session/create', { workspace: { workspacePath: WORKSPACE, workspaceKey: 'inline-probe' } })
  const sessionId = created?.session?.sessionId
  console.log('  sessionId:', sessionId)
  await call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true })
  await call('session/send', { sessionId, content: 'Reply with exactly: pong' }, 15000)
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    await sleep(1000)
    // 从 received 增量判断（内联流不发事件到任何地方，靠计数）
  }
  console.log(`  内联流程期间共收到 ${received} 条消息`)

  console.log('\n--- (2) ZcodeAppServerAdapter.stream（自己启动 client） ---')
  const before = received
  const adapter = new ZcodeAppServerAdapter({ options, logger })
  let count = 0

  // (2a) 单行 content、无 system —— 和探测完全一致的形态
  console.log('\n  [2a] 单行 content、无 system：')
  try {
    for await (const chunk of adapter.stream({
      provider: 'zcode-cli',
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
      sessionId: 'test-2a',
    })) {
      count += 1
      console.log(`  [chunk ${count}]`, JSON.stringify(chunk).slice(0, 160))
    }
    console.log('  2a 完成 ✓')
  } catch (error) {
    console.log(`  2a 失败: ${error?.message ?? error}`)
  }

  // (2b) 带 system 的多行 content
  console.log('\n  [2b] 带 system 的多行 content：')
  try {
    for await (const chunk of adapter.stream({
      provider: 'zcode-cli',
      model: 'glm-5.3-flash',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
      sessionId: 'test-2b',
    })) {
      count += 1
      console.log(`  [chunk ${count}]`, JSON.stringify(chunk).slice(0, 160))
    }
    console.log('  2b 完成 ✓')
  } catch (error) {
    console.log(`  2b 失败: ${error?.message ?? error}`)
  }
  console.log(`  适配器阶段收到 ${received - before} 条消息`)

  child.kill()
  process.exit(0)
})()
