# 落地实现方案

基于调研，给出 bridge-ai 的落地设计。优先做**路径 A（接收侧，合规）**跑通闭环，
路径 B（转发侧）作为后续可选扩展。

## 里程碑 1：OpenAI 兼容接收端（接收侧）

让 kimi-code 指向我们的端点，我们接收并归一化为内部 `Message` 流。

### 架构

```
kimi-code (OPENAI_BASE_URL=http://127.0.0.1:8787/v1)
        │  POST /v1/chat/completions  (OpenAI 格式, stream=true)
        ▼
bridge (Hono / Fastify)
        ├─ 解析 OpenAI messages / tools / stream
        ├─ 归一化为内部 Message 协议
        ├─ 接任意后端 LLM（先 mock，再接真实 provider）
        └─ 以 SSE (text/event-stream) 回吐 OpenAI chunk
```

### 关键实现点

1. **端点**：`POST /v1/chat/completions`，兼容 `stream` 布尔与 `stream_options.include_usage`。
2. **流式**：OpenAI SSE 格式 `data: {json}\n\n`，结束发 `data: [DONE]`。
3. **tools**：透传 `tools` / `tool_calls`，把后端工具调用转回 OpenAI `tool_calls` 形状。
4. **归一化**：内部用与 `aiagent/packages/ai` 一致的 `Message` 类型，避免在 bridge 里重复定义领域类型。
5. **配置**：端口、后端 provider、模型映射从 `config.toml` 或环境变量读。

### 最小草图（Hono，仅示意核心循环）

```ts
import { Hono } from "hono";

const app = new Hono();

// OpenAI 兼容 chat completions
app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json<{
    model: string;
    messages: { role: string; content: string }[];
    stream?: boolean;
    tools?: unknown[];
  }>();

  // 1. 归一化：OpenAI messages -> 内部 Message
  const normalized = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (!body.stream) {
    // 非流式：攒齐后一次性返回
    const text = await backendComplete(normalized, body.model);
    return c.json({
      id: "chatcmpl-bridge",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    });
  }

  // 2. 流式：SSE 逐 chunk 转发
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for await (const delta of backendStream(normalized, body.model)) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({
            id: "chatcmpl-bridge",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`)
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});

export default app;
```

## 里程碑 2（可选）：转发侧 token 注入

复用订阅 plan 额度，把 bridge 变成"上游工具 ↔ 厂商"之间的透明代理。

### 架构

```
上游工具 (curl / 另一个 Claude Code)
   │  POST /v1/chat/completions
   ▼
bridge
   ├─ 注入订阅 OAuth token（读本地凭证库）
   ├─ 协议归一化（Anthropic↔OpenAI 互转；Kimi 免这步）
   ├─ 转发厂商真实端点 (api.moonshot.cn / api.anthropic.com)
   ├─ 解析配额响应头做账号轮转
   └─ SSE 流回上游
```

### 关键实现点

1. **凭证读取**：各 CLI 本地凭证库路径见 RESEARCH.md；token 过期前自刷新并写回。
2. **MITM 转发**（方案 A 高级形态）：通过 `HTTPS_PROXY` 把 CLI 出站流量引到 bridge，
   对硬编码厂商域名做透明拦截 + token 注入（参考 teamclaude 的 MITM forward proxy）。
3. **配额轮转**：解析厂商 `ratelimit` / `usage` 响应头，按 5h 会话、7d 周配额阈值切换账号。
4. **合规**：此里程碑触及 ToS 灰色地带，需明确告知使用者风险，不建议默认开启公网暴露。

## 推荐起步

1. 先实现里程碑 1 的接收端，用 kimi-code 的 `OPENAI_BASE_URL` 指向它，验证闭环。
2. 后端先接 mock（回显 + 假流式），再接真实 provider（复用 `aiagent/packages/ai` 的 `stream`）。
3. 需要复用 plan 额度时，再评估里程碑 2。
