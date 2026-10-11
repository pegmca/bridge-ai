import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { Readable } from 'node:stream';
import { detectStreamError } from './quota.js';

// Forward a single request to the upstream vendor and return a Promise that
// resolves once we are *committed* to a successful response (so the caller can
// safely copy headers to the client). For streaming we peek the first SSE event
// before committing, so an in-stream error can still trigger a failover.

export class UpstreamHttpError extends Error {
  constructor(status, message) {
    super(message || `upstream returned ${status}`);
    this.name = 'UpstreamHttpError';
    this.status = status;
  }
}

export class UpstreamStreamError extends Error {
  constructor(detail) {
    super('upstream stream error');
    this.name = 'UpstreamStreamError';
    this.detail = detail;
  }
}

function pickClient(protocol) {
  return protocol === 'http:' ? http : https;
}

// payload: { baseUrl, path, method, headers, bodyStr, stream, timeout }
export function forwardRequest(payload) {
  const u = new URL(payload.baseUrl);
  const client = pickClient(u.protocol);
  const headers = { ...payload.headers };
  // Force uncompressed so we can safely peek the stream as UTF-8 text.
  headers['accept-encoding'] = 'identity';
  if (payload.bodyStr != null) {
    headers['content-length'] = Buffer.byteLength(payload.bodyStr);
  } else {
    delete headers['content-length'];
  }

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: payload.path,
        method: payload.method || 'POST',
        headers,
        timeout: payload.timeout || 120000,
      },
      (res) => {
        const status = res.statusCode;

        if (status !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            reject(new UpstreamHttpError(status, body.slice(0, 500)));
          });
          res.on('error', (e) => reject(e));
          return;
        }

        if (!payload.stream) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ streaming: false, status, headers: res.headers, body: Buffer.concat(chunks) })
          );
          res.on('error', (e) => reject(e));
          return;
        }

        // Streaming: peek first SSE event before committing to the client.
        const out = new Readable({ read() {} });
        const peekChunks = [];
        let acc = '';
        let committed = false;

        const commit = () => {
          if (committed) return;
          committed = true;
          out.push(Buffer.concat(peekChunks));
          res.on('data', (d) => out.push(d));
          res.on('end', () => out.push(null));
          res.on('error', (e) => out.destroy(e));
          resolve({ streaming: true, status, headers: res.headers, stream: out });
        };

        res.on('data', (chunk) => {
          if (committed) return; // a later 'data' listener now owns forwarding
          peekChunks.push(chunk);
          acc += chunk.toString('utf8');
          if (acc.includes('\n\n') || acc.length > 8192) {
            const err = detectStreamError(acc);
            if (err) {
              res.destroy();
              reject(new UpstreamStreamError(err));
              return;
            }
            commit();
          }
        });
        res.on('end', () => {
          if (committed) return;
          const err = detectStreamError(acc);
          if (err) {
            reject(new UpstreamStreamError(err));
            return;
          }
          commit();
        });
        res.on('error', (e) => {
          if (!committed) reject(e);
          else out.destroy(e);
        });
      }
    );

    req.on('error', (e) => reject(e));
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    if (payload.bodyStr != null) req.write(payload.bodyStr);
    req.end();
  });
}
