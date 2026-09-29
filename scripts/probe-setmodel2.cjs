/**
 * 试 session/setModel {sessionId, model:{providerId, modelId}} 能否把会话切到 ZCode 计划 provider。
 * 打印全部通知，便于看清失败原因。
 *   node scripts/probe-setmodel2.cjs
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const CLI = process.env.ZCODE_CLI_PATH || 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const PROMPT = process.env.PROBE_PROMPT || 'Reply with exactly: pong'
const WORKSPACE = process.env.PROBE_WORKSPACE || path.join(process.env.USERPROFILE, 'ZCodeProject')
const CANDIDATES = (process.env.PROBE_MODELS || 'zai-coding-plan|glm-5.3,zai-coding-plan|glm-5.3-flash,zai-api|glm-5.3-flash,zai-start-plan|glm-5.3-flash').split(',')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: process.env.USERPROFILE, env, windowsHide: true,
})

let nextId = 1
const pending = new Map()
let turn = { done: false, response: undefined, providerId: undefined, modelId: undefined, baseURL: undefined, resultType: undefined }

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
  if (m.method === 'session/event') {
    const p = m.params?.payload ?? {}
    if (p.type === 'session.updated') {
      if (p.providerId) turn.providerId = p.providerId
      if (p.modelId) turn.modelId = p.modelId
      if (p.baseURL) turn.baseURL = p.baseURL
    }
    if (p.type === 'turn.completed') {
      turn.done = true
      turn.response = p.response
      turn.resultType = p.resultType
      if (p.usage) turn.usage = p.usage
    }
  } else if (/error|failed|reject/i.test(String(m.method))) {
    console.log('  [通知]', m.method, JSON.stringify(m.params ?? {}).slice(0, 250))
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
  const created = await call('session/create', { workspace: { workspacePath: WORKSPACE, workspaceKey: 'dsh-zcode2api' } })
  const sessionId = created?.result?.session?.sessionId
  console.log('sessionId =', sessionId)
  if (!sessionId) { child.kill(); process.exit(0) }
  await call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: false })

  for (const item of CANDIDATES) {
    const [providerId, modelId] = item.split('|')
    turn = { done: false }
    console.log(`\n=== setModel providerId=${providerId} modelId=${modelId} ===`)
    const res = await call('session/setModel', { sessionId, model: { providerId, modelId } })
    if (res.timeout) { console.log('  setModel 超时'); continue }
    if (res.error) { console.log('  setModel 报错:', JSON.stringify(res.error.message ?? res.error).slice(0, 260)); continue }
    console.log('  setModel ok:', JSON.stringify(res.result).slice(0, 200))

    const sent = await call('session/send', { sessionId, content: PROMPT }, 15000)
    if (sent.error) { console.log('  send 报错:', JSON.stringify(sent.error.message ?? sent.error).slice(0, 200)); continue }
    const deadline = Date.now() + 60000
    while (!turn.done && Date.now() < deadline) await sleep(1000)
    console.log(`  实际: provider=${turn.providerId ?? '?'} model=${turn.modelId ?? '?'} baseURL=${turn.baseURL ?? '?'}`)
    console.log(`  结果: response=${JSON.stringify(turn.response)} resultType=${turn.resultType ?? '?'} in/out=${turn.usage?.inputTokens ?? '?'}/${turn.usage?.outputTokens ?? '?'}`)
    if (turn.done && turn.response) { console.log('  ✅ 这个组合可用'); break }
  }

  child.kill()
  process.exit(0)
})()
