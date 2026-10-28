#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resurrect } from '../src/build.js';
import { createFetcher } from '../src/fetcher.js';
import { makeScope, withScheme } from '../src/urls.js';

const HELP = `resurrect - give it a dead website, get the website back.

Usage:
  resurrect <url> [--year 2009] [options]

Options:
  --year <yyyy>        rebuild the site as it looked in this year
                       (default: the year the archive saw the most of it)
  --out <dir>          output folder (default: ./resurrected/<host>)
  --max-pages <n>      stop after n pages (default 300)
  --max-assets <n>     stop after n images/styles/files (default 3000)
  --delay <ms>         gap between requests to archive.org (default 1000)
  --cache <dir>        download cache (default ~/.cache/resurrect)
  --no-external        don't fetch images/CSS hosted on other domains
  --allow-indexing     omit the noindex meta tag and robots.txt (only for
                       sites you own)
  -h, --help

For your own sites and personal archival use. Every page gets a footer
crediting the Internet Archive and the capture date.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      year: { type: 'string' },
      out: { type: 'string', short: 'o' },
      'max-pages': { type: 'string' },
      'max-assets': { type: 'string' },
      delay: { type: 'string' },
      cache: { type: 'string' },
      'no-external': { type: 'boolean' },
      'allow-indexing': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}
const { values: v, positionals } = args;
if (v.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(v.help ? 0 : 2);
}
if (v.year && !/^(199\d|20\d\d)$/.test(v.year)) {
  console.error('--year must be a four-digit year between 1990 and 2099');
  process.exit(2);
}

const url = withScheme(positionals[0]);
const scope = makeScope(url);
const out = v.out || join('resurrected', `${scope.host}${scope.prefix}`.replace(/[^a-z0-9._-]+/gi, '_'));
const fetcher = createFetcher({
  cacheDir: v.cache || join(homedir(), '.cache', 'resurrect'),
  delayMs: v.delay ? Number(v.delay) : 1000,
  log: (m) => console.error(m),
});

const t0 = Date.now();
try {
  const r = await resurrect({
    url,
    year: v.year ? Number(v.year) : undefined,
    out,
    fetcher,
    log: (m) => console.error(m),
    maxPages: v['max-pages'] ? Number(v['max-pages']) : undefined,
    maxAssets: v['max-assets'] ? Number(v['max-assets']) : undefined,
    external: !v['no-external'],
    noindex: !v['allow-indexing'],
  });
  const s = fetcher.stats;
  console.log(`
Resurrected ${r.scope} as of ${r.target}
  pages:  ${r.pages.recovered.length} recovered, ${r.pages.lost.length} lost
  assets: ${r.assets.recovered.length} recovered, ${r.assets.lost.length} lost
  ${s.network} requests to archive.org, ${s.cached} from cache, ${((Date.now() - t0) / 1000).toFixed(0)}s
  -> ${join(out, 'index.html')}
  -> ${join(out, '_resurrect', 'REPORT.md')}`);
} catch (err) {
  console.error(`resurrect: ${err.message}`);
  process.exit(1);
}
