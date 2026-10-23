// Adapter for the workbuddy-switch account store (`~/.wb-switch/accounts.json`).
//
// Why this exists: bridge-ai used to own its own copy of every credential
// (config.accounts[] + bridge.state.json). Keeping a second copy of a *rotating*
// refresh token chain is a bug waiting to happen — whoever refreshes first
// invalidates the other copy. Reading the sibling tool's store as the single
// source of truth removes that duplication entirely.
//
// The store is a JSON array; each entry looks like:
//   {
//     "id": "uuid", "uid": "uuid", "variant": "cn" | "ai",
//     "domain": "www.codebuddy.cn",
//     "access_token": "...", "expiresAt": 1795…(ms),
//     "refresh_token": "...", "refreshExpiresAt": ..., "refreshedAt": ...,
//     "nickname": "...", "email": null, "auth_raw": {...}, "profile_raw": {...}
//   }
//
// We use the access token while it is fresh, mint a new one with the refresh
// token when it is not, and write the rotated pair back into the same file
// (atomic replace, unknown fields preserved) so both tools stay convergent.

import fs from 'node:fs';
import { expandHome } from './util.js';

export const DEFAULT_STORE = '~/.wb-switch/accounts.json';
const REFRESH_MARGIN_MS = 60 * 1000;
const REFRESH_PREFIX = '/v2/plugin/auth/token/refresh';

// Region handling.
//
// CN accounts speak to the CLI host in provider.hosts (wb.tencentbuddy.com) and
// are the only ones enabled by default: the international endpoint is a
// different gateway with different requirements, so it should be opted into
// explicitly rather than silently mixed into the pool.
//
// AI accounts (variant "ai") use https://www.codebuddy.ai/v2 instead, whose
// gateway also rejects payloads that do not start with a system message
// (11128 "first message is not system prompt"). Set
// `accountSource.variants: ["cn", "ai"]` to include them.
export const DEFAULT_VARIANTS = ['cn'];
export const AI_CHAT_HOSTS = ['www.codebuddy.ai'];

const inFlight = new Map(); // `${file}#${uid}` -> Promise<{token, expiresAt}>
const forceMint = new Set(); // `${file}#${uid}` — upstream said 401, mint regardless of expiresAt

// Called after the upstream rejects a token: the next resolve() mints a new one
// even if the stored expiresAt still looks valid.
export function invalidateStoreToken({ store, uid }) {
  forceMint.add(`${storeFile(store)}#${uid}`);
}

export function storeFile(p) {
  return expandHome(p || process.env.WBS_ACCOUNTS || DEFAULT_STORE);
}

function isEncrypted(v) {
  return !!(v && typeof v === 'object' && !Array.isArray(v) && v.$wbEncrypted);
}

function readRaw(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read workbuddy-switch store at ${file}: ${e.message}`);
  }
  let arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(arr)) throw new Error(`${file} is not a JSON array`);
  return arr;
}

function normalize(acc, index) {
  const variant = acc.variant === 'ai' ? 'ai' : 'cn';
  const encrypted = isEncrypted(acc.access_token) || isEncrypted(acc.refresh_token);
  return {
    index,
    id: acc.id || acc.uid || `wbs-${index}`,
    uid: acc.uid || acc.id || null,
    name: acc.note || acc.nickname || acc.email || acc.uid || `acct-${index}`,
    email: acc.email || null,
    variant,
    domain: acc.domain || (variant === 'ai' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
    accessToken: typeof acc.access_token === 'string' ? acc.access_token : null,
    refreshToken: typeof acc.refresh_token === 'string' ? acc.refresh_token : null,
    expiresAt: Number(acc.expiresAt) || null,
    refreshExpiresAt: Number(acc.refreshExpiresAt) || null,
    refreshedAt: Number(acc.refreshedAt) || null,
    needsRelogin: acc.needs_relogin === true,
    needsReloginReason: acc.needs_relogin_reason || null,
    encrypted,
  };
}

export function loadStore(p) {
  const file = storeFile(p);
  const raw = readRaw(file);
  return { file, accounts: raw.map(normalize) };
}

export function findEntry(file, uid) {
  const raw = readRaw(file);
  const i = raw.findIndex((a) => a.uid === uid || a.id === uid);
  return i < 0 ? null : { entry: normalize(raw[i], i), raw: raw[i], index: i };
}

function atomicWrite(file, arr) {
  const tmp = `${file}.bridge-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Persist a rotated token pair back into the store, touching only the fields we
// own. Everything else (profile_raw, note, auth_raw, displayField, …) is kept.
export function writeBackToken(file, uid, { accessToken, refreshToken, expiresAt, refreshExpiresAt }) {
  const arr = readRaw(file);
  const i = arr.findIndex((a) => a.uid === uid || a.id === uid);
  if (i < 0) return false;
  const a = arr[i];
  a.access_token = accessToken;
  if (refreshToken) a.refresh_token = refreshToken;
  if (expiresAt) a.expiresAt = expiresAt;
  if (refreshExpiresAt) a.refreshExpiresAt = refreshExpiresAt;
  a.refreshedAt = Date.now();
  atomicWrite(file, arr);
  return true;
}

function isFresh(entry) {
  if (!entry.accessToken) return false;
  if (!entry.expiresAt) return false;
  return entry.expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

// POST /v2/plugin/auth/token/refresh against the account's own domain.
// Headers mirror what the official client sends (X-Auth-Refresh-Source: plugin
// is required — without it the gateway rejects the refresh with 12153).
async function mint(file, entry) {
  if (!entry.refreshToken) {
    throw new Error(
      `account ${entry.name}: no plaintext refresh_token in ${file}` +
        (entry.encrypted ? ' (tokens are encrypted — re-save the account in workbuddy-switch)' : '')
    );
  }
  const url = `https://${entry.domain}${REFRESH_PREFIX}`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Refresh-Token': entry.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': entry.domain,
  };
  if (entry.accessToken) headers.Authorization = `Bearer ${entry.accessToken}`;
  if (entry.uid) headers['X-User-Id'] = entry.uid;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`token refresh failed (${url}): ${e.message}`);
  }
  const json = await res.json().catch(() => null);
  const code = json && json.code;
  if (!json || (code !== 0 && code !== 200) || !json.data || !json.data.accessToken) {
    const msg = json ? `${code}: ${json.msg || json.message || 'unknown'}` : `HTTP ${res.status}`;
    throw new Error(`token refresh rejected for ${entry.name} (${url}): ${msg}`);
  }

  const data = json.data;
  const expiresIn = Number(data.expiresIn) || 0;
  const refreshExpiresIn = Number(data.refreshExpiresIn) || 0;
  const next = {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : null,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : entry.expiresAt,
    refreshExpiresAt: refreshExpiresIn ? Date.now() + refreshExpiresIn * 1000 : entry.refreshExpiresAt,
  };
  writeBackToken(file, entry.uid, next);
  return { token: next.accessToken, expiresAt: next.expiresAt };
}

