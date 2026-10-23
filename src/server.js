import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectAccount,
  selectByRotation,
  createRotation,
  advanceRotation,
  markUsed,
  markExhausted,
  markAuthError,
  clearError,
  beginCall,
  endCall,
} from './accounts.js';
import { resolveToken, refreshToken } from './auth-codebuddy.js';
import { forwardRequest, UpstreamHttpError, UpstreamStreamError } from './proxy.js';
import { classifyStatus } from './quota.js';
import { buildStatus } from './status.js';
import { redact } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_FILE = path.join(HERE, 'dashboard.html');

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'upgrade',
]);

// Client headers that are safe to relay upstream. Everything else is dropped —
// in particular x-api-key / authorization (they authenticate to *this* bridge)
// and SDK-specific markers (x-stainless-*, openai-*) that make the upstream
// treat the call as a non-official client.
const FORWARDABLE = new Set(['content-type', 'accept', 'accept-language']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function filterOutHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export function createServer({ config, pool, configPath = null, reloadAccounts = null }) {
  const provider = config.provider || {};
  const hosts = provider.hosts && provider.hosts.length
    ? provider.hosts
    : [provider.baseUrl ? new URL(provider.baseUrl).host : 'wb.tencentbuddy.com'];
  const upstreamPath = provider.path || '/v2/chat/completions';
  const authHeader = provider.authHeader || 'Authorization';
  const authScheme = provider.authScheme || 'Bearer';
  const identity = provider.identity || { 'X-Product': 'SaaS', 'X-Domain': 'www.codebuddy.cn' };
  // Official CodeBuddy CLI identity markers. The upstream runs a "channel
  // verification" (error 11128) that intermittently rejects relay requests not
  // sent from the official client; mirroring these headers makes gated/flagged
  // requests pass. Override via provider.clientHeaders in config if needed.
  const cliIdentity =
    provider.clientHeaders && typeof provider.clientHeaders === 'object'
      ? provider.clientHeaders
      : {
          'User-Agent': 'CLI/2.168.2 CodeBuddy/2.168.2',
          'X-IDE-Type': 'CLI',
          'X-IDE-Name': 'CLI',
          'X-IDE-Version': '2.168.2',
          'X-Agent-Purpose': 'conversation',
          'X-Agent-Intent': 'craft',
          'X-Agent-Runtime': 'other',
          'X-Agent-Type': 'main',
          'X-Private-Data': 'false',
        };
  // Per-request trace/request-id family the CLI attaches (fresh each call).
  //
  // The conversation id is different: the upstream uses it as the scope of
  // prompt caching, so a fresh UUID per call makes every request look like a
  // brand-new conversation and the cache is never reused (measured: hit=0,
  // full price). Modes:
  //   "prefix" (default) — derive it from the first message, so every turn of
  //                        one conversation reuses the same id and multi-turn
  //                        requests keep hitting the cached prefix; different
  //                        systems / openings get different ids.
  //   "stable"           — one id for the whole process.
  //   "random"           — old behaviour, no cache reuse.
  const sessionMode = ['prefix', 'stable', 'random'].includes(provider.sessionMode)
    ? provider.sessionMode
    : 'prefix';
  const stableConvId = crypto.randomUUID();

  function conversationIdFor(bodyText, alreadyParsed) {
    if (sessionMode === 'random') return crypto.randomUUID();
    if (sessionMode === 'stable') return stableConvId;
    // The cache is anchored on the prompt prefix, so the first message is the
    // right identity for a conversation: turn 2..n keep it unchanged.
    let first = null;
    const parsedBody = alreadyParsed || (() => {
      try {
        return JSON.parse(bodyText);
      } catch {
        return null;
      }
    })();
    if (parsedBody && Array.isArray(parsedBody.messages)) first = parsedBody.messages[0];
    if (!first) return stableConvId;
    const content = typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '');
    const h = crypto.createHash('sha256').update(`${first.role}:${content}`).digest('hex').slice(0, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  function cliTraceHeaders(convId) {
    const rid = crypto.randomUUID().replace(/-/g, '');
    const span = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const parent = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const traceId = crypto.randomUUID().replace(/-/g, '');
    convId = convId || crypto.randomUUID();
    return {
      'X-Request-ID': rid,
      'X-Root-Request-ID': rid,
      'X-Conversation-Request-ID': rid,
      'X-Conversation-Message-ID': rid,
      'X-Conversation-ID': convId,
      'X-Trace-ID': traceId,
      'traceparent': `00-${traceId}-${parent}-01`,
      'b3': `${traceId}-${parent}-1-${span}`,
      'X-B3-TraceId': traceId,
      'X-B3-SpanId': span,
      'X-B3-ParentSpanId': parent,
      'X-B3-Sampled': '1',
      baggage: `codebuddy.session_id=${convId},codebuddy.conversation_request_id=${rid}`,
    };
  }
  const timeout = provider.timeout || 120000;
  const cooldownMs = (config.rotation && config.rotation.cooldownMs) || 3600000;
  // Short cooldown for transient / credential problems (5xx, network, 401/403):
  // long enough not to bounce straight back, short enough to recover quickly.
  const errorCooldownMs = Math.min(cooldownMs, (config.rotation && config.rotation.errorCooldownMs) || 60000);
  // Which account serves traffic, and when the pointer moves to the next one.
  const rotation = createRotation(config);

  // Sticky: one current account for the whole process. LRU: re-pick per request.
  function pickAccount(attempted) {
    return rotation.mode === 'lru'
      ? selectAccount(pool, attempted)
      : selectByRotation(pool, rotation, attempted);
  }
  // Optional: log the exact body sent upstream (off by default; may contain conversation content).
  const logOutgoingBody = !!(config.logOutgoingBody);
  // Upstream "channel verification" (11128) is probabilistic per request and its
  // own message says "Please send it again". Retry with a fresh trace/request-id
  // set; it is NOT an account problem, so never put the account on cooldown.
  const verifyRetries = Number.isFinite(provider.channelVerifyRetries)
    ? provider.channelVerifyRetries
    : 3;

  function isChannelVerify(e) {
    if (!(e instanceof UpstreamHttpError)) return false;
    const m = String(e.message || '');
    return m.includes('11128') || /unapproved channel/i.test(m);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // config.sanitize.rules: [{ find, replace }] applied to message contents.
  const sanitizeCfg = config.sanitize || {};
  const sanitizeRules = sanitizeCfg.enabled
    ? (sanitizeCfg.rules || []).filter(
        (r) => r && typeof r.find === 'string' && r.find && typeof r.replace === 'string'
      )
    : [];

  const ctx = { hosts, identity };
  // Optional gate for incoming requests (useful when bound to 0.0.0.0).
  // Mutable: the dashboard can rotate it at runtime (see handleServerKey), and a
  // restart must not be needed for the new value to take effect.
  const keyField = config.listen ? 'listen.serverApiKey' : 'serverApiKey';
  // "auto" only ever exists before the first start has minted a real key; treat
  // it as "no key yet" rather than as a literal secret.
  const rawKey = (config.listen && config.listen.serverApiKey) || config.serverApiKey || null;
  let serverKey = rawKey && rawKey !== 'auto' ? rawKey : null;

  // Runtime counters surfaced by /admin/pool. `startedAt` is when this server
  // instance came up, not when the process started.
  const startedAt = Date.now();
  const stats = { total: 0, ok: 0, err: 0, inFlight: 0 };

  function queryParam(url, name) {
    try {
      return new URL(url, 'http://placeholder').searchParams.get(name);
    } catch {
      return null;
    }
  }

  function serverAuthOk(req) {
    if (!serverKey) return true;
    const auth = req.headers['authorization'];
    const xkey = req.headers['x-api-key'];
    if (auth && auth === `Bearer ${serverKey}`) return true;
    if (xkey === serverKey) return true;
    // Convenience for curl / a bookmarked dashboard URL; never used by the page.
    return queryParam(req.url, 'key') === serverKey;
  }

  // Requests arriving over loopback are exempt from the key on *read-only*
  // endpoints (the pool view). Rationale: a browser cannot attach an
  // Authorization header to a plain page load, and whoever can reach the bridge
  // over loopback can already read config.json — the key adds nothing there.
  // Chat traffic (/v1/chat/completions) is never exempt, and neither is anything
  // coming in over the network.
  function isLoopback(req) {
    const addr = (req.socket && req.socket.remoteAddress) || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function sendDashboard(res) {
    fs.readFile(DASHBOARD_FILE, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`dashboard.html missing: ${err.message}`);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
    });
  }

  // --- this bridge's own access key ----------------------------------------
  //
  // Not an account token: this is the secret clients must send as
  // `Authorization: Bearer <key>` when they call /v1/chat/completions.
  //
  // GET  /admin/server-key                -> current key (plaintext, for copying)
  // POST /admin/server-key {"key":"…"}    -> write it into config.json and swap
  //      the value the running process checks.
  //
  // The file is written *first*: if it cannot be written the live key stays as
  // it was, so config.json and the process never disagree about what the key is.
  async function handleServerKey(req, res) {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        key: serverKey,
        configured: !!serverKey,
        field: keyField,
        configPath: configPath || null,
        header: 'Authorization: Bearer <key>',
      });
    }
    let body = null;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    }
    const next = String(body.key || '').trim();
    if (!/^[A-Za-z0-9._~+/-]{16,256}$/.test(next)) {
      return sendJson(res, 400, {
        error: { message: 'key must be 16-256 chars of A-Z a-z 0-9 . _ ~ + / -' },
      });
    }
    if (!configPath) {
      return sendJson(res, 500, { error: { message: 'config path unknown; edit config.json by hand' } });
    }
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.listen && typeof cfg.listen === 'object') cfg.listen.serverApiKey = next;
      else cfg.serverApiKey = next;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    } catch (e) {
      return sendJson(res, 500, { error: { message: `could not write ${configPath}: ${e.message}` } });
    }
    serverKey = next;
    if (config.listen) config.listen.serverApiKey = next;
    else config.serverApiKey = next;
    console.log(`[bridge] server api key updated (${redact(next)}) -> ${configPath}`);
    return sendJson(res, 200, {
      ok: true,
      key: next,
      field: keyField,
      configPath,
    });
  }

  async function handleChat(req, res) {
    stats.total += 1;
    stats.inFlight += 1;
    res.on('close', () => {
      stats.inFlight = Math.max(0, stats.inFlight - 1);
    });
    let bodyStr = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
      return;
    }
    const stream = true; // CodeBuddy chat API only supports streaming
    // Force streaming in the upstream body (non-stream is rejected upstream).
    parsed.stream = true;
    const t0 = Date.now();
    const rid = crypto.randomUUID().slice(0, 8);

    // The upstream fingerprints the system prompt of known agent harnesses: a
    // prompt opening with e.g. "You are an AI agent powered by DeepSeek
    // Harness." is rejected with 11128 regardless of headers. Optional rewrite
    // rules (config.sanitize) neutralise those signatures.
    let sanitized = 0;
    if (sanitizeRules.length && Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) {
        if (typeof m.content !== 'string') continue;
        for (const rule of sanitizeRules) {
          if (!m.content.includes(rule.find)) continue;
          m.content = m.content.split(rule.find).join(rule.replace);
          sanitized += 1;
        }
      }
    }

    bodyStr = JSON.stringify(parsed);
    console.log(`[fwd] IN  [${rid}] ${req.method} ${req.url} model=${parsed.model || '?'} bytes=${Buffer.byteLength(bodyStr)}`);
    if (config.dumpBodyDir) {
      try {
        fs.mkdirSync(config.dumpBodyDir, { recursive: true });
        fs.writeFileSync(path.join(config.dumpBodyDir, `${rid}.json`), bodyStr);
      } catch (e) {
        console.log(`[fwd] dump failed: ${e.message}`);
      }
    }
    if (sanitized) console.log(`[fwd] SAN [${rid}] rewrote ${sanitized} prompt fragment(s)`);
    if (config.logIncomingHeaders) {
      console.log(`[fwd] HDR [${rid}] ${Object.keys(req.headers).sort().join(',')}`);
    }
    if (logOutgoingBody) {
      // logOutgoingBody: true -> first 8KB; "full" -> everything.
      const limit = config.logOutgoingBody === 'full' ? Infinity : 8000;
      const preview = bodyStr.length > limit ? bodyStr.slice(0, limit) + '…[truncated]' : bodyStr;
      console.log(`[fwd] OUT [${rid}] ${preview}`);
    }

    // Copy only benign payload headers upstream. Never forward the headers used
    // to gate *this* bridge (x-api-key / authorization) or arbitrary client
    // markers: the upstream rejects requests carrying unexpected auth headers
    // (401 invalid_format) and its channel check is sensitive to stray headers.
    const incoming = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (FORWARDABLE.has(k.toLowerCase())) incoming[k] = v;
    }

    const attempt = async (attempted) => {
      const account = pickAccount(attempted);
      if (!account) {
        const cooling = pool.filter((a) => Date.now() < a.exhaustedUntil).length;
        throw new UpstreamHttpError(
          503,
          pool.length === 0
            ? 'no account configured — the pool is empty; add one via accountSource or accounts[] (see README "1. Configuration")'
            : `all accounts unavailable (${attempted.size}/${pool.length} tried, ${cooling} cooling)`
        );
      }
      attempted.add(account);
      markUsed(account);

      // One "call" per (client request, account). Opened before the token is
      // resolved so a dead credential shows up on the dashboard instead of
      // looking like zero traffic; closed exactly once via settle().
      beginCall(account);
      let settled = false;
      const settle = (opts) => {
        if (settled) return;
        settled = true;
        endCall(account, opts);
        if (opts.ok) stats.ok += 1;
        else stats.err += 1;
      };

      let tokenReady = false;
      try {
        const token = await resolveToken(account, ctx);
        tokenReady = true;
        const uid = (account.auth && account.auth.userId) || ctx.userId;
        // The international gateway requires messages[0] to be a system prompt;
        // prepend a neutral one per account so CN accounts keep the client body
        // exactly as sent.
        let sendBody = bodyStr;
        if (account.needsSystemPrompt) {
          const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
          if (!msgs.length || msgs[0].role !== 'system') {
            const sys =
              (provider.defaultSystemPrompt && String(provider.defaultSystemPrompt)) ||
              'You are a helpful AI assistant.';
            sendBody = JSON.stringify({ ...parsed, messages: [{ role: 'system', content: sys }, ...msgs] });
          }
        }
        let lastErr;
        // Set when the failure is the account's fault — only then does the
        // rotation pointer move on to the next account.
        let rotate = false;
        // An account may pin its own upstream hosts (international accounts do).
        const acctHosts = account.chatHosts || hosts;
        // Derived from the prompt prefix so the upstream cache can be reused.
        const convId = conversationIdFor(sendBody, sendBody === bodyStr ? parsed : null);
        // Round 0 is the normal try; later rounds replay the same payload with new
        // trace headers to get past an intermittent 11128 channel-verification block.
        for (let round = 0; round <= verifyRetries; round++) {
          if (round > 0) {
            console.log(`[fwd] 11128 retry ${round}/${verifyRetries} [${rid}] account=${account.name}`);
            await sleep(200 + Math.floor(Math.random() * 300) * round);
          }
          let blocked = false;
          for (const host of acctHosts) {
            const headers = {
              ...incoming,
              ...identity,
              // The official CLI sends the account's user id on chat calls too;
              // omitting it is one of the signals its channel check looks at.
              ...(uid ? { 'X-User-Id': uid } : {}),
              ...cliIdentity,
              ...cliTraceHeaders(convId),
              'x-codebuddy-request': '1',
              [authHeader]: `${authScheme} ${token}`,
              host,
            };
            try {
              const r = await forwardRequest({
                baseUrl: `https://${host}`,
                path: upstreamPath,
                method: 'POST',
                headers,
                bodyStr: sendBody,
                stream,
                timeout,
              });
              settle({ status: r.status, ok: true });
              clearError(account);
              console.log(`[fwd] OK  [${rid}] account=${account.name} host=${host} status=${r.status} ${Date.now() - t0}ms`);
              return r;
            } catch (e) {
              lastErr = e;
              if (isChannelVerify(e)) {
                blocked = true;
                continue; // retryable at request level, not host/account level
              }
              if (e instanceof UpstreamHttpError) {
                const cls = classifyStatus(e.status);
                if (cls === 'auth') {
                  refreshToken(account); // drop cached token; next resolve re-reads
                  break; // auth error is account-level, don't retry other hosts
                }
                // host-level failure -> try next host
              }
              // fall through to next host
            }
          }
          if (!blocked) break;
        }
        if (lastErr) {
          if (lastErr instanceof UpstreamHttpError) {
            // 11128 is a per-request gate failure: do not penalise the account.
            if (!isChannelVerify(lastErr)) {
              const cls = classifyStatus(lastErr.status);
              if (cls === 'quota') {
                // 429: this account's quota is gone. Step aside for a long time.
                markExhausted(account, cooldownMs, 'quota');
                rotate = true;
              } else if (cls === 'auth') {
                // 401/403: credential is dead. Re-read it next time, and give the
                // pointer a reason not to come straight back here.
                refreshToken(account);
                markAuthError(account, `status ${lastErr.status}`, errorCooldownMs);
                rotate = true;
              } else if (cls === 'retryable') {
                // 5xx: overloaded upstream. Brief cooldown, then step aside.
                markExhausted(account, errorCooldownMs, `http ${lastErr.status}`);
                rotate = true;
              }
              // Anything else (400/404/422…): the *request* is wrong, not the
              // account. Pass it back to the client instead of cooling the pool.
            }
          } else if (lastErr instanceof UpstreamStreamError) {
            markExhausted(account, errorCooldownMs, 'stream_error');
            rotate = true;
          } else {
            // DNS / TCP reset / timeout: account-level enough to try elsewhere.
            markExhausted(account, errorCooldownMs, `network: ${String(lastErr.message || lastErr).slice(0, 60)}`);
            rotate = true;
          }
        }
        settle({
          status: lastErr instanceof UpstreamHttpError ? lastErr.status : null,
          ok: false,
        });
        if (!lastErr) throw new Error('upstream attempt produced no result');
        if (rotate) advanceRotation(pool, rotation, account);
        if (rotate && attempted.size < pool.length) return attempt(attempted);
        throw lastErr;
      } catch (e) {
        settle({ status: e instanceof UpstreamHttpError ? e.status : null, ok: false });
        // A dead credential is account-level, not request-level: rotate to the
        // next account when there is one instead of failing the client call.
        if (!tokenReady) {
          // Dead credential: account-level. Cool it, step aside, retry elsewhere.
          markAuthError(account, `token: ${String(e.message || e).slice(0, 80)}`, errorCooldownMs);
          advanceRotation(pool, rotation, account);
          if (attempted.size < pool.length) return attempt(attempted);
        }
        throw e;
      }
    };

    try {
      const r = await attempt(new Set());
      const outHeaders = filterOutHeaders(r.headers);
      if (!stream || !r.streaming) {
        res.writeHead(r.status, outHeaders);
        res.end(r.body || Buffer.alloc(0));
      } else {
        res.writeHead(r.status, outHeaders);
        r.stream.pipe(res);
        r.stream.on('error', () => {
          try {
            res.end();
          } catch {}
        });
      }
    } catch (e) {
      console.log(`[fwd] ERR [${rid}] ${Date.now() - t0}ms ${e.message}`);
      if (e instanceof UpstreamHttpError) {
        res.writeHead(e.status >= 400 && e.status < 600 ? e.status : 502, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ error: { message: e.message, type: 'bridge_upstream_error' } }));
      } else if (e instanceof UpstreamStreamError) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream stream error', detail: e.detail } }));
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String((e && e.message) || e) } }));
      }
    }
  }

  // POST /admin/current {"index": n} — pin the rotation pointer to one account.
  // Only meaningful in sticky mode (the default): in lru every request re-picks.
  async function handleSetCurrent(req, res) {
    let body = null;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      body = null;
    }
    const i = body ? Number(body.index) : NaN;
    if (!Number.isInteger(i) || i < 0 || i >= pool.length) {
      return sendJson(res, 400, {
        error: { message: `index must be an integer in 0..${Math.max(0, pool.length - 1)}` },
      });
    }
    if (rotation.mode !== 'sticky') {
      return sendJson(res, 409, {
        error: {
          message:
            'rotation.mode is "lru", so every request re-picks an account and a manual pin would not stick — set rotation.mode to "sticky" and restart',
        },
      });
    }
    const account = pool[i];
    // A deliberate human override: lift the cooldown too, otherwise the pointer
    // would land on an account that every request immediately skips.
    const wasCooling = Date.now() < account.exhaustedUntil;
    account.exhaustedUntil = 0;
    account.consecutiveFails = 0;
    rotation.index = i;
    rotation.switchedAt = Date.now();
    rotation.manualAt = Date.now();
    console.log(
      `[bridge] current account pinned to "${account.name}" (index ${i}) from the dashboard` +
        (wasCooling ? ' — cooldown cleared' : '')
    );
    return sendJson(res, 200, {
      ok: true,
      index: i,
      name: account.name,
      clearedCooldown: wasCooling,
    });
  }

  const handler = (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    let pathname = req.url;
    try {
      pathname = new URL(req.url, 'http://placeholder').pathname;
    } catch {}
    // The dashboard shell carries no data and is loaded by a plain browser
    // navigation (which cannot send an Authorization header), so it is served
    // before the key check. It then fetches /admin/pool with the key from
    // localStorage — that endpoint stays protected.
    if (req.method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname === '/admin/')) {
      sendDashboard(res);
      return;
    }
    // Read-only pool view: free over loopback, key-gated from the network.
    if (req.method === 'GET' && pathname === '/admin/pool') {
      if (!isLoopback(req) && !serverAuthOk(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized: missing or invalid server api key' } }));
        return;
      }
      sendJson(res, 200, buildStatus({ config, pool, startedAt, stats, rotation }));
      return;
    }
    // The bridge's own access key (Authorization: Bearer <key>). Same gate as
    // the pool view: free over loopback, the current key is required from the
    // network — otherwise anyone on the LAN could rotate it and lock you out.
    if ((req.method === 'GET' || req.method === 'POST') && pathname === '/admin/server-key') {
      if (!isLoopback(req) && !serverAuthOk(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized: missing or invalid server api key' } }));
        return;
      }
      handleServerKey(req, res).catch((e) => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: String((e && e.message) || e) } });
      });
      return;
    }
    // Re-read the account store on demand. The store is watched while the server
    // runs, so this is the escape hatch (watch unavailable, network path, …).
    if (req.method === 'POST' && pathname === '/admin/reload') {
      if (!isLoopback(req) && !serverAuthOk(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized: missing or invalid server api key' } }));
        return;
      }
      if (!reloadAccounts) {
        sendJson(res, 501, { error: { message: 'this instance is not reading an account store' } });
        return;
      }
      let out;
      try {
        out = reloadAccounts();
      } catch (e) {
        out = { ok: false, error: String((e && e.message) || e) };
      }
      sendJson(res, out && out.ok === false ? 500 : 200, out);
      return;
    }
    // Pick which account is "current" by hand instead of waiting for a failure.
    // A write, so the same gate as rotating the key: loopback is free, the
    // network needs the current key.
    if (req.method === 'POST' && pathname === '/admin/current') {
      if (!isLoopback(req) && !serverAuthOk(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized: missing or invalid server api key' } }));
        return;
      }
      handleSetCurrent(req, res).catch((e) => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: String((e && e.message) || e) } });
      });
      return;
    }
    if (!serverAuthOk(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized: missing or invalid server api key' } }));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      handleChat(req, res).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String((e && e.message) || e) } }));
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  };

  const srv = http.createServer(handler);
  // A live account reload rebuilds `pool` in place and remaps the rotation
  // pointer, so the pointer has to be reachable from the reloader (index.js).
  srv.rotation = rotation;
  return srv;
}
