import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inScope, localPath, makeScope, relativeHref, resolve, unwrapWayback, urlKey,
} from '../src/urls.js';

test('urlKey treats www, ports, case, index files and trailing slashes as one page', () => {
  const same = [
    'http://y2k.gov/',
    'http://www.y2k.gov:80/',
    'http://WWW.Y2K.GOV/index.html',
    'https://y2k.gov/Default.htm',
    'http://y2k.gov',
  ];
  for (const u of same) assert.equal(urlKey(u), 'y2k.gov', u);
  assert.equal(urlKey('http://www.y2k.gov:80/community/'), 'y2k.gov/community');
  assert.equal(urlKey('http://www.y2k.gov/community/index.html'), 'y2k.gov/community');
  assert.equal(urlKey('http://y2k.gov/a%20b.html'), 'y2k.gov/a b.html');
  assert.notEqual(urlKey('http://y2k.gov/x?id=1'), urlKey('http://y2k.gov/x?id=2'));
});

test('unwrapWayback recovers the original URL from archive links', () => {
  assert.deepEqual(unwrapWayback('http://web.archive.org/web/19991012172052/http://www.y2k.gov/faq.html'),
    { ts: '19991012172052', url: 'http://www.y2k.gov/faq.html' });
  assert.deepEqual(unwrapWayback('/web/2001im_/http://x.com/a.gif'), { ts: '2001', url: 'http://x.com/a.gif' });
  // collapsed double slash, scheme-less
  assert.equal(unwrapWayback('https://web.archive.org/web/2005/http:/x.com/').url, 'http://x.com/');
  assert.equal(unwrapWayback('https://web.archive.org/web/2005/x.com/a').url, 'http://x.com/a');
  assert.equal(unwrapWayback('http://x.com/web/page'), null);
});

test('resolve skips non-fetchable links and unwraps archive links', () => {
  const base = 'http://www.y2k.gov/community/index.html';
  assert.equal(resolve('faq.html', base).href, 'http://www.y2k.gov/community/faq.html');
  assert.equal(resolve('../briefings.html#top', base).href, 'http://www.y2k.gov/briefings.html#top');
  assert.equal(resolve('a.cgi?x=1&amp;y=2', base).href, 'http://www.y2k.gov/community/a.cgi?x=1&y=2');
  for (const s of ['#top', 'mailto:a@b.c', 'javascript:void(0)', '', 'ftp://x/y', 'data:image/gif;base64,AAA'])
    assert.equal(resolve(s, base), null, s);
  assert.equal(resolve('http://web.archive.org/web/1999/http://www.y2k.gov/x.html', base).href, 'http://www.y2k.gov/x.html');
});

test('scope: bare domain covers the host, a path covers its directory', () => {
  const root = makeScope('y2k.gov');
  assert.equal(root.cdxUrl, 'y2k.gov/');
  assert.ok(inScope('http://www.y2k.gov/a/b.html', root));
  assert.ok(!inScope('http://other.gov/', root));
  assert.ok(!inScope('http://sub.y2k.gov/', root));

  const geo = makeScope('http://www.geocities.com/Area51/Vault/1234/index.html');
  assert.equal(geo.prefix, '/area51/vault/1234');
  assert.ok(inScope('http://geocities.com/Area51/Vault/1234/pics/me.gif', geo));
  assert.ok(inScope('http://geocities.com/area51/vault/1234/', geo));
  assert.ok(!inScope('http://geocities.com/Area51/Vault/12345/', geo));
  assert.ok(!inScope('http://geocities.com/images/bg.gif', geo));
});

test('localPath maps pages and assets to stable, servable files', () => {
  const s = makeScope('y2k.gov');
  const page = (u) => localPath(new URL(u), s, true);
  const asset = (u) => localPath(new URL(u), s, false);
  assert.equal(page('http://www.y2k.gov/'), 'index.html');
  assert.equal(page('http://www.y2k.gov/community/'), 'community/index.html');
  assert.equal(page('http://www.y2k.gov/community/index.html'), 'community/index.html');
  assert.equal(page('http://www.y2k.gov/community'), 'community/index.html');
  assert.equal(page('http://www.y2k.gov/council/JKTE0115.htm'), 'council/jkte0115.htm');
  assert.equal(page('http://www.y2k.gov/news.shtml'), 'news.shtml.html');
  assert.match(page('http://www.y2k.gov/show.php?id=3'), /^show__[0-9a-f]{8}\.php\.html$/);
  assert.equal(asset('http://www.y2k.gov/images/Seal.GIF'), 'images/seal.gif');
  assert.equal(asset('http://cdn.example.com/x/y.css'), '_ext/cdn.example.com/x/y.css');
  assert.equal(asset('http://www.y2k.gov/con.gif'), '_con.gif'); // Windows reserved name
  assert.equal(asset('http://www.y2k.gov/a b/c%3Cd.gif'), 'a_b/c_d.gif');

  const geo = makeScope('http://www.geocities.com/Area51/Vault/1234/');
  assert.equal(localPath(new URL('http://geocities.com/Area51/Vault/1234/'), geo, true), 'index.html');
  assert.equal(localPath(new URL('http://geocities.com/Area51/Vault/1234/links.html'), geo, true), 'links.html');
});

test('relativeHref produces explicit relative paths that also work on file://', () => {
  assert.equal(relativeHref('index.html', 'community/index.html'), 'community/index.html');
  assert.equal(relativeHref('community/faq.html', 'index.html'), '../index.html');
  assert.equal(relativeHref('community/faq.html', 'community/faq.html'), 'faq.html');
  assert.equal(relativeHref('a/b/c.html', 'a/img/x.gif'), '../img/x.gif');
});
