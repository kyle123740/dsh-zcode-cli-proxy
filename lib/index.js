/**
 * dsh-zcode cli反代 — 把 DSH 的模型请求转交给 ZCode 客户端自带的 agent（zcode.cjs）执行。
 *
 * 本插件只保留一条通道：provider `zcode-cli` 走 GUI 同款的常驻 app-server 会话
 * （JSON-RPC over stdio，真流式）——插件把 ZCode Start Plan 账户注入 agent 并在每次
 * 请求前提供 OAuth 鉴权，模型请求直接烧 Start Plan / Coding Plan 额度。
 * 通道的实现与协议细节见 lib/app-server.js 的头部注释。
 *
 * 历史说明：本插件最初是 zcode2api（HTTP 网关 + 账号池）的 DSH 集成；2026-09-30 起
 * 网关与一次性 CLI 通道已移除 —— 需要它们的请使用原版 https://github.com/liu5269/zcode2api。
 *
 * 依赖只有 harness 自带的 peer 包，没有第三方运行时依赖。
 *
 * @module dsh-zcode-cli-proxy
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { ZcodeAppServerAdapter } from './app-server.js'

export const name = 'dsh-zcode-cli-proxy'

/** `llm` 承载模型提供方注册。 */
export const inject = ['llm']

/** 插件包目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

// ── 配置 ──────────────────────────────────────────────────────────────────────

const MODEL_MODALITIES = ['text', 'image']
const DEFAULT_MAX_TOKENS = 32768
const DEFAULT_CONTEXT_WINDOW = 200000

/**
 * ZCode 客户端自带的 CLI（zcode.cjs）候选路径。
 *
 * 为什么需要它：计划端点（zcode.z.ai/.../zcode-plan/anthropic）带阿里云无痕验证，
 * 外部 HTTP 调用（包括真实浏览器、客户端 renderer）都会被服务端判 3007/3012 拦掉；
 * 而客户端自带的这个 CLI 用的是它自己的凭证与验证码链路 —— app-server 模式实测可用。
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

/** provider `zcode-cli` 对外暴露的模型清单（Start Plan 的 GLM 系列，支持视觉输入）。 */
const DEFAULT_CLI_MODELS = [
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash (ZCode CLI)',
    contextWindow: 200000,
    maxTokens: 64000,
    inputModalities: ['text', 'image'],
  },
]

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text', 'image']),
  startPlanModelId: z.string()
    .description('该条目映射到的 Start Plan 执行模型（GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo）；缺省 = GLM-5.3-Flash'),
})

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关掉后不注册模型提供方'),
  zcodeCliPath: z.string().default('')
    .description('ZCode 客户端自带的 zcode.cjs 路径；留空 = 自动探测 %LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs'),
  zcodeCliNode: z.string().default('node').description('运行 zcode.cjs 的 node 可执行文件'),
  zcodeCliTimeoutMs: z.number().step(1).min(5000).default(900000).description('app-server 单回合（session/send → turn 完成）的超时（毫秒）'),
  cliModels: z.array(catalogModel).default(DEFAULT_CLI_MODELS)
    .description('provider `zcode-cli` 暴露给 DSH 的模型清单；实际执行模型由 Start Plan 注入决定'),
  cliCwd: z.string().default('').description('app-server 会话的工作目录；留空 = 用户主目录'),
  injectStartPlanAccount: z.boolean().default(true)
    .description('把 Start Plan 账户注入 agent（GUI 同款）。关闭则用 agent 冷启动的默认供应商'),
  zcodeDataBaseDir: z.string().default('')
    .description('ZCode 共享凭证目录（读 Start Plan OAuth token）；留空 = 用户主目录（~/.zcode/v2/credentials.json）'),
  childEnvAllow: z.array(z.string()).default([])
    .description('额外透传给 app-server 子进程的环境变量名；默认只透传系统基础变量、ZCODE_* 与 NODE_EXTRA_CA_CERTS'),
  appServerTimeoutMs: z.number().step(1).min(5000).default(120000)
    .description('app-server 单次请求（create/subscribe/send）的超时（毫秒）'),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).description('默认 max_tokens'),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).description('默认上下文窗口'),
  retryPolicy: RetryPolicySchema,
})

