/**
 * app-server 完整流程验证：
 *   session/create → 回复 requestRuntimePreferences → session/subscribe
 *   → session/send{content} → 收集 session/event
 *
 *   node scripts/probe-full-flow.cjs
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
const events = []

function send(message) { child.stdin.write(JSON.stringify(message) + '\n') }
function request(method, params) {
  const id = nextId++
  const promise = new Promise((resolve) => pending.set(id, resolve))
  send({ id, method, params })
  return promise
}
const brief = (v, n = 320) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t && t.length > n ? t.slice(0, n) + '…' : t }

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try { message = JSON.parse(text) } catch { return }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
    return
  }
  if (message.method !== undefined && message.id !== undefined) {
    console.log('  [服务端请求]', message.method, brief(message.params, 160))
    if (message.method === 'session/requestRuntimePreferences') {
      // 依据 bundle 里 pGt 的 schema 回复
      send({
        id: message.id,
        result: {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
          modelContextBudgetStrategy: 'preflight-v1',
        },
      })
      console.log('  -> 已回复运行时偏好')
    } else {
      send({ id: message.id, result: {} })
    }
    return
  }
  if (message.method !== undefined) {
    events.push(message)
    if (message.method === 'session/event') {
      const params = message.params ?? {}
      console.log('  [session/event]', brief(params, 260))
    } else if (!/storageState/.test(String(message.method))) {
      console.log('  [通知]', message.method, brief(message.params, 200))
    }
  }
})
child.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.log('[stderr]', t.slice(0, 160)) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])

async function call(label, method, params, timeout = 10000) {
  const res = await race(request(method, params), timeout)
  if (res.timeout) { console.log(`✗ ${label}: 超时`); return undefined }
  if (res.error) { console.log(`✗ ${label}: ${brief(res.error.message ?? res.error, 400)}`); return undefined }
  console.log(`✓ ${label}: ${brief(res.result, 400)}`)
  return res.result
}

;(async () => {
  await sleep(2500)
  console.log('工作目录:', WORKSPACE)

  let created = await call('session/create', 'session/create', {
    workspace: { workspacePath: WORKSPACE, workspaceKey: 'dsh-dsh-zcode-cli-proxy' },
  })
  if (!created) {
    // 让 Zod 再报一次完整字段
    created = await call('session/create(+prefs)', 'session/create', {
      workspace: { workspacePath: WORKSPACE, workspaceKey: 'dsh-dsh-zcode-cli-proxy' },
      nativeSearchEnhancementsEnabled: false,
    })
  }
  if (!created) { child.kill(); process.exit(0) }

  const sessionId = created.sessionId ?? created.id ?? created.session?.sessionId
  console.log('sessionId =', sessionId)

  await call('session/setModel', 'session/setModel', { sessionId, model: 'glm-5.3-flash' })
  await call('session/subscribe', 'session/subscribe', {
    sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true,
  })

  const sendVariants = [
    { sessionId, content: PROMPT },
    { sessionId, content: PROMPT, inputId: 'input-1' },
  ]
  let sent
  for (const params of sendVariants) {
    sent = await call(`session/send(${Object.keys(params).filter((k) => k !== 'sessionId').join('+')})`, 'session/send', params, 15000)
    if (sent) break
  }
  if (!sent) { child.kill(); process.exit(0) }

  console.log('\n收集事件 45s…')
  await sleep(45000)
  const sessionEvents = events.filter((e) => e.method === 'session/event')
  console.log(`\nsession/event 共 ${sessionEvents.length} 条`)
  const kinds = {}
  for (const event of sessionEvents) {
    const key = event.params?.kind ?? event.params?.event?.type ?? event.params?.type ?? '?'
    kinds[key] = (kinds[key] ?? 0) + 1
  }
  console.log('事件 kind 统计:', JSON.stringify(kinds))
  // 打印几条代表性事件
  const seen = new Set()
  for (const event of sessionEvents) {
    const key = event.params?.kind ?? event.params?.event?.type ?? event.params?.type ?? '?'
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`\n--- 样例 kind=${key} ---`)
    console.log(brief(event.params, 700))
  }

  child.kill()
  process.exit(0)
})()
