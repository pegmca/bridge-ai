# bridge-ai

把命令行 AI 编程 Agent（Kimi Code / Claude Code / Codex）的订阅 plan 额度，
映射成普通 OpenAI 兼容的 HTTP 接口，供任意支持 OpenAI 协议的上游工具调用。

## 为什么可行

这些 CLI 本质上只是"自带 OAuth 登录的 HTTP 客户端"：

- 登录后把订阅 token 存在本地凭证库
  - Claude Code：`~/.claude/.credentials.json` 或 macOS Keychain
  - Codex：`~/.codex/auth.json`
  - Kimi Code：`~/.kimi-code/` 登录态
- 运行时向厂商端点发**标准协议**请求
  - Claude → Anthropic `/v1/messages`
  - Codex → OpenAI Responses API
  - Kimi Code → OpenAI 兼容 `/v1/chat/completions`（原生支持自定义 provider）
- 订阅额度由厂商按账号 / 会话 / 周配额下发，与"API key 按量计费"是两套体系

> 结论：**只要接管 CLI 的出站请求并注入订阅 token，就能把它重暴露成 OpenAI 兼容 HTTP**。
> 不需要阅读 CLI 源码——这是通用模式。

## 目录结构

```
bridge-ai/
├── README.md          # 本文件：总览与快速开始
└── docs/
    ├── RESEARCH.md    # 现有开源方案调研（已验证的通用实现）
    └── DESIGN.md      # 落地实现方案 + 最小可用草图
```

## 两条落地路径

| 路径 | 含义 | 合规风险 |
|------|------|----------|
| **A. 接收侧（推荐先做）** | 让 kimi-code 指向我们自己的 OpenAI 兼容端点，我们写服务端接收 | 低：纯协议桥接 |
| **B. 转发侧** | 拦截 kimi-code 出站请求，注入订阅 token 转发厂商，再对外暴露 | 灰区：涉及复用订阅额度 |

路径 A 完全合规且能立即跑通，建议作为第一里程碑；路径 B 复用 plan 额度，
但有 ToS 灰色地带风险，需谨慎评估。

## 名词

- **bridge**：本项目实现的本地代理 / 桥接服务
- **上游工具**：调用 bridge 的客户端（另一个 Claude Code、Cursor、IDE 插件等）
- **厂商端点**：Anthropic / OpenAI / Moonshot / Tencent CodeBuddy 的真实 API

---

## 运行（方案 A · CodeBuddy 专用中继，已落地）

零依赖 Node 实现：OpenAI 兼容接收端 → 注入 CodeBuddy 订阅 token → 转发 `wb.tencentbuddy.com` → SSE 透传，多账号轮转。

### 0. CodeBuddy 真实端点（实测）

- 聊天接口：`https://wb.tencentbuddy.com/v2/chat/completions`（主），`https://copilot.tencent.com/v2/chat/completions`（备）。
  - ⚠️ **路径是 `/v2/chat/completions`，不是 `/v1/` 也不是裸 `/chat/completions`**。
  - `copilot.tencent.com` 同路径会返回账号信息而非聊天；真正出 token 的是 `wb.tencentbuddy.com`。
  - 上游**只接受流式**（`stream:true`），非流式直接 `400`。
- 鉴权：除标准 `Authorization: Bearer <accessToken>` 外，还需身份头 `X-Product: SaaS`、`X-Domain: www.codebuddy.cn`、`X-User-Id: <uid>`、`x-codebuddy-request: 1`。
- Token 是**两套** JWT：
  - access token（RS256，`typ:Bearer`，约 28 天）—— 聊天用的 Bearer。
  - refresh token（HS512，`typ:Offline`，约 30 天）—— 用它调 `/v2/plugin/auth/token/refresh` 换 access token；**该接口还会回吐新的 refresh token（可轮转）**。
- CodeBuddy 不会把这两套 token 以明文落盘，所以下面用「刷新换发」模式，而不是直接读文件。

### 1. 配置

```bash
cp config.example.json config.json
```

`config.json` 关键字段：

- `provider.hosts` / `provider.path`：上游主机数组 + 路径。`hosts` 默认 `["wb.tencentbuddy.com","copilot.tencent.com"]`，`path` 默认 `/v2/chat/completions`。
- `provider.identity`：要注入的身份头（默认 `X-Product: SaaS`、`X-Domain: www.codebuddy.cn`）。
- `accounts[]`：账号池，支持三种认证：
  - `{ "mode": "refresh", "refreshToken": "…", "userId": "…" }` —— **推荐**。用离线 refresh token 换 access token，自动轮转并落盘到 `bridge.state.json`，可长期自持。（见下方「捕获 refresh token」）
  - `{ "mode": "apikey", "apiKey": "…" }` —— 在 CodeBuddy 控制台生成的 API key，最省事、最持久。
  - `{ "mode": "import", "source": "~/.codebuddy" }` —— **对 CodeBuddy 不生效**（其 token 不落盘明文），仅作占位/其它厂商用。

