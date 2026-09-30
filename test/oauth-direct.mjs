/**
 * 验证：解密 ZCode 客户端的 OAuth token，并直连 ZCode 计划端点（Start Plan 额度）。
 *   node test/oauth-direct.mjs
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { userInfo, platform, homedir } from 'node:os'
import { readFileSync } from 'node:fs'

const credPath = `${homedir()}\\.zcode\\v2\\credentials.json`
const creds = JSON.parse(readFileSync(credPath, 'utf8'))

// 与 zcode.cjs 相同的密钥派生：ZCODE_CREDENTIAL_SECRET ?? 机器指纹
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

console.log('--- 解密凭证 ---')
const accessToken = decrypt(creds['oauth:zai:access_token'])
const jwtToken = decrypt(creds['zcodejwttoken'])
const activeProvider = decrypt(creds['oauth:active_provider'])
console.log('activeProvider:', activeProvider)
console.log('accessToken:', accessToken.slice(0, 40) + '...', `(${accessToken.length} 字符)`)
console.log('jwtToken:', jwtToken.slice(0, 40) + '...', `(${jwtToken.length} 字符)`)

console.log('\n--- 直连 ZCode 计划端点（Start Plan） ---')
// GUI config.json 里 builtin:zai-start-plan 的 baseURL
const baseURL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic'
const res = await fetch(`${baseURL}/v1/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': `Bearer ${accessToken}`,
    'http-referer': 'https://zcode.z.ai',
    'user-agent': 'ZCode/0.16.9',
    'x-zcode-app-version': '0.16.9',
    'x-title': 'Z Code@cli',
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'GLM-5.3-Flash',
    max_tokens: 32,
    messages: [{ role: 'user', content: '只回复两个字：就绪' }],
  }),
})
console.log('HTTP', res.status)
const text = await res.text()
console.log('响应(截500):', text.slice(0, 500))
