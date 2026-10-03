/**
 * 图片传输验证第二轮：app-server 会话里两种形态（A 已证伪——data-URL 内嵌 content
 * 会被 agent 当文件引用 Read，报 Unable to decode image data）。
 *   B1: session/send 带 attachments 参数（ref = 本地绝对路径）
 *   B2: content 文本里给出本地路径，让 agent 用 Read 工具读图（读图转视觉输入）
 * 结果写 stdout（不要接 head/grep 管道，EPIPE 会杀进程）。
 *   node test/image-e2e2.mjs
 */
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import fs from 'node:fs'

const IMG = 'C:\\Users\\zy\\AppData\\Local\\Temp\\zcode-img-test.png'
const imgBytes = fs.readFileSync(IMG)

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
  if (payload.kind === 'reasoning_delta') return
  if (payload.type === 'turn.completed') turnDone = payload
  if (payload.type === 'model_request_started') return
  if (/error|failed/i.test(payload.type ?? '') || payload.error) {
    console.log('  [event-FAIL]', payload.type ?? '?', JSON.stringify(payload).slice(0, 220))
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runTurn(label, params) {
  textDeltas = ''
  turnDone = null
  console.log(`\n=== ${label} ===`)
  try {
    const res = await client.request('session/send', params, options().appServerTimeoutMs)
    console.log('send ->', JSON.stringify(res).slice(0, 140))
  } catch (error) {
    console.log('✗ send 被拒:', String(error?.message ?? error).slice(0, 200))
    return
  }
  const deadline = Date.now() + 180000
  while (!turnDone && Date.now() < deadline) await sleep(500)
  if (!turnDone) { console.log('✗ 180s 内 turn 未完成'); return }
  console.log('✓ turn.completed resultType=' + turnDone.resultType + '  usage=' + JSON.stringify(turnDone.usage ?? {}))
  console.log('模型答复:', JSON.stringify(textDeltas.slice(0, 400)))
}

;(async () => {
  await client.ensureStarted()
  const created = await client.request('session/create', {
    workspace: { workspacePath: 'C:\\Users\\zy', workspaceKey: 'dsh-dsh-zcode-cli-proxy-imgtest2' },
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

  await runTurn('B1：attachments 参数（ref=本地路径）', {
    sessionId,
    content: '附件是一张图片。图片里写的什么字符？只回答图片里的字符本身，不要调用任何工具。',
    attachments: [{ ref: IMG, fileName: 'zcode-img-test.png', mime: 'image/png', bytes: imgBytes.length }],
  })

  await runTurn('B2：content 给本地路径让 agent Read', {
    sessionId,
    content: `请先用 Read 工具读取这张图片：${IMG} ，然后只回答图片里写的字符，不要做其他事。`,
  })

  console.log('\n=== 实验结束 ===')
  adapter.dispose()
  process.exit(0)
})().catch((e) => { console.error('失败:', e?.message ?? e); adapter.dispose(); process.exit(1) })
