/**
 * 探测 app-server 的 session/send 是否支持结构化 content（数组块 + 图片）。
 * 依次尝试多种块形状，各自等 turn.completed，打印模型答复与校验错误。
 *   node scripts/probe-session-image.cjs [图片路径]
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CLI = process.env.ZCODE_CLI_PATH || 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const IMAGE = process.argv[2] || path.join(os.tmpdir(), 'dsh-zcode-cli-proxy-img-test.png')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: os.homedir(), env, windowsHide: true,
})

let nextId = 1
const pending = new Map()
let events = []
let serverRequests = []

function send(message) { child.stdin.write(JSON.stringify(message) + '\n') }
function request(method, params) {
  const id = nextId++
  const promise = new Promise((resolve) => pending.set(id, resolve))
  send({ id, method, params })
  return promise
}
const brief = (value, n = 260) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > n ? text.slice(0, n) + '…' : text
}

const readline = require('node:readline')
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
    serverRequests.push(message.method)
    // 权限/偏好请求尽量按插件的方式回答
    if (message.method === 'session/requestRuntimePreferences') {
      send({ id: message.id, result: {
        nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1',
      } })
    } else {
      send({ id: message.id, result: {} })
    }
    return
  }
  if (message.method === 'session/event') {
    const payload = message.params?.payload ?? {}
    if (process.env.PROBE_VERBOSE) console.log('  [event]', payload.type, brief(payload, 220))
    if (payload.type === 'model.streaming' && payload.kind === 'text_delta') events.push(String(payload.delta ?? ''))
    if (payload.type === 'turn.completed') events.push({ completed: payload })
  }
})
child.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.error('[stderr]', t.slice(0, 160)) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])

async function waitForTurn(label, ms = 90000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const done = events.find((e) => e && e.completed)
    if (done) {
      const completed = done.completed
      console.log(`✓ ${label} turn.completed resultType=${completed.resultType}`)
      console.log(`  答复: ${brief(completed.response, 400)}`)
      if (completed.usage) console.log(`  用量: in=${completed.usage.inputTokens} out=${completed.usage.outputTokens}`)
      return completed
    }
    await sleep(400)
  }
  console.log(`✗ ${label}: ${ms}ms 内没等到 turn.completed`)
  return undefined
}

async function trySend(label, content) {
  events = []
  const res = await race(request('session/send', { sessionId, content }), 15000)
  if (res.timeout) { console.log(`✗ ${label}: send 15s 无响应`); return false }
  if (res.error) { console.log(`✗ ${label} send 被拒: ${brief(res.error, 400)}`); return false }
  console.log(`✓ ${label} send accepted: ${brief(res.result, 120)}`)
  return true
}

let sessionId
;(async () => {
  await sleep(8000) // 就绪等待（插件同款）
  const created = await race(request('session/create', {
    workspace: { workspacePath: os.homedir(), workspaceKey: 'dsh-dsh-zcode-cli-proxy-probe' },
  }), 15000)
  if (created.error || !created.result?.session?.sessionId) {
    console.log('✗ session/create 失败:', brief(created.error ?? created.result, 300))
    child.kill(); process.exit(1)
  }
  sessionId = created.result.session.sessionId
  console.log('✓ session/create:', sessionId)
  await race(request('session/subscribe', {
    sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true,
  }), 15000)
  await sleep(1500)

  const imgPath = path.resolve(IMAGE)

  // 形状 1：纯文本里给出图片路径，让 agent 自己用 Read 工具读图（读图会转成视觉输入）
  if (await trySend('形状1 文本+路径让agent Read',
    `请先用 Read 工具读取这张图片：${imgPath} ，然后只回答图片里写的文字内容，不要做任何其他事。`)) {
    await waitForTurn('形状1')
  }

  console.log('\n服务端请求:', serverRequests.join(', ') || '(none)')
  child.kill()
  process.exit(0)
})().catch((error) => { console.error(error); child.kill(); process.exit(1) })
