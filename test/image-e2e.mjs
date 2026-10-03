/**
 * 图片传输验证：app-server 会话里两种图片形态各发一回合，
 * 问模型图里写的什么字 —— 答对 ZCODE-7391 即为视觉输入真的通了。
 *   node test/image-e2e.mjs
 */
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import fs from 'node:fs'

const IMG = 'C:\\Users\\zy\\AppData\\Local\\Temp\\zcode-img-test.png'
const imgBytes = fs.readFileSync(IMG)
const dataUrl = `data:image/png;base64,${imgBytes.toString('base64')}`

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
  cliCwd: '',
  cliModels: [{ id: 'GLM-5.3-Flash', contextWindow: 1000000, maxTokens: 128000 }],
  defaultContextWindow: 1000000,
  maxTokens: 32768,
  appServerTimeoutMs: 120000,
  zcodeCliTimeoutMs: 180000,
  retryPolicy: {},
  injectStartPlanAccount: true,
  zcodeDataBaseDir: '',
})

const adapter = new ZcodeAppServerAdapter({ options, logger })
const client = adapter.client

let textDeltas = ''
let turnDone = null
client.onNotification((message) => {
  const payload = message.params?.payload ?? {}
  if (payload.kind === 'text_delta') textDeltas += String(payload.delta ?? '')
  if (payload.type === 'turn.completed') turnDone = payload
  if (payload.type === 'model_request_started') console.log('[event] model_request_started', String(payload.baseURL ?? '').slice(0, 60))
  if (payload.type === 'turn.failed' || payload.error) console.log('[event] FAILED', JSON.stringify(payload).slice(0, 200))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runTurn(label, params) {
  textDeltas = ''
  turnDone = null
  console.log(`\n=== ${label} ===`)
  const res = await client.request('session/send', params, options().appServerTimeoutMs)
  console.log('send ->', JSON.stringify(res).slice(0, 120))
  const deadline = Date.now() + 150000
  while (!turnDone && Date.now() < deadline) await sleep(500)
  if (!turnDone) { console.log('✗ 150s 内 turn 未完成'); return }
  console.log('✓ turn.completed resultType=' + turnDone.resultType)
  console.log('模型答复:', JSON.stringify(textDeltas.slice(0, 300)))
}

;(async () => {
  await client.ensureStarted()
  const created = await client.request('session/create', {
    workspace: { workspacePath: 'C:\\Users\\zy', workspaceKey: 'dsh-dsh-zcode-cli-proxy-imgtest' },
  }, options().appServerTimeoutMs)
  const sessionId = created?.session?.sessionId
  console.log('sessionId =', sessionId)
  await sleep(1500)
  await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true }, options().appServerTimeoutMs)
  await sleep(1500)
  await client.injectAccountConfig()
  await sleep(2000)
  await client.request('session/setModel', { sessionId, model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } } }, options().appServerTimeoutMs)
  await sleep(1500)

  // 形态 A：markdown data-URL 图片直接嵌在 content 里
  await runTurn('形态 A：content 内嵌 data-URL 图片', {
    sessionId,
    content: `这张图片里写的什么字符？只回答图片里的字符本身。\n\n![测试图](${dataUrl})`,
  })

  // 形态 B：attachments 参数（ref = 本地路径）
  await runTurn('形态 B：session/send attachments 参数（ref=本地路径）', {
    sessionId,
    content: '这张图片里写的什么字符？只回答图片里的字符本身。（见附件）',
    attachments: [{ ref: IMG, fileName: 'zcode-img-test.png', mime: 'image/png', bytes: imgBytes.length }],
  })

  adapter.dispose()
  process.exit(0)
})().catch((e) => { console.error('失败:', e?.message ?? e); adapter.dispose(); process.exit(1) })
