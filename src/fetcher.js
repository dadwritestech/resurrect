// Polite HTTP client for the Wayback Machine: one request at a time, a fixed
// gap between requests, backoff on 429/5xx, a descriptive User-Agent, and a
// disk cache so a second run (or a crash halfway) never re-downloads anything.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const USER_AGENT =
  'resurrect/0.1 (+https://github.com/dadwritestech/resurrect; personal archival rebuild)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARCHIVE_HOST = /^https?:\/\/(web\.)?archive\.org\//i;

export function createFetcher({
  cacheDir,
  delayMs = 1000,
  userAgent = USER_AGENT,
  fetchImpl = globalThis.fetch,
  maxRetries = 4,
  timeoutMs = 180_000, // CDX queries over big sites are slow
  log = () => {},
} = {}) {
  let last = 0;
  const stats = { network: 0, cached: 0, retries: 0 };

  const cachePaths = (url) => {
    const h = createHash('sha1').update(url).digest('hex');
    const dir = join(cacheDir, h.slice(0, 2));
    return { dir, body: join(dir, `${h}.bin`), meta: join(dir, `${h}.json`) };
  };

  async function fromCache(url) {
    if (!cacheDir) return null;
    const p = cachePaths(url);
    try {
      const meta = JSON.parse(await readFile(p.meta, 'utf8'));
      const body = meta.status === 200 ? await readFile(p.body) : Buffer.alloc(0);
      return { ...meta, body };
    } catch { return null; }
  }

  async function toCache(url, res) {
    if (!cacheDir) return;
    const p = cachePaths(url);
    await mkdir(p.dir, { recursive: true });
    if (res.status === 200) await writeFile(p.body, res.body);
    const { body, ...meta } = res;
    await writeFile(p.meta, JSON.stringify({ url, ...meta }));
  }

  async function once(url) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    stats.network++;
    return fetchImpl(url, {
      headers: { 'user-agent': userAgent, accept: '*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /**
   * GET a URL. Redirects are followed only while they stay on archive.org,
   * so a stray Location header can never send us to the live (dead, or
   * re-registered) site. Returns {status, contentType, finalUrl, body}.
   * 404s and other final errors are cached too: missing stays missing.
   */
  async function get(url) {
    const hit = await fromCache(url);
    if (hit) { stats.cached++; return hit; }

    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await once(current);
        } catch (err) {
          if (attempt >= maxRetries) return { status: 0, error: String(err), contentType: '', finalUrl: current, body: Buffer.alloc(0) };
          stats.retries++;
          await sleep(backoff(attempt));
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          stats.retries++;
          const ra = Number(res.headers.get('retry-after'));
          const ms = ra > 0 ? ra * 1000 : backoff(attempt) * (res.status === 429 ? 4 : 1);
          log(`  ${res.status} from archive, waiting ${Math.round(ms / 1000)}s`);
          await res.arrayBuffer().catch(() => {});
          await sleep(ms);
          continue;
        }
        break;
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current).href;
        await res.arrayBuffer().catch(() => {});
        if (!ARCHIVE_HOST.test(next)) {
          const out = { status: res.status, contentType: '', finalUrl: next, body: Buffer.alloc(0), offsite: true };
          await toCache(url, out);
          return out;
        }
        current = next;
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      const out = {
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        finalUrl: current,
        body: res.status === 200 ? body : Buffer.alloc(0),
      };
      if (res.status !== 429 && res.status < 500) await toCache(url, out);
      return out;
    }
    return { status: 310, contentType: '', finalUrl: current, body: Buffer.alloc(0) };
  }

  return { get, stats };
}

function backoff(attempt) {
  return [5_000, 15_000, 45_000, 90_000, 120_000][Math.min(attempt, 4)];
}
