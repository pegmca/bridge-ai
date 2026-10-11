#!/usr/bin/env node
// Bootstrap helper: capture CodeBuddy's offline refresh token by intercepting
// the CLI's local TLS traffic for one request, then write it into config.json.
//
// Usage (on the server, as root):
//   node scripts/capture-token.mjs [--config /path/to/config.json]
//
// What it does:
//   1. Generates a self-signed cert for copilot.tencent.com (first run only).
//   2. Redirects copilot.tencent.com + wb.tencentbuddy.com to 127.0.0.1 in
//      /etc/hosts and starts a TLS MITM on 127.0.0.1:443 that forwards to the
//      real hosts.
//   3. Runs `codebuddy -p "hi"` once (TLS verification disabled) so the CLI
//      performs a token refresh; the refresh request's X-Refresh-Token is captured.
//   4. Writes the captured token + userId into the first "refresh" account in
//      config.json and exits. /etc/hosts is restored.
//
// The refresh token rotates and is persisted by the bridge afterwards, so you
// normally only run this once (or when the token chain breaks).

import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import tls from 'node:tls';
import https from 'node:https';
import { execSync, spawn } from 'node:child_process';

const CONFIG_DEFAULT = path.join(process.cwd(), 'config.json');
const argv = process.argv.slice(2);
const ci = argv.indexOf('--config');
const configPath = ci !== -1 ? argv[ci + 1] : process.env.BRIDGE_CONFIG || CONFIG_DEFAULT;

const CERT = '/tmp/bridge_cb_cert.pem';
const KEY = '/tmp/bridge_cb_key.pem';
const TARGETS = { 'copilot.tencent.com': '43.159.104.94', 'wb.tencentbuddy.com': '43.144.166.38' };
const HOSTS_LINE = '127.0.0.1 copilot.tencent.com wb.tencentbuddy.com';

function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  console.log('[capture] generating self-signed cert...');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${KEY} -out ${CERT} -days 2 -subj "/CN=copilot.tencent.com"`,
    { stdio: 'ignore' }
  );
}

function restoreHosts(bak) {
  if (bak && fs.existsSync(bak)) fs.copyFileSync(bak, '/etc/hosts');
}

async function main() {
  if (process.getuid?.() !== 0) {
    console.error('[capture] this must run as root (needs /etc/hosts + :443).');
    process.exit(1);
  }
  ensureCert();
  const key = fs.readFileSync(KEY);
  const cert = fs.readFileSync(CERT);

  const captured = { rt: null, uid: null };
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
        const [method, p] = lines[0].split(' ');
        const headers = {};
        for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i < 0) continue; headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        const host = headers['host'] || 'copilot.tencent.com';
        const ip = TARGETS[host] || TARGETS['copilot.tencent.com'];
        if (p === '/v2/plugin/auth/token/refresh') {
          captured.rt = headers['x-refresh-token'] || null;
          captured.uid = headers['x-user-id'] || null;
          console.log('[capture] got refresh token (len ' + (captured.rt ? captured.rt.length : 0) + '), uid=' + captured.uid);
        }
        const fwd = https.request(
          { host: ip, port:443, path: p, method, headers: { ...headers, host }, servername: host },
          (res) => { const rb = []; res.on('data', (c) => rb.push(c)); res.on('end', () => { const body = Buffer.concat(rb); socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`); for (const [k,v] of Object.entries(res.headers)) if (k.toLowerCase()!=='transfer-encoding') socket.write(`${k}: ${v}\r\n`); socket.write(`Content-Length: ${body.length}\r\n\r\n`); socket.write(body); }); }
        );
        fwd.write(buf); // forward the buffered bytes (headers + any body start)
        fwd.on('error', () => socket.end('HTTP/1.1 502\r\nContent-Length: 0\r\n\r\n'));
        socket.on('data', (d) => fwd.write(d));
        socket.on('end', () => fwd.end());
      });
      socket.on('error', () => {});
    }
  );
  server.listen(443, '127.0.0.1');

  const hostsBak = '/tmp/bridge_hosts_bak';
  fs.copyFileSync('/etc/hosts', hostsBak);
  const filtered = fs.readFileSync('/etc/hosts', 'utf8').split('\n').filter((l) => !/copilot\.tencent\.com|wb\.tencentbuddy\.com/.test(l)).join('\n');
  fs.writeFileSync('/etc/hosts', filtered + '\n' + HOSTS_LINE + '\n');
  console.log('[capture] /etc/hosts redirected; running a one-shot codebuddy chat to trigger refresh...');

  const cli = spawn('codebuddy', ['-p', 'hi'], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'ignore' });
  await new Promise((res) => cli.on('exit', res));
  await new Promise((r) => setTimeout(r, 500));
  restoreHosts(hostsBak);
  server.close();

  if (!captured.rt) {
    console.error('[capture] FAILED to capture a refresh token. Check that codebuddy is logged in and try again.');
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const acct = (cfg.accounts || []).find((a) => (a.auth || {}).mode === 'refresh');
  if (!acct) { console.error('[capture] no "refresh" account in ' + configPath + '. Add one first (see config.example.json).'); process.exit(1); }
  acct.auth.refreshToken = captured.rt;
  if (captured.uid) acct.auth.userId = captured.uid;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  console.log('[capture] wrote refresh token + userId into ' + configPath);
  console.log('[capture] done. Start/restart the bridge: node src/index.js server');
}

process.on('exit', () => {});
main().catch((e) => { console.error(e); process.exit(1); });
