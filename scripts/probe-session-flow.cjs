/**
 * 逐步探通 app-server 的会话流程：session/create → session/send → 订阅事件。
 * 每一步都把校验错误打出来，便于推断参数结构。
 *   node scripts/probe-session-flow.cjs
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
const notifications = []

function send(message) { child.stdin.write(JSON.stringify(message) + '\n') }
function request(method, params) {
  const id = nextId++
  const promise = new Promise((resolve) => pending.set(id, resolve))
  send({ id, method, params })
  return promise
}
const brief = (value, n = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > n ? text.slice(0, n) + '…' : text
}

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
    console.log('  [服务端请求]', message.method, brief(message.params, 200))
    send({ id: message.id, result: {} })
    return
  }
  if (message.method !== undefined) {
    notifications.push(message)
    if (!/startup\/storageState|storageState/.test(String(message.method))) {
      console.log('  [通知]', message.method, brief(message.params, 260))
    }
  }
})
child.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.log('[stderr]', t.slice(0, 160)) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])

async function tryCall(label, method, params, timeout = 8000) {
  const res = await race(request(method, params), timeout)
  if (res.timeout) { console.log(`✗ ${label}: 超时`); return undefined }
  if (res.error) { console.log(`✗ ${label}: ${brief(res.error.message ?? res.error, 320)}`); return undefined }
  console.log(`✓ ${label}: ${brief(res.result, 300)}`)
  return res.result
}

;(async () => {
  await sleep(2500)
  console.log('工作目录:', WORKSPACE)

  // ── session/create ──
  let created
  const keyCandidates = ['default', WORKSPACE, 'zcode-dsh', '0'.repeat(64)]
  for (const workspaceKey of keyCandidates) {
    created = await tryCall(`create(key=${brief(workspaceKey, 20)})`, 'session/create', {
      workspace: { workspacePath: WORKSPACE, workspaceKey },
    })
    if (created) break
  }
  if (!created) { child.kill(); process.exit(0) }

  const sessionId = created.sessionId ?? created.id ?? created.session?.sessionId ?? created.session?.id
  console.log('sessionId =', sessionId, ' 返回键:', Object.keys(created).join(','))
  if (!sessionId) { child.kill(); process.exit(0) }

  // ── 订阅（可能必须） ──
  await tryCall('subscribe', 'sessionSubscribe', {
    sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true,
  }, 8000)

  // ── session/send 的几种参数形态 ──
  const sendVariants = [
    { sessionId, message: PROMPT },
    { sessionId, prompt: PROMPT },
    { sessionId, content: PROMPT },
    { sessionId, input: { text: PROMPT } },
    { sessionId, message: { role: 'user', content: PROMPT } },
    { sessionId, text: PROMPT },
  ]
  let sent
  for (const params of sendVariants) {
    sent = await tryCall(`send(${Object.keys(params).filter((k) => k !== 'sessionId').join('+')})`, 'session/send', params, 10000)
    if (sent) break
  }

  console.log(sent ? '\n等 40s 收事件…' : '\n没能发出消息')
  await sleep(40000)
  const methods = [...new Set(notifications.map((n) => n.method))]
  console.log('通知方法:', methods.join(', '))
  const sessionEvents = notifications.filter((n) => /session/i.test(String(n.method)))
  console.log(`session 相关通知 ${sessionEvents.length} 条，样例：`)
  for (const event of sessionEvents.slice(0, 8)) console.log('  ', event.method, brief(event.params, 200))

  child.kill()
  process.exit(0)
})()
