import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'tmp/cap/bridge.log');
const PIDFILE = path.join(ROOT, 'tmp/cap/bridge.pid');
const PORT = 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getPid() {
  try {
    if (os.platform() === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${PORT} "`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      for (const line of out.split('\n')) {
        if (/LISTENING/.test(line)) {
          const parts = line.trim().split(/\s+/);
          return parseInt(parts[parts.length - 1], 10);
        }
      }
    } else {
      const out = execSync(`lsof -ti tcp:${PORT}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const pid = parseInt(out.trim().split('\n')[0], 10);
      if (!Number.isNaN(pid)) return pid;
    }
  } catch {}
  return null;
}

// One HTTP probe; resolves to the status code, or null if nothing answered.
function probe(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function cmdStatus() {
  const pid = getPid();
  if (!pid) {
    console.log(`NOT RUNNING (no listener on :${PORT})`);
    return 0;
  }
  const health = await probe('/healthz');
  const admin = await probe('/admin');
  console.log(
    `RUNNING  pid=${pid}  healthz=${health ?? 'n/a'}  dashboard=${admin ?? 'n/a'}  http://127.0.0.1:${PORT}/admin`
  );
  if (admin === 401 || admin === 404) {
    console.log('hint: this process predates GET /admin — restart it (from an Administrator terminal) to serve the dashboard.');
  }
  return 0;
}

// Returns true when the port is free afterwards. A failed kill is reported
// loudly: silently "succeeding" here is what makes a restart look applied
// while the old process keeps serving.
function stop() {
  const pid = getPid();
  if (!pid) {
    console.log('not running');
    return true;
  }
  let ok;
  if (os.platform() === 'win32') {
    const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    ok = r.status === 0;
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    console.error(`cannot stop pid=${pid}: access denied.`);
    console.error('That process was started with administrator rights, so a normal shell cannot kill it.');
    console.error('Open an Administrator terminal (PowerShell/Terminal -> Run as administrator) and run `npm run restart` there.');
    return false;
  }
  try {
    fs.unlinkSync(PIDFILE);
  } catch {}
  console.log(`stopped ${pid}`);
  return true;
}

function spawnServer() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['src/index.js', 'server'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  return child.pid;
}

async function cmdStart() {
  if (getPid()) {
    console.log('already running — nothing changed. Use `npm run restart` to load new code.');
    return 0;
  }
  const pid = spawnServer();
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if ((await probe('/healthz')) === 200) {
      const admin = await probe('/admin');
      console.log(`started, pid=${pid}  log=${LOG}`);
      console.log(`dashboard  http://127.0.0.1:${PORT}/admin  (${admin ?? 'n/a'})`);
      return 0;
    }
  }
  console.error(`spawned pid=${pid} but /healthz is not answering — check ${LOG}`);
  return 1;
}

async function cmdRestart() {
  if (!stop()) return 1;
  for (let i = 0; i < 30 && getPid(); i++) await sleep(200);
  const left = getPid();
  if (left) {
    console.error(`port ${PORT} is still held by pid=${left}; restart aborted (nothing was started).`);
    return 1;
  }
  return cmdStart();
}

const cmd = process.argv[2] || 'status';
const commands = {
  start: cmdStart,
  stop: async () => (stop() ? 0 : 1),
  restart: cmdRestart,
  status: cmdStatus,
};
const fn = commands[cmd] || cmdStatus;
fn().then((code) => process.exit(code ?? 0));
