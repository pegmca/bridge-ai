# 现有开源方案调研

目标：确认"把 CLI 订阅额度转成 OpenAI 兼容 HTTP"是否有通用、成熟的开源实现。
结论：**有，且模式统一**。核心都是"拦截 CLI 出站请求 + 注入订阅 OAuth token"。
以下是已验证的代表性仓库（截至 2026-10）。

## 一、方案分类

### A. 令牌注入 + 反向代理（多账号 / 配额轮转）
本地起 OpenAI 兼容端点，请求时把订阅 OAuth token 注入到对厂商的真实调用。
可做多账号轮换、配额复用、限流。

| 仓库 | 亮点 |
|------|------|
| [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude) | 最成熟。同时池化 Claude Max + ChatGPT/Codex 订阅；MITM 转发代理捕获硬编码 `api.anthropic.com`；5h 会话 / 7d 周配额自动轮转；token 过期前自刷新并写回凭证库；纯 Node 内置依赖 |
| [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) | 多用户中转，Web 管理面板；自定义 Key 按人统计用量；账号冷却 / 限流；支持 Claude Code / Gemini CLI / Codex CLI |

### B. 订阅共享（跨机 / 拼车）
MITM 拦截厂商 API 域名，把 sharer 的 OAuth token 按请求注入；接收端装临时 CA 证书。

| 仓库 | 亮点 |
|------|------|
| [gurshabad90/code-share](https://github.com/gurshabad90/code-share) | 同时支持 Claude Code 与 Codex；sharer 机器读本地凭证库 token 注入；通过隧道把登录态暴露给接收机；token 永不下发到接收端 |

### C. 协议翻译代理（CLI 接任意后端）
把 Claude / Codex 的私有协议 ↔ OpenAI 格式互转，让 CLI 跑在非厂商模型上。

| 仓库 | 亮点 |
|------|------|
| [kiyo-e/claude-code-proxy](https://github.com/kiyo-e/claude-code-proxy) | Claude API 格式 ↔ OpenAI 格式互译 |
| [fuergaosi233/claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy) | 让 Claude Code 接 OpenAI 兼容 provider |
| [dantefung/codex-proxy](https://github.com/dantefung/codex-proxy) | Codex Responses API → OpenAI `/v1/chat/completions` / Anthropic `/v1/messages` / Gemini / Codex 直通 |

### D. 子进程桥（不碰 token）
直接把 CLI 当子进程（`claude --print` / `codex exec`），输出包成 HTTP。

| 仓库 | 亮点 |
|------|------|
| [sethschnrt/claude-max-api-proxy](https://github.com/sethschnrt/claude-max-api-proxy) | 明确"不提取 OAuth token"，用 `claude --print` 子进程桥接，复用 Max 额度 |

## 二、对 Kimi Code 的映射结论

Kimi 比 Claude/Codex 更简单，因为 **kimi-code 原生支持自定义 provider**：

1. **接收侧（自由）**：在 `config.toml` 或 `OPENAI_BASE_URL` 指到我们的端点即可，
   它发出去的就是标准 OpenAI `/v1/chat/completions`（含 `stream`、`tools`）。
   我们只需写一个 OpenAI 兼容接收端，无需任何代理。
2. **转发侧（复用 Kimi plan）**：沿用方案 A 的 MITM / token 注入模式，
   把 kimi-code 出站请求引到本地代理，注入 Kimi 登录 token 后转发 `api.moonshot.cn`，
   再对第三方暴露成 OpenAI 接口。

> 现状：没有像 teamclaude 那样专为 Kimi 打磨的成熟仓库，
> 但机制与 Claude 完全一致——"拦截 + 注入订阅 token"即可。

## 三、风险与合规

这些"反代复用订阅额度"方案在厂商 ToS 里普遍属于**灰色地带**
（原文："通过反代使用 ChatGPT 订阅，严格来说属于灰色地带"；
teamclaude 也单写 `docs/compliance.md`）。多人拼车 / 转发公网尤其易触发封号。
个人本地自用、仅做协议桥接风险最低；量产前务必评估合规。
