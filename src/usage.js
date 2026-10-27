// Per-request token / credit usage accounting for the bridge.
//
// The upstream CodeBuddy chat API reports a `usage` object on the final SSE
// event of every stream. The bridge otherwise throws that away, so this module
// (a) sniffs it off the response stream without touching the bytes the client
// receives, (b) appends one line per request to a date-partitioned JSONL file,
// and (c) keeps rolling in-memory aggregates so the dashboard can render
// without re-scanning files on every poll.
//
// Token "type" breakdown we care about (verified against a live hy4-preview-f
// response): prompt vs completion, and within the prompt — cache hit / miss /
// write. The completion side can be split further into reasoning ("thinking")
// tokens via completion_tokens_details.reasoning_tokens. The real billing unit
// is `credit`, not tokens, so that is surfaced too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86400000;

// Resolve the usage data dir relative to the project root so it survives
// restarts regardless of the process working directory. The bridge is often
// launched as an elevated / service process whose cwd is not the repo, and a
// cwd-relative `./data/usage` would make writes and the startup backfill land
// in different places — i.e. stats would silently vanish on every restart.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ymd(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function round(x, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((x + Number.EPSILON) * f) / f;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

// Map whichever field names the upstream happens to emit onto a stable set of
// canonical numbers. CodeBuddy ships both its own names (prompt_cache_*_tokens)
// and OpenAI-style aliases (cache_read/cache_creation_input_tokens); the latter
// are treated as fallbacks. The raw object is stored verbatim in the JSONL, so
// nothing is lost if the upstream adds or renames fields.
export function derive(u) {
  if (!u || typeof u !== 'object') return null;
  const hit = num(u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens);
  const miss = num(u.prompt_cache_miss_tokens);
  const write = num(u.prompt_cache_write_tokens ?? u.cache_creation_input_tokens);
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const reasoning =
    num((u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) ?? u.completion_thinking_tokens);
  const credit = typeof u.credit === 'number' ? u.credit : 0;
  return { prompt, completion, reasoning, hit, miss, write, credit };
}

// Attach a read-only tap to an SSE stream: accumulate chunks, split on blank
// lines, and keep the latest `usage` object seen. Does not consume or alter the
// data the client receives (the stream is piped elsewhere in parallel).
export function attachUsageTap(stream, holder) {
  let buf = '';
  const scan = (evt) => {
    for (const line of evt.split('\n')) {
      const s = line.trim();
      if (s.length < 6 || s.slice(0, 5) !== 'data:') continue;
      const json = s.slice(5).trim();
      if (json === '[DONE]') continue;
      try {
        const obj = JSON.parse(json);
        if (obj && obj.usage) holder.usage = obj.usage;
      } catch {}
    }
  };
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      scan(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  });
  const flush = () => {
    if (buf) {
      scan(buf);
      buf = '';
    }
  };
  stream.on('end', flush);
  stream.on('error', flush);
}

