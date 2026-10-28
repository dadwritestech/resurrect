import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractLinks, injectBeforeBodyEnd, injectInHead, transformCss, transformHtml,
} from '../src/rewrite.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const tag = (l) => `${l.kind}:${l.url.href}`;

test('finds nav and asset links in 1990s markup (uppercase, unquoted, frames, background, flash)', () => {
  const html = `<HTML><BODY BACKGROUND=bg.gif>
<A HREF=about.html>About</A> <a href='/news/'>News</a>
<FRAMESET><FRAME SRC="menu.htm" NAME=menu></FRAMESET>
<IMG SRC="img/me.jpg" LOWSRC=img/me-lo.gif> <TD BACKGROUND="tile.gif">
<embed src="intro.swf"><object><param name="movie" value="intro.swf"><param name="quality" value="high"></object>
<link rel="stylesheet" href="style.css"><link rel="alternate" href="feed.rss">
<script src="x.js"></script><bgsound src="tune.mid">
<!-- <a href="commented-out.html"> -->
<a href="mailto:me@aol.com">mail</a><a href="#top">top</a>
</BODY></HTML>`;
  const got = extractLinks(html, 'http://www.example.com/~me/index.html').map(tag);
  assert.deepEqual(got, [
    'asset:http://www.example.com/~me/bg.gif',
    'nav:http://www.example.com/~me/about.html',
    'nav:http://www.example.com/news/',
    'nav:http://www.example.com/~me/menu.htm',
    'asset:http://www.example.com/~me/img/me.jpg',
    'asset:http://www.example.com/~me/img/me-lo.gif',
    'asset:http://www.example.com/~me/tile.gif',
    'asset:http://www.example.com/~me/intro.swf',
    'asset:http://www.example.com/~me/intro.swf',
    'asset:http://www.example.com/~me/style.css',
    'nav:http://www.example.com/~me/feed.rss',
    'asset:http://www.example.com/~me/x.js',
    'asset:http://www.example.com/~me/tune.mid',
  ]);
});

test('rewrites links, keeps fragments, leaves everything else byte-identical', () => {
  const html = `<P ALIGN=center><A HREF="about.html#bio" TARGET=_top>About</A><IMG SRC=me.gif WIDTH=10></P>`;
  const out = transformHtml(html, 'http://ex.com/', (l) => (l.url.pathname === '/about.html' ? 'about/index.html' : 'img/me.gif'));
  assert.equal(out, `<P ALIGN=center><A HREF="about/index.html#bio" TARGET=_top>About</A><IMG SRC="img/me.gif" WIDTH=10></P>`);
});

test('<base href> is honoured for resolution, then removed', () => {
  const html = `<head><base href="http://ex.com/sub/"></head><a href="x.html">x</a>`;
  const seen = [];
  const out = transformHtml(html, 'http://ex.com/other/page.html', (l) => { seen.push(l.url.href); return 'x.html'; });
  assert.deepEqual(seen, ['http://ex.com/sub/x.html']);
  assert.equal(out, `<head></head><a href="x.html">x</a>`);
});

test('meta refresh, inline style and <style> blocks are rewritten', () => {
  const html = `<meta http-equiv="Refresh" content="5; URL=http://ex.com/new.html">
<div style="background:url('pics/a.gif')"></div>
<style>body{background:url(bg.jpg)} @import "more.css";</style>`;
  const out = transformHtml(html, 'http://ex.com/', (l) => `L/${l.url.pathname.slice(1)}`);
  assert.match(out, /content="5; URL=L\/new\.html"/);
  assert.match(out, /style="background:url\('L\/pics\/a\.gif'\)"/);
  assert.match(out, /url\(L\/bg\.jpg\)/);
  assert.match(out, /@import "L\/more\.css"/);
});

test('script bodies are never touched (only the src attribute)', () => {
  const html = `<script src="a.js">var s = "<a href='x.html'>"; document.write('<img src=y.gif>')</script>`;
  const out = transformHtml(html, 'http://ex.com/', () => 'R');
  assert.equal(out, `<script src="R">var s = "<a href='x.html'>"; document.write('<img src=y.gif>')</script>`);
});

test('CSS url() and @import', () => {
  const css = `@import url(base.css); h1{background:url("/img/h1.png") no-repeat} .x{src:url(data:font/woff;base64,AA)}`;
  const out = transformCss(css, 'http://ex.com/css/site.css', (l) => `[${l.url.pathname}]`);
  assert.equal(out, `@import url([/css/base.css]); h1{background:url("[/img/h1.png]") no-repeat} .x{src:url(data:font/woff;base64,AA)}`);
});

test('latin1 round trip keeps non-ASCII bytes of any encoding intact', () => {
  // "Café" in windows-1252 and "日本" in Shift_JIS, raw bytes
  const bytes = Buffer.concat([
    Buffer.from('<p>Caf'), Buffer.from([0xe9]), Buffer.from(' <a href="x.html">'),
    Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from('</a></p>'),
  ]);
  const out = Buffer.from(transformHtml(bytes.toString('latin1'), 'http://ex.com/', () => 'y.html'), 'latin1');
  assert.deepEqual(out, Buffer.from(bytes.toString('latin1').replace('x.html', 'y.html'), 'latin1'));
  assert.equal(out[6], 0xe9);
});

test('footer and head injection', () => {
  assert.equal(injectBeforeBodyEnd('<body>a</BODY></html>', 'F'), '<body>aF</BODY></html>');
  assert.equal(injectBeforeBodyEnd('<p>no body', 'F'), '<p>no bodyF');
  assert.equal(injectInHead('<HTML><HEAD><TITLE>t', 'M'), '<HTML><HEAD>M<TITLE>t');
  assert.equal(injectInHead('<p>x', 'M'), 'M<p>x');
});

test('recorded fixture: y2k.gov home page (1999-2000) links are all found', () => {
  const html = fx('y2k-home.html').toString('latin1');
  const links = extractLinks(html, 'http://www.y2k.gov:80/');
  const navs = links.filter((l) => l.kind === 'nav').map((l) => l.url.pathname);
  const assets = links.filter((l) => l.kind === 'asset').map((l) => l.url.pathname);
  assert.ok(navs.length >= 5, `nav links: ${navs}`);
  assert.ok(assets.some((p) => /\.(gif|jpe?g)$/i.test(p)), `assets: ${assets}`);
  // a visitor that changes nothing must give back the page byte for byte
  assert.equal(transformHtml(html, 'http://www.y2k.gov:80/', () => undefined), html);
});
