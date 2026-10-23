// Runtime status view backing `bridge status`, GET /admin/pool and the
// dashboard at GET /admin.
//
// Everything here is derived from in-process state (the live account pool plus
// per-server counters) and, for account identity, from decoding the configured
// token locally. No upstream calls, no token rotation, no secrets in the output.

import { selectAccount, selectByRotation, poolStatus } from './accounts.js';
import { describeAuth } from './auth-codebuddy.js';

export function buildStatus({ config, pool, startedAt, stats, rotation, now = Date.now() }) {
  const entries = poolStatus(pool, now);
  // The process owns the live pointer; a static view (server not running) shows
  // what it *would* start from: the first account in config order.
  const r =
    rotation || {
      mode: (config.rotation && config.rotation.mode) === 'lru' ? 'lru' : 'sticky',
      index: 0,
      switches: 0,
      switchedAt: 0,
    };
  const current = r.mode === 'lru' ? selectAccount(pool, new Set(), now) : selectByRotation(pool, r, new Set(), now);

  const accounts = entries.map((s, i) => {
    const account = pool[i];
    const info = describeAuth(account);
    const attempts = s.okRequests + s.failRequests;
    return {
      index: i,
      name: s.name,
      type: s.type,
      authMode: info.authMode,
      userId: info.userId,
      identitySource: info.identitySource,
      secretPreview: info.secretPreview,
      // cn / ai — which CodeBuddy region the credential belongs to.
      variant: info.variant || null,
      origin: account.origin || null,
      // state
      state: s.inFlight > 0 ? 'busy' : s.state,
      cooling: s.state === 'cooling',
      cooldownRemainingMs: Math.max(0, s.exhaustedUntil - now),
      lastError: s.lastError,
      consecutiveFails: s.consecutiveFails,
      // true = this is the account every request currently goes to.
      current: current ? current.name === s.name : false,
      // usage
      inFlight: s.inFlight,
      totalRequests: s.totalRequests,
      okRequests: s.okRequests,
      failRequests: s.failRequests,
      successRate: attempts ? s.okRequests / attempts : null,
      lastStatus: s.lastStatus,
      lastUsedAt: s.lastUsedAt || null,
      lastUsedAgoMs: s.lastUsedAt ? now - s.lastUsedAt : null,
      lastOkAt: s.lastOkAt || null,
      lastFailAt: s.lastFailAt || null,
      // credentials (expiry only — never the secret)
      credentialExpiresAt: info.credentialExpiresAt,
      accessTokenExpiresAt: info.accessTokenExpiresAt,
      sessionStartedAt: info.sessionStartedAt,
      sessionId: info.sessionId || null,
      source: info.source || null,
    };
  });

  const provider = config.provider || {};
  const listen = config.listen || {};
  const totals = {
    total: accounts.length,
    available: accounts.filter((a) => !a.cooling && a.state !== 'busy').length,
    busy: accounts.filter((a) => a.state === 'busy').length,
    cooling: accounts.filter((a) => a.cooling).length,
    inFlight: accounts.reduce((n, a) => n + a.inFlight, 0),
  };

  return {
    server: {
      startedAt,
      uptimeMs: startedAt ? now - startedAt : null,
      host: listen.host || '127.0.0.1',
      port: listen.port || 8787,
      requireKey: !!listen.serverApiKey,
      protocol: provider.protocol || 'codebuddy-native',
      hosts: provider.hosts || [],
      path: provider.path || '/v2/chat/completions',
      cooldownMs: (config.rotation && config.rotation.cooldownMs) || 3600000,
      errorCooldownMs: Math.min(
        (config.rotation && config.rotation.cooldownMs) || 3600000,
        (config.rotation && config.rotation.errorCooldownMs) || 60000
      ),
      rotation: {
        mode: r.mode,
        index: r.index,
        current: current ? current.name : null,
        switches: rotation ? r.switches : null,
        switchedAt: rotation && r.switchedAt ? r.switchedAt : null,
      },
      autoRecapture: config.autoRecapture !== false,
      accountSource: config.accountSource || null,
      requests: {
        total: stats?.total || 0,
        ok: stats?.ok || 0,
        err: stats?.err || 0,
        inFlight: stats?.inFlight || 0,
      },
    },
    accounts,
    totals,
  };
}

// Compact terminal rendering used by `bridge status`.
export function formatStatus(status, { now = Date.now() } = {}) {
  const { server, accounts, totals } = status;
  const lines = [];
  const up = server.uptimeMs != null ? formatDuration(server.uptimeMs) : 'n/a';
  const shownHost = server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host;
  lines.push(`bridge  http://${shownHost}:${server.port}   uptime ${up}${server.host !== shownHost ? `   (listening on ${server.host})` : ''}`);
  lines.push(
    `requests total=${server.requests.total} ok=${server.requests.ok} err=${server.requests.err} inFlight=${server.requests.inFlight}`
  );
  lines.push(
    `accounts total=${totals.total} available=${totals.available} busy=${totals.busy} cooling=${totals.cooling}`
  );
  lines.push('');

  const head = ['NAME', 'MODE', 'STATE', 'USER ID', 'REQ', 'OK/FAIL', 'LAST USED', 'CRED EXPIRES'];
  const rows = accounts.map((a) => [
    a.name + (a.current ? ' *' : ''),
    a.authMode + (a.variant ? `/${a.variant}` : ''),
    a.cooling ? `cooling ${formatDuration(a.cooldownRemainingMs)}` : a.state,
    shortId(a.userId),
    String(a.totalRequests),
    `${a.okRequests}/${a.failRequests}`,
    a.lastUsedAgoMs == null ? '-' : `${formatDuration(a.lastUsedAgoMs)} ago`,
    a.credentialExpiresAt ? `${formatDuration(a.credentialExpiresAt - now)} left` : 'no expiry',
  ]);
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i]))));
  const pad = (cells) => cells.map((c, i) => padEndW(c, widths[i])).join('  ').trimEnd();
  lines.push(pad(head));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(pad(r));

  const errs = accounts.filter((a) => a.lastError);
  if (errs.length) {
    lines.push('');
    for (const a of errs) lines.push(`! ${a.name}: ${a.lastError}`);
  }
  lines.push('');
  lines.push(
    `rotation mode=${server.rotation.mode} current=${server.rotation.current || 'none'} switches=${server.rotation.switches == null ? '-' : server.rotation.switches}`
  );
  lines.push(`* = current account (every request goes here until it fails).  Dashboard: /admin`);
  return lines.join('\n');
}

function shortId(id) {
  if (!id) return '-';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

// Terminal tables are padded by display width, not code units: a CJK nickname
// counts as two columns, otherwise every column to its right is shifted.
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function padEndW(s, width) {
  return String(s) + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

export function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? String(m % 60) + 'm' : ''}`;
  return `${Math.floor(h / 24)}d`;
}
