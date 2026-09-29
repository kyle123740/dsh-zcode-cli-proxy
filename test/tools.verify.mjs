/**
 * 独立进程验证：用假 ctx 加载插件、调用每个工具的 execute，
 * 按 dsh-tools 的 snapshotJsonValue 规则校验返回值。
 * 通过 = 代码本身没问题（DSH 里若仍失败就是模块缓存未刷新）。
 */
import { apply } from '../lib/index.js'

function losslessViolation(value) {
  const ancestors = new Set()
  const stack = [{ v: value, p: '$' }]
  while (stack.length > 0) {
    const { v, p } = stack.pop()
    if (v === null) continue
    if (typeof v === 'boolean' || typeof v === 'string') continue
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Object.is(v, -0)) return `${p}: not a finite non-negative-zero number`
      continue
    }
    if (typeof v !== 'object') return `${p}: typeof ${typeof v}`
    if (ancestors.has(v)) return `${p}: circular`
    ancestors.add(v)
    if (Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Array.prototype && proto !== null) return `${p}: non-plain array prototype`
      const keys = Reflect.ownKeys(v)
      if (keys.length !== v.length + 1) return `${p}: array has ${keys.length} own keys for length ${v.length}`
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(v, i)) return `${p}: dense array violation at ${i}`
        stack.push({ v: v[i], p: `${p}[${i}]` })
      }
      continue
    }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return `${p}: non-plain prototype`
    for (const key of Object.keys(v)) {
      if (typeof key !== 'string') return `${p}: non-string key`
      stack.push({ v: v[key], p: `${p}.${key}` })
    }
  }
  return undefined
}

const tools = new Map()
const ctx = {
  llm: {
    registerConfigurableProviders(entries) { console.log('provider registered:', JSON.stringify(entries)) },
    registerAdapter(providers, adapter) { console.log('adapter registered for:', providers.join(','), 'class=', adapter.constructor.name) },
  },
  tools: { register(def) { tools.set(def.name, def) } },
  logger: { info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m), debug: () => {} },
  fiber: { entry: { options: { id: 'zcode2api' } } },
  get() { return undefined },
  effect(fn) { console.log('effect registered') },
}

apply(ctx, { enabled: true, autoStart: false, manageProcess: false })
console.log('tools:', [...tools.keys()].join(', '))

let failures = 0
const cases = [
  ['zcode2api_status', { refresh: false }],
  ['zcode2api_gateway', { action: 'logs', lines: 20 }],
  ['zcode2api_gateway', { action: 'start' }],
  ['zcode2api_accounts', { action: 'list' }],
  ['zcode2api_quota', {}],
]
for (const [name, args] of cases) {
  try {
    const def = tools.get(name)
    if (def === undefined) throw new Error('tool not registered')
    const value = await def.execute(args, undefined)
    const violation = losslessViolation(value)
    if (violation !== undefined) throw new Error(`lossless violation: ${violation}`)
    console.log(`  PASS ${name}(${JSON.stringify(args)})`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}(${JSON.stringify(args)}): ${error?.message ?? error}`)
  }
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
