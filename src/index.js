#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createPool } from './accounts.js';
import { createServer } from './server.js';
import { resolveToken, scanToken, setRecaptureHandler } from './auth-codebuddy.js';
import { runRecapture } from './recapture.js';
import { buildStatus, formatStatus } from './status.js';
import { expandAccountSource } from './store-wbs.js';
import { expandHome, redact } from './util.js';

const CONFIG_DEFAULT = path.join(process.cwd(), 'config.json');

function getConfigPath(argv) {
  const i = argv.indexOf('--config');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.env.BRIDGE_CONFIG || CONFIG_DEFAULT;
}

function loadConfig(p) {
  if (!fs.existsSync(p)) {
    console.error(`config not found at ${p} (copy config.example.json to config.json first)`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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
  if (cfg.accountSource && (!cfg.accountSource.type || cfg.accountSource.type === 'wb-switch')) {
    try {
      const exp = expandAccountSource(cfg.accountSource);
      const staticUids = new Set((cfg.accounts || []).map((a) => a.auth && a.auth.userId).filter(Boolean));
      const dupes = exp.entries.filter((e) => staticUids.has(e.wbs.uid));
      const fromStore = exp.entries.filter((e) => !staticUids.has(e.wbs.uid));
      cfg.accounts = [...fromStore, ...(cfg.accounts || [])];
      console.log(
        `[bridge] accountSource=wb-switch ${exp.file}: store has ${exp.total}, using ${fromStore.length}` +
          (cfg.accounts.length - fromStore.length ? `, plus ${cfg.accounts.length - fromStore.length} from config` : '')
      );
      for (const d of dupes) {
        console.warn(
          `[bridge] WARNING: an accounts[] entry has the same uid as "${d.name}" in the store — skipped the store one. ` +
            `Remove the static entry, otherwise two copies of one token chain will fight over rotation.`
        );
      }
      for (const s of exp.skipped) console.log(`[bridge] accountSource skipped "${s.name}": ${s.reason}`);
    } catch (e) {
      console.error(`[bridge] accountSource failed: ${e.message}`);
      if (!(cfg.accounts || []).length) process.exit(1);
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
    const server = createServer({ config: cfg, pool, configPath });
    const listen = cfg.listen || {};
    const host = listen.host || '127.0.0.1';
    const port = listen.port || 8787;
    server.listen(port, host, () => {
      const provider = cfg.provider || {};
      console.log(`[bridge] listening on http://${host}:${port}`);
      console.log(
        `[bridge] provider=${provider.protocol || provider.type || 'codebuddy-native'} hosts=${(
          provider.hosts || [provider.baseUrl || 'wb.tencentbuddy.com']
        ).join(', ')} path=${provider.path || '/v2/chat/completions'}`
      );
      console.log(`[bridge] accounts=${pool.map((a) => a.name).join(', ')}`);
    });
    const shutdown = () => {
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
