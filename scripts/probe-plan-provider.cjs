/**
 * 试出能把请求路由到 ZCode 计划额度（zcode.z.ai）的 providerId。
 * 做法：session/send 带 modelSelection:{providerId, modelId}，观察事件里的 providerId/baseURL/结果。
 *
 *   node scripts/probe-plan-provider.cjs
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const CLI = process.env.ZCODE_CLI_PATH || 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const PROMPT = process.env.PROBE_PROMPT || 'Reply with exactly: pong'
const MODEL = process.env.PROBE_MODEL || 'glm-5.3-flash'
const WORKSPACE = process.env.PROBE_WORKSPACE || path.join(process.env.USERPROFILE, 'ZCodeProject')
const CANDIDATES = (process.env.PROBE_PROVIDERS || 'zai-coding-plan,zai-start-plan,zai,zai-api').split(',')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: process.env.USERPROFILE, env, windowsHide: true,
})

let nextId = 1
const pending = new Map()
let current = { providerId: undefined, baseURL: undefined, modelId: undefined, response: undefined, usage: undefined, error: undefined, done: false }

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
  if (m.id !== undefined && m.method === undefined) {
    const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m) }
    return
  }
  if (m.method !== undefined && m.id !== undefined) {
    send({ id: m.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' } })
    return
  }
  if (m.method !== 'session/event') return
  const payload = m.params?.payload ?? {}
  if (payload.type === 'session.updated') {
    if (payload.providerId) current.providerId = payload.providerId
    if (payload.modelId) current.modelId = payload.modelId
  }
  if (payload.type === 'session.updated' && payload.baseURL) current.baseURL = payload.baseURL
  if (payload.type === 'model.streaming' || payload.type === 'session.updated') {
    if (payload.baseURL) current.baseURL = payload.baseURL
  }
  if (payload.type === 'turn.completed') {
    current.response = payload.response
    current.usage = payload.usage
    current.error = payload.resultType === 'success' ? undefined : payload.resultType
    current.done = true
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])
async function call(method, params, timeout = 12000) {
  const res = await race(request(method, params), timeout)
  if (res.timeout) return { timeout: true }
  return res
}

;(async () => {
  await sleep(2500)
  const created = await call('session/create', { workspace: { workspacePath: WORKSPACE, workspaceKey: 'dsh-dsh-zcode-cli-proxy' } })
  const sessionId = created?.result?.session?.sessionId
  console.log('sessionId =', sessionId)
  if (!sessionId) { child.kill(); process.exit(0) }
  await call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: false })

  for (const providerId of CANDIDATES) {
    current = { providerId: undefined, baseURL: undefined, modelId: undefined, response: undefined, usage: undefined, error: undefined, done: false }
    console.log(`\n=== 试 providerId=${providerId} / model=${MODEL} ===`)
    const sent = await call('session/send', {
      sessionId,
      content: PROMPT,
      modelSelection: { providerId, modelId: MODEL },
    }, 15000)
    if (sent.timeout) { console.log('  send 超时'); continue }
    if (sent.error) { console.log('  send 报错:', JSON.stringify(sent.error.message ?? sent.error).slice(0, 300)); continue }
    console.log('  send ->', JSON.stringify(sent.result).slice(0, 160))

    const deadline = Date.now() + 60000
    while (!current.done && Date.now() < deadline) await sleep(1000)
    console.log(`  实际 providerId=${current.providerId ?? '?'} modelId=${current.modelId ?? '?'} baseURL=${current.baseURL ?? '?'}`)
    console.log(`  response=${JSON.stringify(current.response)}  usage=${JSON.stringify(current.usage?.inputTokens ?? '?')}/${JSON.stringify(current.usage?.outputTokens ?? '?')}  error=${current.error ?? '无'}`)
    if (current.done && current.error === undefined && current.response) {
      console.log(`  ✅ 成功：provider=${current.providerId}（ZCode 计划额度）`)
      break
    }
  }

  child.kill()
  process.exit(0)
})()
