# dsh-zcode2api

把 [zcode2api](https://github.com/liu5269/zcode2api)（ZCode Coding Plan 额度 → Anthropic Messages API 网关）
装进 **DeepSeek Harness** 的本地插件：内置上游源码、自动装配 Python 运行时、托管网关进程，
并把网关注册成 DSH 的模型提供方 —— **ZCode 的模型（GLM-5.2 / GLM-5-Turbo）直接出现在模型选择器里**，
外加四个运维工具让你在对话里管理账号池、额度和网关。

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

### 用法 A：模型提供方 `zcode-cli`（在模型选择器里选它）

设置 → 模型 → 提供方 **ZCode CLI（客户端 agent）** → 模型 `GLM-5.3-Flash (ZCode CLI)`。
选中后 DSH 的模型请求会交给 ZCode 客户端自带的 agent 执行，**用的是你 ZCode 账号的额度**。

- 多轮会话按 DSH 的 sessionId 自动 `--resume`，后续轮次只发新增消息（省掉每轮约 18k 的重复上下文）
- 会话标题这类辅助调用在本地生成，不消耗额度
- **取舍**：CLI 自身就是 agent，它不会按 DSH 的工具协议发起 tool_call（实测提示词约定会被 GLM 判为注入而拒答），
  所以「模型调用 DSH 自己的工具」这条链不成立 —— 它回答/干活，但工具是它自带的那套。
  需要 DSH 工具循环的场景请用现在的模型 + 用法 B 外包。

### 用法 B：`zcode_cli` 工具（把任务转交给 ZCode agent）

```
zcode_cli(prompt="重构 src/foo.ts 并跑测试", cwd="E:\\proj", mode="yolo")
```

- 返回最终答复、`sessionId`（可用 `resume` 续接）和 token 用量
- CLI 会在指定工作目录里用自带工具读写文件、执行命令 —— 适合"把整块活外包出去"
- 每次调用输入约 18k tokens（CLI agent 的系统提示+工具定义），Start Plan 每日 3M 量级够用

> 为什么不用 HTTP 直连：计划端点 `zcode.z.ai/api/v1/zcode-plan/anthropic` 带阿里云无痕验证 +
> 风控，外部请求（jsdom 求解、真实浏览器、客户端 renderer、过 WAF 的同源浏览器）**一律被服务端判
> `3007 captcha verify failed` 或 `3012 unusual activity`**；而客户端 CLI 这条路径实测可用。

### 实验性：`app-server` 常驻会话（默认关闭，`useAppServer=true` 开启）

`zcode app-server` 是 ZCode Protocol 的 stdio JSON-RPC 服务，协议已完整逆向
（方法清单、schema、事件流见 `scripts/probe-*.cjs`，探测脚本可直接跑通全流程并拿到流式事件）：

- 信封**没有 `jsonrpc` 字段**：请求 `{id,method,params}`、通知 `{method,params}`、响应 `{id,result|error}`
- `session/create {workspace:{workspacePath,workspaceKey}}` → `result.session.sessionId`
- 服务端会反向请求 `session/requestRuntimePreferences`，必须回复
  `{nativeSearchEnhancementsEnabled, memoryEnabled, askUserQuestionAutoResolutionEnabled, modelContextBudgetStrategy:'preflight-v1'}`
- `session/subscribe {sessionId, deliveryKind:'desktop-continuous'}` → `session/event` 事件流
  （`model.streaming{kind:text_delta|reasoning_delta}` 与 `turn.completed{response,usage}`）
- `session/send {sessionId, content}` → `{accepted:true}`
- 会话里可选的模型由客户端**当前选中的供应商**决定（`session/setModel` 换不到别的供应商，
  会报 "Provider Registry 中不存在 Model"）

已知问题：探测脚本直接跑全流程正常，但经本插件的适配器管道 `session/send` 被接受后事件流为空
（`includeSnapshot`、就绪等待、cwd 均已排除），原因未明。因此默认走一次性 CLI；开启后失败会自动回退。

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

## 开发：改了代码怎么生效

DSH 的 loader 只在**行 name 变化**时重新 import 插件模块，而 Node ESM 以完整 URL
（含查询串）为缓存键；profile 的 HMR 没开模块目录监视，所以直接改文件**不会**热加载。
插件用 `cordis.patch.yml` 里的 `?v=N` 解决：

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
