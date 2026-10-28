// The pipeline: index -> crawl (fetch + discover links) -> rewrite -> write -> report.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildIndex, fetchCdx, rankCaptures, targetTimestamp, tsToDate, tsToMs, waybackRawUrl, waybackViewUrl,
} from './cdx.js';
import {
  asciiHtml, extractCssLinks, extractLinks, injectBeforeBodyEnd, injectInHead, isFrameset,
  transformCss, transformHtml,
} from './rewrite.js';
import {
  inScope, localPath, looksLikeAsset, makeScope, relativeHref, unwrapWayback, urlKey, withScheme,
} from './urls.js';
import { lostPage, renderReport } from './report.js';

const MAX_TRIES = 4; // best capture + up to 3 neighbours

function sniffHtml(buf) {
  const head = buf.subarray(0, 1024).toString('latin1').toLowerCase();
  return /<(!doctype html|html|head|body|frameset|title|table|p|center|font)\b/.test(head);
}

function classify(res, url) {
  const ct = (res.contentType || '').toLowerCase();
  const isCss = ct.includes('text/css') || (/\.css$/i.test(url.pathname) && !ct.includes('html'));
  const isHtml = !isCss && (ct.includes('html') || ((!ct || /text\/plain|octet-stream/.test(ct)) && sniffHtml(res.body)));
  return { isHtml, isCss };
}

const days = (a, b) => Math.round(Math.abs(tsToMs(a) - tsToMs(b)) / 86_400_000);

/**
 * Resurrect a site. Returns the report object.
 * @param {object} o
 * @param {string} o.url        dead site URL
 * @param {number} [o.year]     rebuild the site as it was in this year
 * @param {string} o.out        output folder
 * @param {object} o.fetcher    from createFetcher()
 */
export async function resurrect({
  url, year, out, fetcher, log = () => {}, maxPages = 300, maxAssets = 3000,
  external = true, noindex = true,
}) {
  const scope = makeScope(withScheme(url));
  log(`resurrect: ${scope.host}${scope.prefix}/`);
  const { rows, truncated } = await fetchCdx(scope, fetcher, { log, year });
  if (!rows.length) throw new Error(`The Wayback Machine has no successful captures under ${scope.cdxUrl}`);
  const index = buildIndex(rows);
  const target = targetTimestamp(rows, year);
  log(`  target moment: ${tsToDate(target)}${year ? '' : ' (busiest year in the archive)'}; ${index.size} distinct URLs archived`);

  /** key -> resource record */
  const res = new Map();
  const queue = [];
  let pageCount = 0;
  let assetCount = 0;
  let externalNav = 0;

  const enqueue = (u, kind, from) => {
    const key = urlKey(u);
    let r = res.get(key);
    if (!r) {
      const own = inScope(u, scope);
      if (kind === 'nav' && !own) { externalNav++; return; }
      if (!own && !external) return;
      const want = kind === 'nav' && !looksLikeAsset(u) ? 'page' : 'asset';
      r = { key, url: u, want, own, status: 'queued', referrers: new Set() };
      res.set(key, r);
      queue.push(r);
    }
    if (from) r.referrers.add(from);
  };

  async function recover(r) {
    const ranked = rankCaptures(index.get(r.key), target).slice(0, MAX_TRIES);
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      const got = await fetcher.get(waybackRawUrl(c.ts, c.original));
      if (got.status === 200 && got.body.length) {
        const w = unwrapWayback(new URL(got.finalUrl).pathname);
        return { got, ts: w?.ts?.padEnd(14, '0') || c.ts, original: c.original, via: i === 0 ? 'best' : 'neighbour' };
      }
    }
    // Not in our index (other host, or a URL variant the crawler saw): let
    // the Wayback Machine redirect us to its nearest capture of it.
    const got = await fetcher.get(waybackRawUrl(target, r.url.href));
    if (got.status === 200 && got.body.length) {
      const w = unwrapWayback(new URL(got.finalUrl).pathname);
      return { got, ts: w?.ts?.padEnd(14, '0') || target, original: w?.url || r.url.href, via: 'nearest' };
    }
    return null;
  }

  enqueue(new URL(scope.start), 'nav', null);

  while (queue.length) {
    const r = queue.shift();
    if (r.want === 'page' && pageCount >= maxPages) { r.status = 'skipped'; continue; }
    if (r.want === 'asset' && assetCount >= maxAssets) { r.status = 'skipped'; continue; }
    const found = await recover(r);
    if (!found) {
      r.status = 'lost';
      log(`  lost   ${r.url.href}`);
      continue;
    }
    const { got, ts, original, via } = found;
    const { isHtml, isCss } = classify(got, r.url);
    Object.assign(r, {
      status: 'ok', ts, original, via, body: got.body, contentType: got.contentType,
      isHtml: isHtml && r.want === 'page', isCss,
    });
    if (r.isHtml) pageCount++; else assetCount++;
    const mark = via === 'best' ? '' : ` [${via}, ${days(ts, target)}d from target]`;
    log(`  ${r.isHtml ? 'page ' : 'asset'}  ${tsToDate(ts)}  ${r.url.href}${mark}`);

    if (r.isHtml) {
      for (const l of extractLinks(got.body.toString('latin1'), original)) enqueue(l.url, l.kind, r.key);
    } else if (isCss) {
      for (const l of extractCssLinks(got.body.toString('latin1'), original)) enqueue(l.url, 'asset', r.key);
    }
  }

  // ---- assign output paths (stable, collision-free)
  const used = new Set(['_resurrect/lost.html']);
  for (const r of res.values()) {
    if (r.status !== 'ok') continue;
    let p = localPath(r.url, scope, r.isHtml);
    if (used.has(p)) {
      const dot = p.lastIndexOf('.');
      const tag = `__${r.key.length.toString(36)}${used.size}`;
      p = dot > p.lastIndexOf('/') ? p.slice(0, dot) + tag + p.slice(dot) : p + tag;
    }
    used.add(p);
    r.local = p;
  }

  // ---- rewrite + write
  const write = async (rel, data) => {
    const full = join(out, ...rel.split('/'));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  };

  for (const r of res.values()) {
    if (r.status !== 'ok') continue;
    if (r.isHtml) {
      let html = transformHtml(r.body.toString('latin1'), r.original, (l) => linkFor(r, l));
      html = decorate(html, r, noindex);
      await write(r.local, Buffer.from(html, 'latin1'));
    } else if (r.isCss) {
      const css = transformCss(r.body.toString('latin1'), r.original, (l) => linkFor(r, l));
      await write(r.local, Buffer.from(css, 'latin1'));
    } else {
      await write(r.local, r.body);
    }
  }

  function linkFor(from, l) {
    const t = res.get(urlKey(l.url));
    if (t?.status === 'ok') return relativeHref(from.local, t.local);
    if (l.kind === 'nav' && !looksLikeAsset(l.url) || t?.want === 'page') {
      if (t?.status === 'lost') return `${relativeHref(from.local, '_resurrect/lost.html')}#${l.url.href}`;
      // out of scope, or beyond --max-pages: send the reader to the archive's copy
      return waybackViewUrl(from.ts, l.url.href);
    }
    if (t?.status === 'skipped' || t?.status === 'lost') return waybackViewUrl(`${from.ts}im_`, l.url.href);
    return undefined;
  }

  const start = res.get(urlKey(new URL(scope.start)));
  if (start?.status === 'ok' && start.local !== 'index.html' && !used.has('index.html')) {
    await write('index.html', `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${start.local}"><a href="${start.local}">${start.local}</a>\n`);
  }
  if (noindex) await write('robots.txt', 'User-agent: *\nDisallow: /\n');
  await write('_resurrect/lost.html', lostPage());

  const report = summarize({ url, scope, target, year, res, externalNav, truncated, rows: rows.length, indexSize: index.size });
  await write('_resurrect/report.json', `${JSON.stringify(report, null, 2)}\n`);
  await write('_resurrect/REPORT.md', renderReport(report));
  return report;
}

