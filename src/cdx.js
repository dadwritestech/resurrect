// CDX index: which captures exist (in which archive), and which one to use for each page.

import { ARCHIVES, rawUrl, viewUrl } from './archives.js';
import { urlKey } from './urls.js';

const FIELDS = 'urlkey,timestamp,original,mimetype,statuscode,digest,length';

export function cdxQueryUrl(scope, { pageSize = 5000, resumeKey, year, archive = ARCHIVES.wayback } = {}) {
  const wb = archive.flavour === 'wayback';
  const q = new URLSearchParams({
    url: scope.cdxUrl,
    matchType: 'prefix',
    output: 'json',
    ...(wb ? { fl: FIELDS } : {}),
    filter: wb ? 'statuscode:200' : 'status:200',
    collapse: 'digest', // drop back-to-back identical captures of the same URL
    limit: String(pageSize),
    ...(wb ? { showResumeKey: 'true' } : {}),
  });
  // With a target year, only look 5 years either side: big sites answer much
  // faster, and a capture from further away is not "the site in that year".
  if (year) { q.set('from', String(year - 5)); q.set('to', String(year + 5)); }
  if (resumeKey) q.set('resumeKey', resumeKey);
  return `${archive.cdx}?${q}`;
}

/**
 * Parse one page of CDX JSON output. Returns {rows, resumeKey}.
 * With showResumeKey the tail looks like: ..., [], ["<resumeKey>"]
 */
export function parseCdx(json) {
  if (typeof json === 'string' && /^\s*\{/.test(json)) return parseCdxNdjson(json);
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

/**
 * pywb answers output=json with one JSON object per line and its own field
 * names (url/mime/status). Archives built from old ARC files often record
 * length 0 for real captures, so 0 means "unknown" here.
 */
export function parseCdxNdjson(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.timestamp || !(o.url || o.original)) continue;
    const len = /^\d+$/.test(o.length ?? '') ? Number(o.length) : null;
    rows.push({
      ts: o.timestamp,
      original: o.url || o.original,
      mime: o.mime || o.mimetype,
      status: String(o.status ?? o.statuscode ?? ''),
      digest: o.digest,
      length: len || null,
    });
  }
  return { rows, resumeKey: null };
}

/** Fetch the full capture list for a scope from one archive, following resume keys. */
export async function fetchCdx(scope, fetcher, { maxRows = 50000, year, log = () => {}, archive = ARCHIVES.wayback } = {}) {
  const all = [];
  let resumeKey = null;
  // pywb has no resume keys: ask for everything up to the cap in one go
  const pageSize = archive.flavour === 'wayback' ? 5000 : maxRows;
  do {
    const res = await fetcher.get(cdxQueryUrl(scope, { resumeKey, year, archive, pageSize }));
    if (res.status !== 200) throw new Error(`${archive.label} index query failed: HTTP ${res.status || res.error}`);
    const page = parseCdx(res.body.toString('utf8'));
    for (const r of page.rows) r.archive = archive.name;
    all.push(...page.rows);
    resumeKey = page.resumeKey;
    log(`  ${archive.name} index: ${all.length} captures${resumeKey ? ' (more…)' : ''}`);
  } while (resumeKey && all.length < maxRows);
  return { rows: all, truncated: Boolean(resumeKey) || (archive.flavour !== 'wayback' && all.length >= maxRows) };
}

/**
 * Ask every archive. One being down, blocked or empty is not fatal: that is
 * the point of having more than one. Returns rows tagged with their archive.
 */
export async function fetchAllCdx(scope, fetcher, archives, { year, log = () => {}, maxRows } = {}) {
  const rows = [];
  const sources = [];
  let truncated = false;
  for (const archive of archives) {
    try {
      const r = await fetchCdx(scope, fetcher, { year, log, archive, maxRows });
      rows.push(...r.rows);
      truncated ||= r.truncated;
      sources.push({ archive: archive.name, captures: r.rows.length });
    } catch (err) {
      log(`  ${archive.name}: unavailable (${err.message}); carrying on without it`);
      sources.push({ archive: archive.name, captures: 0, error: err.message });
    }
  }
  return { rows, truncated, sources };
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

export const waybackRawUrl = (ts, original) => rawUrl(ARCHIVES.wayback, ts, original);
export const waybackViewUrl = (ts, original) => viewUrl(ARCHIVES.wayback, ts, original);
