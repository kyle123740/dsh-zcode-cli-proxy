/**
 * 专项探测 session/create 的 params 结构（Zod 会告诉我们缺什么）。
 *   node scripts/probe-session-create.cjs
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')

const CLI = process.env.ZCODE_CLI_PATH || 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node', [CLI, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: process.env.USERPROFILE, env, windowsHide: true,
})

let nextId = 1
const pending = new Map()

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n')
}
function request(method, params) {
  const id = nextId++
  const promise = new Promise((resolve) => pending.set(id, resolve))
  console.log(`\n>>> ${method} ${JSON.stringify(params)}`)
  send({ id, method, params })
  return promise
}

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try { message = JSON.parse(text) } catch { return }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
    const pretty = JSON.stringify(message, null, 2)
    console.log('<<< 响应:\n' + pretty.slice(0, 2500))
    return
  }
  if (message.method !== undefined && message.id !== undefined) {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method !== undefined) {
    if (!/startup\/storageState/.test(message.method)) {
      console.log('<<< 通知', message.method, JSON.stringify(message.params ?? {}).slice(0, 400))
    }
  }
})
child.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.log('[stderr]', t.slice(0, 200)) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])

;(async () => {
  await sleep(2500)

  // 逐步补齐字段：先看 workspace 空对象报什么
  const attempts = [
    ['session/create', { workspace: {} }],
  ]
  for (const [method, params] of attempts) {
    const res = await race(request(method, params), 8000)
    if (res.timeout) console.log('   超时')
  }
  child.kill()
  process.exit(0)
})()
