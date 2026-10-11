import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './util.js';

// Resolve the bearer token for a CodeBuddy account.
//   mode "apikey"  -> static API key from config (no refresh needed)
//   mode "import"  -> read the live CodeBuddy session token from ~/.codebuddy
//   mode undefined -> "token" field pasted directly (escape hatch)
//
// For "import" we use a short-TTL cache so a re-login is picked up within ~30s
// and a 401 can trigger a refresh (see refreshToken).

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

export async function resolveToken(account) {
  const auth = account.auth || {};
  if (auth.mode === 'apikey') {
    if (!auth.apiKey || auth.apiKey.startsWith('REPLACE')) {
      throw new Error(`account ${account.name}: apikey mode missing a real apiKey`);
    }
    return auth.apiKey;
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
  importCache.delete(account.name);
}

// Best-effort recursive scan of a directory for a CodeBuddy session token.
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
  // Fallback: a plausible long token / JWT.
  const m = text.match(/"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[\w-]{40,})"/);
  if (m && m[1]) return m[1];
  return null;
}
