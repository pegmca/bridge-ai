// In-memory account pool: selection, rotation, cooldown and status reporting.
// Secrets are never stored here — tokens are resolved on demand by auth-codebuddy.

export function createPool(config) {
  return (config.accounts || []).map((a, i) => ({
    index: i,
    name: a.name || `acct-${i}`,
    type: a.type || 'codebuddy',
    auth: a.auth || {},
    // Per-account upstream hosts (e.g. an international account talks to a
    // different chat endpoint than the default provider.hosts).
    chatHosts: Array.isArray(a.chatHosts) && a.chatHosts.length ? a.chatHosts : null,
    // Some channels (the international one) reject a payload whose first message
    // is not a system prompt — 11128 "first message is not system prompt".
    needsSystemPrompt: a.needsSystemPrompt === true,
    // Where the credential comes from, when it is not this config file.
    origin: a.wbs ? { type: 'wb-switch', uid: a.wbs.uid, variant: a.wbs.variant, store: a.wbs.store } : null,
    // runtime state
    lastUsedAt: 0,
    exhaustedUntil: 0,
    lastError: null,
    consecutiveFails: 0,
    // runtime counters (surfaced by /admin/pool — not persisted)
    inFlight: 0,
    totalRequests: 0,
    okRequests: 0,
    failRequests: 0,
    lastStatus: null,
    lastOkAt: 0,
    lastFailAt: 0,
  }));
}

// Best account to try next: skip already-attempted ones, prefer available
// (not cooling) and least-recently-used. Falls back to any remaining candidate.
export function selectAccount(pool, attempted = new Set(), now = Date.now()) {
  const candidates = pool.filter((a) => !attempted.has(a));
  if (candidates.length === 0) return null;
  const available = candidates.filter((a) => now >= a.exhaustedUntil);
  const pickFrom = available.length ? available : candidates;
  return [...pickFrom].sort((x, y) => x.lastUsedAt - y.lastUsedAt)[0];
}

// --- rotation state ------------------------------------------------------
//
// "sticky" (default): one account is *current* and serves every request until
// it fails. Only an account-level failure moves the pointer to the next account
// in the pool, so one conversation keeps landing on the same account instead of
// being re-picked per request.
// "lru": the old behaviour — every request picks the least-recently-used
// account, which spreads load per request but also spreads each conversation
// across accounts.
export function createRotation(config = {}) {
  const r = config.rotation || {};
  return {
    mode: r.mode === 'lru' ? 'lru' : 'sticky',
    index: 0,
    switches: 0,
    switchedAt: 0,
  };
}

// The current account, or the first usable one after it (skipping accounts this
// request already tried and those still cooling). Returns null when the whole
// pool is cooling or exhausted — the caller then fails the call instead of
// hammering accounts that just told us to stop.
export function selectByRotation(pool, rotation, attempted = new Set(), now = Date.now()) {
  if (!pool.length) return null;
  const start = rotation && Number.isInteger(rotation.index) ? rotation.index : 0;
  for (let i = 0; i < pool.length; i++) {
    const a = pool[(start + i) % pool.length];
    if (attempted.has(a)) continue;
    if (now < a.exhaustedUntil) continue;
    return a;
  }
  return null;
}

// Move the pointer past `account`, so the next request (and the retry of the
// current one) starts from the following account.
export function advanceRotation(pool, rotation, account) {
  if (!rotation) return;
  const i = pool.indexOf(account);
  if (i < 0) return;
  rotation.index = (i + 1) % pool.length;
  rotation.switches += 1;
  rotation.switchedAt = Date.now();
}

export function markUsed(a, now = Date.now()) {
  a.lastUsedAt = now;
}

export function markExhausted(a, cooldownMs, reason = 'quota', now = Date.now()) {
  a.exhaustedUntil = now + cooldownMs;
  a.lastError = reason;
  a.consecutiveFails += 1;
}

export function markAuthError(a, msg, cooldownMs = 0, now = Date.now()) {
  a.lastError = `auth:${msg}`;
  a.consecutiveFails += 1;
  // A dead credential is not fixed by retrying immediately: cool the account for
  // a while so the pointer does not bounce straight back onto it.
  if (cooldownMs > 0) a.exhaustedUntil = now + cooldownMs;
}

export function clearError(a) {
  a.lastError = null;
  a.consecutiveFails = 0;
}

// Counters used by the status dashboard. A "call" is one upstream HTTP attempt
// (a single client request may fan out over several accounts / hosts).
export function beginCall(a) {
  a.inFlight += 1;
  a.totalRequests += 1;
}

export function endCall(a, { status = null, ok = false } = {}, now = Date.now()) {
  a.inFlight = Math.max(0, a.inFlight - 1);
  if (status != null) a.lastStatus = status;
  if (ok) {
    a.okRequests += 1;
    a.lastOkAt = now;
  } else {
    a.failRequests += 1;
    a.lastFailAt = now;
  }
}

export function poolStatus(pool, now = Date.now()) {
  return pool.map((a) => ({
    name: a.name,
    type: a.type,
    state: now < a.exhaustedUntil ? 'cooling' : 'available',
    exhaustedUntil: a.exhaustedUntil,
    lastUsedAt: a.lastUsedAt,
    lastError: a.lastError,
    consecutiveFails: a.consecutiveFails,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
    okRequests: a.okRequests,
    failRequests: a.failRequests,
    lastStatus: a.lastStatus,
    lastOkAt: a.lastOkAt,
    lastFailAt: a.lastFailAt,
  }));
}
