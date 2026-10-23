// Keeping the account pool in step with the workbuddy-switch store.
//
// The store is the single source of truth (see store-wbs.js), and another tool
// owns it: accounts get added, removed and their tokens rotate while the bridge
// is running. Reading it once at boot means a freshly added account is invisible
// until a restart — so the store is watched, and the pool is re-derived in place
// whenever it changes.

import fs from 'node:fs';
import path from 'node:path';
import { expandAccountSource, storeFile } from './store-wbs.js';
import { syncPool } from './accounts.js';

// accountSource entries + the hand-written config.accounts[] list, with the
// store winning on duplicate uids (two copies of one token chain would fight
// over rotation).
export function mergeAccounts(source, staticAccounts = []) {
  const exp = expandAccountSource(source);
  const staticUids = new Set(staticAccounts.map((a) => a.auth && a.auth.userId).filter(Boolean));
  const dupes = exp.entries.filter((e) => staticUids.has(e.wbs.uid));
  const fromStore = exp.entries.filter((e) => !staticUids.has(e.wbs.uid));
  return {
    file: exp.file,
    total: exp.total,
    fromStore,
    skipped: exp.skipped,
    dupes,
    accounts: [...fromStore, ...staticAccounts],
  };
}

function signature(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

// Watch the store's *directory*, not the file: the writer replaces accounts.json
// through an atomic rename, which detaches a watcher attached to the inode.
// Returns { apply, close } or null when watching is not possible.
export function watchAccountStore({
  source,
  staticAccounts = [],
  pool,
  rotation = null,
  log = console.log,
  warn = console.warn,
}) {
  const file = storeFile(source.path);
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (!fs.existsSync(dir)) return null;

  let timer = null;
  let last = signature(file);

  // Re-derive the pool. A manual call always applies; an automatic one only when
  // the file really changed (fs.watch is noisy on Windows).
  function apply(reason = 'manual', { force = true } = {}) {
    if (!force) {
      const sig = signature(file);
      if (sig === last) return { ok: true, changed: false, added: [], removed: [], total: pool.length };
    }
    let merged;
    try {
      merged = mergeAccounts(source, staticAccounts);
    } catch (e) {
      warn(`[bridge] account reload failed (${reason}) — keeping ${pool.length} account(s): ${(e && e.message) || e}`);
      return { ok: false, error: String((e && e.message) || e) };
    }
    // Flip before syncing so a write triggered by the sync itself cannot loop.
    last = signature(file);
    const res = syncPool(pool, merged.accounts, rotation);
    res.changed = res.added.length > 0 || res.removed.length > 0;
    // Only speak up when the pool actually changed; token write-backs from our
    // own rotation would otherwise log on every refresh.
    if (res.changed || reason === 'manual') {
      const delta = [];
      if (res.added.length) delta.push(`+${res.added.length} new: ${res.added.join(', ')}`);
      if (res.removed.length) delta.push(`-${res.removed.length} gone: ${res.removed.join(', ')}`);
      log(
        `[bridge] account pool reloaded (${reason}) — ${res.total} account${res.total === 1 ? '' : 's'}` +
          (delta.length ? `, ${delta.join('; ')}` : '')
      );
    }
    return { ok: true, ...res };
  }

  let watcher;
  try {
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== base) return; // e.g. .bridge-*.tmp
      if (timer) clearTimeout(timer);
      // The writer may still be mid-rename; a short debounce reads the final file.
      timer = setTimeout(() => {
        timer = null;
        apply('store changed', { force: false });
      }, 250);
      timer.unref?.();
    });
  } catch (e) {
    warn(`[bridge] cannot watch ${file} for changes: ${(e && e.message) || e}`);
    return null;
  }
  watcher.on('error', (e) => warn(`[bridge] account store watch error: ${(e && e.message) || e}`));

  return {
    file,
    apply,
    close() {
      if (timer) clearTimeout(timer);
      try {
        watcher.close();
      } catch {}
    },
  };
}
