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

零依赖 Node 实现：OpenAI 兼容接收端 → 注入 CodeBuddy 订阅 token → 转发 `copilot.tencent.com` → SSE 透传，多账号轮转。

### 1. 配置

```bash
cp config.example.json config.json
```

`config.json` 关键字段：

- `provider.baseUrl` / `provider.path`：上游端点（默认 `https://copilot.tencent.com` + `/v1/chat/completions`）。
  - 若首次真实调用返回 404，把 `provider.path` 改成 `/chat/completions`（或把 `baseUrl` 设为 `…/v1` 并把 `path` 设为 `/chat/completions`）。
- `accounts[]`：账号池，两种认证：
  - `{ "mode": "import", "source": "~/.codebuddy" }` —— 复用本机 CodeBuddy 已登录会话（委派式 OAuth，自动读取 token）。
  - `{ "mode": "apikey", "apiKey": "…" }` —— 在 `copilot.tencent.com/profile` 生成的 API key。

### 2. 校验凭证

```bash
node src/index.js scan     # 看 import 账号是否能找到 token（脱敏）
node src/index.js login    # 校验每个账号 token 可解析
node src/index.js status   # 看账号池 / 轮转状态
```

### 3. 启动

```bash
node src/index.js server                 # 默认 127.0.0.1:8787
# 或 BRIDGE_CONFIG=/path/to/config.json node src/index.js server
```

### 4. 调用

本地 harness 指向它即可（标准 OpenAI 协议，含 `stream` / `tools`）：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

也可把 **CodeBuddy CLI 自身的自定义 endpoint** 指到同一地址，bridge 会注入池内 token 并轮转。

### 5. 轮转规则（简单实现）

- 每请求选「最久未用且未冷却」的账号。
- 上游 `401/403` → 标记 auth 错误并刷新 token（import 模式重读）；`429` → 标记配额耗尽，冷却 `rotation.cooldownMs` 后轮到下一账号。
- 流式响应在向上游发头前先窥探首段 SSE，遇错误事件则本账号内失败切换一次。

### 6. 腾讯云部署（私有暴露，不裸奔公网）

```bash
# 镜像内监听 0.0.0.0:8787，安全组勿开放公网；用隧道暴露给本地 harness
docker build -t bridge-ai .
docker run -d -p 8787:8787 -v $PWD/config.json:/app/config.json bridge-ai
```

本地用 `ssh -R 8787:localhost:8787 user@cloud` 或 Cloudflare Tunnel 反向隧道暴露，harness 访问 `http://127.0.0.1:8787/v1`。
个人自用、私有链路；不接公网、不多人共用（反代复用订阅额度在厂商 ToS 属灰区）。
