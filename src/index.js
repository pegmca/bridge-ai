#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPool } from './accounts.js';
import { createServer } from './server.js';
import { resolveToken, scanToken, setRecaptureHandler } from './auth-codebuddy.js';
import { runRecapture } from './recapture.js';
import { buildStatus, formatStatus } from './status.js';
import { mergeAccounts, watchAccountStore } from './pool-reload.js';
import { expandHome, redact } from './util.js';

const CONFIG_DEFAULT = path.join(process.cwd(), 'config.json');
const CONFIG_EXAMPLE = 'config.example.json';

function getConfigPath(argv) {
  const i = argv.indexOf('--config');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.env.BRIDGE_CONFIG || CONFIG_DEFAULT;
}

// First run after a clone: config.json is gitignored (it holds the access key),
// so materialise it from the tracked template instead of failing with "config
// not found". The bridge then starts with an empty account pool rather than
// refusing to boot — an empty pool is a valid state that the dashboard explains.
function seedFromExample(p) {
  const candidates = [path.join(path.dirname(p), CONFIG_EXAMPLE), path.join(process.cwd(), CONFIG_EXAMPLE)];
  for (const src of candidates) {
    if (path.resolve(src) === path.resolve(p)) continue;
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, p);
      console.log(`[bridge] created ${p} from ${src}`);
      console.log(`[bridge] no accounts yet — see README "1. Configuration" to add one.`);
      return true;
    } catch (e) {
      console.error(`[bridge] could not create ${p}: ${e.message}`);
      return false;
    }
  }
  return false;
}

