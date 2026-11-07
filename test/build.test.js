// End to end, offline: a fake archive.org serves recorded/fixture responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resurrect } from '../src/build.js';
import { createFetcher } from '../src/fetcher.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));

const cdx = [
  ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
  // home: the closest capture (2003-06) is broken in the archive -> neighbour 2003-02 is used
  ['com,oldsite)/', '20030601000000', 'http://www.oldsite.com:80/', 'text/html', '200', 'A', '900'],
  ['com,oldsite)/', '20030201000000', 'http://oldsite.com:80/', 'text/html', '200', 'B', '900'],
  ['com,oldsite)/', '20090101000000', 'http://oldsite.com:80/', 'text/html', '200', 'P', '300'],
  ['com,oldsite)/about/index.html', '20030702000000', 'http://www.oldsite.com:80/about/index.html', 'text/html', '200', 'C', '500'],
  ['com,oldsite)/style.css', '20030702000000', 'http://www.oldsite.com:80/style.css', 'text/css', '200', 'D', '100'],
  ['com,oldsite)/img/bg.gif', '20030702000000', 'http://www.oldsite.com:80/img/bg.gif', 'image/gif', '200', 'E', '100'],
  ['com,oldsite)/img/me.jpg', '20030703000000', 'http://www.oldsite.com:80/img/me.jpg', 'image/jpeg', '200', 'F', '100'],
];

const home = `<HTML><HEAD><TITLE>My Homepage!!</TITLE><LINK REL=stylesheet HREF="/style.css"></HEAD>
<BODY BACKGROUND="img/bg.gif"><CENTER><IMG SRC="http://www.oldsite.com/img/me.jpg">
<A HREF="about/">About me</A> | <A HREF="http://oldsite.com/guestbook.html#sign">Guestbook</A>
| <A HREF="http://www.geocities.com/~friend/">My friend</A> <IMG SRC="http://counter.example.net/c.gif?id=7">
</CENTER></BODY></HTML>`;
const about = `<html><body><a href="../index.html">home</a> <a href="/">home again</a> <img src="../img/me.jpg"></body></html>`;

const routes = new Map([
  ['https://web.archive.org/cdx/search/cdx', { body: JSON.stringify(cdx), type: 'application/json' }],
  ['https://web.archive.org/web/20030601000000id_/http://www.oldsite.com:80/', { status: 404 }],
  ['https://web.archive.org/web/20030201000000id_/http://oldsite.com:80/', { body: home, type: 'text/html' }],
  ['https://web.archive.org/web/20030702000000id_/http://www.oldsite.com:80/about/index.html', { body: about, type: 'text/html; charset=iso-8859-1' }],
  ['https://web.archive.org/web/20030702000000id_/http://www.oldsite.com:80/style.css', { body: 'body{background:url(img/bg.gif)}', type: 'text/css' }],
  ['https://web.archive.org/web/20030702000000id_/http://www.oldsite.com:80/img/bg.gif', { body: fixture('pixel.gif'), type: 'image/gif' }],
  ['https://web.archive.org/web/20030703000000id_/http://www.oldsite.com:80/img/me.jpg', { body: fixture('pixel.gif'), type: 'image/jpeg' }],
  // external counter image: the archive redirects to its nearest capture
  ['https://web.archive.org/web/20030701000000id_/http://counter.example.net/c.gif?id=7', { status: 302, location: '/web/20030415000000id_/http://counter.example.net/c.gif?id=7' }],
  ['https://web.archive.org/web/20030415000000id_/http://counter.example.net/c.gif?id=7', { body: fixture('pixel.gif'), type: 'image/gif' }],
]);

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    const key = url.startsWith('https://web.archive.org/cdx/') ? 'https://web.archive.org/cdx/search/cdx' : url;
    const r = routes.get(key) || { status: 404 };
    const headers = new Headers();
    if (r.type) headers.set('content-type', r.type);
    if (r.location) headers.set('location', r.location);
    return new Response(r.status && r.status !== 200 ? null : r.body, { status: r.status || 200, headers });
  };
}

