import os from 'node:os';
import path from 'node:path';

// Expand a leading ~ to the user's home directory.
export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Redact a secret for safe logging (keep first/last 4 chars).
export function redact(s) {
  if (!s) return s;
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '…' + s.slice(-4);
}

// Decode a JWT payload WITHOUT verifying the signature. Display-only: used to
// show which account a token belongs to and when it expires; never trust it for
// authorization decisions.
export function decodeJwt(tok) {
  if (typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}
