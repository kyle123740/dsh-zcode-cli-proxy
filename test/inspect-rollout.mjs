/** 检查 rollout 日志：模型请求体里有没有 image 内容块。 node test/inspect-rollout.mjs <jsonl路径> */
import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
console.log('文件:', file)
console.log('总行数:', lines.length)
let imageInRequest = 0
let lastReq = null
let lastErr = null
let turnSummaries = []
for (const line of lines) {
  try {
    const j = JSON.parse(line)
    const body = j.request?.body
    if (body) {
      const s = JSON.stringify(body)
      const hasImage = /"type":\s*"image"|"mediaType"\s*:\s*"image|data:image/.test(s)
      if (hasImage) imageInRequest++
      lastReq = { model: body.model, messages: (body.messages ?? []).length, hasImage }
    }
    if (j.error) lastErr = j.error.message ?? JSON.stringify(j.error).slice(0, 140)
    const u = j.usage
    if (u && j.model) turnSummaries.push(`in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'} cache=${u.cacheReadTokens ?? 0}`)
  } catch { /* 跳过坏行 */ }
}
console.log('含图片内容的请求数:', imageInRequest)
console.log('最后一个请求:', JSON.stringify(lastReq))
console.log('最后的错误:', lastErr)
console.log('用量序列(末5):', turnSummaries.slice(-5).join(' | '))
