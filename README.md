# bridge-ai

> ⚠️ **This project targets the [Tencent CodeBuddy](https://www.codebuddy.cn) CLI only** (`@tencent-ai/codebuddy-code`).
> It maps a CodeBuddy subscription plan quota into an OpenAI-compatible HTTP endpoint, for use by a local harness or any OpenAI-protocol client.
> It does **not** support other CLIs such as Claude Code / Codex / Kimi Code — those belong to other projects.

## What it does

After the CodeBuddy CLI logs in, it holds a subscription token. Without modifying the CLI source, this project **takes over its outbound chat requests, injects the subscription token, and re-exposes it as an OpenAI-compatible `/v1/chat/completions`**:

- OpenAI-compatible receiver (local / remote) → inject CodeBuddy subscription token → forward to `wb.tencentbuddy.com` → SSE passthrough
- Multi-account rotation, automatic refresh-token renewal & rotation, and upstream host failover

## Directory layout

```
bridge-ai/
├── README.md          # This file: overview and quick start (CodeBuddy only)
└── docs/
    ├── RESEARCH.md    # Survey of existing open-source approaches (background)
    └── DESIGN.md      # Implementation design + minimal viable sketch
```

## Glossary

- **bridge**: the proxy / bridging service implemented by this project
- **upstream client**: the client that calls the bridge (local harness, Cursor, IDE plugins, etc.)
- **vendor endpoint**: Tencent CodeBuddy's real API (`wb.tencentbuddy.com` / `copilot.tencent.com`)

---

## Running (Approach A · CodeBuddy-specific relay, implemented)

Zero-dependency Node implementation: OpenAI-compatible receiver → inject CodeBuddy subscription token → forward to `wb.tencentbuddy.com` → SSE passthrough, with multi-account rotation.

### 0. CodeBuddy real endpoint (verified)

- Chat endpoint: `https://wb.tencentbuddy.com/v2/chat/completions` (primary), `https://copilot.tencent.com/v2/chat/completions` (failover).
  - ⚠️ **The path is `/v2/chat/completions` — not `/v1/` and not a bare `/chat/completions`.**
  - `copilot.tencent.com` at the same path returns account info rather than chat; the endpoint that actually streams tokens is `wb.tencentbuddy.com`.
  - The upstream **only accepts streaming** (`stream:true`); a non-stream request gets an immediate `400`.
- Auth: in addition to the standard `Authorization: Bearer <accessToken>`, the following identity headers are required: `X-Product: SaaS`, `X-Domain: www.codebuddy.cn`, `X-User-Id: <uid>`, `x-codebuddy-request: 1`.
- Tokens come as **two** JWTs:
  - access token (RS256, `typ:Bearer`, ~28 days) — used as the Bearer for chat.
  - refresh token (HS512, `typ:Offline`, ~30 days) — used to call `/v2/plugin/auth/token/refresh` to mint a new access token; **that endpoint also returns a new refresh token (rotatable).**
- CodeBuddy does not persist these two tokens in plaintext on disk, so below we use a "refresh-and-mint" mode rather than reading files directly.

### 1. Configuration

```bash
cp config.example.json config.json
```

Key fields in `config.json`:

- `provider.hosts` / `provider.path`: upstream host array + path. `hosts` defaults to `["wb.tencentbuddy.com","copilot.tencent.com"]`, `path` defaults to `/v2/chat/completions`.
- `provider.identity`: identity headers to inject (defaults to `X-Product: SaaS`, `X-Domain: www.codebuddy.cn`).
- `accounts[]`: the account pool, supporting several auth modes:
  - `{ "mode": "refresh", "refreshToken": "…", "userId": "…" }` —— **recommended**. Uses the offline refresh token to mint an access token, auto-rotates and persists to `bridge.state.json`, self-sustaining long-term. (See "Capture refresh token" below.)
  - `{ "mode": "apikey", "apiKey": "…" }` —— an API key generated in the CodeBuddy console; simplest and most durable.
  - `{ "mode": "import", "source": "~/.codebuddy" }` —— **does not work for CodeBuddy** (its tokens are not stored in plaintext), kept only as a placeholder / for other vendors.

### 2. Capture refresh token (first time only / when the token chain breaks)

On the **machine where `codebuddy` is already logged in** (requires root, edits `/etc/hosts` + binds `:443`):

```bash
sudo node scripts/capture-token.mjs --config config.json
# Temporarily points copilot.tencent.com / wb.tencentbuddy.com to localhost and MITMs one request,
# captures X-Refresh-Token, writes it back into config.json, then restores /etc/hosts.
```

The script auto-fills `accounts[].auth.refreshToken` and `userId`. After that the bridge refreshes and rotates on its own — **you normally never need to run it again.**

> Simpler alternative: generate an API key in the CodeBuddy console and use `mode:"apikey"`.

### 3. Verify credentials

```bash
node src/index.js login    # verify each account can mint an access token
node src/index.js status   # view account pool / rotation status
```

### 4. Start

```bash
node src/index.js server                 # defaults to 127.0.0.1:8787
# or BRIDGE_CONFIG=/path/to/config.json node src/index.js server
```

### 5. Calling it

Point your local harness at it (standard OpenAI protocol; `stream` is forced to `true` by the bridge):

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

### 6. Rotation rules

- Each request picks the "least-recently-used and not-cooled-down" account; upstream hosts fail over in `provider.hosts` order.
- Upstream `401` → mark auth error and clear cache to re-mint token; `429` → mark quota exhausted, cool down for `rotation.cooldownMs`, then rotate to the next account.
- For streaming responses, the first SSE chunk is peeked before headers are sent upstream; on an error event it fails over once within the same account.
- A few gateway nodes return SSE as "comma-separated ASCII codes"; the bridge auto-decodes it back to normal SSE.

### 7. Tencent Cloud deployment

Two exposure options, pick one.

**(A) Private tunnel (recommended, no security-group opening needed)**

```bash
# Image listens on 0.0.0.0:8787, but do NOT open the security group to the public; expose to the local harness via a tunnel
docker build -t bridge-ai .
docker run -d -p 8787:8787 -v $PWD/config.json:/app/config.json bridge-ai
```

Local reverse tunnel; the harness accesses `http://127.0.0.1:8787/v1`:

```bash
ssh -N -L 8787:127.0.0.1:8787 tx        # run locally, tx = Tencent Cloud alias
```

**(B) Direct public access (must pair with `serverApiKey` auth)**

Set `listen.host: "0.0.0.0"` in `config.json` and set an access key:

```json
"listen": { "host": "0.0.0.0", "port": 8787, "serverApiKey": "your-strong-random-key" }
```

The bridge validates the key on every request (except `/healthz`); missing/wrong returns `401`:

```bash
curl http://43.130.49.34:8787/v1/chat/completions \
  -H "Authorization: Bearer your-strong-random-key" \
  -H 'Content-Type: application/json' \
  -d '{"model":"hy4-preview-f","messages":[{"role":"user","content":"hi"}]}'
# also accepted: -H "x-api-key: your-strong-random-key"
```

> **Required**: open inbound TCP `8787` in the Tencent Cloud console **security group** (the host `ufw`/iptables is confirmed not blocking; a timeout when self-connecting via the public IP indicates the security group is not open). Otherwise `http://43.130.49.34:8787/...` is unreachable from outside.

For personal, private use only; do not expose publicly or share across multiple users (proxying a subscription quota may conflict with the vendor's Terms of Service).

### 8. Logging

The bridge writes its runtime log to stdout at startup (redirected to `bridge.log` in deployment):

```bash
ssh tx "tail -f /opt/bridge-ai/bridge.log"      # live tail
ssh tx "grep '\[fwd\]' /opt/bridge-ai/bridge.log"   # forwarding records only
```

Two lines per request:

```
[fwd] IN  POST /v1/chat/completions model=hy4-preview-f
[fwd] OK  account=cb-1 host=wb.tencentbuddy.com status=200 2347ms
```

- `IN` = request received; `OK`/`ERR` = forwarding result (`account`/`host`/`status`/latency).
- The upstream error response body (first 500 chars) is appended to the `ERR` line.
- **Conversation content is not logged by default.** To verify the bridge isn't injecting anything, enable at the top level of `config.json`:

```json
"logOutgoingBody": true
```

When enabled, an extra `[fwd] OUT <actual body sent upstream>` line (truncated to 8KB) is logged per request, proving the bridge only passes through your `messages`. **Note**: this persists your conversation content to disk — enable only temporarily for debugging, then set it back to `false`.
