// Automatic re-capture of CodeBuddy's offline refresh token.
//
// When the upstream rejects our (rotated) refresh token (e.g. code=12153
// "refresh token is invalid"), the bridge can self-heal by re-running the same
// MITM bootstrap that `scripts/capture-token.mjs` does: it briefly intercepts
// the local `codebuddy` CLI's TLS traffic, grabs a fresh X-Refresh-Token, and
// writes it back into config.json.
//
// Because the MITM must bind :443, and a web server (nginx) often already holds
// that port, this module temporarily stops and restarts it. It is opt-in via
// `autoRecapture` in config and only runs as root with the CLI installed.
//
// All of this is best-effort and fails safe: if anything goes wrong, it throws
// so the original request fails rather than looping forever.

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import tls from 'node:tls';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';

const CERT = '/tmp/bridge_cb_cert.pem';
const KEY = '/tmp/bridge_cb_key.pem';
const HOSTS_LINE = '127.0.0.1 copilot.tencent.com wb.tencentbuddy.com';
const DOMAINS = ['copilot.tencent.com', 'wb.tencentbuddy.com'];

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // don't retry auto-recapture more than once / 10 min after a failure

// Serialize concurrent recaptures (only one MITM on :443 at a time).
let inFlight = null;
let lastFailureAt = 0;

export function resetRecaptureState() {
  inFlight = null;
  lastFailureAt = 0;
}

async function resolveIp(host) {
  return new Promise((res, rej) => {
    dns.lookup(host, { family: 4 }, (e, a) => (e ? rej(e) : res(a)));
  });
}

function ensureCert(log) {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  log('[recapture] generating self-signed cert...');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY, '-out', CERT, '-days', '2', '-subj', '/CN=copilot.tencent.com',
  ], { stdio: 'ignore' });
}

