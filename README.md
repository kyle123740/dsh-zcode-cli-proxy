# dsh-zcode cli反代（dsh-zcode-cli-proxy）

把 **DeepSeek Harness（DSH）** 的模型请求转交给 ZCode 客户端自带的 agent 执行的本地插件：
provider `zcode-cli` 走 GUI 同款的常驻 app-server 会话，插件把 ZCode **Start Plan** 账户注入 agent
并在每次请求前提供 OAuth 鉴权 —— **直接烧 ZCode Start Plan / Coding Plan 的额度**，
无需任何 API Key，也不需要自建网关。

仓库：<https://github.com/kyle123740/dsh-zcode-cli-proxy>

> **原 zcode2api 网关已移除（2026-09-30）**：本插件最初是
> [liu5269/zcode2api](https://github.com/liu5269/zcode2api)（ZCode 额度 → Anthropic Messages API
> 网关 + 账号池）的 DSH 集成。网关、账号池工具与一次性 CLI 通道已从本插件删除；
> 需要那些功能的请直接使用原版 zcode2api。

```
DSH Agent ──► provider "zcode-cli" ──► ZcodeAppServerAdapter
                                            │  spawn zcode.cjs app-server --stdio（常驻）
                                            ├─ provider/updateAccountConfig   注入 Start Plan 账户
                                            ├─ session/setModel               切到 Start Plan
                                            ├─ session/send                   发回合（真流式）
                                            └─ interaction/requestProviderRuntimeHeaders  回 OAuth 鉴权
                                                  └──► zcode.z.ai/api/v1/zcode-plan/anthropic
```

## 用法

DSH 设置 → 模型（Models）→ 提供方 **ZCode Start Plan（客户端反代）** → 模型 `GLM-5.3-Flash (ZCode CLI)`。
选中后 DSH 的模型请求会交给常驻的 ZCode app-server 执行，**烧的是你 ZCode 账号的 Start Plan 额度**
（执行渠道实测为 `account:zai-start-plan/GLM-5.3-Flash @ https://zcode.z.ai/api/v1/zcode-plan/anthropic`）。

- 真流式（text/reasoning delta 直接转发）、工具调用、图片输入（图片以本地文件随消息附上，agent 用 Read 读图）
- 多轮会话按 DSH 的 sessionId 复用 app-server 会话
- 会话标题这类辅助调用在本地生成，不消耗额度
- 前置条件：本机装着 ZCode 客户端（自动探测 `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`），
  且客户端已登录拥有 Start Plan 额度的账号

## 安全须知（装之前必读）

这个「模型提供方」的真身是一个**以你当前用户权限运行、且带全套工具执行能力的 agent**：

- 插件建会话时把权限模式切到 `yolo`，并对 agent 的每一次 `interaction/requestPermission`
  自动回 `allow` —— agent 执行 Bash、读写文件、联网等操作**不会弹任何确认**。
- agent 的输入是 DSH 拍平后的整段对话（含网页抓取、工具结果等外部内容）。这些内容里若被
  塞入注入指令，agent 可能据此执行命令 —— 请只在可信场景使用，不要把不可信网页内容喂进
  挂着本插件的会话。
- 子进程环境变量按白名单透传（系统基础变量、`ZCODE_*`、`NODE_EXTRA_CA_CERTS`），不继承
  DSH 宿主的全部 env；确有需要可用配置项 `childEnvAllow` 追加变量名。
- 鉴权 token（`zcodejwttoken`）只经本机 stdio JSON-RPC 交给 agent 进程，不发往任何第三方。

## 通道原理（2026-09-30 逆向打通，全部实测）

1. spawn `zcode app-server` 时按 GUI 同款设置 `ZCODE_APP_VERSION` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
   `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BASE_URL`（否则 CLI 落在 0.0.0-dev 目录，注入对不上）；
2. `provider/updateAccountConfig` 注入 `account:zai-start-plan`（entitled）。**关键坑**：
   `basedOnZCodeBuiltinRevision` 必须逐字符等于 configSource 的
   `zcode-builtin:<revision>:<sha256(activeFilePath)>`，否则 registry 合并循环**静默跳过**（不报错）；
3. `session/setModel`（0.16.9 起要求对象式 `{providerId, modelId, options:{reasoningLevel}}`，level 必填，GUI 用 max）；
4. agent 发模型请求前回调 `interaction/requestProviderRuntimeHeaders` 要鉴权 —— 回共享凭证里的
   **`zcodejwttoken`**（`oauth:zai:access_token` 已过期，回它上游 401）。agent 自己算 coding-plan 请求签名，能过 WAF；
5. `session/event` 的事件类型在 **params.type 顶层**（不是 payload.type），`turn.failed` 也要处理，
   `replayState` 里不能有 `undefined` 字段（lossless JSON 校验会炸）。

> HTTP 直连计划端点会被阿里云无痕验证拦（3007/3012）——只有 agent 二进制自己发的签名请求能过，
> 所以「反代」的形态是托管 agent 进程而不是自建 HTTP 网关。

## 回合锁与自愈

app-server **一个会话同时只允许一个在途回合**。上一轮被中止 / 超时 / 静默丢弃时它不会自己释放，
下一轮 `session/send` 就被拒成 `A prompt is already running for this session`（DSH 里显示成
「本轮运行失败 · PROVIDER」，因为文案是逐字透传上游的 JSON-RPC 错误）。通道层做六件事兜底：

1. **补发 `session/stop`**：本轮只要没正常结束（超时 / 被中止 / 发送失败 / `turn.failed`），
   生成器 `finally` 一定补一刀，不把锁留给下一轮；
2. **撞锁自愈**：`send` 被回「already running」→ 补 stop → 等 1.5s → 原会话重试一次；
   被回「session … not found」（会话被回收 / 进程重启）→ 丢弃缓存条目、新建会话，
   `firstTurn` 语义自动重放整段对话，历史不丢；
3. **回合串行化**：同一 DSH 会话的两轮排队跑（最多等 60s，超时放行交给 2 处理），
   并发请求不再直接撞错；
4. **进程退出即作废 + 快败**：app-server 子进程退出（含 spawn 失败）时清空会话映射，
   避免下一轮拿悬空 sessionId 去发；**在途的流会立刻收到一个回合失败收尾**，
   不用干等回合超时（默认 15 分钟）；spawn 的 `error` 事件也接住了，不会打挂宿主。
5. **会话分叉检测**：每轮 send 都记录当时的消息列表指纹；下一轮续接前先比对前缀，
   DSH 侧编辑 / 回退过历史就重建会话、按首轮语义重放新分支，避免模型看着旧历史答新问题。
6. **模型映射**：DSH 选中的模型 id 经 `cliModels[].startPlanModelId` 映射到真实的
   Start Plan 执行模型；同一会话中途换模型时在原会话上重发 `session/setModel`。

回归验证（不需要真 ZCode 客户端与额度，跑的是假 app-server）：

```
node test\turn-lock.mjs        # 撞锁自愈 / 串行化 / 中止补刀 / 重启作废 / 会话失效重放 / 退出快败 / 分叉重建
```

## 配置（设置 → 插件）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `zcodeCliPath` | 自动探测 | ZCode 客户端自带的 zcode.cjs 路径 |
| `zcodeCliNode` | `node` | 运行 zcode.cjs 的 node 可执行文件 |
| `cliModels` | `glm-5.3-flash` | provider `zcode-cli` 暴露给 DSH 的模型清单；`startPlanModelId` 字段把条目映射到真实的 Start Plan 执行模型（缺省 `GLM-5.3-Flash`） |
| `cliCwd` | 空 | app-server 会话的工作目录；留空 = 用户主目录 |
| `injectStartPlanAccount` | `true` | 把 Start Plan 账户注入 agent（GUI 同款） |
| `zcodeDataBaseDir` | 空 | ZCode 共享凭证目录（读 `zcodejwttoken`）；留空 = 用户主目录 |
| `childEnvAllow` | `[]` | 额外透传给 app-server 子进程的环境变量名（默认只透传系统基础变量、`ZCODE_*` 与 `NODE_EXTRA_CA_CERTS`） |
| `appServerTimeoutMs` | `120000` | app-server 单次请求超时（毫秒） |
| `zcodeCliTimeoutMs` | `900000` | app-server 单回合超时（毫秒） |

## 开发：改了代码怎么生效

**桌面版**（`C:\Users\zy\.dsh\profiles\desktop`，bundle 以 `link:` 挂载）：
没有热重载，改完 `lib\*.js` 后**重启 DeepSeek Harness** 即生效。

**网页版 / file:// 装配**：DSH 的 loader 只在**行 name 变化**时重新 import 插件模块，
而 Node ESM 以完整 URL（含查询串）为缓存键。仓库里的 `cordis.patch.yml` 写的是包名
`dsh-zcode-cli-proxy`（npm / link: 装配的正确形态）；本地目录式开发装配时把它换成
file:// URL 加 `?v=N`：

```yaml
# cordis.patch.yml（仅本地开发，勿提交）
- insert:
    - id: zcode2api
      name: 'file:///E:/ai/dsh/plugins/dsh-zcode-cli-proxy/lib/index.js?v=N'
```

改完 `lib\*.js` 后：把 `?v=N` 递增，然后在插件管理里对 bundle
**禁用 → 启用**（或重启 DSH），新代码即生效。
（重启 DSH 永远有效；忘记 bump 版本号则只会重跑旧代码。）

## 目录结构

```
lib/index.js        插件装配：Config schema、provider 注册
lib/app-server.js   app-server 通道：JSON-RPC 客户端 + LlmAdapter（Start Plan 注入/鉴权/事件流）
lib/messages.js     共用消息工具：图片落盘、对话拍平
lib/credentials.js  解密 ~/.zcode/v2/credentials.json，取 Start Plan token
scripts/            Start Plan 通道的逆向探测脚本（probe-*.cjs）
test/               app-server 通道与凭证解密的验证脚本
                    turn-lock.mjs + fake-app-server.cjs：回合锁自愈的回归测试
```

## 许可

AGPL-3.0。本插件的 app-server 通道实现独立于上游，仅将
[liu5269/zcode2api](https://github.com/liu5269/zcode2api) 作为历史来源致谢；
上游代码已不再随本仓库分发，其本身遵循 AGPL-3.0，仅限学习、研究、个人实验用途。