### 2. 捕获 refresh token（仅首次 / token 链断开时）

在**已 `codebuddy` 登录过的那台机器**（需要 root，改 `/etc/hosts` + 占 `:443`）：

```bash
sudo node scripts/capture-token.mjs --config config.json
# 会临时把 copilot.tencent.com / wb.tencentbuddy.com 指到本机并 MITM 一次，
# 抓到 X-Refresh-Token 后写回 config.json，并复原 /etc/hosts。
```

脚本会自动填好 `accounts[].auth.refreshToken` 与 `userId`。之后 bridge 自己刷新 + 轮转，**通常不需要再跑**。

> 更简单的替代：在 CodeBuddy 控制台生成 API key，改用 `mode:"apikey"`。

### 3. 校验凭证

```bash
node src/index.js login    # 校验每个账号能换出 access token
node src/index.js status   # 看账号池 / 轮转状态
```

### 4. 启动

```bash
node src/index.js server                 # 默认 127.0.0.1:8787
# 或 BRIDGE_CONFIG=/path/to/config.json node src/index.js server
```

### 5. 调用

本地 harness 指向它即可（标准 OpenAI 协议，`stream` 由 bridge 强制为 true）：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

### 6. 轮转规则

- 每请求选「最久未用且未冷却」的账号；上游主机按 `provider.hosts` 顺序失败切换。
- 上游 `401` → 标记 auth 错误并清缓存重换 token；`429` → 标记配额耗尽，冷却 `rotation.cooldownMs` 后轮到下一账号。
- 流式响应在向上游发头前先窥探首段 SSE，遇错误事件则本账号内失败切换一次。
- 个别网关节点会把 SSE 以「逗号分隔的 ASCII 码」形式返回，bridge 自动解码回正常 SSE。

### 7. 腾讯云部署

两种暴露方式二选一。

**(A) 私有隧道（推荐，无需开安全组）**

```bash
# 镜像内监听 0.0.0.0:8787，但安全组勿开放公网；用隧道暴露给本地 harness
docker build -t bridge-ai .
docker run -d -p 8787:8787 -v $PWD/config.json:/app/config.json bridge-ai
```

本地反向隧道，harness 访问 `http://127.0.0.1:8787/v1`：

```bash
ssh -N -L 8787:127.0.0.1:8787 tx        # 本地执行，tx=腾讯云别名
```

**(B) 直接公网访问（需配合 serverApiKey 鉴权）**

`config.json` 里设 `listen.host: "0.0.0.0"` 并设置访问密钥：

```json
"listen": { "host": "0.0.0.0", "port": 8787, "serverApiKey": "你的强随机密钥" }
```

bridge 收到任何请求（除 `/healthz`）都会校验密钥，缺失/错误返回 `401`：

```bash
curl http://43.130.49.34:8787/v1/chat/completions \
  -H "Authorization: Bearer 你的强随机密钥" \
  -H 'Content-Type: application/json' \
  -d '{"model":"hy4-preview-f","messages":[{"role":"user","content":"hi"}]}'
# 也可用 -H "x-api-key: 你的强随机密钥"
```

> **必须**：在腾讯云控制台的**安全组**中放行入站 TCP `8787`（主机 `ufw`/iptables 已确认无拦截，自连公网 IP 超时即为安全组未放行所致）。否则 `http://43.130.49.34:8787/...` 无法从外部连入。

个人自用、私有链路；不接公网、不多人共用（反代复用订阅额度在厂商 ToS 属灰区）。

### 8. 日志

bridge 把运行日志写到启动时的 stdout（部署时重定向到 `bridge.log`）：

```bash
ssh tx "tail -f /opt/bridge-ai/bridge.log"     # 实时跟踪
ssh tx "grep '\[fwd\]' /opt/bridge-ai/bridge.log"   # 只看转发记录
```

每条请求两行：

```
[fwd] IN  POST /v1/chat/completions model=hy4-preview-f
[fwd] OK  account=cb-1 host=wb.tencentbuddy.com status=200 2347ms
```

- `IN` = 收到的请求；`OK`/`ERR` = 转发结果（`account`/`host`/`status`/耗时）。
- 上游错误响应体（前 500 字符）会附在 `ERR` 行里。
- **默认不记录对话内容**。如需核对 bridge 是否夹带内容，在 `config.json` 顶层开：

```json
"logOutgoingBody": true
```

开启后每条请求多打一行 `[fwd] OUT <实际发给上游的 body>`（截断 8KB），可证明 bridge 只透传你的 `messages`。**注意**：这会落盘你的对话内容，仅调试时临时开启，用完请改回 `false`。