function decorate(html, r, noindex) {
  const when = tsToDate(r.ts);
  const view = waybackViewUrl(r.ts, r.original);
  const footer =
    `\n<div data-resurrect-footer style="all:initial;display:block;clear:both;margin:24px 0 0;padding:8px 12px;` +
    `border-top:1px dashed #999;background:#fafafa;color:#555;font:12px/1.5 Verdana,Arial,sans-serif;text-align:center">` +
    `Resurrected from the <a style="color:#36c" href="${asciiHtml(view)}">Internet Archive's Wayback Machine</a>` +
    ` &middot; captured ${when} &middot; originally at ${asciiHtml(r.original.replace(/:80\//, '/'))}` +
    ` &middot; rebuilt by <a style="color:#36c" href="https://github.com/dadwritestech/resurrect">resurrect</a>` +
    `</div>\n`;
  let out = isFrameset(html) ? html : injectBeforeBodyEnd(html, footer);
  const meta = `\n<!-- resurrected from ${asciiHtml(view)} by resurrect; archive date ${when} -->\n` +
    (noindex ? '<meta name="robots" content="noindex,nofollow">\n' : '');
  out = injectInHead(out, meta);
  return out;
}

function summarize({ url, scope, target, year, res, externalNav, truncated, rows, indexSize }) {
  const all = [...res.values()];
  const ok = all.filter((r) => r.status === 'ok');
  const item = (r) => ({
    url: r.url.href,
    file: r.local,
    captured: r.ts && tsToDate(r.ts),
    via: r.via,
    driftDays: r.ts ? days(r.ts, target) : null,
  });
  const lost = (r) => ({ url: r.url.href, kind: r.want, linkedFrom: [...r.referrers].slice(0, 5) });
  const tss = ok.map((r) => r.ts).sort();
  return {
    source: url,
    scope: `${scope.host}${scope.prefix}/`,
    target: tsToDate(target),
    targetFrom: year ? '--year' : 'busiest archived year',
    generatedAt: new Date().toISOString(),
    index: { captures: rows, distinctUrls: indexSize, truncated },
    capturesSpan: tss.length ? [tsToDate(tss[0]), tsToDate(tss.at(-1))] : null,
    pages: {
      recovered: ok.filter((r) => r.isHtml).map(item),
      lost: all.filter((r) => r.status === 'lost' && r.want === 'page').map(lost),
      skipped: all.filter((r) => r.status === 'skipped' && r.want === 'page').map((r) => r.url.href),
    },
    assets: {
      recovered: ok.filter((r) => !r.isHtml).map(item),
      lost: all.filter((r) => r.status === 'lost' && r.want === 'asset').map(lost),
      skipped: all.filter((r) => r.status === 'skipped' && r.want === 'asset').map((r) => r.url.href),
    },
    externalLinks: externalNav,
  };
}
