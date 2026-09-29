/**
 * 探测 `zcode app-server`（ZCode Protocol stdio app server）的真实 JSON-RPC 协议。
 *
 * 关键发现（第一次探测的错误回执）：信封 **不接受 `jsonrpc` 字段**，形如
 *   请求   { id, method, params }
 *   通知   { method, params }
 *   响应   { id, result } / { id, error }
 *
 *   node scripts/probe-app-server.cjs
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')

const CLI = process.env.ZCODE_CLI_PATH || 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const PROMPT = process.env.PROBE_PROMPT || 'Reply with exactly: pong'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: process.env.USERPROFILE,
  env,
  windowsHide: true,
})

let nextId = 1
const pending = new Map()
const events = []

function send(message) {
  const line = JSON.stringify(message)
  console.log('>>>', line.slice(0, 300))
  child.stdin.write(line + '\n')
}

function request(method, params) {
  const id = nextId++
  const promise = new Promise((resolve) => pending.set(id, resolve))
  send({ id, method, params })
  return promise
}

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    console.log('<<< (非 JSON)', text.slice(0, 200))
    return
  }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
    console.log('<<< 响应', JSON.stringify(message).slice(0, 600))
    return
  }
  if (message.method !== undefined && message.id !== undefined) {
    console.log('<<< 服务端请求', message.method, JSON.stringify(message.params ?? {}).slice(0, 250))
    send({ id: message.id, result: {} })
    return
  }
  if (message.method !== undefined) {
    events.push(message)
    console.log('<<< 通知', message.method, JSON.stringify(message.params ?? {}).slice(0, 220))
    return
  }
  console.log('<<< 其它', JSON.stringify(message).slice(0, 250))
})

child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text !== '') console.log('[stderr]', text.slice(0, 250))
})
child.on('exit', (code) => console.log(`[app-server 退出] code=${code}`))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const race = (promise, ms) => Promise.race([promise, sleep(ms).then(() => ({ timeout: true }))])

;(async () => {
  console.log('--- 阶段 1：监听 2.5s（只看它主动发什么） ---')
  await sleep(2500)

  console.log('\n--- 阶段 2：试几种可能的握手/创建方法 ---')
  const attempts = [
    ['initialize', { clientCapabilities: {} }],
    ['session/create', { cwd: process.env.USERPROFILE }],
    ['session/create', {}],
    ['session/new', { cwd: process.env.USERPROFILE }],
  ]
  let sessionId
  for (const [method, params] of attempts) {
    const res = await race(request(method, params), 8000)
    if (res.timeout) {
      console.log(`   ${method} 超时`)
      continue
    }
    if (res.error === undefined) {
      sessionId = res.result?.sessionId ?? res.result?.id ?? res.result?.session?.sessionId ?? res.result?.session?.id
      console.log(`   ${method} 成功！sessionId=${sessionId}，result 键=${Object.keys(res.result ?? {}).join(',')}`)
      if (sessionId) break
    } else {
      console.log(`   ${method} 报错: ${JSON.stringify(res.error).slice(0, 220)}`)
    }
  }

  console.log('\n--- 阶段 3：发消息 ---')
  if (sessionId) {
    const res = await race(request('session/send', { sessionId, message: PROMPT }), 12000)
    console.log('   session/send ->', JSON.stringify(res).slice(0, 300))
    console.log('   收集 40s 事件…')
    await sleep(40000)
    console.log(`   共 ${events.length} 条通知；方法: ${[...new Set(events.map((e) => e.method))].join(', ')}`)
    const kinds = [...new Set(events.map((e) => e.params?.kind ?? e.params?.event?.type ?? '?'))]
    console.log('   事件 kind: ' + kinds.slice(0, 20).join(', '))
  } else {
    console.log('   没有 sessionId，结束')
  }

  child.kill()
  process.exit(0)
})()
