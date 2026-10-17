#!/usr/bin/env node
// Dump the EXACT request headers the official `codebuddy` CLI sends to
// /v2/chat/completions. Useful to discover channel-verification headers
// (e.g. X-Codebuddy-Channel) that gated models may require.
//
// Run on the server as root (needs /etc/hosts + :443, temporarily stops nginx).
import fs from 'node:fs';
import dns from 'node:dns';
import tls from 'node:tls';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';

const CERT = '/tmp/bridge_cb_cert.pem';
const KEY = '/tmp/bridge_cb_key.pem';
const HOSTS_LINE = '127.0.0.1 copilot.tencent.com wb.tencentbuddy.com';
const DOMAINS = ['copilot.tencent.com', 'wb.tencentbuddy.com'];

function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', CERT, '-days', '2', '-subj', '/CN=copilot.tencent.com'], { stdio: 'ignore' });
}
function probe443() {
  let out = '';
  try { out = execFileSync('ss', ['-ltnp', '-4'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { try { out = execFileSync('ss', ['-ltnp'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return []; } }
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!/(^|\s|:)(0\.0\.0\.0|127\.0\.0\.1|\[::\]|\*):443(\s|$)/.test(line)) continue;
    (line.match(/pid=(\d+)/g) || []).forEach((x) => pids.add(Number(x.slice(4))));
  }
  const occ = [];
  for (const pid of pids) {
    let name = '', cmd = '';
    try { name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch {}
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
    occ.push({ pid, name, cmd });
  }
  return occ;
}
function stopOcc(occ) {
  const restart = [];
  if (occ.some((o) => o.name === 'nginx')) {
    try { execFileSync('nginx', ['-s', 'quit'], { stdio: 'ignore' }); } catch { try { execFileSync('pkill', ['-x', 'nginx'], { stdio: 'ignore' }); } catch {} }
    restart.push({ kind: 'nginx' });
    return restart;
  }
  for (const o of occ) { try { process.kill(o.pid, 'SIGKILL'); } catch {} if (o.cmd) restart.push({ kind: 'cmd', cmd: o.cmd }); }
  return restart;
}
function startOcc(restart) {
  for (const r of restart) {
    try {
      if (r.kind === 'nginx') { try { execFileSync('nginx', [], { stdio: 'ignore' }); } catch { execFileSync('systemctl', ['start', 'nginx'], { stdio: 'ignore' }); } }
      else { const [b, ...a] = r.cmd.split(/\s+/); spawn(b, a, { stdio: 'ignore', detached: true }).unref(); }
    } catch (e) { console.log('[warn] restart failed', r.kind, e.message); }
  }
}

async function main() {
  if (process.getuid?.() !== 0) { console.error('must run as root'); process.exit(1); }
  ensureCert();
  const key = fs.readFileSync(KEY), cert = fs.readFileSync(CERT);
  const occupants = probe443();
  const restart = stopOcc(occupants);
  const bak = '/tmp/bridge_hosts_bak_' + Date.now();
  fs.copyFileSync('/etc/hosts', bak);
  const filtered = fs.readFileSync('/etc/hosts', 'utf8').split('\n').filter((l) => !DOMAINS.some((d) => l.includes(d))).join('\n');
  fs.writeFileSync('/etc/hosts', filtered + '\n' + HOSTS_LINE + '\n');
  console.log('[cap-h] /etc/hosts redirected; running one codebuddy chat...');

  const server = tls.createServer({ key, cert, SNICallback: (_s, cb) => cb(null, tls.createSecureContext({ key, cert })) }, (socket) => {
    const chunks = [];
    socket.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (!buf.includes('\r\n\r\n')) return;
      const head = buf.slice(0, buf.indexOf('\r\n\r\n')).toString('latin1');
      const lines = head.split('\r\n');
      const [method, p] = (lines[0] || '').split(' ');
      if (p === '/v2/chat/completions') {
        console.log('\n===== CLI CHAT REQUEST HEADERS =====');
        console.log(head);
        console.log('===== END =====\n');
      }
      const host = (lines.slice(1).find((l) => l.toLowerCase().startsWith('host:')) || '').split(':')[1]?.trim() || 'copilot.tencent.com';
      dns.lookup(host, { family: 4 }, (e, ip) => {
        const fwd = https.request({ host: ip || host, port: 443, path: p, method, headers: { ...Object.fromEntries(lines.slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; })), host }, servername: host }, (res) => { const rb = []; res.on('data', (c) => rb.push(c)); res.on('end', () => { const body = Buffer.concat(rb); socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}\r\n`); for (const [k, v] of Object.entries(res.headers)) if (k.toLowerCase() !== 'transfer-encoding') socket.write(`${k}: ${v}\r\n`); socket.write(`Content-Length: ${body.length}\r\n\r\n`); socket.write(body); }); });
        fwd.on('error', () => socket.end('HTTP/1.1 502\r\nContent-Length: 0\r\n\r\n'));
        fwd.write(buf);
        socket.on('data', (dd) => fwd.write(dd));
        socket.on('end', () => fwd.end());
      });
    });
    socket.on('error', () => {});
  });
  server.listen(443, '127.0.0.1');
  const cli = spawn('codebuddy', ['-p', 'hi'], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'ignore' });
  await new Promise((r) => cli.on('exit', r));
  await new Promise((r) => setTimeout(r, 500));
  server.close();
  fs.copyFileSync(bak, '/etc/hosts'); fs.unlinkSync(bak);
  startOcc(restart);
  console.log('[cap-h] done. /etc/hosts restored, services restarted.');
}
main().catch((e) => { console.error(e); process.exit(1); });
