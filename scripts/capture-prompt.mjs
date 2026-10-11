#!/usr/bin/env node
// Capture what the CodeBuddy CLI actually sends to the model: the full chat
// request body (system prompt, messages, tool definitions) for one request.
//
// Usage (on the server, as root):
//   node scripts/capture-prompt.mjs
//
// Technique: self-signed cert + /etc/hosts redirect + TLS MITM on :443, same as
// capture-token.mjs. The CLI's chat request body is saved to /tmp and the
// system prompt is printed. /etc/hosts is restored afterwards.
//
// This does NOT modify any bridge files; it only observes one CLI call.

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import tls from 'node:tls';
import https from 'node:https';
import zlib from 'node:zlib';
import { execSync, spawn } from 'node:child_process';

const CERT = '/tmp/bridge_cb_cert.pem';
const KEY = '/tmp/bridge_cb_key.pem';
const HOSTS = ['copilot.tencent.com', 'wb.tencentbuddy.com'];
const HOSTS_LINE = '127.0.0.1 ' + HOSTS.join(' ');
const OUT_DIR = '/tmp/bridge_cb_prompt';

function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  console.log('[capture] generating self-signed cert...');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${KEY} -out ${CERT} -days 2 ` +
      `-subj "/CN=copilot.tencent.com" ` +
      `-addext "subjectAltName=DNS:copilot.tencent.com,DNS:wb.tencentbuddy.com"`,
    { stdio: 'ignore' }
  );
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade']);

function resolveIps() {
  const map = {};
  for (const h of HOSTS) {
    try { map[h] = dns.lookupSync(h, { family: 4 }); } catch { /* keep */ }
  }
  return map;
}

async function resolveIpsAsync() {
  const fallback = { 'copilot.tencent.com': '43.159.104.94', 'wb.tencentbuddy.com': '43.144.166.38' };
  const map = {};
  for (const h of HOSTS) {
    try {
      const { address } = await dns.promises.lookup(h, { family: 4 });
      map[h] = address;
    } catch {
      try {
        const out = execSync(`getent hosts ${h}`, { encoding: 'utf8' }).trim().split(/\s+/);
        if (out[0]) map[h] = out[0];
      } catch { map[h] = fallback[h]; }
    }
  }
  return map;
}

function restoreHosts(bak) {
  if (bak && fs.existsSync(bak)) fs.copyFileSync(bak, '/etc/hosts');
}

function extractSystem(json) {
  const out = [];
  if (json && typeof json.system === 'string') out.push(['system(field)', json.system]);
  if (json && Array.isArray(json.messages)) {
    for (const m of json.messages) {
      if (m && m.role === 'system') out.push(['messages[].system', typeof m.content === 'string' ? m.content : JSON.stringify(m.content)]);
    }
  }
  return out;
}

async function main() {
  if (process.getuid?.() !== 0) {
    console.error('[capture] this must run as root (needs /etc/hosts + :443).');
    process.exit(1);
  }
  ensureCert();
  const key = fs.readFileSync(KEY);
  const cert = fs.readFileSync(CERT);
  const TARGETS = await resolveIpsAsync();
  console.log('[capture] resolved upstream IPs:', JSON.stringify(TARGETS));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let saveIdx = 0;
  const seen = [];

  const server = tls.createServer(
    { key, cert, SNICallback: (_s, cb) => cb(null, tls.createSecureContext({ key, cert })) },
    (socket) => {
      console.log('[capture] TLS connection accepted from', socket.remoteAddress);
      let buf = Buffer.alloc(0);
      let forwarded = false;
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!forwarded && buf.includes('\r\n\r\n')) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          const head = buf.slice(0, headerEnd).toString('latin1');
          const lines = head.split('\r\n');
          const [method, p] = lines[0].split(' ');
          const headers = {};
          for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i < 0) continue; headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
          const cl = parseInt(headers['content-length'] || '0', 10);
          const host = headers['host'] || HOSTS[0];
          const ip = TARGETS[host] || TARGETS[HOSTS[0]];
          if (!(buf.length >= headerEnd + 4 + cl)) return; // wait for full body

          const bodyBuf = buf.slice(headerEnd + 4, headerEnd + 4 + cl);
          forwarded = true;

          // Decompress the body if the client gzipped it (CLI does this).
          let bodyBytes = bodyBuf;
          const ce = (headers['content-encoding'] || '').toLowerCase();
          if (ce === 'gzip' || ce === 'x-gzip') {
            try { bodyBytes = zlib.gunzipSync(bodyBuf); } catch { /* keep raw */ }
          } else if (ce === 'deflate') {
            try { bodyBytes = zlib.inflateSync(bodyBuf); } catch { /* keep raw */ }
          }

          // Save EVERY request body for inspection (decoded text).
          const file = path.join(OUT_DIR, `req_${++saveIdx}.json`);
          const raw = bodyBytes.toString('utf8');
          fs.writeFileSync(file, raw);
          let keys = '', isChat = false;
          try {
            const json = JSON.parse(raw);
            keys = Object.keys(json).join(',');
            isChat = Array.isArray(json.messages);
          } catch { keys = '(non-JSON, ' + raw.length + ' bytes)'; }
          console.log(`[capture] ${method} ${p} body=${raw.length}B keys=[${keys}] -> ${file}`);

          // Pretty-extract system prompt only for chat-shaped bodies.
          if (isChat) {
            try {
              const json = JSON.parse(raw);
              const sys = extractSystem(json);
              seen.push({ p, file, sys, model: json.model, nTools: Array.isArray(json.tools) ? json.tools.length : 0 });
              console.log(`[capture]   ^ chat request (model=${json.model}, tools=${Array.isArray(json.tools) ? json.tools.length : 0}, systemBlocks=${sys.length})`);
            } catch { /* ignore */ }
          }

          // Forward the full request properly: headers via options, body via write.
          const fwdHeaders = {};
          for (const [k, v] of Object.entries(headers)) {
            if (HOP_BY_HOP.has(k)) continue;
            fwdHeaders[k] = v;
          }
          fwdHeaders.host = host;
          fwdHeaders.connection = 'close';
          const fwd = https.request(
            { host: ip, port: 443, path: p, method, headers: fwdHeaders, servername: host },
            (res) => {
              socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`);
              for (const [k, v] of Object.entries(res.headers)) {
                const lk = k.toLowerCase();
                if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
                socket.write(`${k}: ${v}\r\n`);
              }
              socket.write('Connection: close\r\n\r\n');
              res.on('data', (c) => socket.write(c));
              res.on('end', () => socket.end());
              res.on('error', () => socket.end());
            }
          );
          fwd.on('error', () => socket.end('HTTP/1.1 502\r\nContent-Length: 0\r\n\r\n'));
          fwd.write(bodyBuf);
          fwd.end();
        } else if (forwarded) {
          // keep-alive extra data (rare here) — ignore, connection:close used.
        }
      });
      socket.on('error', () => {});
    }
  );
  server.listen(443, '127.0.0.1');

  const hostsBak = '/tmp/bridge_hosts_bak';
  fs.copyFileSync('/etc/hosts', hostsBak);
  const filtered = fs.readFileSync('/etc/hosts', 'utf8').split('\n').filter((l) => !HOSTS.some((h) => l.includes(h))).join('\n');
  fs.writeFileSync('/etc/hosts', filtered + '\n' + HOSTS_LINE + '\n');
  console.log('[capture] /etc/hosts redirected; running one-shot codebuddy chat...');

  try {
    const cli = spawn('codebuddy', ['-p', 'hi'], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    cli.stdout.on('data', (d) => process.stdout.write('[cli] ' + d));
    cli.stderr.on('data', (d) => process.stdout.write('[cli!] ' + d));
    await new Promise((res) => cli.on('exit', res));
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    restoreHosts(hostsBak);
    server.close();
  }

  console.log('\n[capture] done. /etc/hosts restored.');
  console.log(`[capture] captured ${saveIdx} request(s) under ${OUT_DIR}/`);
  if (saveIdx === 0) {
    console.error('[capture] no request bodies captured at all — the CLI may not have made an HTTP request, or used a path we did not observe.');
    process.exit(1);
  }
  console.log('\n================ CAPTURED SYSTEM PROMPT(S) ================');
  for (const s of seen) {
    console.log(`\n--- from ${s.p} (model=${s.model}, tools=${s.nTools}) -> ${s.file}`);
    if (s.sys.length === 0) console.log('  (no explicit system block found in this request)');
    for (const [label, text] of s.sys) {
      console.log(`\n[${label}]\n` + text);
    }
  }
}

process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
main().catch((e) => { console.error(e); process.exit(1); });
