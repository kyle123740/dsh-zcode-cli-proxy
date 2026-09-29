/**
 * 自动探出 session/create 的完整参数结构：
 * 反复调用，解析 Zod 报错里缺失的 path/期望类型，自动补默认值，直到成功。
 *
 *   node scripts/probe-schema-autofill.cjs
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
const serverRequests = []

function send(message) { child.stdin.write(JSON.stringify(message) + '\n') }
function request(method, params) {
  const id = nextId++
  const promise = new Promise((resolve) => pending.set(id, resolve))
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
    return
  }
  if (message.method !== undefined && message.id !== undefined) {
    serverRequests.push(message)
    console.log('  [服务端请求]', message.method, JSON.stringify(message.params ?? {}).slice(0, 200))
    send({ id: message.id, result: {} })
    return
  }
})
child.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.log('[stderr]', t.slice(0, 160)) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))])

/** 依据 Zod 报错，把缺失字段补进 params。返回是否补了东西。 */
function applyZodFixes(params, message) {
  let issues
  try {
    issues = JSON.parse(message)
  } catch {
    return 0
  }
  let fixed = 0
  for (const issue of issues) {
    const keyPath = issue.path ?? []
    if (keyPath.length === 0) continue
    if (issue.code === 'unrecognized_keys') continue
    let target = params
    let ok = true
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i]
      if (typeof target[key] !== 'object' || target[key] === null) target[key] = {}
      target = target[key]
      if (typeof target !== 'object') { ok = false; break }
    }
    if (!ok) continue
    const last = keyPath[keyPath.length - 1]
    if (target[last] !== undefined) continue
    const expected = issue.expected ?? issue.type
    target[last] =
      expected === 'boolean' ? false :
      expected === 'number' || expected === 'int' ? 0 :
      expected === 'array' ? [] :
      expected === 'object' ? {} :
      expected === 'string' ? '' : null
    fixed += 1
  }
  return fixed
}

;(async () => {
  await sleep(2500)

  const params = { workspace: { workspacePath: WORKSPACE, workspaceKey: 'dsh' } }
  for (let attempt = 1; attempt <= 15; attempt++) {
    const res = await race(request('session/create', params), 8000)
    if (res.timeout) { console.log(`第 ${attempt} 次：超时`); break }
    if (!res.error) {
      console.log(`\n✓ 第 ${attempt} 次成功！`)
      console.log('params =', JSON.stringify(params, null, 2).slice(0, 1200))
      console.log('result =', JSON.stringify(res.result, null, 2).slice(0, 800))
      break
    }
    const zod = res.error?.data?.message
    if (!zod) { console.log(`第 ${attempt} 次：非 Zod 错误`, JSON.stringify(res.error).slice(0, 300)); break }
    const fixed = applyZodFixes(params, zod)
    console.log(`第 ${attempt} 次：补了 ${fixed} 个字段 -> ${JSON.stringify(params).slice(0, 260)}`)
    if (fixed === 0) { console.log('无法继续补全，Zod 原文:\n', zod.slice(0, 800)); break }
  }

  console.log('\n服务端请求过的我方方法:', [...new Set(serverRequests.map((r) => r.method))].join(', ') || '(无)')
  child.kill()
  process.exit(0)
})()
