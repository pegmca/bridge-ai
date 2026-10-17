#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createPool, poolStatus } from './accounts.js';
import { createServer } from './server.js';
import { resolveToken, scanToken, setRecaptureHandler } from './auth-codebuddy.js';
import { runRecapture } from './recapture.js';
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
  bridge status  [--config <path>]   Show account pool / rotation state
  bridge scan    [--config <path>]   Show where the import token is found (redacted)

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
  const pool = createPool(cfg);
  wireRefreshPersistence(pool, statePathFor(configPath));

  // Auto-recapture: when the upstream rejects our (rotated) refresh token, self-heal
  // by re-running the MITM bootstrap. Requires root + the codebuddy CLI installed.
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

  if (cmd === 'server') {
    const server = createServer({ config: cfg, pool });
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
    console.log(JSON.stringify(poolStatus(pool), null, 2));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  printUsage();
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
