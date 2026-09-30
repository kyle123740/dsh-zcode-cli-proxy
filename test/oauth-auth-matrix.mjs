/**
 * 鉴权组合测试：找出 ZCode 计划端点接受的头。
 *   node test/oauth-auth-matrix.mjs
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { userInfo, platform, homedir } from 'node:os'
import { readFileSync } from 'node:fs'

const credPath = `${homedir()}\\.zcode\\v2\\credentials.json`
const creds = JSON.parse(readFileSync(credPath, 'utf8'))
const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
  ?? `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`
const key = createHash('sha256').update(secret).digest()
function decrypt(value) {
  if (!value.startsWith('enc:v1:')) return value
  const [ivB64, tagB64, dataB64] = value.slice('enc:v1:'.length).split('.')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8')
}
const accessToken = decrypt(creds['oauth:zai:access_token'])
const jwtToken = decrypt(creds['zcodejwttoken'])
const accountKey = decrypt(creds['account-provider:coding-plan:account:zai-individual-coding-plan:account:79c62226-1ee9-4eb5-ab3f-b9647083725a:api-key'])

const baseURL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic'
const body = JSON.stringify({
  model: 'GLM-5.3-Flash',
  max_tokens: 32,
  messages: [{ role: 'user', content: '只回复两个字：就绪' }],
})
const baseHeaders = {
  'content-type': 'application/json',
  'http-referer': 'https://zcode.z.ai',
  'user-agent': 'ZCode/0.16.9',
  'x-zcode-app-version': '0.16.9',
  'x-title': 'Z Code@cli',
  'anthropic-version': '2023-06-01',
}

const variants = [
  ['x-api-key: accessToken', { ...baseHeaders, 'x-api-key': accessToken }],
  ['Authorization: Bearer jwtToken', { ...baseHeaders, 'authorization': `Bearer ${jwtToken}` }],
  ['x-api-key: jwtToken', { ...baseHeaders, 'x-api-key': jwtToken }],
  ['Authorization: Bearer accessToken (zcode-plan path, /v1/messages 去掉重复)', { ...baseHeaders, 'authorization': `Bearer ${accessToken}` }],
  ['accountKey bearer', { ...baseHeaders, 'authorization': `Bearer ${accountKey}` }],
]

for (const [label, headers] of variants) {
  const url = label.includes('去掉重复') ? baseURL : `${baseURL}/v1/messages`
  try {
    const res = await fetch(url, { method: 'POST', headers, body })
    const text = await res.text()
    console.log(`[${label}] HTTP ${res.status}  ${text.slice(0, 160)}`)
  } catch (e) {
    console.log(`[${label}] 失败: ${e?.message ?? e}`)
  }
}
