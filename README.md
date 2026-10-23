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
- `provider.channelVerifyRetries`: how many times to replay a request blocked by `11128` with fresh trace ids (default `3`).
- `sanitize`: `{ "enabled": true, "rules": [{ "find": "…", "replace": "…" }] }` — rewrites matching fragments in `messages[].content` before forwarding. Needed when a client's system prompt matches a fingerprint the upstream rejects with `11128` (see 6b).
- Only `content-type`, `accept` and `accept-language` from the incoming request are relayed upstream; everything else (notably the `x-api-key`/`Authorization` used to gate this bridge) is dropped.
- `accounts[]`: the account pool, supporting several auth modes:
  - `{ "mode": "refresh", "refreshToken": "…", "userId": "…" }` —— **recommended**. Uses the offline refresh token to mint an access token, auto-rotates and persists to `bridge.state.json`, self-sustaining long-term. (See "Capture refresh token" below.)
  - `{ "mode": "apikey", "apiKey": "…" }` —— an API key generated in the CodeBuddy console; simplest and most durable.
  - `{ "mode": "wbs", "uid": "…" }` —— credential owned by [workbuddy-switch](https://github.com/changexbc/workbuddy-switch); normally produced automatically by `accountSource` (see 5c).
  - `{ "mode": "import", "source": "~/.codebuddy" }` —— **does not work for CodeBuddy** (its tokens are not stored in plaintext), kept only as a placeholder / for other vendors.
- `accountSource`: alternative to a hand-maintained `accounts[]` — expands the pool from the workbuddy-switch account library so there is one copy of every credential (see 5c).

### 2. Capture refresh token (first time only / when the token chain breaks)

On the **machine where `codebuddy` is already logged in** (requires root, edits `/etc/hosts` + binds `:443`):

```bash
sudo node scripts/capture-token.mjs --config config.json
# Temporarily points copilot.tencent.com / wb.tencentbuddy.com to localhost and MITMs one request,
# captures X-Refresh-Token, writes it back into config.json, then restores /etc/hosts.
```

The script auto-fills `accounts[].auth.refreshToken` and `userId`. After that the bridge refreshes and rotates on its own — **you normally never need to run it again.**

> Simpler alternative: generate an API key in the CodeBuddy console and use `mode:"apikey"`.

### 2b. Automatic re-capture (self-healing)

The offline refresh token can become invalid server-side over time (upstream returns `code=12153 "refresh token is invalid"`). To avoid manual intervention, the bridge can re-capture a fresh token on its own when that happens.

- Enabled by `"autoRecapture": true` in `config.json` (default on). Requires the bridge to run as **root** and the `codebuddy` CLI to be logged in on the same machine.
- When a refresh fails with `12153`, the bridge briefly runs the same MITM bootstrap as `scripts/capture-token.mjs`: it stops whatever holds `:443` (e.g. nginx), redirects `/etc/hosts`, intercepts one `codebuddy -p` call to grab a fresh `X-Refresh-Token`, writes it into `config.json`, then restores `/etc/hosts` and restarts the stopped service.
- Safety: serialized (one MITM at a time) with a 10-minute cooldown after a failure, and it fails safe — if re-capture can't run, the original request fails rather than looping forever.
- Disable with `"autoRecapture": false` if you prefer to re-capture manually.

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

### 5b. Account dashboard (who is logged in, and what are they doing)

The dashboard is not a separate service: `src/dashboard.html` is served by the bridge itself, so starting the bridge is what starts the dashboard.

```
npm start        # run in the background on config.listen (:8787); prints "already running" if the port is taken
npm run restart  # stop + start, i.e. the way to load new code
npm run status   # RUNNING pid=… healthz=200 dashboard=200
npm run preview  # serve a second instance on :8789 without touching the real one (Ctrl+C to stop)
```

On Windows, if the running process was started with administrator rights, a normal shell cannot kill it: `npm run restart` fails with `cannot stop pid=…: access denied` and exits non-zero (it no longer reports a fake success). Run it from an Administrator terminal.

While the server runs, open `http://127.0.0.1:8787/admin` (or just `/`). It lists every account in the pool with:

- **identity** — the `userId` the account actually presents upstream (taken from `auth.userId`, falling back to the `sub` claim of the refresh token, decoded locally);
- **state** — available / busy (in flight) / cooling, with the remaining cooldown;
- **usage** — current concurrency, total requests, ok / fail, last use, last HTTP status;
- **credentials** — when the refresh token expires and when the in-memory access token expires;
- **last error** — `quota`, `http 401`, `token: … refresh token is invalid`, etc.

It polls every 3s and is a single self-contained file (`src/dashboard.html`): no build step, no CDN, no external assets.

- `GET /admin` — the page itself (contains no data, so no key required).
- `GET /admin/pool` — the same data as JSON. **Free over loopback**, key-gated everywhere else: callers from another machine need `listen.serverApiKey` via `Authorization: Bearer <key>`, `x-api-key: <key>`, or `?key=<key>`.
- The page asks for the key once and stores it in `localStorage`; a deep link like `/admin?key=<key>` also works.
- `node src/index.js status [--json]` prints the same view in the terminal by querying the running server (and says so explicitly when it can't reach it, instead of pretending the pool is idle).
- Counters live in process memory and reset on restart. Secrets are never exposed — only a masked preview plus expiry timestamps.

### 5c. Sharing the account library with workbuddy-switch

[workbuddy-switch](https://github.com/changexbc/workbuddy-switch) keeps a library of logged-in WorkBuddy / CodeBuddy accounts at `~/.wb-switch/accounts.json` (OAuth scan, region, nicknames, credit keep-alive). Instead of maintaining a second copy of those credentials here, point the bridge at that store and let it be the single source of truth:

```json
"accountSource": { "type": "wb-switch", "path": "~/.wb-switch/accounts.json", "variants": ["cn"] },
"accounts": []
```

`path` is optional (defaults to `~/.wb-switch/accounts.json`, overridable with `WBS_ACCOUNTS`). Restart the bridge after adding or removing accounts in workbuddy-switch — the pool is expanded at startup and every account shows up in `/admin`.

How it stays consistent:

- **Reads are always live.** For each request the account entry is re-read from the store; no cached copy lives here.
- **Only mints when needed.** A fresh `access_token` (`expiresAt` more than 60 s away) is used as is. Otherwise the bridge calls `POST /v2/plugin/auth/token/refresh` on the account's own `domain` (with `X-Auth-Refresh-Source: plugin`) and **writes the rotated `access_token` / `refresh_token` / `expiresAt` / `refreshedAt` back into the same file**, atomically, preserving `nickname`, `note`, `auth_raw`, `profile_raw` and everything else. Both tools therefore converge on one token chain instead of invalidating each other.
- **If workbuddy-switch rotated first** (its keep-alive does this daily), a refresh rejected with `12153` re-reads the store once and uses whatever is on disk.
- **Regions are separate gateways, so only CN is on by default.** `variant: "cn"` accounts go to `provider.hosts` (`wb.tencentbuddy.com`). `variant: "ai"` accounts live on a different endpoint (`https://www.codebuddy.ai/v2`) with different rules — its gateway rejects payloads whose first message is not a system prompt (`11128 first message is not system prompt`) — so they are **excluded unless you opt in** with `"variants": ["cn", "ai"]`; then the bridge also prepends a neutral system prompt for those accounts only (override with `provider.defaultSystemPrompt`). Accounts filtered out this way are left untouched in the store and keep being kept alive by workbuddy-switch.
- **No duplicates.** If a static `accounts[]` entry has the same `userId` as a store account, the store one is skipped and a warning is printed. Keep exactly one owner per account: either the store or a static entry, never both.
- **Turn `autoRecapture` off** in this mode. It re-captures whichever account the local CLI is logged into and can write it into the wrong slot; with the store as the source it has nothing left to do.

Entries that cannot be used are listed at startup with a reason (encrypted tokens, `needs_relogin`, variant disabled). Filter with `"variants": ["cn"]` (the default), `"includeUids": [...]` or `"excludeUids": [...]` inside `accountSource`.

### 5d. Prompt-cache reuse (`provider.sessionMode`)

The upstream caches long prompt prefixes and reports it in the final `usage` event (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_read_input_tokens`). Measured on a 7.5k-token system prompt: the first call is full price (`credit` 1.10), later calls come back as `hit=7552 miss=5` with `credit` 0.15–0.06.

Reuse is scoped by the **conversation id**, not by account. The same prefix still hits when the next turn is served by a different account in the pool, so account rotation costs nothing. What used to throw the cache away was the resolver generating a fresh `X-Conversation-ID` UUID on every request, which made every call look like a new conversation (`hit=0` every time).

`provider.sessionMode` decides how that id is built:

- `"prefix"` — **default**. Derived from `messages[0]`, so turn 2..n of one conversation reuse the same id and the cached prefix, while a different system prompt / opening gets its own id.
- `"stable"` — one id for the whole process lifetime.
- `"random"` — a new UUID per request. Old behaviour, no cache reuse; keep it only as a fallback if the upstream ever objects to a stable id.

Multi-turn check (`tmp/probe/multiturn.mjs`, three turns, three different accounts): `hit=0 → 6144 → 6144`, `credit 1.08 → 0.09 → 0.07`.

### 6. Rotation rules

`rotation.mode` decides how requests are routed across the pool:

- **`sticky` (default)** — one account is *current* and serves **every** request. The pointer only moves to the next account in config order when that account fails. Consecutive turns of a conversation therefore stay on one account, and the pool is not spread per request.
- **`lru`** — the old behaviour: every request picks the least-recently-used, non-cooling account.

When the current account fails, what happens depends on *why*, and only these count as account-level failures:

| Upstream result | Cooldown | Pointer |
|---|---|---|
| `429` quota exhausted | `rotation.cooldownMs` (1 h) | advance, retry on the next account |
| `5xx` overloaded | `rotation.errorCooldownMs` (60 s) | advance, retry on the next account |
| `401` / `403` | `rotation.errorCooldownMs` (60 s) | drop the cached token, advance, retry |
| network / stream interrupted | `rotation.errorCooldownMs` (60 s) | advance, retry on the next account |
| `400` / `404` / `422` | none | **no rotation** — the request itself is wrong, so the error is returned to the client instead of cooling the whole pool |
| `11128` channel verification | none | no rotation — retried on the same account with fresh trace headers |

The current request is retried on each next account until one succeeds. When every account has been tried or is cooling, the bridge answers `503 all accounts unavailable (n/m tried, k cooling)` instead of hammering an exhausted pool. A successful response keeps the pointer where it is.

The live pointer is visible as `rotation` in `GET /admin/pool`, as the `当前` badge on the dashboard, and as `mode=sticky current=… switches=…` in `bridge status`.

- Upstream hosts fail over in `provider.hosts` order within one account attempt.
- For streaming responses, the first SSE chunk is peeked before headers are sent upstream; on an error event it fails over once within the same account.
- A few gateway nodes return SSE as "comma-separated ASCII codes"; the bridge auto-decodes it back to normal SSE.

### 6b. Upstream error codes you may see

These come from CodeBuddy's API (in the `[fwd] ERR` line or the response body), not from the bridge:

- `11102 "model [...] service info not found"` — the `model` you sent isn't available. Use a supported model (e.g. `hy4-preview-f`, `hy4-preview`, `hy3`).
- `11134 "the model provider is temporarily unavailable"` — upstream provider is down/rate-limited; retry later or switch model.
- `11128 "channel verification failed … not sent from an official client"` — the upstream rejects the call. Two distinct causes, both handled:
  - **Prompt fingerprint (the common one).** The upstream rejects prompts that match fingerprints of known agent harnesses, regardless of headers. It matches multi-sentence fragments too, not just the opening line — e.g. `You are an AI agent powered by DeepSeek Harness` at the start, or that brand name appearing later in a distinctive sentence pair. `config.sanitize` rewrites configured fragments (all messages, in rule order) before forwarding; each rewrite is logged as `[fwd] SAN [<rid>] rewrote N prompt fragment(s)`. Rule order matters: put the longer, more specific `find` first.
  - **Probabilistic per-request gate.** Occasionally a normal request is rejected ("Please send it again"). The bridge mirrors the official CLI identity headers (`User-Agent: CLI/2.168.2 CodeBuddy/2.168.2`, `X-IDE-Type: CLI`, `X-Agent-*`, `X-User-Id`) and a fresh per-request trace/request-id family, then replays with new trace IDs (`provider.channelVerifyRetries`, default `3`). The account is never put on cooldown for 11128.
- `12153 "refresh token is invalid"` — the (rotated) refresh token was rejected. The bridge auto-recovers via auto-recapture (see 2b); if disabled, re-run `scripts/capture-token.mjs`.

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

Two lines per request, tagged with a short request id so concurrent calls stay distinguishable:

```
[fwd] IN  [737826a7] POST /v1/chat/completions model=hy4-preview-f bytes=3120
[fwd] OK  [737826a7] account=cb-1 host=wb.tencentbuddy.com status=200 2347ms
```

- `IN` = request received; `OK`/`ERR` = forwarding result (`account`/`host`/`status`/latency).
- `[fwd] SAN [<rid>] rewrote N prompt fragment(s)` appears when a `config.sanitize` rule matched.
- `[fwd] 11128 retry N/M [<rid>] account=...` appears when a channel-verification block is being replayed.
- The upstream error response body (first 500 chars) is appended to the `ERR` line.
- **Conversation content is not logged by default.** To verify the bridge isn't injecting anything, enable at the top level of `config.json`:

```json
"logOutgoingBody": true
```

When enabled, an extra `[fwd] OUT <actual body sent upstream>` line (truncated to 8KB) is logged per request; use `"full"` instead of `true` to log the whole body. There is also `"logIncomingHeaders": true` to record the *names* of the client headers received, and `"dumpBodyDir": "/path"` to write each outgoing body to `<rid>.json` for offline bisection. **Note**: these persist your conversation content to disk — enable only temporarily for debugging, then remove/disable them.
