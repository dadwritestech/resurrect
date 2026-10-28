// Wayback CDX index: which captures exist, and which one to use for each page.

import { urlKey } from './urls.js';

const CDX = 'https://web.archive.org/cdx/search/cdx';
const FIELDS = 'urlkey,timestamp,original,mimetype,statuscode,digest,length';

export function cdxQueryUrl(scope, { pageSize = 5000, resumeKey, year } = {}) {
  const q = new URLSearchParams({
    url: scope.cdxUrl,
    matchType: 'prefix',
    output: 'json',
    fl: FIELDS,
    filter: 'statuscode:200',
    collapse: 'digest', // drop back-to-back identical captures of the same URL
    limit: String(pageSize),
    showResumeKey: 'true',
  });
  // With a target year, only look 5 years either side: big sites answer much
  // faster, and a capture from further away is not "the site in that year".
  if (year) { q.set('from', String(year - 5)); q.set('to', String(year + 5)); }
  if (resumeKey) q.set('resumeKey', resumeKey);
  return `${CDX}?${q}`;
}

/**
 * Parse one page of CDX JSON output. Returns {rows, resumeKey}.
 * With showResumeKey the tail looks like: ..., [], ["<resumeKey>"]
 */
export function parseCdx(json) {
  const data = typeof json === 'string' ? JSON.parse(json || '[]') : json;
  if (!Array.isArray(data) || data.length === 0) return { rows: [], resumeKey: null };
  const [header, ...rest] = data;
  let resumeKey = null;
  const body = [];
  for (let i = 0; i < rest.length; i++) {
    const r = rest[i];
    if (r.length === 0) { resumeKey = rest[i + 1]?.[0] ?? null; break; }
    body.push(r);
  }
  const rows = body.map((r) => {
    const o = Object.fromEntries(header.map((h, j) => [h, r[j]]));
    return {
      ts: o.timestamp,
      original: o.original,
      mime: o.mimetype,
      status: o.statuscode,
      digest: o.digest,
      length: /^\d+$/.test(o.length ?? '') ? Number(o.length) : null,
    };
  });
  return { rows, resumeKey };
}

/** Fetch the full capture list for a scope, following resume keys. */
export async function fetchCdx(scope, fetcher, { maxRows = 50000, year, log = () => {} } = {}) {
  const all = [];
  let resumeKey = null;
  do {
    const res = await fetcher.get(cdxQueryUrl(scope, { resumeKey, year }));
    if (res.status !== 200) throw new Error(`CDX query failed: HTTP ${res.status}`);
    const page = parseCdx(res.body.toString('utf8'));
    all.push(...page.rows);
    resumeKey = page.resumeKey;
    log(`  index: ${all.length} captures${resumeKey ? ' (more…)' : ''}`);
  } while (resumeKey && all.length < maxRows);
  return { rows: all, truncated: Boolean(resumeKey) };
}

/** Group captures by canonical URL key. */
export function buildIndex(rows) {
  const index = new Map();
  for (const r of rows) {
    let key;
    try { key = urlKey(r.original); } catch { continue; }
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }
  return index;
}

/** 14-digit Wayback timestamp -> epoch ms. Short timestamps are padded. */
export function tsToMs(ts) {
  const s = String(ts).padEnd(14, '0');
  return Date.UTC(+s.slice(0, 4), Math.max(0, +s.slice(4, 6) - 1), Math.max(1, +s.slice(6, 8)),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
}

export function tsToDate(ts) {
  return new Date(tsToMs(ts)).toISOString().slice(0, 10);
}

/**
 * The moment we want to rebuild. With --year, mid-year. Without, the site's
 * "peak": the year in which the most *distinct* URLs were captured. Counting
 * distinct URLs (not raw captures) matters: dead domains are often re-crawled
 * thousands of times as a single parked page, which would win a raw count.
 */
export function targetTimestamp(rows, year) {
  if (year) return `${year}0701000000`;
  const perYear = new Map();
  for (const r of rows) {
    const y = r.ts.slice(0, 4);
    if (!perYear.has(y)) perYear.set(y, new Set());
    perYear.get(y).add(r.original.toLowerCase());
  }
  let best = null;
  for (const [y, set] of perYear) {
    if (!best || set.size > best.n || (set.size === best.n && y < best.y)) best = { y, n: set.size };
  }
  if (!best) return null;
  // centre on the median capture of that year rather than an arbitrary date
  const inYear = rows.filter((r) => r.ts.startsWith(best.y)).map((r) => r.ts).sort();
  return inYear[Math.floor(inYear.length / 2)].padEnd(14, '0');
}

/**
 * Order captures of one URL from best to worst for a target moment:
 * closest in time first; on a tie the earlier one (sites decay, they rarely improve).
 * Empty or non-200 captures are dropped.
 */
export function rankCaptures(captures, target) {
  const t = tsToMs(target);
  return (captures || [])
    .filter((c) => c.status === '200' && c.length !== 0)
    .sort((a, b) => Math.abs(tsToMs(a.ts) - t) - Math.abs(tsToMs(b.ts) - t) || a.ts.localeCompare(b.ts));
}

export function waybackRawUrl(ts, original) {
  return `https://web.archive.org/web/${ts}id_/${original}`;
}

export function waybackViewUrl(ts, original) {
  return `https://web.archive.org/web/${ts}/${original}`;
}
