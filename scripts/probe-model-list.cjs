/**
 * 抓 app-server 的会话结构：create 返回了什么、订阅快照里有哪些 provider/model 可选。
 *   node scripts/probe-model-list.cjs
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const CLI = process.env.ZCODE_CLI_PATH || 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const WORKSPACE = process.env.PROBE_WORKSPACE || path.join(process.env.USERPROFILE, 'ZCodeProject')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: process.env.USERPROFILE, env, windowsHide: true,
})

let nextId = 1
const pending = new Map()
const seenModels = new Map()

function send(m) { child.stdin.write(JSON.stringify(m) + '\n') }
function request(method, params) {
  const id = nextId++
  const p = new Promise((resolve) => pending.set(id, resolve))
  send({ id, method, params })
  return p
}

/** 递归找出所有 {providerId, modelId} 形态的对象 */
function collectModels(node, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const item of node) collectModels(item, depth + 1); return }
  if (typeof node.providerId === 'string' && typeof node.modelId === 'string') {
    const key = `${node.providerId}|${node.modelId}`
    if (!seenModels.has(key)) {
      seenModels.set(key, { providerId: node.providerId, modelId: node.modelId, providerLabel: node.providerLabel ?? node.providerName, label: node.label ?? node.name })
    }
  }
  for (const value of Object.values(node)) collectModels(value, depth + 1)
}

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let m
  try { m = JSON.parse(text) } catch { return }
  if (m.id !== undefined && m.method === undefined) {
    const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m) }
    collectModels(m.result)
    return
  }
  if (m.method !== undefined && m.id !== undefined) {
    send({ id: m.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' } })
    return
  }
  if (m.method !== undefined) collectModels(m.params)
})
child.stderr.on('data', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])
async function call(label, method, params, timeout = 12000) {
  const res = await race(request(method, params), timeout)
  if (res.timeout) { console.log(`✗ ${label}: 超时`); return undefined }
  if (res.error) { console.log(`✗ ${label}: ${JSON.stringify(res.error.message ?? res.error).slice(0, 300)}`); return undefined }
  return res.result
}

;(async () => {
  await sleep(2500)
  const created = await call('create', 'session/create', { workspace: { workspacePath: WORKSPACE, workspaceKey: 'dsh-dsh-zcode-cli-proxy' } })
  if (!created) { child.kill(); process.exit(0) }

  console.log('=== create 返回的顶层键 ===')
  console.log(Object.keys(created).join(', '))
  console.log('\n=== 顶层每个键的类型/摘要 ===')
  for (const [key, value] of Object.entries(created)) {
    const summary = typeof value === 'object' && value !== null ? `{${Object.keys(value).slice(0, 12).join(',')}}` : JSON.stringify(value)
    console.log(`  ${key}: ${String(summary).slice(0, 200)}`)
  }
  // 找 sessionId：递归搜 sess_ 前缀
  const text = JSON.stringify(created)
  const match = text.match(/sess_[0-9a-f-]{36}/)
  const sessionId = match ? match[0] : undefined
  console.log('\n提取到 sessionId =', sessionId)
  if (!sessionId) { child.kill(); process.exit(0) }

  await call('subscribe', 'session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true })
  await sleep(3000)

  console.log(`\n=== 收集到的可选模型 ${seenModels.size} 个 ===`)
  for (const entry of seenModels.values()) {
    console.log(`  provider=${entry.providerId}  model=${entry.modelId}  providerLabel=${entry.providerLabel ?? '?'}  label=${entry.label ?? '?'}`)
  }
  child.kill()
  process.exit(0)
})()
