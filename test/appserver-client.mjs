/**
 * 用适配器的 AppServerClient（不是内联代码）按探测的精确时序重放，
 * 定位「send accepted 但无事件」出在 client 层还是 stream() 层。
 *   node test/appserver-client.mjs
 */
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import fs from 'node:fs'

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
  appServerTimeoutMs: 120000,
  zcodeCliTimeoutMs: 240000,
  retryPolicy: {},
})

const adapter = new ZcodeAppServerAdapter({ options, logger })
const client = adapter.client

// 原始通知监听
let count = 0
let turnDone = false
let response = ''
client.onNotification((message) => {
  count += 1
  const payload = message.params?.payload ?? {}
  if (payload.type === 'turn.completed') {
    turnDone = true
    response = payload.response ?? ''
  }
  console.log(`[#${count}]`, message.method, payload.type ?? '', JSON.stringify(payload).slice(0, 200))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])

;(async () => {
  console.log('=== 1. ensureStarted（含就绪等待 2.5s+） ===')
  await client.ensureStarted()

  console.log('\n=== 2. session/create（探测时序：等就绪后再 +0s） ===')
  const created = await client.request('session/create', {
    workspace: { workspacePath: 'C:\\Users\\zy\\ZCodeProject', workspaceKey: 'dsh-zcode2api' },
  }, 120000)
  const sessionId = created?.session?.sessionId
  console.log('sessionId =', sessionId)
  if (!sessionId) process.exit(1)

  console.log('\n=== 3. subscribe（探测时序：垫 1.5s） ===')
  await sleep(1500)
  await client.request('session/subscribe', {
    sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true,
  }, 120000)
  console.log('订阅完成，此时已收通知:', count)

  console.log('\n=== 4. session/send（探测时序：垫 1.5s） ===')
  await sleep(1500)
  const sendRes = await client.request('session/send', { sessionId, content: 'Reply with exactly: pong' }, 120000)
  console.log('send ->', JSON.stringify(sendRes).slice(0, 200))

  console.log('\n=== 5. 收集 45s ===')
  const deadline = Date.now() + 45000
  while (!turnDone && Date.now() < deadline) await sleep(500)
  console.log(`共收通知 ${count} 条；turnDone=${turnDone}`)
  if (turnDone) console.log('response:', String(response).slice(0, 300))

  client.dispose()
  process.exit(0)
})().catch((e) => { console.error('失败:', e?.stack ?? e); process.exit(1) })