// Find the process(es) bound to :443 and figure out how to stop/restart them.
function probePort443(log) {
  let out = '';
  try { out = execFileSync('ss', ['-ltnp', '-4'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch {
    try { out = execFileSync('ss', ['-ltnp'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return []; }
  }
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!/(^|\s|:)(0\.0\.0\.0|127\.0\.0\.1|\[::\]|\*):443(\s|$)/.test(line)) continue;
    const m = line.match(/pid=(\d+)/g) || [];
    m.forEach((x) => pids.add(Number(x.slice(4))));
  }
  const occupants = [];
  for (const pid of pids) {
    let name = '';
    try { name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { continue; }
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
    occupants.push({ pid, name, cmdline });
  }
  return occupants;
}

// Wait until :443 is free (the stopped process may take a moment to release it).
async function waitPortFree(log, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const occ = probePort443(log);
    if (occ.length === 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stopOccupants(occupants, log) {
  const restart = [];
  const isNginx = occupants.some((o) => o.name === 'nginx');
  if (isNginx) {
    log('[recapture] :443 held by nginx — stopping it for the MITM window');
    try { execFileSync('nginx', ['-s', 'quit'], { stdio: 'ignore' }); } catch { try { execFileSync('pkill', ['-x', 'nginx'], { stdio: 'ignore' }); } catch {} }
    restart.push({ kind: 'nginx' });
    return restart;
  }
  // Unknown occupant: best-effort stop + remember how to restart it.
  for (const o of occupants) {
    log(`[recapture] :443 held by ${o.name} (pid ${o.pid}) — stopping it for the MITM window`);
    try { process.kill(o.pid, 'SIGKILL'); } catch {}
    if (o.cmdline) restart.push({ kind: 'cmdline', cmdline: o.cmdline });
  }
  return restart;
}

function startOccupants(restart, log) {
  for (const r of restart) {
    try {
      if (r.kind === 'nginx') {
        try { execFileSync('nginx', [], { stdio: 'ignore' }); }
        catch { execFileSync('systemctl', ['start', 'nginx'], { stdio: 'ignore' }); }
        log('[recapture] nginx restarted');
      } else if (r.kind === 'cmdline') {
        const [bin, ...args] = r.cmdline.split(/\s+/);
        spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
        log(`[recapture] restarted occupant: ${r.cmdline}`);
      }
    } catch (e) {
      log(`[recapture] WARNING: could not restart occupant (${r.kind}): ${e.message}`);
    }
  }
}

function redirectHosts(log) {
  const bak = '/tmp/bridge_hosts_bak_' + Date.now();
  fs.copyFileSync('/etc/hosts', bak);
  const filtered = fs.readFileSync('/etc/hosts', 'utf8')
    .split('\n')
    .filter((l) => !DOMAINS.some((d) => l.includes(d)))
    .join('\n');
  fs.writeFileSync('/etc/hosts', filtered + '\n' + HOSTS_LINE + '\n');
  log('[recapture] /etc/hosts redirected to localhost');
  return bak;
}

function restoreHosts(bak, log) {
  try {
    if (bak && fs.existsSync(bak)) { fs.copyFileSync(bak, '/etc/hosts'); fs.unlinkSync(bak); }
    log('[recapture] /etc/hosts restored');
  } catch (e) { log(`[recapture] WARNING: failed to restore /etc/hosts: ${e.message}`); }
}

function runMitm(log) {
  const key = fs.readFileSync(KEY);
  const cert = fs.readFileSync(CERT);
  const captured = { rt: null, uid: null };
  return new Promise((resolve, reject) => {
    const server = tls.createServer(
      { key, cert, SNICallback: (_s, cb) => cb(null, tls.createSecureContext({ key, cert })) },
      (socket) => {
        const chunks = [];
        socket.on('data', (d) => {
          chunks.push(d);
          const buf = Buffer.concat(chunks);
          if (!buf.includes('\r\n\r\n')) return;
          const head = buf.slice(0, buf.indexOf('\r\n\r\n')).toString('latin1');
          const lines = head.split('\r\n');
          const [method, p] = (lines[0] || '').split(' ');
          const headers = {};
          for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i < 0) continue; headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
          const host = headers['host'] || 'copilot.tencent.com';
          if (p === '/v2/plugin/auth/token/refresh') {
            captured.rt = headers['x-refresh-token'] || null;
            captured.uid = headers['x-user-id'] || null;
            log(`[recapture] got refresh token (len ${captured.rt ? captured.rt.length : 0}), uid=${captured.uid}`);
          }
          const ipP = new Promise((res) => {
            if (p === '/v2/plugin/auth/token/refresh') res(null);
            else resolveIp(host).then(res, () => res(null));
          });
          ipP.then((ip) => {
            const fwd = https.request(
              { host: ip || host, port: 443, path: p, method, headers: { ...headers, host }, servername: host },
              (res2) => {
                const rb = [];
                res2.on('data', (c) => rb.push(c));
                res2.on('end', () => {
                  const body = Buffer.concat(rb);
                  socket.write(`HTTP/1.1 ${res2.statusCode} ${res2.statusMessage || ''}\r\n`);
                  for (const [k, v] of Object.entries(res2.headers)) if (k.toLowerCase() !== 'transfer-encoding') socket.write(`${k}: ${v}\r\n`);
                  socket.write(`Content-Length: ${body.length}\r\n\r\n`);
                  socket.write(body);
                });
              }
            );
            fwd.on('error', () => socket.end('HTTP/1.1 502\r\nContent-Length: 0\r\n\r\n'));
            fwd.write(buf);
            socket.on('data', (dd) => fwd.write(dd));
            socket.on('end', () => fwd.end());
          });
        });
        socket.on('error', () => {});
      }
    );
    server.on('error', reject);
    server.listen(443, '127.0.0.1', () => resolve({ server, captured }));
  });
}

function writeToken(configPath, accountName, refreshToken, userId, log) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const accts = cfg.accounts || [];
  const target = accts.find((a) => a.name === accountName && (a.auth || {}).mode === 'refresh')
    || accts.find((a) => (a.auth || {}).mode === 'refresh');
  if (!target) throw new Error('no "refresh" account in ' + configPath);
  target.auth.refreshToken = refreshToken;
  if (userId) target.auth.userId = userId;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  log(`[recapture] wrote fresh refresh token into ${configPath}`);
}

// Main entry. Returns { refreshToken, userId } or throws.
export async function runRecapture({ configPath, accountName, log = console.log, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  if (process.getuid?.() !== 0) throw new Error('auto-recapture requires root (needs /etc/hosts + :443)');
  if (inFlight) return inFlight;
  if (Date.now() - lastFailureAt < cooldownMs) {
    throw new Error('auto-recapture is in cooldown after a previous failure; retry later or run scripts/capture-token.mjs manually');
  }
  inFlight = (async () => {
    let hostsBak = null;
    let server = null;
    let restart = [];
    try {
      ensureCert(log);
      const occupants = probePort443(log);
      restart = stopOccupants(occupants, log);
      const freed = await waitPortFree(log);
      if (!freed) log('[recapture] WARNING: :443 still occupied after stop; MITM may fail to bind');
      hostsBak = redirectHosts(log);
      const { server: srv, captured } = await runMitm(log);
      server = srv;
      const cli = spawn('codebuddy', ['-p', 'hi'], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'ignore' });
      await new Promise((res) => cli.on('exit', res));
      await new Promise((r) => setTimeout(r, 500));
      if (!captured.rt) throw new Error('MITM did not capture a refresh token (is codebuddy CLI logged in?)');
      writeToken(configPath, accountName, captured.rt, captured.uid, log);
      return { refreshToken: captured.rt, userId: captured.uid };
    } finally {
      if (server) { try { server.close(); } catch {} }
      if (hostsBak) restoreHosts(hostsBak, log);
      startOccupants(restart, log);
    }
  })().catch((e) => {
    lastFailureAt = Date.now();
    throw e;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
