/** 转储 rollout 每行的关键字段。 node test/dump-rollout.mjs <jsonl路径> */
import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
lines.forEach((line, i) => {
  try {
    const j = JSON.parse(line)
    const body = j.request?.body
    console.log(`--- 行 ${i + 1} ---`)
    console.log('keys:', Object.keys(j).join(','))
    if (j.attempt !== undefined) console.log('attempt:', j.attempt, 'model:', JSON.stringify(j.model ?? ''))
    if (body) {
      console.log('body.model:', body.model, '| messages:', (body.messages ?? []).length, '| system 类型:', typeof body.system, '| max_tokens:', body.max_tokens)
      for (const [mi, m] of (body.messages ?? []).entries()) {
        const c = m.content
        const desc = typeof c === 'string' ? `string(${c.length})` : Array.isArray(c) ? `[${c.map((b) => b.type ?? '?').join(',')}]` : typeof c
        console.log(`  msg[${mi}] ${m.role}: ${desc}`)
      }
    }
    if (j.error) console.log('error:', j.error.name, '-', String(j.error.message).slice(0, 120), '| attempt:', j.attempt)
    if (j.completedAt) console.log('completedAt:', j.completedAt, 'durationMs:', j.durationMs)
    if (j.usage) console.log('usage:', JSON.stringify(j.usage))
  } catch (e) {
    console.log(`--- 行 ${i + 1} (解析失败) ---`, String(e).slice(0, 80))
  }
})
