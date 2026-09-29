/**
 * dsh-zcode2api — 把 zcode2api 装进 DeepSeek Harness 的插件（Host 半边）。
 *
 * 这个插件解决的问题是：zcode2api 本身是个独立的 Python 网关，装好了也只是
 * 一个跑在 3000 端口的服务；DSH 既不知道它的存在，也不会去管它的死活。
 * 插件把两者缝在一起：
 *
 *   1. **模型提供方**：注册 provider `zcode2api`，把网关的 Anthropic Messages
 *      端点接进 harness 的 LLM 服务 —— ZCode 的模型因此直接出现在 DSH 的模型
 *      选择器里，可以像内置模型一样被 Agent 使用（含流式、工具调用、思考块）。
 *   2. **生命周期**：按配置自动拉起 / 停止 / 重启网关进程，意外退出按退避重启，
 *      端口上已有健康实例时借用而不接管。
 *   3. **运维工具**：`zcode2api_status` / `zcode2api_accounts` / `zcode2api_quota`
 *      / `zcode2api_gateway` 四个工具，让 Agent（也就是你）直接查看账号池、
 *      加号、刷额度、看日志，不必切到浏览器。
 *   4. **运行时装配**：内置上游源码于 vendor/zcode2api，Python venv 与 Node
 *      求解器依赖由 scripts/setup.ps1 一次性装好。
 *
 * 依赖只有 harness 自带的 peer 包，没有第三方运行时依赖。
 *
 * @module dsh-zcode2api
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { Zcode2ApiAdapter } from './anthropic-adapter.js'
import { ZcodeAppServerAdapter } from './app-server.js'
import { ZcodeCliAdapter } from './cli-provider.js'
import { GatewayClient } from './gateway-client.js'
import { GATEWAY_STATE, GatewaySupervisor } from './supervisor.js'

export const name = 'zcode2api'

/**
 * `llm` 是这个插件存在的理由；`tools` 承载运维工具。
 * 其余设施（credentials / attachments）通过 ctx.get() 可选获取，缺了只降级不报错。
 */
export const inject = ['llm', 'tools']

/** 插件包目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/** harness 家目录：优先 DSH_HOME，其次 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

// ── 配置 ──────────────────────────────────────────────────────────────────────

const MODEL_MODALITIES = ['text', 'image']
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_PORT = 3000
const DEFAULT_MAX_TOKENS = 32768
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_THINKING_BUDGET_TOKENS = 8192
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000

/**
 * ZCode 客户端自带的 CLI（zcode.cjs）候选路径。
 *
 * 为什么需要它：计划端点（zcode.z.ai/.../zcode-plan/anthropic）带阿里云无痕验证，
 * 外部 HTTP 调用（包括真实浏览器、客户端 renderer）都会被服务端判 3007/3012 拦掉；
 * 而客户端自带的这个 CLI 用的是它自己的凭证与验证码链路 —— 实测 `-p` 能正常出结果。
 * 于是「让 DSH 用 ZCode 额度」的正解是把任务转交给这个 CLI，而不是自己发 HTTP。
 */
const ZCODE_CLI_CANDIDATES = [
  process.env.ZCODE_CLI_PATH,
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
    : undefined,
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs') : undefined,
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  '/opt/ZCode/resources/glm/zcode.cjs',
].filter((candidate) => typeof candidate === 'string' && candidate !== '')
/**
 * 网关对外公布的模型（app/routes/gateway.py 的 AVAILABLE_MODELS）。
 * 大小写敏感，必须与上游一致。`glm-5-turbo` / `glm-5.1` / `glm-4.7` 等别名
 * 由网关自己映射，想用就在这里加一行。
 */
const DEFAULT_MODELS = [
  { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text'] },
  { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo', contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text'] },
]

