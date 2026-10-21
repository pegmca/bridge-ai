import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  selectAccount,
  markUsed,
  markExhausted,
  markAuthError,
  clearError,
} from './accounts.js';
import { resolveToken, refreshToken } from './auth-codebuddy.js';
import { forwardRequest, UpstreamHttpError, UpstreamStreamError } from './proxy.js';
import { classifyStatus } from './quota.js';

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

export function createServer({ config, pool }) {
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
  function cliTraceHeaders() {
    const rid = crypto.randomUUID().replace(/-/g, '');
    const span = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const parent = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const traceId = crypto.randomUUID().replace(/-/g, '');
    const convId = crypto.randomUUID();
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
  const serverKey = (config.listen && config.listen.serverApiKey) || config.serverApiKey || null;

  function serverAuthOk(req) {
    if (!serverKey) return true;
    const auth = req.headers['authorization'];
    const xkey = req.headers['x-api-key'];
    return (auth && auth === `Bearer ${serverKey}`) || xkey === serverKey;
  }

  async function handleChat(req, res) {
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
      const account = selectAccount(pool, attempted);
      if (!account) throw new UpstreamHttpError(503, 'no available account');
      attempted.add(account);
      markUsed(account);
      const token = await resolveToken(account, ctx);
      const uid = (account.auth && account.auth.userId) || ctx.userId;
      let lastErr;
      // Round 0 is the normal try; later rounds replay the same payload with new
      // trace headers to get past an intermittent 11128 channel-verification block.
      for (let round = 0; round <= verifyRetries; round++) {
        if (round > 0) {
          console.log(`[fwd] 11128 retry ${round}/${verifyRetries} [${rid}] account=${account.name}`);
          await sleep(200 + Math.floor(Math.random() * 300) * round);
        }
        let blocked = false;
        for (const host of hosts) {
          const headers = {
            ...incoming,
            ...identity,
            // The official CLI sends the account's user id on chat calls too;
            // omitting it is one of the signals its channel check looks at.
            ...(uid ? { 'X-User-Id': uid } : {}),
            ...cliIdentity,
            ...cliTraceHeaders(),
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
              bodyStr,
              stream,
              timeout,
            });
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
                markAuthError(account, `status ${e.status}`);
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
            if (cls === 'quota') markExhausted(account, cooldownMs);
            else markExhausted(account, Math.min(cooldownMs, 60000));
          }
        } else if (lastErr instanceof UpstreamStreamError) {
          markExhausted(account, cooldownMs);
        }
        if (!isChannelVerify(lastErr) && attempted.size < pool.length) return attempt(attempted);
        throw lastErr;
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

  const handler = (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
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

  return http.createServer(handler);
}
