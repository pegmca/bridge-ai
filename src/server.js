import http from 'node:http';
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
  const timeout = provider.timeout || 120000;
  const cooldownMs = (config.rotation && config.rotation.cooldownMs) || 3600000;

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
    bodyStr = JSON.stringify(parsed);

    const incoming = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) incoming[k] = v;
    }

    const attempt = async (attempted) => {
      const account = selectAccount(pool, attempted);
      if (!account) throw new UpstreamHttpError(503, 'no available account');
      attempted.add(account);
      markUsed(account);
      const token = await resolveToken(account, ctx);
      const baseHeaders = {
        ...incoming,
        ...identity,
        'x-codebuddy-request': '1',
        [authHeader]: `${authScheme} ${token}`,
      };
      let lastErr;
      for (const host of hosts) {
        const headers = { ...baseHeaders, host };
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
          return r;
        } catch (e) {
          lastErr = e;
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
      if (lastErr) {
        if (lastErr instanceof UpstreamHttpError) {
          const cls = classifyStatus(lastErr.status);
          if (cls === 'quota') markExhausted(account, cooldownMs);
          else markExhausted(account, Math.min(cooldownMs, 60000));
        } else if (lastErr instanceof UpstreamStreamError) {
          markExhausted(account, cooldownMs);
        }
        if (attempted.size < pool.length) return attempt(attempted);
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