function loadConfig(p) {
  if (!fs.existsSync(p) && !seedFromExample(p)) {
    console.error(`config not found at ${p} (copy ${CONFIG_EXAMPLE} next to it, or pass --config <path>)`);
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.error(`cannot read ${p}: ${e.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`${p} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

// "auto" (the value shipped in config.example.json) means: mint an access key on
// first start and write it back, so a fresh clone is callable without editing
// anything. An explicit "" means "no incoming auth at all" and is left alone.
const AUTO_KEY = 'auto';

function ensureServerKey(cfg, configPath) {
  const holder = cfg.listen && typeof cfg.listen === 'object' ? cfg.listen : cfg;
  if (holder.serverApiKey !== AUTO_KEY) return null;

  const key = crypto.randomBytes(32).toString('hex');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const onDisk = JSON.parse(raw);
    const target = onDisk.listen && typeof onDisk.listen === 'object' ? onDisk.listen : onDisk;
    target.serverApiKey = key;
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  } catch (e) {
    console.error(`[bridge] could not save the generated key to ${configPath}: ${e.message}`);
    console.error('[bridge] using an in-memory key instead — it changes on restart.');
  }
  holder.serverApiKey = key;
  return key;
}

// Persisted refresh tokens live in a sibling state file so the offline refresh
// token can be rotated across restarts without re-capturing it.
function statePathFor(configPath) {
  return path.join(path.dirname(configPath), 'bridge.state.json');
}
function loadState(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { accounts: {} };
  }
}
function saveState(p, s) {
  try {
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error(`[bridge] warning: could not persist state: ${e.message}`);
  }
}
function wireRefreshPersistence(pool, statePath) {
  const state = loadState(statePath);
  for (const a of pool) {
    if ((a.auth || {}).mode === 'refresh') {
      if (state.accounts && state.accounts[a.name]) {
        a.auth.refreshToken = state.accounts[a.name];
      }
      a.auth._persistRefreshToken = (tok) => {
        state.accounts = state.accounts || {};
        state.accounts[a.name] = tok;
        saveState(statePath, state);
      };
      a.auth._clearState = () => {
        if (state.accounts) delete state.accounts[a.name];
        saveState(statePath, state);
      };
    }
  }
}

function printUsage() {
  console.log(`bridge-ai — OpenAI-compatible relay for CodeBuddy subscription tokens

Usage:
  bridge server  [--config <path>]   Start the relay (default 127.0.0.1:8787)
  bridge login   [--config <path>]   Verify each account's token resolves
  bridge status  [--config <path>]   Live account pool / usage (add --json for raw)
  bridge scan    [--config <path>]   Show where the import token is found (redacted)

Dashboard (while the server runs):
  http://127.0.0.1:8787/admin         Account pool view, refreshes every 3s
  http://127.0.0.1:8787/admin/pool    Same data as JSON (needs serverApiKey if set)

Point your harness at it:
  OPENAI_BASE_URL=http://127.0.0.1:8787/v1
Or point the CodeBuddy CLI's custom endpoint at the same URL.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }

  const configPath = getConfigPath(argv);
  const cfg = loadConfig(configPath);

  // The pool can be sourced from the workbuddy-switch account store instead of a
  // hand-maintained accounts[] list. The store stays the single source of truth:
  // bridge-ai mints from it and writes rotated tokens back there.
  //
  // `staticAccounts` is kept aside so a live reload can re-merge the store with
  // the same config list (cfg.accounts gets the merged result below).
  const staticAccounts = Array.isArray(cfg.accounts) ? cfg.accounts.slice() : [];
  const source =
    cfg.accountSource && (!cfg.accountSource.type || cfg.accountSource.type === 'wb-switch') ? cfg.accountSource : null;
  if (source) {
    try {
      const merged = mergeAccounts(source, staticAccounts);
      cfg.accounts = merged.accounts;
      const fromConfig = merged.accounts.length - merged.fromStore.length;
      console.log(
        `[bridge] accountSource=wb-switch ${merged.file}: store has ${merged.total}, using ${merged.fromStore.length}` +
          (fromConfig ? `, plus ${fromConfig} from config` : '')
      );
      for (const d of merged.dupes) {
        console.warn(
          `[bridge] WARNING: an accounts[] entry has the same uid as "${d.name}" in the store — skipped the store one. ` +
            `Remove the static entry, otherwise two copies of one token chain will fight over rotation.`
        );
      }
      for (const s of merged.skipped) console.log(`[bridge] accountSource skipped "${s.name}": ${s.reason}`);
    } catch (e) {
      const msg = String((e && e.message) || e);
      const noStore = /cannot read .*store|ENOENT|no such file/i.test(msg);
      if (noStore && !staticAccounts.length) {
        // A fresh clone has no workbuddy-switch library yet. Booting with an
        // empty pool is far more useful than exiting: the dashboard comes up,
        // /healthz answers, and every chat call explains what is missing.
        console.warn(`[bridge] ${msg}`);
        console.warn('[bridge] account pool is empty — chat requests will answer 503 until an account is added.');
        console.warn(
          '[bridge] add one either by installing workbuddy-switch and logging in there, ' +
            'or by putting an entry into accounts[] in the config (README "1. Configuration").'
        );
      } else {
        // A store that exists but is corrupt/unreadable is a real error: stop,
        // otherwise the bridge silently serves from a half-broken pool.
        console.error(`[bridge] accountSource failed: ${msg}`);
        if (!staticAccounts.length) process.exit(1);
      }
    }
  }

  const pool = createPool(cfg);
  wireRefreshPersistence(pool, statePathFor(configPath));

  // Auto-recapture: when the upstream rejects our (rotated) refresh token, self-heal
  // by re-running the MITM bootstrap. Requires root + the codebuddy CLI installed.
  // Only wired up for the long-running server — one-shot commands stay quiet.
  if (cmd === 'server') {
    if (cfg.autoRecapture !== false) {
      if (process.getuid?.() === 0) {
        setRecaptureHandler(async (accountName) => {
          console.log(`[bridge] auto-recapture triggered for ${accountName}`);
          return await runRecapture({ configPath, accountName, log: (m) => console.log(m) });
        });
        console.log('[bridge] auto-recapture: enabled');
      } else {
        console.log('[bridge] auto-recapture: skipped (requires root)');
      }
    } else {
      console.log('[bridge] auto-recapture: disabled by config');
    }
  }

  if (cmd === 'server') {
    const freshKey = ensureServerKey(cfg, configPath);
    // Live account reload: the store is owned by workbuddy-switch and can change
    // under us (accounts added/removed, tokens rotated). `reloader` is filled in
    // right after the server exists, because the rotation pointer lives there.
    let reloader = null;
    const server = createServer({
      config: cfg,
      pool,
      configPath,
      reloadAccounts: () =>
        reloader ? reloader.apply('manual') : { ok: false, error: 'no account store is being watched' },
    });
    if (source) {
      reloader = watchAccountStore({
        source,
        staticAccounts,
        pool,
        rotation: server.rotation,
        log: (m) => console.log(m),
        warn: (m) => console.warn(m),
      });
      if (reloader) console.log(`[bridge] watching ${reloader.file} — accounts added there show up without a restart`);
    }
    const listen = cfg.listen || {};
    const host = listen.host || '127.0.0.1';
    const port = listen.port || 8787;
    // A busy or privileged port is the most common first-run failure; Node's raw
    // stack trace says nothing useful about what to do next.
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`[bridge] port ${port} is already in use — set listen.port in ${configPath}, or stop whatever owns it.`);
      } else if (e.code === 'EACCES') {
        console.error(`[bridge] not allowed to bind ${host}:${port} — pick another listen.port (and prefer 127.0.0.1).`);
      } else {
        console.error(`[bridge] listen failed: ${e.message}`);
      }
      process.exit(1);
    });
    server.listen(port, host, () => {
      const provider = cfg.provider || {};
      console.log(`[bridge] listening on http://${host}:${port}`);
      console.log(
        `[bridge] provider=${provider.protocol || provider.type || 'codebuddy-native'} hosts=${(
          provider.hosts || [provider.baseUrl || 'wb.tencentbuddy.com']
        ).join(', ')} path=${provider.path || '/v2/chat/completions'}`
      );
      console.log(
        pool.length
          ? `[bridge] accounts=${pool.map((a) => a.name).join(', ')}`
          : '[bridge] accounts: none — open the dashboard, it explains how to add one'
      );
      if (freshKey) {
        console.log('');
        console.log('[bridge] generated an access key (saved to config.json):');
        console.log(`[bridge]   ${freshKey}`);
        console.log(`[bridge] clients send: Authorization: Bearer ${freshKey}`);
        console.log('[bridge] copy it any time from the dashboard -> 访问密钥');
        console.log('');
      } else if (listen.serverApiKey) {
        console.log('[bridge] clients send: Authorization: Bearer <the key in config.json> (dashboard -> 访问密钥)');
      }
    });
    const shutdown = () => {
      if (reloader) reloader.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'login') {
    let ok = true;
    for (const a of pool) {
      try {
        const t = await resolveToken(a);
        console.log(`[login] ${a.name}: OK (token ${redact(t)})`);
      } catch (e) {
        ok = false;
        console.error(`[login] ${a.name}: FAILED — ${e.message}`);
      }
    }
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'scan') {
    for (const a of pool) {
      if ((a.auth || {}).mode === 'import') {
        const dir = expandHome((a.auth.source || '~/.codebuddy'));
        const token = scanToken(dir);
        console.log(`[scan] ${a.name}: dir=${dir} -> ${token ? 'found ' + redact(token) : 'NOT FOUND'}`);
      } else {
        console.log(`[scan] ${a.name}: mode=${(a.auth || {}).mode || 'n/a'} (not import)`);
      }
    }
    return;
  }

  if (cmd === 'status') {
    const listen = cfg.listen || {};
    const host = listen.host && listen.host !== '0.0.0.0' ? listen.host : '127.0.0.1';
    const port = listen.port || 8787;
    const key = listen.serverApiKey || cfg.serverApiKey || null;
    const base = `http://${host}:${port}`;
    try {
      const res = await fetch(`${base}/admin/pool`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (argv.includes('--json')) console.log(JSON.stringify(data, null, 2));
      else console.log(formatStatus(data));
      return;
    } catch (e) {
      console.error(
        `[status] cannot reach the running bridge at ${base} (${e.message}).\n` +
          `[status] showing the static view from ${configPath} instead — no runtime data.\n`
      );
      const staticView = buildStatus({
        config: cfg,
        pool,
        startedAt: null,
        stats: { total: 0, ok: 0, err: 0, inFlight: 0 },
      });
      if (argv.includes('--json')) console.log(JSON.stringify(staticView, null, 2));
      else console.log(formatStatus(staticView));
      return;
    }
  }

  console.error(`unknown command: ${cmd}`);
  printUsage();
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
