// Surviving the Wayback Machine: other archives, and an outage mid-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHIVES, pickArchives, rawUrl, unwrapReplay, viewUrl } from '../src/archives.js';
import { cdxQueryUrl, parseCdx } from '../src/cdx.js';
import { makeScope } from '../src/urls.js';
import { resurrect } from '../src/build.js';
import { createFetcher } from '../src/fetcher.js';

test('pickArchives: defaults, names, and any pywb collection URL', () => {
  assert.deepEqual(pickArchives().map((a) => a.name), ['wayback', 'arquivo']);
  assert.deepEqual(pickArchives(['Arquivo']).map((a) => a.name), ['arquivo']);
  const [own] = pickArchives(['http://localhost:8080/my-warcs']);
  assert.equal(own.base, 'http://localhost:8080/my-warcs/');
  assert.equal(own.cdx, 'http://localhost:8080/my-warcs/cdx');
  assert.equal(own.flavour, 'pywb');
  assert.throws(() => pickArchives(['archive.today']), /unknown archive/);
  assert.throws(() => pickArchives([]), /no archives/);
  assert.equal(pickArchives(['wayback', 'wayback']).length, 1);
});

test('replay URLs round-trip, including the nearest-capture redirect target', () => {
  const a = ARCHIVES.arquivo;
  assert.equal(rawUrl(a, '20050701000000', 'http://www.publico.pt/'), 'https://arquivo.pt/wayback/20050701000000id_/http://www.publico.pt/');
  assert.equal(viewUrl(ARCHIVES.wayback, '1999', 'http://x.gov/'), 'https://web.archive.org/web/1999/http://x.gov/');
  assert.deepEqual(unwrapReplay(a, 'https://arquivo.pt/wayback/20050701025246id_/http://www.publico.pt:80/'),
    { ts: '20050701025246', url: 'http://www.publico.pt:80/' });
  assert.equal(unwrapReplay(a, 'https://web.archive.org/web/2005id_/http://x/'), null);
});

test('pywb CDX: query shape and newline-delimited JSON with its own field names', () => {
  const u = new URL(cdxQueryUrl(makeScope('publico.pt'), { archive: ARCHIVES.arquivo, year: 2005, pageSize: 100 }));
  assert.equal(u.origin + u.pathname, 'https://arquivo.pt/wayback/cdx');
  assert.equal(u.searchParams.get('filter'), 'status:200');
  assert.equal(u.searchParams.get('fl'), null);
  assert.equal(u.searchParams.get('showResumeKey'), null);
  assert.equal(u.searchParams.get('from'), '2000');

  // recorded from arquivo.pt; old ARC files report length 0 for real captures
  const text = [
    '{"urlkey": "pt,publico)/", "timestamp": "19961013182712", "status": "200", "url": "http://www.publico.pt/", "length": "0", "mime": "text/html", "digest": "HL"}',
    '{"urlkey": "pt,publico)/", "timestamp": "19981212032121", "status": "200", "url": "http://www.publico.pt:80/", "length": "5120", "mime": "text/html", "digest": "X"}',
    'not json',
    '',
  ].join('\n');
  const { rows, resumeKey } = parseCdx(text);
  assert.equal(resumeKey, null);
  assert.deepEqual(rows[0], { ts: '19961013182712', original: 'http://www.publico.pt/', mime: 'text/html', status: '200', digest: 'HL', length: null });
  assert.equal(rows[1].length, 5120);
  assert.equal(rows.length, 2);
});

// ---- end to end against a fake Wayback + a fake Arquivo.pt

const home = '<html><head><link rel=stylesheet href="s.css"></head><body><a href="about.html">About</a><img src="logo.gif"></body></html>';
const about = '<html><body><a href="index.html">home</a> <a href="gone.html">gone</a></body></html>';
const nd = (rows) => rows.map(([ts, url, mime]) => JSON.stringify({ timestamp: ts, url, mime, status: '200', length: '0', digest: ts + url })).join('\n');