export function createUsageRecorder({ dir, retainDays = 90, enabled = true } = {}) {
  const rawDir = dir || './data/usage';
  const useDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(PROJECT_ROOT, rawDir);
  let warned = false;

  // Rolling aggregates keyed by date (YYYY-MM-DD), kept for ~30 days in memory.
  const days = new Map();

  const emptyAgg = () => ({
    requests: 0,
    unsettle: 0,
    credit: 0,
    prompt: 0,
    completion: 0,
    reasoning: 0,
    hit: 0,
    miss: 0,
    write: 0,
    accounts: new Map(),
    models: new Map(),
  });

  const day = (date) => {
    let a = days.get(date);
    if (!a) {
      a = emptyAgg();
      days.set(date, a);
    }
    return a;
  };

  // Wall-clock time of the oldest record still held. The dashboard shows it as
  // "统计开始时间" so the lifetime totals have a frame of reference. A reset
  // clears it; it is derived from data, never from process start.
  let sinceTs = null;
  const noteSince = (ts) => {
    const t = Number(ts) || 0;
    if (t > 0 && (sinceTs === null || t < sinceTs)) sinceTs = t;
  };

  // Called from two places with different shapes: record() passes freshly
  // derived numbers (one request), snapshot() passes a whole day aggregate
  // (many requests). Take the count from `d.requests` when present so the
  // per-account / per-model `requests` field is a real count, not always 1.
  const bump = (map, key, d) => {
    let e = map.get(key);
    if (!e) {
      e = { requests: 0, credit: 0, prompt: 0, completion: 0, reasoning: 0, hit: 0, miss: 0, write: 0 };
      map.set(key, e);
    }
    e.requests += d && typeof d.requests === 'number' ? d.requests : 1;
    if (d) {
      e.credit += d.credit;
      e.prompt += d.prompt;
      e.completion += d.completion;
      e.reasoning += d.reasoning;
      e.hit += d.hit;
      e.miss += d.miss;
      e.write += d.write;
    }
  };

  function record(entry) {
    if (!enabled) return;
    const date = entry.date || ymd(entry.ts || Date.now());
    noteSince(entry.ts || Date.now());
    const a = day(date);
    const d = entry.derived || derive(entry.usage);
    a.requests += 1;
    if (!d) a.unsettle += 1;
    if (d) {
      a.credit += d.credit;
      a.prompt += d.prompt;
      a.completion += d.completion;
      a.reasoning += d.reasoning;
      a.hit += d.hit;
      a.miss += d.miss;
      a.write += d.write;
    }
    bump(a.accounts, entry.account || 'unknown', d);
    bump(a.models, entry.model || 'unknown', d);
    try {
      fs.mkdirSync(useDir, { recursive: true });
      fs.appendFileSync(path.join(useDir, `usage-${date}.jsonl`), JSON.stringify(entry) + '\n');
    } catch (e) {
      if (!warned) {
        console.error(`[usage] write failed: ${e.message}`);
        warned = true;
      }
    }
  }

  function loadHistory(daysBack = 30) {
    try {
      fs.mkdirSync(useDir, { recursive: true });
    } catch {}
    const now = Date.now();
    for (let i = 0; i <= daysBack; i++) {
      const date = ymd(now - i * DAY);
      const file = path.join(useDir, `usage-${date}.jsonl`);
      let txt;
      try {
        txt = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const ln of txt.split('\n')) {
        if (!ln.trim()) continue;
        try {
          const entry = JSON.parse(ln);
          noteSince(entry.ts || Date.parse(date + 'T00:00:00'));
          const a = day(entry.date || date);
          const d = entry.derived || derive(entry.usage);
          a.requests += 1;
          if (!d) a.unsettle += 1;
          if (d) {
            a.credit += d.credit;
            a.prompt += d.prompt;
            a.completion += d.completion;
            a.reasoning += d.reasoning;
            a.hit += d.hit;
            a.miss += d.miss;
            a.write += d.write;
          }
          bump(a.accounts, entry.account || 'unknown', d);
          bump(a.models, entry.model || 'unknown', d);
        } catch {}
      }
    }
  }

  function prune() {
    if (!retainDays || retainDays <= 0) return;
    try {
      const cut = Date.now() - retainDays * DAY;
      for (const f of fs.readdirSync(useDir)) {
        const m = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m) continue;
        const t = Date.parse(m[1] + 'T00:00:00');
        if (!isNaN(t) && t < cut) {
          try {
            fs.unlinkSync(path.join(useDir, f));
          } catch {}
        }
      }
    } catch {}
  }

  const serialize = (map) =>
    [...map.entries()].map(([name, v]) => ({ name, ...v })).sort((x, y) => y.credit - x.credit);

  // Aggregate. `rangeDays <= 0` (or omitted) means "everything we hold" — the
  // dashboard only ever asks for that; the per-day/per-account breakdowns are
  // still returned for anyone calling the endpoint directly.
  function snapshot(rangeDays = 1) {
    const now = Date.now();
    const allTime = !rangeDays || rangeDays <= 0;
    const dates = [];
    if (allTime) {
      dates.push(...[...days.keys()].sort());
    } else {
      for (let i = rangeDays - 1; i >= 0; i--) dates.push(ymd(now - i * DAY));
    }
    const outDays = [];
    const tot = emptyAgg();
    const accMap = new Map();
    const modMap = new Map();
    for (const date of dates) {
      const a = days.get(date);
      outDays.push({
        date,
        requests: a ? a.requests : 0,
        unsettle: a ? a.unsettle : 0,
        credit: a ? round(a.credit) : 0,
        prompt: a ? a.prompt : 0,
        completion: a ? a.completion : 0,
        reasoning: a ? a.reasoning : 0,
        hit: a ? a.hit : 0,
        miss: a ? a.miss : 0,
        write: a ? a.write : 0,
      });
      if (a) {
        tot.requests += a.requests;
        tot.unsettle += a.unsettle;
        tot.credit += a.credit;
        tot.prompt += a.prompt;
        tot.completion += a.completion;
        tot.reasoning += a.reasoning;
        tot.hit += a.hit;
        tot.miss += a.miss;
        tot.write += a.write;
        for (const [k, v] of a.accounts) bump(accMap, k, v);
        for (const [k, v] of a.models) bump(modMap, k, v);
      }
    }
    const hitRate = tot.hit + tot.miss > 0 ? round(tot.hit / (tot.hit + tot.miss), 4) : null;
    return {
      rangeDays: allTime ? 0 : rangeDays,
      since: sinceTs,
      generatedAt: now,
      total: {
        requests: tot.requests,
        unsettle: tot.unsettle,
        credit: round(tot.credit),
        prompt: tot.prompt,
        completion: tot.completion,
        reasoning: tot.reasoning,
        hit: tot.hit,
        miss: tot.miss,
        write: tot.write,
        hitRate,
      },
      perDay: outDays,
      perAccount: serialize(accMap),
      perModel: serialize(modMap),
    };
  }

  // Clear all usage data: both the in-memory aggregates and the on-disk JSONL
  // files. This is the ONLY path that wipes statistics — it is triggered solely
  // by an explicit POST /admin/usage/reset (e.g. the dashboard "重置" button),
  // never on startup or restart. Pass { days } to keep only data outside that
  // trailing window (i.e. delete the last `days` days).
  function reset(opts = {}) {
    const rangeDays = typeof opts.days === 'number' && opts.days > 0 ? opts.days : null;
    days.clear();
    sinceTs = null;
    let deleted = 0;
    try {
      fs.mkdirSync(useDir, { recursive: true });
      const now = Date.now();
      for (const f of fs.readdirSync(useDir)) {
        const m = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m) continue;
        if (rangeDays) {
          const t = Date.parse(m[1] + 'T00:00:00');
          if (isNaN(t) || now - t > rangeDays * DAY) continue; // keep outside range
        }
        try {
          fs.unlinkSync(path.join(useDir, f));
          deleted += 1;
        } catch {}
      }
    } catch {}
    return { deleted };
  }

  return { record, loadHistory, prune, snapshot, reset, dir: useDir };
}
