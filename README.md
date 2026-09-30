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

## 配置（设置 → 插件）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `zcodeCliPath` | 自动探测 | ZCode 客户端自带的 zcode.cjs 路径 |
| `zcodeCliNode` | `node` | 运行 zcode.cjs 的 node 可执行文件 |
| `cliModels` | `glm-5.3-flash` | provider `zcode-cli` 暴露给 DSH 的模型清单 |
| `cliCwd` | 空 | app-server 会话的工作目录；留空 = 用户主目录 |
| `injectStartPlanAccount` | `true` | 把 Start Plan 账户注入 agent（GUI 同款） |
| `zcodeDataBaseDir` | 空 | ZCode 共享凭证目录（读 `zcodejwttoken`）；留空 = 用户主目录 |
| `appServerTimeoutMs` | `120000` | app-server 单次请求超时（毫秒） |
| `zcodeCliTimeoutMs` | `900000` | app-server 单回合超时（毫秒） |

## 开发：改了代码怎么生效

**桌面版**（`C:\Users\zy\.dsh\profiles\desktop`，bundle 以 `link:` 挂载）：
没有热重载，改完 `lib\*.js` 后**重启 DeepSeek Harness** 即生效。

**网页版 / file:// 装配**：DSH 的 loader 只在**行 name 变化**时重新 import 插件模块，
而 Node ESM 以完整 URL（含查询串）为缓存键。用 `cordis.patch.yml` 里的 `?v=N` 解决：

```yaml
# cordis.patch.yml
- insert:
    - id: zcode2api
      name: 'file:///E:/ai/dsh/plugins/dsh-zcode2api/lib/index.js?v=10'
```

改完 `lib\*.js` 后：把 `?v=10` 改成 `?v=11`，然后在插件管理里对 bundle
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
```

## 许可

AGPL-3.0。本插件的 app-server 通道实现独立于上游，仅将
[liu5269/zcode2api](https://github.com/liu5269/zcode2api) 作为历史来源致谢；
上游代码已不再随本仓库分发，其本身遵循 AGPL-3.0，仅限学习、研究、个人实验用途。
