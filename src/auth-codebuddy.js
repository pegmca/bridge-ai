import fs from 'node:fs';
import path from 'node:path';
import { expandHome, redact, decodeJwt } from './util.js';
import { resolveStoreToken, storeFile, findEntry, invalidateStoreToken } from './store-wbs.js';

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
  if (auth.mode === 'wbs') {
    // Credentials owned by workbuddy-switch: read/mint from its store and write
    // the rotated pair back there, so both tools converge on one token chain.
    const { token } = await resolveStoreToken({ store: auth.store, uid: auth.uid });
    return token;
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
  else if (account.auth?.mode === 'wbs') invalidateStoreToken({ store: account.auth.store, uid: account.auth.uid });
  else importCache.delete(account.name);
}
// --- introspection (status dashboard) ---------------------------------------
// Describe *who* an account is and when its credentials expire. Purely local:
// no network call, no token rotation, and the secret itself is only ever
// returned masked.
export function describeAuth(account) {
  const auth = account.auth || {};
  const mode = auth.mode || (auth.token ? 'token' : 'unknown');

  if (mode === 'apikey') {
    return {
      authMode: 'apikey',
      userId: auth.userId || null,
      identitySource: auth.userId ? 'config' : 'unknown',
      secretPreview: redact(auth.apiKey),
      credentialExpiresAt: null,
      accessTokenExpiresAt: null,
      sessionStartedAt: null,
      sessionId: null,
    };
  }

  if (mode === 'refresh') {
    const payload = decodeJwt(auth.refreshToken);
    const cached = refreshCache.get(account.name);
    const uid = auth.userId || (payload && payload.sub) || null;
    return {
      authMode: 'refresh',
      userId: uid,
      identitySource: auth.userId ? 'config' : payload?.sub ? 'jwt' : 'unknown',
      secretPreview: redact(auth.refreshToken),
      // The offline refresh token is the long-lived credential.
      credentialExpiresAt: payload?.exp ? payload.exp * 1000 : null,
      // The minted access token currently held in memory (null = not minted yet).
      accessTokenExpiresAt: cached ? cached.exp : null,
      sessionStartedAt: payload?.iat ? payload.iat * 1000 : null,
      sessionId: payload?.sid ? String(payload.sid).slice(0, 8) : null,
    };
  }

  if (mode === 'wbs') {
    const file = storeFile(auth.store);
    let entry = null;
    try {
      const found = findEntry(file, auth.uid);
      entry = found && found.entry;
    } catch {
      entry = null;
    }
    return {
      authMode: 'wb-switch',
      userId: auth.uid || (entry && entry.uid) || null,
      identitySource: 'store',
      secretPreview: entry && entry.accessToken ? redact(entry.accessToken) : null,
      // The refresh token is the durable credential; the access token is the
      // short-lived one we actually send upstream.
      credentialExpiresAt: entry ? entry.refreshExpiresAt : null,
      accessTokenExpiresAt: entry ? entry.expiresAt : null,
      sessionStartedAt: null,
      sessionId: null,
      variant: entry ? entry.variant : null,
      store: file,
      accountName: entry ? entry.name : null,
    };
  }

  if (mode === 'import') {
    const cached = importCache.get(account.name);
    return {
      authMode: 'import',
      userId: auth.userId || null,
      identitySource: auth.userId ? 'config' : 'unknown',
      secretPreview: cached ? redact(cached.token) : null,
      credentialExpiresAt: null,
      accessTokenExpiresAt: cached ? cached.ts + IMPORT_TTL_MS : null,
      sessionStartedAt: null,
      sessionId: null,
      source: expandHome(auth.source || '~/.codebuddy'),
    };
  }

  return {
    authMode: mode,
    userId: auth.userId || null,
    identitySource: auth.userId ? 'config' : 'unknown',
    secretPreview: redact(auth.token),
    credentialExpiresAt: null,
    accessTokenExpiresAt: null,
    sessionStartedAt: null,
    sessionId: null,
  };
}

// Optional self-heal hook: when the upstream rejects our (rotated) refresh token
// (e.g. code=12153 "refresh token is invalid"), this is called to obtain a fresh
// one. Set via setRecaptureHandler (see src/recapture.js).
let recaptureHandler = null;
export function setRecaptureHandler(fn) {
  recaptureHandler = typeof fn === 'function' ? fn : null;
}

async function resolveRefresh(account, auth, ctx, attemptedRecapture = false) {
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
  if (!data) {
    const invalid = lastErr && /refresh token is invalid|12153/.test(lastErr.message || '');
    if (invalid && !attemptedRecapture && typeof recaptureHandler === 'function') {
      try {
        console.log(`[bridge] refresh token invalid (${lastErr.message}); attempting auto-recapture...`);
        const fresh = await recaptureHandler(account.name);
        if (fresh && fresh.refreshToken) {
          auth.refreshToken = fresh.refreshToken;
          if (fresh.userId) auth.userId = fresh.userId;
          refreshCache.delete(account.name);
          if (typeof auth._clearState === 'function') { try { auth._clearState(); } catch {} }
          return resolveRefresh(account, auth, ctx, true);
        }
      } catch (re) {
        throw new Error(
          `token refresh failed and auto-recapture failed: ${re.message} (original: ${lastErr && lastErr.message})`
        );
      }
    }
    throw lastErr || new Error('token refresh failed');
  }

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