const arquivoCdx = nd([
  ['20040301000000', 'http://www.deadsite.pt/', 'text/html'],
  ['20040302000000', 'http://www.deadsite.pt/about.html', 'text/html'],
  ['20040303000000', 'http://www.deadsite.pt/s.css', 'text/css'],
]);
const arquivo = new Map([
  ['https://arquivo.pt/wayback/20040301000000id_/http://www.deadsite.pt/', { body: home, type: 'text/html' }],
  ['https://arquivo.pt/wayback/20040302000000id_/http://www.deadsite.pt/about.html', { body: about, type: 'text/html' }],
  ['https://arquivo.pt/wayback/20040303000000id_/http://www.deadsite.pt/s.css', { body: 'body{color:red}', type: 'text/css' }],
  // not in the index: the archive redirects to its nearest capture, on its own host
  ['https://arquivo.pt/wayback/20040701000000id_/http://www.deadsite.pt/logo.gif', { status: 307, location: 'https://arquivo.pt/wayback/20040220000000id_/http://www.deadsite.pt/logo.gif' }],
  ['https://arquivo.pt/wayback/20040220000000id_/http://www.deadsite.pt/logo.gif', { body: 'GIF89a', type: 'image/gif' }],
]);

function fake({ wayback = () => ({ status: 503 }), calls }) {
  return async (url) => {
    calls.push(url);
    let r;
    if (url.startsWith('https://arquivo.pt/wayback/cdx')) r = { body: arquivoCdx, type: 'text/x-ndjson' };
    else if (url.startsWith('https://arquivo.pt/')) r = arquivo.get(url) || { status: 404 };
    else if (url.startsWith('https://web.archive.org/')) r = wayback(url);
    else throw new Error(`contacted a non-archive host: ${url}`);
    const headers = new Headers();
    if (r.type) headers.set('content-type', r.type);
    if (r.location) headers.set('location', r.location);
    return new Response(r.status && r.status !== 200 ? null : r.body, { status: r.status || 200, headers });
  };
}