/** CLI 委派通道（provider `zcode-cli`）对外暴露的模型：就是 CLI 会话当前使用的模型。 */
const DEFAULT_CLI_MODELS = [
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash (ZCode CLI)',
    contextWindow: 200000,
    maxTokens: 64000,
    inputModalities: ['text'],
  },
]

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
})

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关掉后不注册模型、也不管进程'),
  autoStart: z.boolean().default(false)
    .description('DSH 启动时自动拉起 HTTP 网关。默认关闭——JWT 账号的直连被上游验证码拦住，' +
      '主力通道是 zcode_cli（不需要网关）；有 API Key 账号时再打开'),
  manageProcess: z.boolean().default(true).description('允许插件启动/停止网关进程（关闭则只连接到已有实例）'),
  restartOnExit: z.boolean().default(true).description('网关意外退出时自动重启'),
  maxRestarts: z.number().step(1).min(0).default(5).description('连续自动重启次数上限'),
  host: z.string().default('127.0.0.1').description('网关监听地址'),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT).description('网关端口'),
  adminKey: z.string().default('zcode').description('后台管理密码（首次启动写入网关数据库，之后以数据库为准）'),
  gatewayKeyEnv: z.string().role('credential-ref').default('ZCODE2API_GATEWAY_KEY')
    .description('网关 API Key 的凭证引用；留空/未设置表示网关不校验（默认）'),
  gatewayKey: z.string().default('').description('网关 API Key 明文（不想用凭证服务时直接填）'),
  pythonPath: z.string().default('').description('Python 解释器；留空 = 用 <runtimeHome>/venv 里的那个'),
  projectDir: z.string().default('').description('zcode2api 源码目录；留空 = 插件内置的 vendor/zcode2api'),
  runtimeHome: z.string().default('').description('运行时目录（venv/data/logs）；留空 = <DSH_HOME>/zcode2api'),
  dataDir: z.string().default('').description('账号数据库目录；留空 = <runtimeHome>/data'),
  nodePath: z.string().default('node').description('无痕验证求解器使用的 node 可执行文件'),
  quotaRefreshInterval: z.number().step(1).min(0).default(60).description('网关后台刷新账号额度的间隔（秒），0 关闭'),
  coolingSeconds: z.number().step(1).min(0).default(300).description('上游 429 后的冷却时长（秒）'),
  startTimeoutMs: z.number().step(1).min(1000).default(90000).description('等待网关就绪的超时（毫秒）'),
  models: z.array(catalogModel).default(DEFAULT_MODELS).description('暴露给 DSH 的模型清单'),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).description('默认 max_tokens'),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).description('默认上下文窗口'),
  thinking: z.union(['enabled', 'disabled']).default('disabled').description('是否请求 thinking 块（网关/上游支持时才有意义）'),
  thinkingBudgetTokens: z.number().step(1).min(1024).default(DEFAULT_THINKING_BUDGET_TOKENS),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).description('流式响应空闲超时（毫秒）'),
  retryPolicy: RetryPolicySchema,
  zcodeCliPath: z.string().default('')
    .description('ZCode 客户端自带的 zcode.cjs 路径；留空 = 自动探测 %LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs'),
  zcodeCliNode: z.string().default('node').description('运行 zcode.cjs 的 node 可执行文件'),
  zcodeCliMode: z.union(['build', 'edit', 'plan', 'yolo']).default('yolo')
    .description('转交任务给 CLI 时的权限模式（--mode）；yolo = 不打断地自动执行'),
  zcodeCliTimeoutMs: z.number().step(1).min(5000).default(900000).description('单次 CLI 转交的超时（毫秒）'),
  cliModels: z.array(catalogModel).default(DEFAULT_CLI_MODELS)
    .description('CLI 通道（provider `zcode-cli`）暴露给 DSH 的模型；CLI 不支持 --model，实际模型取决于客户端会话'),
  cliCwd: z.string().default('').description('CLI 委派时的工作目录；留空 = DSH 进程当前目录'),
  useAppServer: z.boolean().default(false)
    .description('实验性：用常驻 zcode app-server（JSON-RPC，真流式）代替一次性 CLI 调用。' +
      '协议已完整逆向（见 scripts/probe-*.cjs），但经适配器管道回合会被上游静默吞掉，默认关闭'),
  appServerTimeoutMs: z.number().step(1).min(5000).default(120000)
    .description('app-server 单次请求（create/subscribe/send）的超时（毫秒）'),
})

