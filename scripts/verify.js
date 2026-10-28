#!/usr/bin/env node
// Check a resurrected folder: every local link must point at a file that exists,
// and count links that still point at the dead site.
// Usage: node scripts/verify.js <out-dir> <dead-host>
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep, resolve as resolvePath } from 'node:path';
import { extractLinks } from '../src/rewrite.js';

const [dir, host] = process.argv.slice(2);
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

let pages = 0; let local = 0; let broken = 0; let lostLinks = 0; let wayback = 0; let deadHost = 0;
const brokenList = [];
for (const file of walk(dir).filter((f) => /\.html?$/i.test(f) && !f.includes('_resurrect'))) {
  pages++;
  const html = readFileSync(file, 'latin1');
  for (const l of extractLinks(html, `http://resurrect.local/${relative(dir, file).split(sep).join('/')}`)) {
    const raw = l.raw.split('#')[0];
    if (/^https?:/i.test(raw)) {
      if (/web\.archive\.org/.test(raw)) wayback++;
      else if (host && new URL(raw).hostname.replace(/^www\./, '') === host) deadHost++;
      continue;
    }
    if (raw.endsWith('_resurrect/lost.html')) { lostLinks++; continue; }
    local++;
    const target = resolvePath(dirname(file), decodeURI(raw));
    if (!existsSync(target)) { broken++; brokenList.push(`${relative(dir, file)} -> ${raw}`); }
  }
}
console.log(JSON.stringify({ pages, localLinks: local, brokenLocal: broken, toLostPlaceholder: lostLinks, toWayback: wayback, stillPointingAtDeadHost: deadHost }, null, 2));
if (brokenList.length) console.log(brokenList.slice(0, 20).join('\n'));
process.exit(broken ? 1 : 0);
