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