/** 校验并规范化模型清单（与 dsh-llm-anthropic 保持一致的校验强度）。 */
function resolveModels(models) {
  const seen = new Set()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (typeof model.id !== 'string' || model.id.length === 0) throw new Error('zcode2api: 模型 id 不能为空')
    if (model.name !== undefined && model.name.length === 0) throw new Error(`zcode2api: 模型 "${model.id}" 的 name 不能为空`)
    if (seen.has(model.id)) throw new Error(`zcode2api: 模型 "${model.id}" 重复`)
    seen.add(model.id)
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) throw new Error(`zcode2api: 模型 "${model.id}" 的 inputModalities 不能为空`)
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: [...inputModalities],
    }
  })
}

/** 把 Config 解析成一份运行期只读配置；非法值直接抛错。 */
export function resolveOptions(config) {
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('zcode2api: defaultContextWindow 必须是正整数')
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('zcode2api: maxTokens 必须是正整数')
  }
  if (config.thinking === 'enabled' && (!Number.isInteger(config.thinkingBudgetTokens) || config.thinkingBudgetTokens < 1024)) {
    throw new Error('zcode2api: thinkingBudgetTokens 必须是不小于 1024 的整数')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error('zcode2api: streamIdleTimeoutMs 必须是正数')
  }
  const port = config.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('zcode2api: port 非法')

  const runtimeHome = (config.runtimeHome ?? '').trim() || path.join(dshHome(), 'zcode2api')
  const projectDir = (config.projectDir ?? '').trim() || path.join(PLUGIN_DIR, 'vendor', 'zcode2api')
  const dataDir = (config.dataDir ?? '').trim() || path.join(runtimeHome, 'data')
  const venvPython = process.platform === 'win32'
    ? path.join(runtimeHome, 'venv', 'Scripts', 'python.exe')
    : path.join(runtimeHome, 'venv', 'bin', 'python')
  const host = (config.host ?? '127.0.0.1').trim() || '127.0.0.1'

  return {
    enabled: config.enabled !== false,
    autoStart: config.autoStart !== false,
    manageProcess: config.manageProcess !== false,
    restartOnExit: config.restartOnExit !== false,
    maxRestarts: config.maxRestarts ?? 5,
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    adminKey: (config.adminKey ?? 'zcode').trim() || 'zcode',
    gatewayKey: (config.gatewayKey ?? '').trim(),
    gatewayKeyEnv: (config.gatewayKeyEnv ?? '').trim() || 'ZCODE2API_GATEWAY_KEY',
    pythonPath: (config.pythonPath ?? '').trim(),
    projectDir,
    pluginDir: PLUGIN_DIR,
    runtimeHome,
    dataDir,
    venvPython,
    logFile: path.join(runtimeHome, 'logs', 'gateway.log'),
    nodePath: (config.nodePath ?? 'node').trim() || 'node',
    quotaRefreshInterval: config.quotaRefreshInterval ?? 60,
    coolingSeconds: config.coolingSeconds ?? 300,
    startTimeoutMs: config.startTimeoutMs ?? 90000,
    models: resolveModels(config.models),
    anthropicVersion: ANTHROPIC_VERSION,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    thinking: config.thinking ?? 'disabled',
    thinkingBudgetTokens: config.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'zcode2api: retryPolicy'),
    zcodeCliPath: (() => {
      const configured = (config.zcodeCliPath ?? '').trim()
      if (configured !== '') return configured
      return ZCODE_CLI_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? ''
    })(),
    zcodeCliNode: (config.zcodeCliNode ?? 'node').trim() || 'node',
    zcodeCliMode: config.zcodeCliMode ?? 'yolo',
    zcodeCliTimeoutMs: config.zcodeCliTimeoutMs ?? 900000,
    cliModels: config.cliModels ?? DEFAULT_CLI_MODELS,
    cliMode: config.zcodeCliMode ?? 'yolo',
    cliCwd: (config.cliCwd ?? '').trim(),
    useAppServer: config.useAppServer !== false,
    appServerTimeoutMs: config.appServerTimeoutMs ?? 120000,
  }
}

