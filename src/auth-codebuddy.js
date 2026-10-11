import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './util.js';

// Resolve the bearer token for a CodeBuddy account.
//   mode "apikey"  -> static API key from config (no refresh needed)
//   mode "import"  -> read the live CodeBuddy session token from ~/.codebuddy
//   mode "refresh" -> CodeBuddy-native: mint a short-lived access token from a
//                     long-lived offline refresh token via /v2/plugin/auth/token/refresh
//   mode undefined -> "token" field pasted directly (escape hatch)
//
// For "import"/"refresh" we use a short-TTL cache so a re-login is picked up
// within ~30s and a 401 can trigger a refresh (see refreshToken).

const importCache = new Map(); // accountName -> { token, ts }
const IMPORT_TTL_MS = 30000;

const TOKEN_KEY_PRIORITY = [
  'accessToken',
  'access_token',
  'token',
  'authToken',
  'CODEBUDDY_AUTH_TOKEN',
  'sessionToken',
];

// --- refresh-token flow (CodeBuddy-native) ----------------------------------

const refreshCache = new Map(); // accountName -> { token, exp(ms) }

// ctx: { hosts:[...], identity:{...} }  (from provider config)
// stateStore: optional { get(name)->refreshToken, set(name, refreshToken) }
export async function resolveToken(account, ctx = {}) {
  const auth = account.auth || {};
  if (auth.mode === 'apikey') {
    if (!auth.apiKey || auth.apiKey.startsWith('REPLACE')) {
      throw new Error(`account ${account.name}: apikey mode missing a real apiKey`);
    }
    return auth.apiKey;
  }
  if (auth.mode === 'refresh') {
    return await resolveRefresh(account, auth, ctx);
  }
  if (auth.mode === 'import') {
    const cached = importCache.get(account.name);
    if (cached && Date.now() - cached.ts < IMPORT_TTL_MS) return cached.token;
    const dir = expandHome(auth.source || '~/.codebuddy');
    const token = scanToken(dir);
    if (!token) {
      throw new Error(
        `account ${account.name}: no token found in ${dir}. ` +
          `Log in once with the real 'codebuddy' CLI, or switch this account to mode "apikey".`
      );
    }
    importCache.set(account.name, { token, ts: Date.now() });
    return token;
  }
  if (auth.token) return auth.token;
  throw new Error(`account ${account.name}: unknown auth mode "${auth.mode}"`);
}

// Drop any cached token so the next resolveToken re-reads the source.
// Called after a 401 so a fresh CodeBuddy login is picked up.
export function refreshToken(account) {
  if (account.auth?.mode === 'refresh') refreshCache.delete(account.name);
  else importCache.delete(account.name);
}

async function resolveRefresh(account, auth, ctx) {
  const cached = refreshCache.get(account.name);
  if (cached && Date.now() < cached.exp) return cached.token;

  const hosts = auth.hosts || ctx.hosts || ['wb.tencentbuddy.com', 'copilot.tencent.com'];
  const identity = auth.identity || ctx.identity || { 'X-Product': 'SaaS', 'X-Domain': 'www.codebuddy.cn' };
  const uid = auth.userId || ctx.userId;

  // Start from the persisted/rotated refresh token if a stateStore has one.
  const refreshTokenVal = auth.refreshToken;

  let data = null;
  let lastErr;
  for (const host of hosts) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Refresh-Token': refreshTokenVal,
        'X-Auth-Refresh-Source': 'plugin',
        'X-Product': identity['X-Product'] || 'SaaS',
        'X-Domain': identity['X-Domain'] || 'www.codebuddy.cn',
      };
      if (uid) headers['X-User-Id'] = uid;
      const res = await fetch(`https://${host}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json().catch(() => null);
      if (j && j.code === 0 && j.data && j.data.accessToken) {
        data = j.data;
        break;
      }
      lastErr = new Error(`refresh ${host}: code=${j && j.code} msg=${j && j.msg}`);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) throw lastErr || new Error('token refresh failed');

  const expiresIn = data.expiresIn ? data.expiresIn - 120 : 7 * 24 * 3600;
  refreshCache.set(account.name, {
    token: data.accessToken,
    exp: Date.now() + expiresIn * 1000,
  });

  // Rotate the offline refresh token so the bridge stays alive long-term.
  if (data.refreshToken && typeof auth._persistRefreshToken === 'function') {
    try { auth._persistRefreshToken(data.refreshToken); } catch {}
  }
  return data.accessToken;
}

// --- import-mode helpers ----------------------------------------------------

// Best-effort recursive scan of a directory for a CodeBuddy session token.
// NOTE: CodeBuddy's real access token is a short-lived JWT that is NOT persisted
// in plaintext; this is only a best-effort fallback for the "import" mode and
// most deployments should use mode "refresh" instead.
export function scanToken(dir) {
  if (!fs.existsSync(dir)) return null;
  let found = null;
  const visit = (p) => {
    if (found) return;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries;
      try {
        entries = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) {
        if (found) break;
        visit(path.join(p, e));
      }
    } else if (st.isFile() && /\.(json|jsonl|txt)$/.test(p)) {
      let content;
      try {
        content = fs.readFileSync(p, 'utf8');
      } catch {
        return;
      }
      found = extractTokenFromText(content) || found;
    }
  };
  visit(dir);
  return found;
}

function extractTokenFromText(text) {
  for (const key of TOKEN_KEY_PRIORITY) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{8,})"`));
    if (m && m[1]) return m[1];
  }
  const m = text.match(/"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[\w-]{40,})"/);
  if (m && m[1]) return m[1];
  return null;
}
