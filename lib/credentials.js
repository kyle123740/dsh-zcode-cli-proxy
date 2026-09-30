/**
 * ZCode 客户端共享凭证的解密（读取 Start Plan 的 OAuth token）。
 *
 * zcode.cjs 的凭证存储（~/.zcode/v2/credentials.json）：
 *   - 每个值形如 `enc:v1:<iv>.<tag>.<data>`（base64url 三段）
 *   - AES-256-GCM，密钥 = SHA-256(ZCODE_CREDENTIAL_SECRET ?? 机器指纹)
 *   - 机器指纹 = `zcode-credential-fallback:<platform>:<homedir>:<username>`
 *     （与 zcode.cjs 的 resolveCredentialSecret 完全一致）
 *
 * 关联凭证键（2026-09-30 实测）：
 *   - `zcodejwttoken`：ZCode JWT —— **Start Plan 端点的鉴权凭证**（requestAuth.apiKey 用它，
 *     agent 在其上计算 coding-plan 请求签名）。`oauth:zai:access_token` 是 OAuth 会话 token，
 *     长期不刷新已过期（401），只作兜底。
 *   - `oauth:zai:access_token`：Z.AI OAuth 会话 token（已过期的兜底）
 *   - `oauth:active_provider`：当前登录的家族（"zai" | "bigmodel"）
 *
 * @module lib/credentials.js
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { userInfo, platform, homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ENC_PREFIX = 'enc:v1:'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

export class CredentialError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

/**
 * 复刻 zcode.cjs resolveCredentialSecret 的机器指纹。
 * @param {string} [secretOverride] 测试覆盖（ZCODE_CREDENTIAL_SECRET）
 */
export function credentialSecret(secretOverride) {
  const fromEnv = secretOverride ?? process.env.ZCODE_CREDENTIAL_SECRET
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    /* 用户名不可得时与 zcode.cjs 一致地降级 */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
}

/** AES-256-GCM 密钥（SHA-256 摘要，与 zcode.cjs deriveCipherKey 一致）。 */
export function deriveKey(secret = credentialSecret()) {
  return createHash('sha256').update(secret).digest()
}

/** 解密单个 `enc:v1:` 值；非加密值原样返回。 */
export function decryptValue(value, key = deriveKey()) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value
  const parts = value.slice(ENC_PREFIX.length).split('.')
  if (parts.length !== 3) {
    throw new CredentialError('凭证密文格式无效（应为 iv.tag.data 三段）', 'CIPHER_FORMAT')
  }
  const [ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const data = Buffer.from(dataB64, 'base64url')
  if (iv.length !== IV_LENGTH) {
    throw new CredentialError(`凭证 IV 长度无效（${iv.length} ≠ ${IV_LENGTH}）`, 'CIPHER_IV')
  }
  if (tag.length !== TAG_LENGTH) {
    throw new CredentialError(`凭证 auth tag 长度无效（${tag.length} ≠ ${TAG_LENGTH}）`, 'CIPHER_TAG')
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new CredentialError(`凭证解密失败：${error?.message ?? error}`, 'CIPHER_DECRYPT')
  }
}

/** 共享凭证文件路径（~/.zcode/v2/credentials.json）。 */
export function credentialsPath(dataBaseDir) {
  // 空串视为未设置（path.join('', '.zcode', …) 会得到相对路径）
  const base = dataBaseDir?.trim?.() || process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir()
  return path.join(base, '.zcode', 'v2', 'credentials.json')
}

/**
 * 读取并解密共享凭证。
 * @returns {Record<string, string>} 键 → 解密后的值（未加密值原样保留）
 */
export function readCredentials(dataBaseDir, key = deriveKey()) {
  const file = credentialsPath(dataBaseDir)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CredentialError(`共享凭证文件不存在：${file}（ZCode 客户端未登录？）`, 'CREDENTIALS_MISSING')
    }
    throw new CredentialError(`共享凭证文件读取失败：${error?.message ?? error}`, 'CREDENTIALS_READ')
  }
  const out = {}
  for (const [key_, value] of Object.entries(raw)) {
    try {
      out[key_] = decryptValue(value, key)
    } catch (error) {
      // 单个凭证解密失败不影响其他（记为 null，调用方按需判空）
      out[key_] = null
    }
  }
  return out
}

/**
 * 提取 Start Plan 请求需要的鉴权：
 *   - planToken：`zcodejwttoken`（Start Plan 端点的 x-api-key / 签名基钥；缺省回退 access OAuth token）
 *   - accessToken：`oauth:zai:access_token`（OAuth 会话 token，多已过期，仅兜底）
 *   - activeProvider：`oauth:active_provider`（应为 "zai"）
 * @returns {{ planToken: string, accessToken?: string, jwtToken?: string, activeProvider?: string }}
 */
export function readZaiPlanAuth(dataBaseDir, key = deriveKey()) {
  const creds = readCredentials(dataBaseDir, key)
  const planToken = creds['zcodejwttoken']
  const accessToken = creds['oauth:zai:access_token']
  if ((typeof planToken !== 'string' || planToken === '') && (typeof accessToken !== 'string' || accessToken === '')) {
    throw new CredentialError('共享凭证里没有 zcodejwttoken / oauth:zai:access_token（ZCode 客户端未登录 Z.AI？）', 'TOKEN_MISSING')
  }
  return {
    planToken: (typeof planToken === 'string' && planToken !== '') ? planToken : accessToken,
    ...(typeof accessToken === 'string' && accessToken !== '' ? { accessToken } : {}),
    activeProvider: creds['oauth:active_provider'] ?? undefined,
  }
}
