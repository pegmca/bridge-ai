// Serve the account dashboard on a second port, so you can look at the pool
// without touching (or needing to restart) the long-running service on :8787.
//
// The preview runs the normal server against a temporary copy of config.json
// with only `listen` overridden: same accounts, same store, different port and
// its own bridge.state.json under tmp/preview/. Credentials are shared through
// ~/.wb-switch/accounts.json, which is the single source of truth anyway.
//
// Usage:  npm run preview [-- <port>]        (default 8789, loopback only)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PREVIEW_PORT || 8789);
const srcConfig = path.join(ROOT, 'config.json');

if (!fs.existsSync(srcConfig)) {
  console.error(`config not found: ${srcConfig} (copy config.example.json to config.json first)`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(srcConfig, 'utf8'));
} catch (e) {
  console.error(`${srcConfig} is not valid JSON: ${e.message}`);
  process.exit(1);
}

// Loopback only: a preview must never widen what the real service exposes.
cfg.listen = { ...(cfg.listen || {}), host: '127.0.0.1', port };

const dir = path.join(ROOT, 'tmp/preview');
fs.mkdirSync(dir, { recursive: true });
const cfgPath = path.join(dir, `config-${port}.json`);
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

console.log(`[preview] config  ${cfgPath}`);
console.log(`[preview] accounts from ${cfg.accountSource ? JSON.stringify(cfg.accountSource) : 'accounts[]'}`);
console.log(`[preview] dashboard http://127.0.0.1:${port}/admin     (Ctrl+C to stop)`);

const child = spawn(process.execPath, ['src/index.js', 'server', '--config', cfgPath], {
  cwd: ROOT,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
