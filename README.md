# dsh-zcode cli反代（dsh-zcode-cli-proxy）

把 [zcode2api](https://github.com/liu5269/zcode2api)（ZCode Coding Plan 额度 → Anthropic Messages API 网关）
装进 **DeepSeek Harness** 的本地插件：内置上游源码、自动装配 Python 运行时、托管网关进程，
并把网关注册成 DSH 的模型提供方 —— **ZCode 的模型（GLM-5.2 / GLM-5-Turbo）直接出现在模型选择器里**，
外加四个运维工具让你在对话里管理账号池、额度和网关。

**主通道（推荐，默认开启）**：`zcode-cli` 提供方走 GUI 同款的 app-server 常驻会话 ——
插件注入 Start Plan 账户（entitled）+ 每次请求前提供 OAuth 鉴权，直接烧 ZCode Coding Plan / Start Plan
的额度（真流式、图片输入、会话复用，无需任何 API Key）。HTTP 网关通道保留给有免验证 API Key 账号的场景。

仓库：<https://github.com/kyle123740/dsh-zcode-cli-proxy>

```
DSH Agent ──► provider "zcode2api" ──► Zcode2ApiAdapter ──► http://127.0.0.1:3000/v1/messages
     │                                                            ▲  （Anthropic Messages，SSE）
     └──► zcode2api_* 工具 ──► GatewayClient ──► /admin/api/* ────┤
                                                                  │
                              GatewaySupervisor ──► python main.py serve（子进程托管）
```

## 安装状态（本机）

| 组件 | 位置 |
|------|------|
| 插件包 | `E:\ai\dsh\plugins\dsh-zcode2api`（`link:` 进 desktop profile） |
| 上游源码 | `vendor\zcode2api`（git 副本，`origin` 指向上游） |
| Python venv | `C:\Users\zy\.dsh\zcode2api\venv`（fastapi/uvicorn/httpx） |
| 无痕验证求解器 | `vendor\zcode2api\captcha_node\node_modules`（jsdom） |
| 账号数据库 | `C:\Users\zy\.dsh\zcode2api\data\accounts.db` |
| 网关日志 | `C:\Users\zy\.dsh\zcode2api\logs\gateway.log` |
| 网关端点 | `http://127.0.0.1:3000/v1/messages` · 后台 `http://127.0.0.1:3000/admin` |

插件启用后会自动拉起网关进程；DSH 关闭时网关随插件卸载一起停止。
端口上如果已经有一个别人启动的 zcode2api，插件会**借用**它而不接管、不杀进程。

## 快速上手

1. **选模型**：DSH 设置 → 模型（Models）→ 提供方 **ZCode (zcode2api)** → 选 `GLM-5.2` 或 `GLM-5-Turbo`。
2. **加账号**（三选一）：
   - 对话里直接说“给 zcode2api 加个账号 …”，插件的 `zcode2api_accounts` 工具会完成；
   - 浏览器打开 `http://127.0.0.1:3000/admin`（默认密码 `zcode`）；
   - 命令行：`C:\Users\zy\.dsh\zcode2api\venv\Scripts\python.exe main.py add-account zai <名字> <JWT或Key>`。
3. **看额度/状态**：对话里问“zcode2api 还有多少额度”，或用 `zcode2api_status` / `zcode2api_quota`。

> Coding Plan JWT（三段点分）走 `zcode.z.ai` 上游，需要阿里云无痕验证——插件已自动装配
> Node 求解器，无需浏览器；API Key 账号走 `api.z.ai` 回退端点，不需要验证。

## 三种用法

### 用法 A：模型提供方 `zcode-cli`（在模型选择器里选它）✅ 主力通道

设置 → 模型 → 提供方 **ZCode CLI（客户端 agent）** → 模型 `GLM-5.3-Flash (ZCode CLI)`。
选中后 DSH 的模型请求会交给常驻的 ZCode app-server 执行，**烧的是你 ZCode 账号的 Start Plan 额度**
（执行渠道实测为 `account:zai-start-plan/GLM-5.3-Flash @ https://zcode.z.ai/api/v1/zcode-plan/anthropic`）。

通道由 `useAppServer`（出厂 true）控制，走 **GUI 同款 app-server 链路**（2026-09-30 逆向打通并实测）：

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

- 多轮会话按 DSH 的 sessionId 复用 app-server 会话
- 会话标题这类辅助调用在本地生成，不消耗额度

### 用法 B：`zcode_cli` 工具（把任务转交给 ZCode agent）

```
zcode_cli(prompt="重构 src/foo.ts 并跑测试", cwd="E:\\proj", mode="yolo")
```

- 返回最终答复、`sessionId`（可用 `resume` 续接）和 token 用量
- CLI 会在指定工作目录里用自带工具读写文件、执行命令 —— 适合"把整块活外包出去"
- 注意：CLI 冷启动（`-p`）的会话默认供应商来自 registry-fallback，若默认渠道（如"基源"）余额不足会 402。
  用 Start Plan 请走用法 A。

### 用法 C：HTTP 网关 + provider `zcode2api`（仅适用于 API Key 账号）

需要**免验证码的账号** —— Z.ai / BigModel 的 **API Key**（按量计费）。
JWT 类型的 Coding Plan/Start Plan 账号在当前上游版本下会被验证码拦住，**不要用它**。
网关默认**不再自动启动**（`autoStart=false`），需要时用 `zcode2api_gateway` 工具 start。

## 工具一览

| 工具 | 用途 |
|------|------|
| **`zcode_cli`** | **把任务转交给 ZCode 客户端 CLI（用法 A/B，不需要网关）** |
| `zcode2api_status` | 网关进程状态、端口、日志位置、可用模型、账号池概览（可 `refresh` 顺手刷额度） |
| `zcode2api_accounts` | 账号池管理：`list / add / remove / enable / disable`，`add` 支持多行批量 |
| `zcode2api_quota` | 刷新并汇总各账号实时额度（可按 `ids` 指定） |
| `zcode2api_gateway` | 进程控制：`start / stop / restart / logs`（看网关日志尾部） |

## 配置（设置 → 插件 → dsh-zcode2api）

常用项（完整 schema 见设置页的 Config 表单）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` / `autoStart` | `true` | 总开关 / 启动 DSH 时自动拉起网关 |
| `port` | `3000` | 网关端口（撞上 Windows 保留端口段会**快速失败**并提示换端口） |
| `adminKey` | `zcode` | 后台管理密码（首次启动写入库，之后以库为准） |
| `gatewayKey` / `gatewayKeyEnv` | 空 | 网关 API Key（明文，或走凭证服务的引用）；空 = 网关不校验 |
| `models` | `GLM-5.2`、`GLM-5-Turbo` | 暴露给 DSH 的模型清单（要与网关对外公布的模型一致） |
| `thinking` | `disabled` | 是否请求 thinking 块 |
| `runtimeHome` / `projectDir` / `dataDir` | 自动 | 运行时目录 / 源码目录 / 数据目录 |
| `useAppServer` | `true` | app-server 常驻通道（Start Plan 主路径，用法 A）。关闭则退回一次性 CLI 冷启动 |
| `injectStartPlanAccount` | `true` | app-server 通道：把 Start Plan 账户注入 agent（GUI 同款） |
| `zcodeDataBaseDir` | 空 | ZCode 共享凭证目录（读 `zcodejwttoken`）；留空 = 用户主目录 |
| `cliCwd` | 空 | CLI/app-server 委派时的工作目录；留空 = DSH 进程当前目录（app-server 会话默认用户主目录） |

## 开发：改了代码怎么生效

**桌面版**（`C:\Users\zy\.dsh\profiles\desktop`，bundle `dsh-zcode2api` 以 `link:` 挂载）：
没有热重载，改完 `lib\*.js` 后**重启 DeepSeek Harness** 即生效。

**网页版 / file:// 装配**：DSH 的 loader 只在**行 name 变化**时重新 import 插件模块，
而 Node ESM 以完整 URL（含查询串）为缓存键；profile 的 HMR 没开模块目录监视，
直接改文件不会热加载。用 `cordis.patch.yml` 里的 `?v=N` 解决：

```yaml
# cordis.patch.yml
- insert:
    - id: zcode2api
      name: 'file:///E:/ai/dsh/plugins/dsh-zcode2api/lib/index.js?v=2'
```

改完 `lib\*.js` 后：把 `?v=2` 改成 `?v=3`，然后在插件管理里对 `dsh-zcode2api`
**禁用 → 启用**（或重启 DSH），新代码即生效。
（重启 DSH 永远有效；忘记 bump 版本号则只会重跑旧代码。）

## 测试

```powershell
node test\adapter.test.mjs    # 8 项：请求序列化 / SSE 翻译 / 错误映射（mock 网关，离线）
node test\gateway.smoke.mjs   # 9 项：真进程启动、鉴权、账号池、协议、停机、端口占用快速失败
node test\tools.verify.mjs    # 5 项：四个工具输出的 lossless-JSON 校验（打真网关）
```

## 运行时维护

```powershell
# 重新装配运行时 / 安装 Python 依赖（幂等；不加 -SkipVendor 时会顺便把内置源码
# git fetch/reset 到上游最新）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
```

## 故障排查

| 症状 | 处理 |
|------|------|
| 模型请求报“网关请求失败” | `zcode2api_gateway` `logs` 看日志；或 `start` 拉起 |
| 503 `no_available_account` | 账号池空/全不可用——`zcode2api_accounts` `add` 加号，`quota` 看额度 |
| 启动即失败且提示端口 | 端口被占用或被 Windows 保留（`netsh interface ipv4 show excludedportrange protocol=tcp` 查），改 `port` 配置 |
| 提示缺 Python 运行时 | 跑 `scripts\setup.ps1` |
| 改了代码没生效 | 按上文 bump `?v=N` 并禁用/启用插件 |

## 上游与许可

内置源码来自 [liu5269/zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0），
仅限学习、研究、个人实验用途，免责声明见上游 README。本插件代码同样遵循该用途约束。