/** 校验并规范化模型清单（与 dsh-llm-anthropic 保持一致的校验强度）。 */
function resolveModels(models) {
  const seen = new Set()
  return (models ?? DEFAULT_CLI_MODELS).map((model) => {
    if (typeof model.id !== 'string' || model.id.length === 0) throw new Error('zcode: 模型 id 不能为空')
    if (model.name !== undefined && model.name.length === 0) throw new Error(`zcode: 模型 "${model.id}" 的 name 不能为空`)
    if (seen.has(model.id)) throw new Error(`zcode: 模型 "${model.id}" 重复`)
    seen.add(model.id)
    const inputModalities = model.inputModalities ?? ['text', 'image']
    if (inputModalities.length === 0) throw new Error(`zcode: 模型 "${model.id}" 的 inputModalities 不能为空`)
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: [...inputModalities],
      ...(model.startPlanModelId === undefined || model.startPlanModelId === ''
        ? {} : { startPlanModelId: model.startPlanModelId }),
    }
  })
}

/** 把 Config 解析成一份运行期只读配置；非法值直接抛错。 */
export function resolveOptions(config) {
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('zcode: defaultContextWindow 必须是正整数')
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('zcode: maxTokens 必须是正整数')
  }
  const zcodeCliTimeoutMs = config.zcodeCliTimeoutMs ?? 900000
  if (!Number.isSafeInteger(zcodeCliTimeoutMs) || zcodeCliTimeoutMs < 5000) {
    throw new Error('zcode: zcodeCliTimeoutMs 必须是不小于 5000 的整数')
  }

  return {
    enabled: config.enabled !== false,
    zcodeCliPath: (() => {
      const configured = (config.zcodeCliPath ?? '').trim()
      if (configured !== '') return configured
      return ZCODE_CLI_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? ''
    })(),
    zcodeCliNode: (config.zcodeCliNode ?? 'node').trim() || 'node',
    zcodeCliTimeoutMs,
    cliModels: resolveModels(config.cliModels),
    cliCwd: (config.cliCwd ?? '').trim(),
    injectStartPlanAccount: config.injectStartPlanAccount !== false,
    zcodeDataBaseDir: (config.zcodeDataBaseDir ?? '').trim(),
    childEnvAllow: Array.isArray(config.childEnvAllow)
      ? config.childEnvAllow.filter((key) => typeof key === 'string' && key.trim() !== '')
      : [],
    appServerTimeoutMs: config.appServerTimeoutMs ?? 120000,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'zcode: retryPolicy'),
  }
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
      logger.error?.('zcode: 配置非法，继续使用上一份可用配置')
      logger.error?.(error)
      return lastGood
    }
  }
  options()

  const adapter = new ZcodeAppServerAdapter({
    options,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    logger,
  })

  // ── 模型提供方 ──────────────────────────────────────────────────────────────
  const entryNs = ctx.fiber?.entry?.options?.id ?? name

  ctx.effect(() => () => {
    if (typeof adapter.dispose === 'function') adapter.dispose()
  }, 'zcode-cli: app-server client')

  if (options().enabled) {
    if (options().zcodeCliPath !== '') {
      ctx.llm.registerConfigurableProviders([{
        provider: 'zcode-cli',
        displayName: 'ZCode Start Plan（客户端反代）',
        settingsNs: entryNs,
        settingsPath: [],
      }])
      ctx.llm.registerAdapter(['zcode-cli'], adapter)
      logger.info?.(`zcode: provider "zcode-cli" 已注册（app-server Start Plan 通道），模型=${options().cliModels.map((model) => model.id).join('/')}`)
    } else {
      logger.warn?.('zcode: 没探测到 ZCode CLI，provider "zcode-cli" 未注册（可用配置项 zcodeCliPath 指定）')
    }
  }

  logger.info?.(`zcode: 已加载，provider="zcode-cli"（Start Plan 反代），模型=${options().cliModels.map((model) => model.id).join('/')}`)
}

export { ZcodeAppServerAdapter }
export default { name, inject, Config, apply }