// ── 工具结果渲染 ──────────────────────────────────────────────────────────────

/** 状态文案。 */
const STATE_LABEL = {
  [GATEWAY_STATE.STOPPED]: '未运行',
  [GATEWAY_STATE.STARTING]: '启动中',
  [GATEWAY_STATE.RUNNING]: '运行中（插件托管）',
  [GATEWAY_STATE.EXTERNAL]: '运行中（外部实例，插件未接管）',
  [GATEWAY_STATE.FAILED]: '启动失败',
  [GATEWAY_STATE.DISABLED]: '未托管',
  [GATEWAY_STATE.NEEDS_SETUP]: '缺少运行时',
}

function text(blocks) {
  return [{ type: 'text', text: blocks.join('\n') }]
}

/**
 * 工具返回值必须是 lossless JSON：丢了 undefined、把 NaN/Infinity 规整成 null，
 * 顺带保证没有类实例混进去（registry 会拒绝非平凡对象）。
 */
function lossless(value) {
  return JSON.parse(JSON.stringify(value))
}

function renderGateway(snapshot) {
  const lines = [`zcode2api 网关：${STATE_LABEL[snapshot.state] ?? snapshot.state} — ${snapshot.baseUrl}`]
  if (snapshot.pid !== undefined) lines.push(`  pid=${snapshot.pid}，已运行 ${Math.round(snapshot.uptimeMs / 1000)}s，自动重启次数 ${snapshot.restarts}`)
  lines.push(`  后台管理：${snapshot.adminUrl}`)
  lines.push(`  数据目录：${snapshot.dataDir}`)
  lines.push(`  日志文件：${snapshot.logFile}`)
  if (snapshot.lastError) lines.push(`  ⚠️ ${snapshot.lastError}`)
  return lines
}

function renderAccounts(payload) {
  const stats = payload.stats ?? {}
  const lines = [
    `账号池：共 ${stats.total ?? 0}，其中现在可参与轮询 ${stats.active ?? 0}`,
    `  状态分布：正常 ${stats.active ?? 0} / 额度用尽 ${stats.exhausted ?? 0} / 冷却 ${stats.cooling ?? 0} / 无效 ${stats.invalid ?? 0} / 禁用 ${stats.disabled ?? 0}`,
    `  累计调用 ${stats.calls ?? 0}，失败 ${stats.fail ?? 0}`,
  ]
  const accounts = payload.accounts ?? []
  for (const account of accounts) {
    const quota = Object.entries(account.quota ?? {})
      .map(([model, value]) => {
        if (value === null || typeof value !== 'object') return model
        const remaining = value.remaining ?? '?'
        const total = value.total ?? '?'
        return `${model} 剩余 ${remaining}/${total}`
      })
      .join('，')
    lines.push(
      `  - ${account.name} (${account.id}) [${account.provider}/${account.mode}]${account.enabled === false ? ' 已禁用' : ''} ` +
      `status=${account.status} 调用 ${account.use_count ?? 0} / 失败 ${account.fail_count ?? 0}${quota === '' ? '' : ` | ${quota}`}`,
    )
    if (account.last_error) lines.push(`      最近错误：${account.last_error}`)
  }
  if (accounts.length === 0) lines.push('  （账号池是空的：用 zcode2api_accounts 的 add 动作加入 Coding Plan JWT 或 API Key）')
  return lines
}

