// In-memory account pool: selection, rotation, cooldown and status reporting.
// Secrets are never stored here — tokens are resolved on demand by auth-codebuddy.

export function createPool(config) {
  return (config.accounts || []).map((a, i) => ({
    index: i,
    name: a.name || `acct-${i}`,
    type: a.type || 'codebuddy',
    auth: a.auth || {},
    // runtime state
    lastUsedAt: 0,
    exhaustedUntil: 0,
    lastError: null,
    consecutiveFails: 0,
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

export function markUsed(a, now = Date.now()) {
  a.lastUsedAt = now;
}

export function markExhausted(a, cooldownMs, now = Date.now()) {
  a.exhaustedUntil = now + cooldownMs;
  a.lastError = 'quota';
  a.consecutiveFails += 1;
}

export function markAuthError(a, msg) {
  a.lastError = `auth:${msg}`;
  a.consecutiveFails += 1;
}

export function clearError(a) {
  a.lastError = null;
  a.consecutiveFails = 0;
}

export function poolStatus(pool, now = Date.now()) {
  return pool.map((a) => ({
    name: a.name,
    type: a.type,
    state: now < a.exhaustedUntil ? 'cooling' : 'available',
    exhaustedUntil: a.exhaustedUntil,
    lastUsedAt: a.lastUsedAt,
    lastError: a.lastError,
  }));
}
