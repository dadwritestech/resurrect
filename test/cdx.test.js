import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildIndex, cdxQueryUrl, parseCdx, rankCaptures, targetTimestamp, tsToDate,
} from '../src/cdx.js';
import { makeScope } from '../src/urls.js';

// Recorded from the live CDX API for y2k.gov (page 1 trimmed to a few URLs).
const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const page1 = parseCdx(fx('y2k-cdx-page1.json'));
const page2 = parseCdx(fx('y2k-cdx-page2.json'));
const rows = [...page1.rows, ...page2.rows];

test('parseCdx reads rows and the resume key for pagination', () => {
  assert.equal(page1.rows.length, 23);
  assert.match(page1.resumeKey, /^eJx/);
  assert.equal(page2.resumeKey, null);
  assert.deepEqual(page1.rows[0], {
    ts: '19981207032804', original: 'http://y2k.gov:80/', mime: 'text/html',
    status: '200', digest: 'FAJVDATP2OY7KDMH2W5GZ4Y26ZTG6QNZ', length: 1008,
  });
  assert.deepEqual(parseCdx('[]'), { rows: [], resumeKey: null });
  assert.deepEqual(parseCdx(''), { rows: [], resumeKey: null });
});

test('cdxQueryUrl asks for successful captures under the scope, deduped by digest', () => {
  const u = new URL(cdxQueryUrl(makeScope('www.y2k.gov'), { resumeKey: 'abc', year: 1999 }));
  assert.equal(u.searchParams.get('url'), 'y2k.gov/');
  assert.equal(u.searchParams.get('matchType'), 'prefix');
  assert.equal(u.searchParams.get('filter'), 'statuscode:200');
  assert.equal(u.searchParams.get('collapse'), 'digest');
  assert.equal(u.searchParams.get('resumeKey'), 'abc');
  assert.equal(u.searchParams.get('from'), '1994');
  assert.equal(u.searchParams.get('to'), '2004');
});

test('buildIndex merges www/bare host and / vs /index.html into one page', () => {
  const index = buildIndex(rows);
  assert.equal(index.get('y2k.gov').length, 18); // 14 x "/" + 4 x "/index.html"
  assert.equal(index.get('y2k.gov/community').length, 1);
  assert.ok(index.has('y2k.gov/youth/world.html'));
});

test('targetTimestamp: busiest year by distinct URLs, or mid --year', () => {
  assert.equal(targetTimestamp(rows, 1999), '19990701000000');
  const t = targetTimestamp(rows);
  assert.equal(t.slice(0, 4), '2000'); // the site was at its biggest just after Y2K
  // a parked domain crawled 500 times as one URL must not beat a real site year
  const parked = Array.from({ length: 500 }, (_, i) => ({
    ts: `2016${String(i % 12 + 1).padStart(2, '0')}01000000`, original: 'http://y2k.gov/', status: '200',
  }));
  assert.equal(targetTimestamp([...rows, ...parked]).slice(0, 4), '2000');
});

test('rankCaptures: closest to target first, earlier wins ties, empty/non-200 dropped', () => {
  const home = buildIndex(rows).get('y2k.gov');
  const r1999 = rankCaptures(home, '19990701000000').map((c) => c.ts);
  assert.equal(r1999[0], '19990422154234');
  assert.equal(r1999[1], '19991013021843');
  const r2001 = rankCaptures(home, '20010101000000').map((c) => c.ts);
  assert.equal(r2001[0], '20010306035834'); // 64 days after beats 70 days before
  assert.equal(r2001.length, 18);

  const tie = rankCaptures([
    { ts: '20000102000000', status: '200', length: 5 },
    { ts: '19991231000000', status: '200', length: 5 },
    { ts: '20000101000000', status: '404', length: 5 },
    { ts: '20000101000000', status: '200', length: 0 },
  ], '20000101000000').map((c) => c.ts);
  assert.deepEqual(tie, ['19991231000000', '20000102000000']);
});

test('tsToDate handles short timestamps', () => {
  assert.equal(tsToDate('19991013021843'), '1999-10-13');
  assert.equal(tsToDate('2001'), '2001-01-01');
});