// ── apply ─────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  // 配置热更新：一次非法改动不应打挂正在跑的插件，保留上一份可用配置。
  let current = () => config
  let lastRaw
  let lastGood
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      logger.error?.('zcode2api: 配置非法，继续使用上一份可用配置')
      logger.error?.(error)
      return lastGood
    }
  }
  options()

  const client = new GatewayClient({ options, logger })
  const supervisor = new GatewaySupervisor({ options, logger })

  const resolveApiKey = async (connection) => {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(credentialRef(connection.gatewayKeyEnv))
        if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim() !== '') return hit.value.trim()
      } catch (error) {
        logger.debug?.(`zcode2api: 读取凭证 ${connection.gatewayKeyEnv} 失败（${error?.message ?? error}）`)
      }
    }
    if (connection.gatewayKey !== '') return connection.gatewayKey
    // 网关未配置 API Key 时不校验鉴权；这里给一个占位值即可（Anthropic 协议要求带头）。
    return undefined
  }

  const adapter = new Zcode2ApiAdapter({
    options,
    resolveApiKey,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
  })

  // ── 模型提供方 ──────────────────────────────────────────────────────────────
  const cliAdapter = options().useAppServer
    ? new ZcodeAppServerAdapter({ options, logger })
    : new ZcodeCliAdapter({ options, logger })
  const entryNs = ctx.fiber?.entry?.options?.id ?? name

  ctx.effect(() => () => {
    if (typeof cliAdapter.dispose === 'function') cliAdapter.dispose()
  }, 'zcode2api: app-server client')

  if (options().enabled) {
    // HTTP 网关通道（需要免验证码的 API Key 账号）
    ctx.llm.registerConfigurableProviders([{
      provider: name,
      displayName: 'ZCode (zcode2api)',
      settingsNs: entryNs,
      settingsPath: [],
    }])
    ctx.llm.registerAdapter([name], adapter)

    // CLI 委派通道（用 ZCode 客户端自己的额度，不需要网关）
    if (options().zcodeCliPath !== '') {
      ctx.llm.registerConfigurableProviders([{
        provider: 'zcode-cli',
        displayName: 'ZCode CLI（客户端 agent）',
        settingsNs: entryNs,
        settingsPath: [],
      }])
      ctx.llm.registerAdapter(['zcode-cli'], cliAdapter)
      logger.info?.(`zcode2api: CLI 通道已注册 provider "zcode-cli"，模型=${options().cliModels.map((model) => model.id).join('/')}`)
    } else {
      logger.warn?.('zcode2api: 没探测到 ZCode CLI，provider "zcode-cli" 未注册（可用配置项 zcodeCliPath 指定）')
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────────

  const ensureRunning = async (signal) => {
    if (!options().autoStart && supervisor.state === GATEWAY_STATE.STOPPED) return supervisor.snapshot()
    return supervisor.ensureRunning(signal)
  }

  /** 汇总一次“现在到底怎么样”，工具和日志共用。 */
  const collectStatus = async ({ refresh = false, signal } = {}) => {
    const snapshot = supervisor.snapshot()
    const health = await client.health()
    const result = {
      gateway: { ...snapshot, probed: health },
      models: options().models.map((model) => model.id),
      provider: name,
      accounts: undefined,
      adminError: undefined,
      hint: undefined,
    }
    if (health.ok) {
      try {
        if (refresh) await client.refreshQuota({ all: true, signal })
        const payload = await client.accounts()
        result.accounts = payload
      } catch (error) {
        result.adminError = String(error?.message ?? error)
      }
    } else {
      result.hint = snapshot.state === GATEWAY_STATE.NEEDS_SETUP || snapshot.state === GATEWAY_STATE.FAILED
        ? `网关没起来。${snapshot.lastError || ''}`
        : '网关没有响应：用 zcode2api_gateway 的 start 动作拉起它，或检查配置里的 host/port。'
    }
    return result
  }

  ctx.tools.register(defineTool({
    name: 'zcode2api_status',
    description: '查看 zcode2api 网关与账号池状态：进程是否在跑、端口/日志位置、可用模型、每个账号的状态与剩余额度。' +
      '装好 zcode2api 插件后想知道“现在能不能用 ZCode 模型”就用它。',
    parameters: {
      refresh: { type: 'boolean', description: '顺手刷新一次各账号的实时额度（会访问上游，稍慢）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const lines = [...renderGateway(value.gateway)]
        lines.push(`  探活：${value.gateway.probed?.ok ? `正常（HTTP ${value.gateway.probed.status}）` : `失败（${value.gateway.probed?.error ?? '未知'}）`}`)
        lines.push(`  可用模型：${(value.models ?? []).join(', ') || '（无）'}`)
        if (value.accounts !== undefined) lines.push('', ...renderAccounts(value.accounts))
        if (value.adminError !== undefined) lines.push(`  ⚠️ 后台 API 读取失败：${value.adminError}`)
        if (value.hint !== undefined) lines.push(`  💡 ${value.hint}`)
        return text(lines)
      },
    },
    timeoutMs: 30000,
    execute: async (args, exec) => lossless(await collectStatus({ refresh: args.refresh === true, signal: exec?.signal })),
  }))

  ctx.tools.register(defineTool({
    name: 'zcode2api_gateway',
    description: '控制 zcode2api 网关进程：start（拉起或借用已有实例）、stop、restart、logs（看网关日志尾部）。' +
      '改完插件配置、换了端口、或者模型请求报“网关请求失败”时用它。',
    parameters: {
      action: { type: 'string', required: true, description: 'start | stop | restart | logs' },
      lines: { type: 'number', description: 'logs 动作返回的日志行数（默认 80）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.logs === undefined
        ? text([...renderGateway(value.gateway)])
        : text([`zcode2api 网关日志（${value.gateway.logFile}，最后 ${value.lines} 行）：`, '', value.logs]),
    },
    timeoutMs: 120000,
    execute: async (args) => {
      const action = String(args.action ?? '').trim().toLowerCase()
      switch (action) {
        case 'start': {
          await ensureRunning()
          return lossless({ gateway: supervisor.snapshot(), action })
        }
        case 'stop': {
          await supervisor.stop({ reason: 'tool request' })
          return lossless({ gateway: supervisor.snapshot(), action })
        }
        case 'restart': {
          await supervisor.restart()
          return lossless({ gateway: supervisor.snapshot(), action })
        }
        case 'logs': {
          const lines = Math.max(1, Math.min(Number(args.lines ?? 80) || 80, 1000))
          return lossless({ gateway: supervisor.snapshot(), action, lines, logs: supervisor.tailLines(lines) })
        }
        default:
          throw new Error(`未知动作 "${args.action}"；可用：start | stop | restart | logs`)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zcode2api_accounts',
    description: '管理 zcode2api 账号池：list（列出账号与状态）、add（加入 Coding Plan JWT 或 API Key，支持多行批量）、' +
      'remove（按 id 删除）、enable / disable（启停单个账号）。JWT 形如三段点分令牌，API Key 走 api.z.ai 回退端点。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add | remove | enable | disable' },
      tokens: { type: 'string', description: 'add：凭证本身，多个用换行分隔' },
      provider: { type: 'string', description: 'add：zai（默认）或 bigmodel' },
      name: { type: 'string', description: 'add：账号备注名（可选）' },
      ids: { type: 'string', description: 'remove/enable/disable：账号 id，多个用逗号分隔' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const lines = []
        if (value.action === 'add') lines.push(`已加入 ${value.added?.count ?? 0} 个账号：${(value.added?.ids ?? []).join(', ')}`)
        if (value.action === 'remove') lines.push(`已删除 ${value.removed?.deleted ?? 0} 个账号`)
        if (value.action === 'enable' || value.action === 'disable') lines.push(`已${value.action === 'enable' ? '启用' : '禁用'} ${(value.ids ?? []).join(', ')}`)
        lines.push('', ...renderAccounts(value.accounts))
        return text(lines)
      },
    },
    timeoutMs: 60000,
    execute: async (args, exec) => {
      const action = String(args.action ?? '').trim().toLowerCase()
      const ids = String(args.ids ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '')
      await ensureRunning()
      let added
      let removed
      switch (action) {
        case 'list':
          break
        case 'add': {
          const tokens = String(args.tokens ?? '').split(/\r?\n/).map((value) => value.trim()).filter((value) => value !== '')
          if (tokens.length === 0) throw new Error('add 动作需要 tokens（每行一个 JWT / API Key）')
          added = await client.addAccounts({
            provider: args.provider === undefined ? 'zai' : String(args.provider),
            tokens,
            ...(args.name === undefined ? {} : { name: String(args.name) }),
          })
          break
        }
        case 'remove': {
          if (ids.length === 0) throw new Error('remove 动作需要 ids（逗号分隔）')
          removed = await client.removeAccounts(ids)
          break
        }
        case 'enable':
        case 'disable': {
          if (ids.length === 0) throw new Error(`${action} 动作需要 ids（逗号分隔）`)
          for (const id of ids) await client.setEnabled(id, action === 'enable')
          break
        }
        default:
          throw new Error(`未知动作 "${args.action}"；可用：list | add | remove | enable | disable`)
      }
      const accounts = await client.accounts()
      return lossless({ action, ids, ...(added === undefined ? {} : { added }), ...(removed === undefined ? {} : { removed }), accounts })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zcode2api_quota',
    description: '查询 zcode2api 账号池的实时额度：默认刷新全部 Coding Plan（JWT）账号并汇总剩余额度、状态与错误。' +
      '想知道“这个号还能用多久”“哪个号快用完了”就用它。',
    parameters: {
      ids: { type: 'string', description: '只刷新这些账号 id（逗号分隔）；留空表示全部' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const lines = [`额度刷新：${value.refresh?.count ?? 0} 个账号`, JSON.stringify(value.refresh?.summary ?? {}, null, 2)]
        lines.push('', ...renderAccounts(value.accounts))
        return text(lines)
      },
    },
    timeoutMs: 120000,
    execute: async (args, exec) => {
      const ids = String(args.ids ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '')
      await ensureRunning()
      const refresh = await client.refreshQuota(ids.length > 0 ? { ids } : { all: true, signal: exec?.signal })
      const accounts = await client.accounts()
      return lossless({ refresh, accounts })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_cli',
    description: '把任务转交给本机 ZCode 客户端自带的 CLI（zcode.cjs）执行 —— 走的是 ZCode 账号自己的凭证与' +
      '验证码链路，因此能真正用上 Start Plan/Coding Plan 额度（HTTP 直连会被上游风控 3007/3012 拦掉）。' +
      'CLI 本身是一个 agent，会在指定工作目录里用自带工具读写文件；返回最终答复、sessionId（可用 resume 续接）和 token 用量。' +
      '适合把「需要 ZCode 额度/GLM 模型」的活整体外包出去。',
    parameters: {
      prompt: { type: 'string', required: true, description: '交给 ZCode agent 的任务描述' },
      cwd: { type: 'string', description: '工作目录（建议显式传入，默认为 DSH 进程的当前目录）' },
      mode: { type: 'string', description: 'build | edit | plan | yolo（默认取插件配置，出厂 yolo）' },
      resume: { type: 'string', description: '续接已有会话的 sessionId（sess_…，来自上一次返回）' },
      extraArgs: { type: 'string', description: '追加的 CLI 参数（空格分隔，可选）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const lines = [`ZCode CLI（${value.model ?? '默认模型'}）返回：`, '', value.response ?? '(空响应)']
        const usage = value.usage ?? {}
        lines.push(
          '',
          `— 会话 ${value.sessionId ?? '(无)'}｜输入 ${usage.inputTokens ?? '?'} / 输出 ${usage.outputTokens ?? '?'} tokens` +
          `（缓存命中 ${usage.cacheReadTokens ?? 0}）｜用时 ${Math.round((value.elapsedMs ?? 0) / 1000)}s`,
        )
        if (value.warning) lines.push(`⚠️ ${value.warning}`)
        return text(lines)
      },
    },
    timeoutMs: 960000,
    execute: async (args) => {
      const o = options()
      if (o.zcodeCliPath === '' || !fs.existsSync(o.zcodeCliPath)) {
        throw new Error(
          `找不到 ZCode CLI（配置项 zcodeCliPath，当前值 "${o.zcodeCliPath}"）。` +
          `它随 ZCode 客户端安装，通常位于 %LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs`,
        )
      }
      const prompt = String(args.prompt ?? '').trim()
      if (prompt === '') throw new Error('prompt 不能为空')
      const mode = String(args.mode ?? o.zcodeCliMode)
      const cwd = String(args.cwd ?? '').trim() || process.cwd()
      if (!fs.existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`)

      const cliArgs = [o.zcodeCliPath, '-p', prompt, '--json', '--surface', 'terminal', '--no-color', '--mode', mode, '--cwd', cwd]
      if (args.resume !== undefined && String(args.resume).trim() !== '') cliArgs.push('--resume', String(args.resume).trim())
      if (args.extraArgs !== undefined && String(args.extraArgs).trim() !== '') {
        cliArgs.push(...String(args.extraArgs).trim().split(/\s+/))
      }

      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE // 否则 Electron 系二进制会退化成 Node

      const started = Date.now()
      const result = await new Promise((resolve, reject) => {
        const child = spawn(o.zcodeCliNode, cliArgs, { cwd, env, windowsHide: true })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {}
          reject(new Error(`zcode_cli 超时（${o.zcodeCliTimeoutMs}ms）`))
        }, o.zcodeCliTimeoutMs)
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(new Error(`无法启动 node（${o.zcodeCliNode}）：${error.message}`))
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          const text = stdout.trim()
          const start = text.indexOf('{')
          if (start === -1) {
            reject(new Error(`zcode_cli 没有输出 JSON（退出码 ${code}）：${(stderr || text).slice(0, 400)}`))
            return
          }
          let parsed
          try {
            parsed = JSON.parse(text.slice(start))
          } catch (error) {
            reject(new Error(`zcode_cli 输出不是合法 JSON：${text.slice(0, 300)}`))
            return
          }
          resolve({ code, parsed, stderr: stderr.trim(), elapsedMs: Date.now() - started })
        })
      })

      const warning = /built-in (missing|skipped)/i.test(result.stderr) ? result.stderr.split('\n')[0] : ''
      return lossless({
        response: result.parsed.response ?? '',
        sessionId: result.parsed.sessionId,
        turnId: result.parsed.turnId,
        usage: result.parsed.usage,
        projection: result.parsed.projection,
        mode,
        cwd,
        exitCode: result.code,
        elapsedMs: result.elapsedMs,
        warning,
      })
    },
  }))

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  ctx.effect(() => () => {
    void supervisor.dispose()
  }, 'zcode2api: gateway process')

  ctx.effect(() => {
    if (!options().enabled || !options().autoStart) {
      logger.info?.('zcode2api: 未启用自动启动（enabled/autoStart 为 false）')
      return
    }
    void ensureRunning()
      .then((snapshot) => {
        if (snapshot.ready) {
          logger.info?.(`zcode2api: 网关就绪 ${snapshot.baseUrl}（provider "${name}" 已注册 ${options().models.length} 个模型）`)
        } else {
          logger.warn?.(`zcode2api: 网关未就绪（${snapshot.state}）${snapshot.lastError === '' ? '' : `：${snapshot.lastError}`}`)
        }
      })
      .catch((error) => logger.error?.(`zcode2api: 启动网关失败（${error?.message ?? error}）`))
  }, 'zcode2api: autostart')

  logger.info?.(`zcode2api: 已加载，provider="${name}"，模型=${options().models.map((model) => model.id).join('/')}，网关=${options().baseUrl}`)
}

export { GATEWAY_STATE, GatewayClient, GatewaySupervisor, Zcode2ApiAdapter, dshHome }
export default { name, inject, Config, apply }