// Resolve a usable access token for one store account.
//   - fresh access token on disk -> use it (no network, no writes)
//   - otherwise mint, write back, and on a 12153 re-read the store once: the
//     sibling tool may have rotated the chain in the meantime.
export async function resolveStoreToken({ store, uid }) {
  const file = storeFile(store);
  const key = `${file}#${uid}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const task = (async () => {
    const found = findEntry(file, uid);
    if (!found) throw new Error(`account ${uid} is no longer in ${file}`);
    const entry = found.entry;
    const forced = forceMint.delete(key);
    if (!forced && isFresh(entry)) return { token: entry.accessToken, expiresAt: entry.expiresAt };
    try {
      return await mint(file, entry);
    } catch (e) {
      const invalid = /12153|invalid_grant|invalid refresh/i.test(String(e.message || ''));
      if (!invalid) throw e;
      const again = findEntry(file, uid);
      if (again && isFresh(again.entry)) {
        console.log(`[wbs] ${entry.name}: refresh chain was rotated by another tool; using the fresh token from disk`);
        return { token: again.entry.accessToken, expiresAt: again.entry.expiresAt };
      }
      throw e;
    }
  })();

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

export function clearStoreCache() {
  inFlight.clear();
}

// Turn the store into pool entries. Static config.accounts[] entries with the
// same uid are reported so the caller can drop the duplicate.
export function expandAccountSource(source = {}) {
  const store = loadStore(source.path);
  const variants = Array.isArray(source.variants) && source.variants.length ? source.variants : DEFAULT_VARIANTS;
  const include = Array.isArray(source.includeUids) && source.includeUids.length ? new Set(source.includeUids) : null;
  const exclude = new Set(source.excludeUids || []);
  const entries = [];
  const skipped = [];

  for (const a of store.accounts) {
    if (!variants.includes(a.variant)) {
      skipped.push({
        name: a.name,
        reason:
          a.variant === 'ai'
            ? 'international account (variant ai) is not enabled — add "ai" to accountSource.variants to include it'
            : `variant ${a.variant} is not enabled`,
      });
      continue;
    }
    if (include && !include.has(a.uid)) continue;
    if (exclude.has(a.uid)) {
      skipped.push({ name: a.name, reason: 'excluded by excludeUids' });
      continue;
    }
    if (a.encrypted) {
      skipped.push({ name: a.name, reason: 'tokens are encrypted in the store' });
      continue;
    }
    if (!a.refreshToken && !isFresh(a)) {
      skipped.push({ name: a.name, reason: 'no usable credential' });
      continue;
    }
    if (a.needsRelogin) {
      skipped.push({ name: a.name, reason: a.needsReloginReason || 'needs_relogin' });
      continue;
    }
    entries.push({
      name: a.name,
      wbs: { uid: a.uid, variant: a.variant, store: store.file },
      chatHosts: a.variant === 'ai' ? AI_CHAT_HOSTS : undefined,
      // Only set for variant "ai", which is opt-in; CN requests keep the
      // client's message array untouched.
      needsSystemPrompt: a.variant === 'ai',
      auth: {
        mode: 'wbs',
        uid: a.uid,
        store: store.file,
        hosts: [a.domain], // refresh endpoint follows the account's own domain
      },
    });
  }

  return { file: store.file, total: store.accounts.length, entries, skipped };
}

// One-line summary of an entry, used by the CLI / dashboard.
export function describeStoreAccount(uid, store) {
  const found = findEntry(storeFile(store), uid);
  if (!found) return null;
  const e = found.entry;
  return {
    name: e.name,
    variant: e.variant,
    domain: e.domain,
    expiresAt: e.expiresAt,
    refreshExpiresAt: e.refreshExpiresAt,
    needsRelogin: e.needsRelogin,
  };
}