test('Wayback Machine down: the site is rebuilt from Arquivo.pt and credited to it', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const calls = [];
  try {
    const fetcher = createFetcher({ delayMs: 0, maxRetries: 0, fetchImpl: fake({ calls }) });
    const logs = [];
    const report = await resurrect({ url: 'deadsite.pt', year: 2004, out, fetcher, log: (m) => logs.push(m) });

    assert.deepEqual(report.pages.recovered.map((p) => p.file).sort(), ['about.html', 'index.html']);
    assert.ok(report.pages.recovered.every((p) => p.archive === 'arquivo'));
    assert.deepEqual(report.pages.lost.map((p) => p.url), ['http://www.deadsite.pt/gone.html']);
    const logo = report.assets.recovered.find((a) => a.file === 'logo.gif');
    assert.equal(logo.via, 'nearest');
    assert.equal(logo.captured, '2004-02-20');
    assert.equal(report.index.sources.find((s) => s.archive === 'wayback').captures, 0);
    assert.match(report.index.sources.find((s) => s.archive === 'wayback').error, /503/);
    assert.deepEqual(report.archives.map((a) => [a.name, a.used]), [['wayback', 0], ['arquivo', 4]]);
    assert.ok(logs.some((l) => /wayback: unavailable/.test(l)));

    const h = await readFile(join(out, 'index.html'), 'latin1');
    assert.match(h, /Resurrected from <a style="color:#36c" href="https:\/\/arquivo\.pt\/wayback\/20040301000000\/http:\/\/www\.deadsite\.pt\/">Arquivo\.pt<\/a>/);
    assert.match(h, /href="about\.html"/);
    assert.match(h, /src="logo\.gif"/);
    const md = await readFile(join(out, '_resurrect', 'REPORT.md'), 'utf8');
    assert.match(md, /Arquivo\.pt/);

    // once its index failed, Wayback is never asked for a page
    assert.deepEqual(calls.filter((u) => u.startsWith('https://web.archive.org/')).map((u) => new URL(u).pathname), ['/cdx/search/cdx']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('Wayback up but erroring on pages: three strikes, then the rest comes from Arquivo.pt', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const calls = [];
  const wbCdx = JSON.stringify([
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['pt,deadsite)/', '20040701000000', 'http://www.deadsite.pt/', 'text/html', '200', 'A', '900'],
    ['pt,deadsite)/about.html', '20040701000000', 'http://www.deadsite.pt/about.html', 'text/html', '200', 'B', '900'],
    ['pt,deadsite)/s.css', '20040701000000', 'http://www.deadsite.pt/s.css', 'text/css', '200', 'C', '90'],
  ]);
  try {
    const wayback = (u) => (u.includes('/cdx/') ? { body: wbCdx, type: 'application/json' } : { status: 502 });
    const fetcher = createFetcher({ delayMs: 0, maxRetries: 0, fetchImpl: fake({ wayback, calls }) });
    const logs = [];
    const report = await resurrect({ url: 'deadsite.pt', year: 2004, out, fetcher, log: (m) => logs.push(m) });

    // Wayback had the closest captures, but they failed: Arquivo's copies filled in
    const home2 = report.pages.recovered.find((p) => p.file === 'index.html');
    assert.equal(home2.archive, 'arquivo');
    assert.equal(home2.via, 'neighbour');
    assert.deepEqual(report.pages.recovered.map((p) => p.file).sort(), ['about.html', 'index.html']);
    assert.ok(logs.some((l) => /wayback keeps failing/.test(l)));
    const wbPageCalls = calls.filter((u) => u.startsWith('https://web.archive.org/web/'));
    assert.equal(wbPageCalls.length, 3);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('--archive with only a self-hosted pywb never contacts the Wayback Machine', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const calls = [];
  try {
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('http://localhost:8080/mine/cdx')) {
        return new Response(nd([['20040301000000', 'http://www.deadsite.pt/', 'text/html']]), { headers: { 'content-type': 'text/x-ndjson' } });
      }
      if (url === 'http://localhost:8080/mine/20040301000000id_/http://www.deadsite.pt/') {
        return new Response('<html><body>hi</body></html>', { headers: { 'content-type': 'text/html' } });
      }
      return new Response(null, { status: 404 });
    };
    const report = await resurrect({
      url: 'deadsite.pt', year: 2004, out, archives: ['http://localhost:8080/mine/'],
      fetcher: createFetcher({ delayMs: 0, maxRetries: 0, fetchImpl }),
    });
    assert.equal(report.pages.recovered.length, 1);
    assert.equal(report.pages.recovered[0].archive, 'localhost:8080');
    assert.ok(calls.every((u) => u.startsWith('http://localhost:8080/mine/')));
    assert.match(await readFile(join(out, 'index.html'), 'latin1'), />localhost:8080<\/a>/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('an archive with zero captures of the site is not asked for each lost page', async () => {
  const out = await mkdtemp(join(tmpdir(), 'resurrect-'));
  const calls = [];
  const wbCdx = JSON.stringify([
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['pt,deadsite)/', '20040701000000', 'http://www.deadsite.pt/', 'text/html', '200', 'A', '900'],
  ]);
  try {
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('https://arquivo.pt/wayback/cdx')) return new Response('', { headers: { 'content-type': 'text/x-ndjson' } });
      if (url.startsWith('https://web.archive.org/cdx/')) return new Response(wbCdx, { headers: { 'content-type': 'application/json' } });
      if (url === 'https://web.archive.org/web/20040701000000id_/http://www.deadsite.pt/') {
        return new Response('<html><body><a href="a.html">a</a><a href="b.html">b</a></body></html>', { headers: { 'content-type': 'text/html' } });
      }
      return new Response(null, { status: 404 });
    };
    const report = await resurrect({ url: 'deadsite.pt', year: 2004, out, fetcher: createFetcher({ delayMs: 0, maxRetries: 0, fetchImpl }) });
    assert.equal(report.pages.lost.length, 2);
    assert.deepEqual(calls.filter((u) => u.startsWith('https://arquivo.pt/')).map((u) => new URL(u).pathname), ['/wayback/cdx']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
