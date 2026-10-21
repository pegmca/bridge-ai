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

function status() {
  const pid = getPid();
  if (!pid) { console.log(`NOT RUNNING (no listener on :${PORT})`); return; }
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 5000 }, (res) => {
    console.log(`RUNNING  pid=${pid}  healthz=${res.statusCode}`);
    res.resume();
  });
  req.on('error', () => console.log(`RUNNING  pid=${pid}  healthz=n/a`));
  req.on('timeout', function () { this.destroy(); console.log(`RUNNING  pid=${pid}  healthz=timeout`); });
}

function start() {
  if (getPid()) { console.log('already running'); return; }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['src/index.js', 'server'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  setTimeout(() => console.log(`started, pid=${child.pid}  log=${LOG}`), 1500);
}

function stop() {
  const pid = getPid();
  if (!pid) { console.log('not running'); return; }
  try {
    if (os.platform() === 'win32') spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
    console.log(`stopped ${pid}`);
  } catch (e) { console.log('stop failed: ' + e.message); }
  try { fs.unlinkSync(PIDFILE); } catch {}
}

const cmd = process.argv[2] || 'status';
if (cmd === 'start') start();
else if (cmd === 'stop') stop();
else if (cmd === 'restart') { stop(); setTimeout(start, 1200); }
else status();