test('resurrects a small site end to end: neighbour fill, lost pages, external assets, credit footer', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const calls = [];
  try {
    const fetcher = createFetcher({ delayMs: 0, fetchImpl: fakeFetch(calls) });
    const report = await resurrect({ url: 'oldsite.com', year: 2003, out, fetcher });

    // home page came from the neighbouring snapshot
    const homeItem = report.pages.recovered.find((p) => p.file === 'index.html');
    assert.equal(homeItem.via, 'neighbour');
    assert.equal(homeItem.captured, '2003-02-01');
    assert.deepEqual(report.pages.recovered.map((p) => p.file).sort(), ['about/index.html', 'index.html']);
    assert.deepEqual(report.pages.lost.map((p) => p.url), ['http://oldsite.com/guestbook.html']);
    assert.equal(report.externalLinks, 1);
    assert.equal(report.assets.lost.length, 0);
    assert.equal(report.assets.recovered.find((a) => a.file.startsWith('_ext/')).via, 'nearest');

    const h = await readFile(join(out, 'index.html'), 'latin1');
    assert.match(h, /HREF="style\.css"/);
    assert.match(h, /BACKGROUND="img\/bg\.gif"/);
    assert.match(h, /SRC="img\/me\.jpg"/);
    assert.match(h, /HREF="about\/index\.html"/);
    assert.match(h, /HREF="_resurrect\/lost\.html#http:\/\/oldsite\.com\/guestbook\.html#sign"/);
    assert.match(h, /HREF="https:\/\/web\.archive\.org\/web\/20030201000000\/http:\/\/www\.geocities\.com\/~friend\/"/);
    assert.match(h, /SRC="_ext\/counter\.example\.net\/c__[0-9a-f]{8}\.gif"/);
    assert.match(h, /Internet Archive's Wayback Machine<\/a> &middot; captured 2003-02-01/);
    assert.match(h, /<meta name="robots" content="noindex,nofollow">/);
    assert.ok(h.indexOf('data-resurrect-footer') < h.indexOf('</BODY>'));

    const a = await readFile(join(out, 'about', 'index.html'), 'latin1');
    assert.match(a, /<a href="\.\.\/index\.html">home<\/a> <a href="\.\.\/index\.html">home again/);
    assert.match(a, /src="\.\.\/img\/me\.jpg"/);

    assert.equal(await readFile(join(out, 'style.css'), 'latin1'), 'body{background:url(img/bg.gif)}');
    assert.ok(existsSync(join(out, '_resurrect', 'lost.html')));
    assert.ok(existsSync(join(out, '_resurrect', 'REPORT.md')));
    assert.equal(await readFile(join(out, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');

    // politeness: the dead live site is never contacted, only archive.org
    assert.ok(calls.every((u) => u.startsWith('https://web.archive.org/') || u.startsWith('https://arquivo.pt/')));
    assert.ok(!calls.some((u) => /^https?:\/\/(www\.)?oldsite\.com/.test(u)));
    // each URL fetched once (in-run de-duplication)
    assert.equal(new Set(calls).size, calls.length);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('the disk cache makes a second run hit the network zero times', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const cacheDir = join(out, '.cache');
  try {
    const calls1 = [];
    await resurrect({ url: 'oldsite.com', year: 2003, out: join(out, 'a'), fetcher: createFetcher({ cacheDir, delayMs: 0, fetchImpl: fakeFetch(calls1) }) });
    const calls2 = [];
    const f2 = createFetcher({ cacheDir, delayMs: 0, fetchImpl: fakeFetch(calls2) });
    await resurrect({ url: 'oldsite.com', year: 2003, out: join(out, 'b'), fetcher: f2 });
    assert.ok(calls1.length > 5);
    assert.equal(calls2.length, 0);
    assert.equal(f2.stats.network, 0); // redirects are cached under the URL that was asked for
    assert.equal(await readFile(join(out, 'a', 'index.html'), 'latin1'), await readFile(join(out, 'b', 'index.html'), 'latin1'));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('fetcher refuses redirects that leave archive.org (never touches the live domain)', async () => {
  const calls = [];
  const f = createFetcher({
    delayMs: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://parked-domain-spam.example/' } });
    },
  });
  const r = await f.get('https://web.archive.org/web/2003id_/http://oldsite.com/');
  assert.equal(r.offsite, true);
  assert.equal(r.body.length, 0);
  assert.deepEqual(calls, ['https://web.archive.org/web/2003id_/http://oldsite.com/']);
});

test('fetcher backs off on 429 and retries', async () => {
  let n = 0;
  const f = createFetcher({
    delayMs: 0,
    fetchImpl: async () => (++n === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } })
      : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })),
  });
  const r = await f.get('https://web.archive.org/x');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'ok');
  assert.equal(f.stats.retries, 1);
});

test('when the start URL was never captured, the crawl enters via the shallowest archived page', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const rows = [
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['gov,old)/kids/html/home.html', '20010101000000', 'http://old.gov:80/kids/html/home.html', 'text/html', '200', 'A', '50'],
    ['gov,old)/kids/html/deep/pets.html', '20010101000000', 'http://old.gov:80/kids/html/deep/pets.html', 'text/html', '200', 'B', '50'],
  ];
  const pages = {
    'http://old.gov:80/kids/html/home.html': '<a href="deep/pets.html">pets</a> <a href="/media/big.jpg">photo</a> <a href="/media/gone.jpg">gone</a>',
    'http://old.gov/media/big.jpg': 'JPEGDATA',
    'http://old.gov:80/kids/html/deep/pets.html': '<a href="../home.html">home</a>',
  };
  const fetchImpl = async (u) => {
    if (u.includes('/cdx/')) return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
    const orig = u.replace(/^https:\/\/web\.archive\.org\/web\/\d+id_\//, '');
    const type = orig.endsWith('.jpg') ? 'image/jpeg' : 'text/html';
    return pages[orig] ? new Response(pages[orig], { headers: { 'content-type': type } }) : new Response(null, { status: 404 });
  };
  try {
    const report = await resurrect({ url: 'http://old.gov/kids/', year: 2001, out, fetcher: createFetcher({ delayMs: 0, fetchImpl }) });
    assert.equal(report.pages.recovered.length, 2);
    assert.match(await readFile(join(out, 'index.html'), 'utf8'), /url=html\/index\.html/); // home.html is canonicalised as a directory index
    // a link out of the /kids/ prefix that opens a photo is fetched as an asset;
    // one that can't be recovered goes to the archive, never stays a dead-site path
    const home = await readFile(join(out, 'html', 'index.html'), 'utf8');
    assert.match(home, /href="\.\.\/_ext\/old\.gov\/media\/big\.jpg">photo/);
    assert.match(home, /href="https:\/\/web\.archive\.org\/web\/20010101000000im_\/http:\/\/old\.gov\/media\/gone\.jpg">gone/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('a "nearest" capture decades away, or HTML served for a .zip, counts as lost', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const rows = [
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['gov,old)/', '20010101000000', 'http://old.gov:80/', 'text/html', '200', 'A', '50'],
    ['gov,old)/manual.zip', '20010101000000', 'http://old.gov:80/manual.zip', 'application/zip', '200', 'B', '50'],
  ];
  const fetchImpl = async (u) => {
    if (u.includes('/cdx/')) return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
    if (u.endsWith('id_/http://old.gov:80/')) return new Response('<a href="manual.zip">zip</a><img src="logo.gif">', { headers: { 'content-type': 'text/html' } });
    // the indexed zip capture is really a soft-404 HTML page
    if (u.endsWith('id_/http://old.gov:80/manual.zip')) return new Response('<!DOCTYPE html><html>moved</html>', { headers: { 'content-type': 'text/html' } });
    // logo.gif is not indexed; the archive's nearest copy is from 2024
    if (u.includes('20010101000000id_/http://old.gov/logo.gif')) return new Response(null, { status: 302, headers: { location: '/web/20240101000000id_/http://old.gov/logo.gif' } });
    if (u.includes('20240101000000id_/http://old.gov/logo.gif')) return new Response(fixture('pixel.gif'), { headers: { 'content-type': 'image/gif' } });
    return new Response(null, { status: 404 });
  };
  try {
    const report = await resurrect({ url: 'old.gov', year: 2001, out, fetcher: createFetcher({ delayMs: 0, fetchImpl }) });
    assert.deepEqual(report.assets.recovered, []);
    assert.deepEqual(report.assets.lost.map((a) => a.url).sort(), ['http://old.gov/logo.gif', 'http://old.gov/manual.zip']);
    assert.ok(!existsSync(join(out, 'manual.zip')));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
