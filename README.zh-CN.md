# bridge-ai

[English](README.md) · **简体中文**

> ⚠️ **本项目只针对[腾讯 CodeBuddy](https://www.codebuddy.cn) 命令行版**（`@tencent-ai/codebuddy-code`）。
> 它把 CodeBuddy 订阅套餐的额度映射成一个 OpenAI 兼容的 HTTP 端点，供本地 harness 或任意 OpenAI 协议客户端使用。
> **不支持** Claude Code / Codex / Kimi Code 等其它 CLI —— 那些属于别的项目。

## 它做什么

CodeBuddy CLI 登录后会持有一个订阅 token。本项目不改动 CLI 源码，而是**接管它发出的对话请求、注入订阅 token，再以 OpenAI 兼容的 `/v1/chat/completions` 暴露出来**：

- OpenAI 兼容入口（本机 / 远程）→ 注入 CodeBuddy 订阅 token → 转发到 `wb.tencentbuddy.com` → SSE 原样透传
- 多账号轮转、refresh token 自动续期与轮换、上游主机故障切换

## 环境要求

- **Node.js 18+**。没有任何 npm 依赖，**不需要** `npm install`。
- 一个已登录的 CodeBuddy / WorkBuddy 账号。用 [workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 管理账号是可选项，但正是它让 clone 下来零配置就能跑。
- 抓包脚本（第 2 步）需要 root 并占用 `:443`，其余功能都以普通权限运行。

## 目录结构

```
bridge-ai/
├── README.md            # 英文版（本仓库主 README）
├── README.zh-CN.md      # 本文件
├── config.example.json  # 配置模板；首次启动会据此生成 config.json
├── src/
│   ├── index.js          # CLI：server / login / status / scan
│   ├── server.js         # 接收请求、密钥门禁、attempt() 循环、/admin/* 接口
│   ├── proxy.js          # 上游请求 + SSE 首帧窥探
│   ├── accounts.js       # 账号池、运行时计数、sticky 轮转
│   ├── auth-codebuddy.js # 按 auth.mode 解析 token
│   ├── store-wbs.js      # 读写 workbuddy-switch 账号库（原子写回）
│   ├── quota.js          # 状态码 → 失败分类（quota / auth / retryable / error）
│   ├── status.js         # /admin/pool 的数据结构 + CLI 表格
│   └── dashboard.html    # 自带看板（无需构建、无 CDN）
├── scripts/              # svc.mjs（启停）、preview.mjs、capture-*.mjs
└── docs/
    ├── DESIGN.md         # 实现设计与轮转说明
    ├── request-flow.svg  # 请求分发流程图
    └── RESEARCH.md       # 同类方案调研
```

## 术语

- **bridge（桥）**：本项目实现的转发 / 桥接服务
- **上游客户端**：调用 bridge 的客户端（本地 harness、Cursor、IDE 插件等）
- **厂商端点**：腾讯 CodeBuddy 的真实 API（`wb.tencentbuddy.com` / `copilot.tencent.com`）

---

## 运行（方案 A · CodeBuddy 专用中继，已实现）

零依赖 Node 实现：OpenAI 兼容入口 → 注入 CodeBuddy 订阅 token → 转发到 `wb.tencentbuddy.com` → SSE 透传，并带多账号轮转。

### 0. CodeBuddy 真实端点（已实测）

- 对话端点：`https://wb.tencentbuddy.com/v2/chat/completions`（主）、`https://copilot.tencent.com/v2/chat/completions`（兜底）。
  - ⚠️ **路径是 `/v2/chat/completions`，不是 `/v1/`，也不是裸的 `/chat/completions`。**
  - `copilot.tencent.com` 同路径返回的是账号信息而不是对话；真正吐 token 的是 `wb.tencentbuddy.com`。
  - 上游**只接受流式**（`stream:true`），非流式请求直接 `400`。
- 鉴权：除了标准的 `Authorization: Bearer <accessToken>`，还必须带这几个身份头：`X-Product: SaaS`、`X-Domain: www.codebuddy.cn`、`X-User-Id: <uid>`、`x-codebuddy-request: 1`。
- token 是**两个** JWT：
  - access token（RS256，`typ:Bearer`，约 28 天）——对话时作为 Bearer 使用。
  - refresh token（HS512，`typ:Offline`，约 30 天）——用来调 `/v2/plugin/auth/token/refresh` 换新的 access token；**该接口同时返回新的 refresh token（可轮换）。**
- CodeBuddy 不把这两个 token 明文落盘，所以下面用「refresh 换新」模式，而不是直接读文件。

### 1. 配置（首次启动自动完成）

`config.json` 因为要保存本服务的访问密钥而被 gitignore，因此**首次启动时会从纳入版本库的 `config.example.json` 自动生成**，不需要手动 `cp`：

```bash
git clone https://github.com/pegmca/bridge-ai.git && cd bridge-ai
npm start
# 自动生成 config.json，读取 workbuddy-switch 里已登录的账号，
# 首次启动生成一把访问密钥，并打印：
#
#   dashboard  http://127.0.0.1:8787/admin  (200)
#   access key 6f1c…  <- 客户端用 Authorization: Bearer 6f1c…
```

首次启动依次做四件事：

1. **`config.json`** —— 由 `config.example.json` 复制生成（它被 gitignore 是因为最终会装密钥）。
2. **账号** —— 从 [workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 的账号库 `~/.wb-switch/accounts.json` 读取，你在那边登录过的账号不用改任何配置就会出现在看板上。`variant: "ai"` 的条目默认跳过，除非在 `accountSource.variants` 里加上 `"ai"`。账号库不存在时服务照常启动，只是池子为空并给出提示。
3. **访问密钥** —— 模板里 `listen.serverApiKey` 是 `"auto"`，含义是「现在生成一把并写回」。你会得到 64 位 hex 的 key，存在 `config.json`，重启不变。看板右上角的「访问密钥」可以明文查看、复制和更换。
4. 然后在 `127.0.0.1:8787` 上监听并对外提供 `/admin`。

所以 clone 下来立刻就能调：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <npm start 打印的那把 key>" \
  -H 'content-type: application/json' \
  -d '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

以后加账号也不用改配置：在 workbuddy-switch 里再登录一个，重启即可，账号池会自动带上。手工方式仍然有效：往 `accounts[]` 里加一条（模式见下），或跑 `scripts/capture-token.mjs`（见第 2 步）。`npm start` 是后台守护进程，用 `npm run status` / `stop` / `restart` 管理，日志在 `tmp/cap/bridge.log`。

换配置文件路径：`BRIDGE_CONFIG=/path/to/config.json`，或 `node src/index.js server --config <path>`（守护脚本固定使用 `./config.json`）。

### 1b. 服务命令

| 命令 | 作用 |
|---|---|
| `npm start` | 按 `config.listen` 后台启动；打印看板地址**和访问密钥**。端口被占时输出「already running」。 |
| `npm run status` | 探测 `/healthz`、`/admin`，打印 pid、看板地址和当前访问密钥。 |
| `npm run stop` | 停止后台进程。 |
| `npm run restart` | 停止 + 启动，**加载新代码就走这里**。 |
| `npm run preview` | 在 `127.0.0.1:8789` 起一个临时实例，状态独立放在 `tmp/preview/`，用来试 UI 改动而不碰正式服务。Ctrl+C 结束。 |
| `npm run login` | 逐个账号验证能否换出 access token。 |

Windows 上如果进程是用管理员权限启动的，普通终端杀不掉：`npm run restart` 会报 `cannot stop pid=…: access denied` 并以非零码退出（不会再假装成功）。请在管理员终端里执行。

`npm run status` 输出 `RUNNING  pid=…  healthz=200  dashboard=200  <url>` 加一行 `access key …`；要看账号表格用 `node src/index.js status`（`--json` 拿原始数据）。

`config.json` 的主要字段：

- `listen`：`{ "host": "127.0.0.1", "port": 8787, "serverApiKey": "auto" }`。`"auto"` = 首次启动生成并持久化；换成真实字符串就是固定使用它；设为 `""` 表示完全关闭入口鉴权（只在绑定 loopback 时合理）。
- `provider.hosts` / `provider.path`：上游主机数组 + 路径。`hosts` 默认 `["wb.tencentbuddy.com","copilot.tencent.com"]`，`path` 默认 `/v2/chat/completions`。
- `provider.identity`：要注入的身份头（默认 `X-Product: SaaS`、`X-Domain: www.codebuddy.cn`）。
- `provider.channelVerifyRetries`：被 `11128` 拦下后用新 trace id 重放的次数（默认 `3`）。
- `provider.sessionMode`：会话 ID 生成方式，见 5d。
- `sanitize`：`{ "enabled": true, "rules": [{ "find": "…", "replace": "…" }] }` —— 转发前改写 `messages[].content` 里匹配的片段。当客户端的系统提示词命中上游指纹、被 `11128` 拒绝时需要它（见 6b）。
- 入站请求只转发 `content-type`、`accept`、`accept-language` 三个头，其它一律丢弃（尤其是用来给 bridge 做门禁的 `x-api-key` / `Authorization`）。
- `accounts[]`：账号池，支持几种认证模式：
  - `{ "mode": "refresh", "refreshToken": "…", "userId": "…" }` —— **推荐**。用离线 refresh token 换 access token，自动轮换并持久化到 `bridge.state.json`，长期自持。（见「抓取 refresh token」。）
  - `{ "mode": "apikey", "apiKey": "…" }` —— CodeBuddy 控制台生成的 API key，最省事也最持久。
  - `{ "mode": "wbs", "uid": "…" }` —— 由 [workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 持有的凭证；通常由 `accountSource` 自动生成（见 5c）。
  - `{ "mode": "import", "source": "~/.codebuddy" }` —— **对 CodeBuddy 无效**（它的 token 不明文落盘），仅作占位。
- `accountSource`：`accounts[]` 的替代方案 —— 从 workbuddy-switch 账号库展开账号池，保证每份凭证只有一个归属（见 5c）。

### 2. 抓取 refresh token（首次 / token 链断了时）

在**已登录 `codebuddy` 的那台机器**上（需要 root，会改 `/etc/hosts` 并占用 `:443`）：

```bash
sudo node scripts/capture-token.mjs --config config.json
# 临时把 copilot.tencent.com / wb.tencentbuddy.com 指向本地并 MITM 一次请求，
# 抓到 X-Refresh-Token 后写回 config.json，再还原 /etc/hosts。
```

脚本会自动填入 `accounts[].auth.refreshToken` 和 `userId`。之后 bridge 自己刷新、自己轮换 —— **正常情况下再也不需要跑它**。

> 更简单的替代：在 CodeBuddy 控制台生成 API key，用 `mode:"apikey"`。

### 2b. 自动重新抓取（自愈）

离线 refresh token 可能被服务端作废（上游返回 `code=12153 "refresh token is invalid"`）。为避免人工介入，bridge 可以在遇到这种情况时自己重新抓一份。

- 由 `config.json` 的 `"autoRecapture": true` 启用（代码默认开启，只有写 `false` 才关闭）。要求 bridge 以 **root** 运行，且同一台机器上 `codebuddy` CLI 已登录。**账号来自 workbuddy-switch 账号库时请关掉它**（原因见 5c）。
- 刷新失败并返回 `12153` 时，bridge 会短暂执行与 `scripts/capture-token.mjs` 相同的 MITM 引导：停掉占用 `:443` 的进程（例如 nginx）、改 `/etc/hosts`、拦截一次 `codebuddy -p` 调用抓新的 `X-Refresh-Token`、写回 `config.json`，然后还原 hosts 并重启被停掉的服务。
- 安全措施：串行执行（同一时间只做一次 MITM），失败后冷却 10 分钟；且**失败即放弃**，不会无限重试。
- 不想用就把 `"autoRecapture"` 设为 `false`，改为手工重抓。

### 3. 验证凭证

```bash
node src/index.js login    # 验证每个账号都能换出 access token
node src/index.js status   # 查看账号池 / 轮转状态
```

### 4. 启动

```bash
node src/index.js server                 # 默认 127.0.0.1:8787
# 或 BRIDGE_CONFIG=/path/to/config.json node src/index.js server
# 日常用 npm start（后台守护），见 1b
```

### 5. 调用

把本地 harness 指向它即可（标准 OpenAI 协议；`stream` 会被 bridge 强制为 `true`）：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

### 5b. 账号看板（谁在登录、正在干什么）

看板不是独立服务：`src/dashboard.html` 由 bridge 自己提供，所以启动 bridge 就等于启动看板。启停命令见 [1b](#1b-服务命令)。

服务运行期间打开 `http://127.0.0.1:8787/admin`（或直接 `/`）。它列出池中每个账号：

- **身份** —— 该账号实际上游使用的 `userId`（取 `auth.userId`，否则本地解出 refresh token 的 `sub`）；
- **状态** —— 可用 / 忙（有在途请求）/ 冷却中，并显示剩余冷却时间；
- **用量** —— 当前并发、总请求数、成功 / 失败、最后使用时间、最后一次 HTTP 状态；
- **凭证** —— refresh token 何时到期、内存里的 access token 何时到期；
- **最后错误** —— `quota`、`http 401`、`token: … refresh token is invalid` 等。

当前正在承接流量的账号会标一个 `当前`，页头显示轮转模式以及指针被移动过多少次。

**手动指定当前账号。** 其余每一行都有「设为当前」按钮：点了就把 sticky 指针移到那个账号，下一个请求直接打到它，不必等它出错才轮转。两个细节值得知道：这一下也会**解除该账号的冷却**（否则指针会停在一个每次请求都被跳过的账号上——真要发生时页面会先确认），以及它**不会锁死**账号：该账号出现账号级错误后，轮转照常从它后面继续。`rotation.mode` 为 `lru` 时按钮是禁用的，因为那种模式每个请求都重新挑号，没有指针可移。

页面每 3 秒轮询一次，整个看板就是一个 `src/dashboard.html`：不用构建、不引 CDN、无外部资源。

**访问密钥弹窗（右上角「访问密钥」）** 显示的是**本服务自己的 key**（客户端 `Authorization: Bearer <key>` 里那串），可明文查看、复制、随机生成（32 字节 → 64 位 hex）并保存。新 key 会**先写入 `config.json`，写盘成功后才替换进程内存里的值**，所以文件和进程永远不会不一致，**改完立即生效、不用重启**；浏览器也会自动换用新 key，否则下一轮 3 秒轮询会把自己挡成 401。用户自己打开的弹窗不会被自动刷新关掉——有弹窗时轮询整体暂停。

接口：

- `GET /admin` —— 页面本身（不含数据，所以不需要密钥）。
- `GET /admin/pool` —— 同样的数据，JSON 形式。**本机 loopback 免密钥**，其它来源都要密钥：别处调用需带 `listen.serverApiKey`，支持 `Authorization: Bearer <key>`、`x-api-key: <key>` 或 `?key=<key>`。
- `GET /admin/server-key` —— 当前访问密钥及其位置；`POST /admin/server-key`，body `{"key":"…"}` 可更换（16–256 位，字符集 `A-Z a-z 0-9 . _ ~ + / -`）。门禁与 `/admin/pool` 相同，因此**从局域网更换必须带当前 key**。
- `POST /admin/current`，body `{"index": 3}` —— 把轮转指针固定到 `pool[3]`（「设为当前」按钮调的就是它）。成功返回 `{"ok":true,"index":3,"name":"…","clearedCooldown":false}`；索引非法 `400`，`rotation.mode` 为 `lru` 时 `409`。它改变运行行为，所以门禁与换 key 一致。
- `POST /admin/reload` —— 立即重读账号库（见 [5c](#5c-与-workbuddy-switch-共用账号库)）。
- 页面会问一次密钥并存进 `localStorage`；`/admin?key=<key>` 这样的深链也可以。
- `node src/index.js status [--json]` 在终端打印同样的视图（连不上会明确说明，而不是假装账号都空闲）。
- 计数只在内存里，重启清零。账号 token 从不外露——只有掩码和到期时间；明文展示的只有访问密钥，因为它本来就是拿来复制的。

### 5c. 与 workbuddy-switch 共用账号库

[workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 会在 `~/.wb-switch/accounts.json` 维护一份已登录账号的库（OAuth 扫描、区域、昵称、额度保活）。与其在这里再存一份凭证，不如让 bridge 直接指向那个库，把它当作唯一事实来源：

```json
"accountSource": { "type": "wb-switch", "path": "~/.wb-switch/accounts.json", "variants": ["cn"] },
"accounts": []
```

`path` 可省略（默认 `~/.wb-switch/accounts.json`，也可用环境变量 `WBS_ACCOUNTS` 覆盖）。运行期间这个文件会被监听：在 workbuddy-switch 里新增、删除账号或重新登录后，一秒内就会反映到账号池和 `/admin`，**不需要重启**。`POST /admin/reload` 可以强制重读（鉴权规则与 `/admin/pool` 相同）。重读会保留各账号的运行时计数与冷却状态；即使账号顺序变了，「当前账号」也仍然贴在同一个人身上。

一致性是怎么保证的：

- **读取始终是实时的。** 每次请求都会从账号库重新读该条目，本地不留缓存副本。
- **只在需要时换新。** `access_token` 还新鲜（`expiresAt` 距现在超过 60 秒）就直接用；否则按该账号自己的 `domain` 调 `POST /v2/plugin/auth/token/refresh`（带 `X-Auth-Refresh-Source: plugin`），并把轮换后的 `access_token` / `refresh_token` / `expiresAt` / `refreshedAt` **原子写回同一个文件**，`nickname`、`note`、`auth_raw`、`profile_raw` 等字段原样保留。于是两个工具收敛到同一条 token 链，而不是互相把对方顶掉。
- **如果 workbuddy-switch 先轮换了**（它的保活每天会做），这里刷新时会收到 `12153`，bridge 会重新读一次账号库、直接使用盘上的新 token。
- **区域是不同网关，所以默认只开 CN。** `variant: "cn"` 的账号走 `provider.hosts`（`wb.tencentbuddy.com`）。`variant: "ai"` 的账号在另一个端点（`https://www.codebuddy.ai/v2`）、规则也不同——它的网关要求首条消息必须是 system prompt（否则 `11128 first message is not system prompt`）——所以**默认排除**，需要显式写 `"variants": ["cn", "ai"]` 才会启用；启用后 bridge 只对这些账号补一条中性 system prompt（可用 `provider.defaultSystemPrompt` 覆盖）。被过滤掉的账号在库里保持不动，继续由 workbuddy-switch 保活。
- **不重复。** 如果静态 `accounts[]` 里的 `userId` 和库里某个账号相同，库里的那条会被跳过并打印警告。一个账号只保留一个归属：要么账号库，要么静态条目。
- **这种模式下请关掉 `autoRecapture`。** 它会把「本机 CLI 当前登录的账号」抓到并写进某一个槽位，可能写错；账号库作为来源时它也无事可做。

无法使用的条目会在启动时连同原因一起列出（加密 token、`needs_relogin`、区域被禁用）。可在 `accountSource` 里用 `"variants": ["cn"]`（默认）、`"includeUids": [...]`、`"excludeUids": [...]` 过滤。

### 5d. prompt 缓存复用（`provider.sessionMode`）

上游会缓存长 prompt 前缀，并在最后一个 `usage` 事件里报告（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_read_input_tokens`）。在 7.5k token 的系统提示上实测：首次全价（`credit` 1.10），后续变成 `hit=7552 miss=5`，`credit` 0.15–0.06。

复用的作用域是**会话 ID**，不是账号。下一轮即使被池中另一个账号承接，同样的前缀依然命中，所以账号轮转不产生额外成本。过去把缓存冲掉的原因是解析器每次请求都生成新的 `X-Conversation-ID`，让每次调用看起来都是新会话（`hit=0`）。

`provider.sessionMode` 决定这个 ID 怎么生成：

- `"prefix"` —— **默认**。由 `messages[0]` 派生，所以同一会话的第 2..n 轮复用同一个 ID 和已缓存前缀，而不同的系统提示 / 开场白会拿到自己的 ID。
- `"stable"` —— 整个进程生命周期共用一个 ID。
- `"random"` —— 每次请求一个新 UUID。旧行为，不命中缓存；只在上游不接受稳定 ID 时当兜底。

多轮实测（`tmp/probe/multiturn.mjs`，三轮、三个不同账号）：`hit=0 → 6144 → 6144`，`credit 1.08 → 0.09 → 0.07`。

### 6. 轮转规则

`rotation.mode` 决定请求如何在池中分配：

- **`sticky`（默认）** —— 有一个「当前账号」，**所有**请求都走它。只有当它失败时，指针才按配置顺序移到下一个账号。因此同一会话的连续几轮都落在同一个账号上，也不会按请求把负载摊开。
- **`lru`** —— 旧行为：每个请求挑「最久未用且未冷却」的账号。

当前账号失败后怎么处理取决于**原因**，只有下面这些算账号级失败：

| 上游结果 | 冷却 | 指针 |
|---|---|---|
| `429` 额度耗尽 | `rotation.cooldownMs`（1 小时） | 换号，在下一个账号上重试 |
| `5xx` 过载 | `rotation.errorCooldownMs`（60 秒） | 换号重试 |
| `401` / `403` | `rotation.errorCooldownMs`（60 秒） | 丢弃缓存的 token，换号重试 |
| 网络中断 / 流中断 | `rotation.errorCooldownMs`（60 秒） | 换号重试 |
| `400` / `404` / `422` | 无 | **不换号** —— 是请求本身有问题，直接把错误返回客户端，而不是冷却整个池 |
| `11128` 渠道校验 | 无 | 不换号 —— 用新的 trace 头在同一账号上重放 |

当前请求会在下一个账号上继续重试，直到某个账号成功。当所有账号都试过或都在冷却时，bridge 返回 `503 all accounts unavailable (n/m tried, k cooling)`，而不是对着已耗尽的池子硬打。成功的响应不会移动指针。

指针状态可以从三处看到：`GET /admin/pool` 里的 `rotation`、看板上的 `当前` 标记、以及 `bridge status` 的 `mode=sticky current=… switches=…`。

流程图：[`docs/request-flow.svg`](docs/request-flow.svg)（同一张图也嵌在 [`docs/DESIGN.md`](docs/DESIGN.md)；改动 `attempt()` 时请同步更新）。

- 同一次账号尝试内，上游主机按 `provider.hosts` 顺序故障切换。
- 流式响应会先窥探第一个 SSE 片段再提交响应头；若其中带 error 事件，在同一账号内切换一次。
- 少数网关节点会把 SSE 返回成「逗号分隔的 ASCII 码」，bridge 会自动解码回标准 SSE。

### 6b. 可能遇到的上游错误码

这些来自 CodeBuddy 的 API（出现在 `[fwd] ERR` 行或响应体里），不是 bridge 造的：

- `11102 "model [...] service info not found"` —— 你发的 `model` 不可用。换成受支持的模型（例如 `hy4-preview-f`、`hy4-preview`、`hy3`）。
- `11134 "the model provider is temporarily unavailable"` —— 上游供应商不可用 / 限流；稍后重试或换模型。
- `11128 "channel verification failed … not sent from an official client"` —— 上游拒绝该调用。两种不同原因，都已处理：
  - **提示词指纹（最常见）。** 上游会拒绝匹配已知 agent harness 指纹的提示词，与请求头无关，而且不只看开头一句、多句片段也会匹配（例如开头是 `You are an AI agent powered by DeepSeek Harness`，或该品牌名出现在后续某段特征句里）。`config.sanitize` 会在转发前按规则顺序改写 `messages[].content`，每次改写都会打印 `[fwd] SAN [<rid>] rewrote N prompt fragment(s)`。**规则顺序重要**：更长、更具体的 `find` 放前面。
  - **概率性单请求拦截。** 偶尔一个正常请求会被拒（"Please send it again"）。bridge 会模仿官方 CLI 的身份头（`User-Agent: CLI/2.168.2 CodeBuddy/2.168.2`、`X-IDE-Type: CLI`、`X-Agent-*`、`X-User-Id`）以及一套新的 per-request trace / request-id，再用新 trace ID 重放（`provider.channelVerifyRetries`，默认 `3`）。**11128 不会让账号进入冷却。**
- `12153 "refresh token is invalid"` —— （轮换后的）refresh token 被拒。bridge 通过自动重抓恢复（见 2b）；如果关了它，请重跑 `scripts/capture-token.mjs`。

### 7. 腾讯云部署

两种暴露方式，选一种。

**（A）私有隧道（推荐，无需开放安全组）**

```bash
# 镜像监听 0.0.0.0:8787，但不要把安全组对公网开放；通过隧道暴露给本地 harness
docker build -t bridge-ai .
docker run -d -p 8787:8787 -v $PWD/config.json:/app/config.json bridge-ai
```

本地反向隧道；harness 访问 `http://127.0.0.1:8787/v1`：

```bash
ssh -N -L 8787:127.0.0.1:8787 tx        # 本地执行，tx = 腾讯云主机别名
```

**（B）直接公网访问（必须配合 `serverApiKey` 鉴权）**

在 `config.json` 里把 `listen.host` 设为 `"0.0.0.0"` 并设置访问密钥：

```json
"listen": { "host": "0.0.0.0", "port": 8787, "serverApiKey": "your-strong-random-key" }
```

bridge 会校验每个请求的密钥（`/healthz` 除外），缺失或错误返回 `401`：

```bash
curl http://<server-ip>:8787/v1/chat/completions \
  -H "Authorization: Bearer your-strong-random-key" \
  -H 'Content-Type: application/json' \
  -d '{"model":"hy4-preview-f","messages":[{"role":"user","content":"hi"}]}'
# 也支持 -H "x-api-key: your-strong-random-key"
```

> **必须**在腾讯云控制台的**安全组**放行入站 TCP `8787`（主机上的 `ufw`/iptables 已确认不拦；用公网 IP 自连超时通常就是安全组没放行）。否则外部访问 `http://<server-ip>:8787/...` 不通。

仅限个人自用、私有链路；不要公开暴露或多人共用（代理订阅额度可能违反厂商服务条款）。

### 8. 日志

bridge 把运行日志写到 stdout（部署时重定向到 `bridge.log`）：

```bash
ssh tx "tail -f /opt/bridge-ai/bridge.log"      # 实时跟踪
ssh tx "grep '\[fwd\]' /opt/bridge-ai/bridge.log"   # 只看转发记录
```

每个请求两行，带一个短请求 ID，并发时也能区分：

```
[fwd] IN  [737826a7] POST /v1/chat/completions model=hy4-preview-f bytes=3120
[fwd] OK  [737826a7] account=cb-1 host=wb.tencentbuddy.com status=200 2347ms
```

- `IN` = 收到请求；`OK`/`ERR` = 转发结果（`account`/`host`/`status`/耗时）。
- `[fwd] SAN [<rid>] rewrote N prompt fragment(s)` 出现在 `config.sanitize` 命中时。
- `[fwd] 11128 retry N/M [<rid>] account=...` 出现在重放渠道校验拦截时。
- 上游错误响应体会附在 `ERR` 行后面（前 500 字符）。
- **默认不记录对话内容。** 想确认 bridge 没有注入东西，可在 `config.json` 顶层打开：

```json
"logOutgoingBody": true
```

打开后每个请求会多一行 `[fwd] OUT <实际发给上游的 body>`（截断 8KB）；写 `"full"` 可输出完整 body。另有 `"logIncomingHeaders": true` 记录收到的客户端头**名称**，`"dumpBodyDir": "/path"` 把每个出站 body 写成 `<rid>.json` 便于离线排查。**注意**：这些会把你的对话内容落盘——只在调试时临时打开，之后务必关掉。

### 9. 密钥：两层、三个文件

涉及两套互不相干的凭证，把它们搞混是最常见的错误：

| 凭证 | 方向 | 存放位置 | 怎么换 |
|---|---|---|---|
| **访问密钥**（`listen.serverApiKey`） | 客户端 → bridge | `config.json`（已 gitignore） | 看板「访问密钥」弹窗，或 `POST /admin/server-key` |
| **账号 token**（access + refresh JWT） | bridge → CodeBuddy | 账号自己的库：`~/.wb-switch/accounts.json`（wbs）或 `bridge.state.json`（refresh 模式） | workbuddy-switch 重新登录；`scripts/capture-token.mjs` |

- 换访问密钥**不会**动账号 token，反之亦然。
- 本机 loopback 调用不需要访问密钥；跨机才需要。只要配置了密钥，`/v1/chat/completions` 就必须带上。
- 所有含密钥的文件都在 gitignore 里：`config.json`、`bridge.state.json`、`README.local.md`。仓库里只有 `config.example.json`。
- 优先用 SSH 隧道而不是把 `:8787` 暴露到公网；如果确实要暴露，密钥保持足够长（自动生成的是 64 位 hex），一旦泄漏就立刻更换。
- `logOutgoingBody` / `dumpBodyDir` 会把对话内容写到磁盘——只用于调试，用完关掉。

## 合规提示

反代复用订阅额度可能触及厂商 ToS 限制。个人自用、私有链路、不开公网、不多人共用风险最低；量产前务必评估合规。
