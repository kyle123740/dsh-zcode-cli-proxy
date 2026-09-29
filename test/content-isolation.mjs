/**
 * 隔离实验：app-server 会话里发「适配器同款的多行 content」（# 系统提示 开头）。
 *   node test/content-isolation.mjs
 */
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

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

let count = 0
let turnDone = false
let lastPayload = ''
client.onNotification((message) => {
  count += 1
  const payload = message.params?.payload ?? {}
  if (payload.type === 'turn.completed') { turnDone = true; lastPayload = JSON.stringify(payload).slice(0, 400) }
  const label = payload.type ?? message.method ?? '?'
  if (/turn\.|error|fail|model.streaming/.test(label) || count <= 8) {
    console.log(`[#${count}]`, label, JSON.stringify(payload).slice(0, 180))
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])

;(async () => {
  await client.ensureStarted()
  const created = await client.request('session/create', {
    workspace: { workspacePath: 'C:\\Users\\zy\\ZCodeProject', workspaceKey: 'dsh-zcode2api' },
  }, 120000)
  const sessionId = created?.session?.sessionId
  console.log('sessionId =', sessionId)
  await sleep(1500)
  await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true }, 120000)
  await sleep(1500)

  const variants = [
    ['单行（对照组）', 'Reply with exactly: pong'],
    ['适配器同款多行（# 系统提示 开头）', '# 系统提示\nYou are a helpful assistant.\n\n# 用户\nReply with exactly: pong'],
    ['多行但 # 换成 Header:', 'Header: system.\nYou are a helpful assistant.\n\nUser: Reply with exactly: pong'],
  ]

  for (const [label, content] of variants) {
    turnDone = false
    count = 0
    console.log(`\n=== ${label} ===`)
    console.log('content 前 80 字符:', JSON.stringify(content.slice(0, 80)))
    await client.request('session/send', { sessionId, content }, 120000)
    const deadline = Date.now() + 45000
    while (!turnDone && Date.now() < deadline) await sleep(500)
    console.log(`通知 ${count} 条；turnDone=${turnDone}`)
    if (turnDone) console.log('response:', String(lastPayload).slice(0, 200))
  }

  client.dispose()
  process.exit(0)
})().catch((e) => { console.error('失败:', e?.stack ?? e); process.exit(1) })
