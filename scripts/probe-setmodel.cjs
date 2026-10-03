/**
 * 探测 session/setModel 以及会话里可选的模型/供应商列表，
 * 目标：把会话切到 ZCode 计划 provider（zcode.z.ai），而不是客户端当前选的自定义供应商。
 *
 *   node scripts/probe-setmodel.cjs
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const CLI = process.env.ZCODE_CLI_PATH || 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const PROMPT = process.env.PROBE_PROMPT || 'Reply with exactly: pong'
const WORKSPACE = process.env.PROBE_WORKSPACE || path.join(process.env.USERPROFILE, 'ZCodeProject')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: process.env.USERPROFILE, env, windowsHide: true,
})

let nextId = 1
const pending = new Map()
let availableModels = []

function send(m) { child.stdin.write(JSON.stringify(m) + '\n') }
function request(method, params) {
  const id = nextId++
  const p = new Promise((resolve) => pending.set(id, resolve))
  send({ id, method, params })
  return p
}
const brief = (v, n = 260) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t && t.length > n ? t.slice(0, n) + '…' : t }

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
    if (m.method === 'session/requestRuntimePreferences') {
      send({ id: m.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' } })
    } else {
      send({ id: m.id, result: {} })
    }
    return
  }
  if (m.method === 'state.updated') {
    const model = m.params?.patch?.model ?? m.params?.model
    if (model?.available) {
      availableModels = model.available
      console.log(`  [state.updated] 收到 ${availableModels.length} 个可选模型：`)
      for (const entry of availableModels) {
        console.log(`    provider=${entry.ref?.providerId} model=${entry.ref?.modelId} label=${entry.label} providerLabel=${entry.providerLabel} ctx=${entry.contextWindow ?? '?'}`)
      }
    }
  }
  if (m.method === 'session/event' && m.params?.payload?.type === 'session.updated') {
    const p = m.params.payload
    if (p.modelId) console.log(`  [session.updated] providerId=${p.providerId} modelId=${p.modelId}`)
  }
  if (m.method === 'session/event' && m.params?.payload?.type === 'model.streaming' && m.params.payload.kind === 'text_delta') {
    process.stdout.write(String(m.params.payload.delta))
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])
async function call(label, method, params, timeout = 10000) {
  const res = await race(request(method, params), timeout)
  if (res.timeout) { console.log(`✗ ${label}: 超时`); return undefined }
  if (res.error) { console.log(`✗ ${label}: ${brief(res.error.message ?? res.error, 300)}`); return undefined }
  console.log(`✓ ${label}`)
  return res.result
}

;(async () => {
  await sleep(2500)
  const created = await call('create', 'session/create', { workspace: { workspacePath: WORKSPACE, workspaceKey: 'dsh-dsh-zcode-cli-proxy' } })
  if (!created) { child.kill(); process.exit(0) }
  const sessionId = created.sessionId
  await sleep(1500) // 等 state.updated 带出可选模型

  // 找到 ZCode 计划 provider（label 里带 Z.ai / Coding Plan / Start Plan）
  const zcodePlan = availableModels.find((e) => /z\.?ai|coding plan|start plan/i.test(String(e.providerLabel ?? '')))
  console.log('\nZCode 计划候选:', zcodePlan ? `${zcodePlan.providerLabel} / ${zcodePlan.label}` : '(没找到)')

  if (zcodePlan) {
    await call('setModel(ref 对象)', 'session/setModel', {
      sessionId,
      model: { providerId: zcodePlan.ref.providerId, modelId: zcodePlan.ref.modelId },
    }, 12000)
  }

  await call('subscribe', 'session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: false })
  await call('send', 'session/send', { sessionId, content: PROMPT }, 15000)
  console.log('\n--- 流式输出 ---')
  await sleep(45000)
  console.log('\n--- 结束 ---')
  child.kill()
  process.exit(0)
})()
