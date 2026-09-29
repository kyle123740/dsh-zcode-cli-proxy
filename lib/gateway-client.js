/**
 * zcode2api 的 HTTP 客户端（后台管理 API + 网关探活）。
 *
 * 只做两件事：把 JSON 请求打出去、把错误翻译成人类能读的信息。
 * 账号/额度/设置都走 `/admin/api/*`（Bearer 后台密码），
 * 探活用 `/v1/models`（未配置网关 Key 时无需鉴权，配置了则 401 也算“活着”）。
 *
 * @module lib/gateway-client.js
 */

const DEFAULT_TIMEOUT_MS = 20_000

/** 用一个可取消的定时器把 fetch 包成“带超时 + 可被调用方取消”。 */
async function request(url, { method = 'GET', headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('request timeout'), timeoutMs)
  timer.unref?.()
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    return await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 读取响应体：优先 JSON，退回到文本。 */
async function readBody(response) {
  const text = await response.text().catch(() => '')
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 把失败的响应变成带上下文的错误。 */
function failure(url, response, payload) {
  const detail = payload?.detail ?? payload?.error?.message ?? payload?.error ?? (typeof payload === 'string' ? payload : '')
  const suffix = detail === '' || detail === undefined ? '' : `：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  const error = new Error(`zcode2api ${response.status} ${response.statusText || ''} ${url}${suffix}`.replace(/\s+/g, ' ').trim())
  error.status = response.status
  error.payload = payload
  return error
}

/**
 * 后台 API 客户端。
 */
export class GatewayClient {
  /**
   * @param {object} deps
   * @param {() => object} deps.options 解析后的插件配置。
   * @param {object} [deps.logger]
   */
  constructor({ options, logger }) {
    this.options = options
    this.logger = logger
  }

  /** 不带尾斜杠的 base url。 */
  get baseUrl() {
    const { host, port } = this.options()
    return `http://${host}:${port}`
  }

  /** 网关端点（/v1/messages、/v1/models）。 */
  gatewayUrl(pathname) {
    return `${this.baseUrl}${pathname}`
  }

  /** 后台端点。 */
  adminUrl(pathname) {
    return `${this.baseUrl}/admin/api${pathname}`
  }

  /** 后台请求：自动带 Bearer 后台密码。 */
  async admin(pathname, { method = 'GET', body, timeoutMs, signal } = {}) {
    const options = this.options()
    const url = this.adminUrl(pathname)
    let response
    try {
      response = await request(url, {
        method,
        headers: { authorization: `Bearer ${options.adminKey}` },
        body,
        timeoutMs,
        signal,
      })
    } catch (error) {
      throw new Error(`无法连接 zcode2api 网关（${url}）：${error?.message ?? error}。请先启动网关或运行 setup.ps1。`)
    }
    const payload = await readBody(response)
    if (!response.ok) throw failure(url, response, payload)
    return payload
  }

  /** 网关是否活着：任何 HTTP 响应都算（401/403 说明服务在、只是要 Key）。 */
  async health(timeoutMs = 5000) {
    const url = this.gatewayUrl('/v1/models')
    try {
      const response = await request(url, { timeoutMs })
      await response.body?.cancel?.().catch(() => {})
      return { ok: true, status: response.status, url }
    } catch (error) {
      return { ok: false, url, error: String(error?.message ?? error) }
    }
  }

  /** 后台状态：provider 列表 + 配额池 + 是否已设网关 Key。 */
  status() {
    return this.admin('/status')
  }

  /** 账号池 + 统计。 */
  accounts() {
    return this.admin('/accounts')
  }

  /** 新增账号（tokens 可以是数组或换行分隔的字符串）。 */
  addAccounts({ provider = 'zai', tokens, name } = {}) {
    return this.admin('/accounts', { method: 'POST', body: { provider, tokens, ...(name === undefined ? {} : { name }) } })
  }

  /** 删除账号。 */
  removeAccounts(ids) {
    return this.admin('/accounts', { method: 'DELETE', body: [...ids] })
  }

  /** 启用 / 禁用账号。 */
  setEnabled(id, enabled) {
    return this.admin(`/accounts/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: { enabled: enabled === true } })
  }

  /** 编辑账号（改名 / 换凭证）。 */
  editAccount(id, patch) {
    return this.admin(`/accounts/${encodeURIComponent(id)}`, { method: 'PUT', body: patch })
  }

  /** 刷新额度：全部或指定 id。 */
  refreshQuota({ ids, all = false } = {}) {
    return this.admin('/accounts/refresh', { method: 'POST', body: all ? { all: true } : { ids: [...(ids ?? [])] } })
  }

  /** 单个账号的实时额度（仅 JWT 模式支持）。 */
  refreshOne(id) {
    return this.admin(`/accounts/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
  }

  /** 后台设置（后台密码 / 网关 Key / 刷新间隔）。 */
  settings() {
    return this.admin('/settings')
  }

  /** 更新后台设置。 */
  updateSettings(patch) {
    return this.admin('/settings', { method: 'PUT', body: patch })
  }

  /** 导出账号池。 */
  exportAccounts() {
    return this.admin('/export')
  }

  /** 鉴权探针（也用来判断后台密码是否正确）。 */
  verify() {
    return this.admin('/verify')
  }
}
