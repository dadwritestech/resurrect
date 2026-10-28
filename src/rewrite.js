// HTML and CSS link rewriting, without a DOM.
//
// Pages from 1996-2010 are routinely invalid HTML in unknown encodings. A real
// parser would "fix" them (and re-serialise in a different shape and charset);
// we want the original bytes back with only the URLs changed. So: decode as
// latin1 (a lossless 1 byte = 1 char mapping for ANY encoding), swap URLs with
// regexes (URLs are ASCII), encode back as latin1. UTF-8, Shift_JIS, KOI8-R
// pages all come out byte-identical apart from the links.

import { resolve } from './urls.js';

// Comments | raw-text elements (script/style/...) | ordinary start tags.
const TOKEN = /<!--[\s\S]*?-->|<(script|style|xmp|textarea)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const ATTR = /([^\s"'>\/=]+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const NAV_ATTRS = { a: ['href'], area: ['href'], frame: ['src', 'longdesc'], iframe: ['src'] };
const ASSET_ATTRS = ['src', 'background', 'lowsrc', 'dynsrc', 'data', 'poster', 'codebase'];
const CSS_URL = /url\(\s*(['"]?)([^'")]*?)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi;
const REFRESH = /^(\s*\d*\s*;?\s*url\s*=\s*)(['"]?)(.*?)\2(\s*)$/i;

/** Which links in a tag are navigation (pages) vs assets (embedded files). */
function linkAttrs(tag, attrs) {
  const t = tag.toLowerCase();
  const out = [];
  if (NAV_ATTRS[t]) for (const a of NAV_ATTRS[t]) out.push([a, 'nav']);
  if (t === 'link') {
    const rel = (attrs.rel || '').toLowerCase();
    out.push(['href', /stylesheet|icon/.test(rel) ? 'asset' : 'nav']);
  }
  if (t === 'param' && /^(movie|src|filename|url)$/i.test(attrs.name || '')) out.push(['value', 'asset']);
  if (!NAV_ATTRS[t]) for (const a of ASSET_ATTRS) out.push([a, 'asset']);
  if (t === 'object') out.push(['data', 'asset']);
  return out;
}

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[4] ?? m[5] ?? m[6] ?? '';
  }
  return attrs;
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Split a raw URL attribute into [url, '#fragment'] so fragments survive rewriting. */
function splitFragment(raw) {
  const i = raw.indexOf('#');
  return i < 0 ? [raw, ''] : [raw.slice(0, i), raw.slice(i)];
}

/**
 * Rewrite every url(...) and @import in a CSS string.
 * visit({url, raw, kind:'asset'}) returns the replacement or undefined.
 */
export function transformCss(css, baseUrl, visit) {
  return css.replace(CSS_URL, (m, q1, u1, q2, u2) => {
    const raw = u1 ?? u2;
    const url = resolve(raw, baseUrl);
    if (!url) return m;
    const rep = visit({ url, raw, kind: 'asset', context: 'css' });
    if (rep === undefined) return m;
    return u1 !== undefined ? `url(${q1}${rep}${q1})` : `@import ${q2}${rep}${q2}`;
  });
}

/** First <base href> in the document, resolved; used as the base for every other link. */
export function findBase(html, pageUrl) {
  const m = /<base\b((?:"[^"]*"|'[^']*'|[^'">])*)>/i.exec(html);
  if (!m) return pageUrl;
  const href = parseAttrs(m[1]).href;
  return (href && resolve(href, pageUrl)?.href) || pageUrl;
}

/**
 * Walk all links in an HTML string and let `visit` replace them.
 * visit({url: URL, raw, tag, attr, kind: 'nav'|'asset', context}) -> string|undefined.
 * <base> tags are removed (relative output links must not be re-based).
 */
export function transformHtml(html, pageUrl, visit) {
  const base = findBase(html, pageUrl);

  const rewriteAttrs = (tag, attrStr) => {
    const attrs = parseAttrs(attrStr);
    const targets = new Map(linkAttrs(tag, attrs));
    const isRefresh = tag.toLowerCase() === 'meta' && /refresh/i.test(attrs['http-equiv'] || '');
    return attrStr.replace(ATTR, (m, name, eq, _v, dq, sq, bare) => {
      const n = name.toLowerCase();
      const value = dq ?? sq ?? bare ?? '';
      if (n === 'style') {
        const css = transformCss(value, base, visit);
        const q = sq !== undefined ? "'" : '"';
        return css === value ? m : `${name}${eq}${q}${css}${q}`;
      }
      if (isRefresh && n === 'content') {
        const r = REFRESH.exec(value);
        if (!r) return m;
        const [u, frag] = splitFragment(r[3]);
        const url = resolve(u, base);
        if (!url) return m;
        const rep = visit({ url, raw: r[3], tag, attr: n, kind: 'nav', context: 'refresh' });
        return rep === undefined ? m : `${name}="${escAttr(r[1] + rep + frag)}"`;
      }
      const kind = targets.get(n);
      if (!kind) return m;
      const [u, frag] = splitFragment(value);
      if (!u) return m;
      const url = resolve(u, base);
      if (!url) return m;
      const rep = visit({ url, raw: value, tag, attr: n, kind, context: 'html' });
      return rep === undefined ? m : `${name}${eq}"${escAttr(rep + frag)}"`;
    });
  };

  return html.replace(TOKEN, (m, rawTag, rawAttrs, rawBody, tag, attrStr) => {
    if (m.startsWith('<!--')) return m;
    if (rawTag) {
      const open = `<${rawTag}${rewriteAttrs(rawTag, rawAttrs || '')}>`;
      const body = rawTag.toLowerCase() === 'style' ? transformCss(rawBody, base, visit) : rawBody;
      return `${open}${body}</${rawTag}>`;
    }
    if (tag.toLowerCase() === 'base') return '';
    return `<${tag}${rewriteAttrs(tag, attrStr || '')}>`;
  });
}

/** Collect links without changing anything. */
export function extractLinks(html, pageUrl) {
  const links = [];
  transformHtml(html, pageUrl, (l) => { links.push(l); return undefined; });
  return links;
}

export function extractCssLinks(css, cssUrl) {
  const links = [];
  transformCss(css, cssUrl, (l) => { links.push(l); return undefined; });
  return links;
}

export function isFrameset(html) {
  return /<frameset\b/i.test(html);
}

/** Non-ASCII safe: footer text goes in as numeric entities, so it is valid in any charset. */
export function asciiHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    .replace(/[^\x20-\x7e\n]/g, (c) => `&#${c.codePointAt(0)};`);
}

/** Insert html just before </body> (or </html>, or at the end). */
export function injectBeforeBodyEnd(html, snippet) {
  const i = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  if (i >= 0) return html.slice(0, i) + snippet + html.slice(i);
  const j = html.search(/<\/html\s*>(?![\s\S]*<\/html\s*>)/i);
  if (j >= 0) return html.slice(0, j) + snippet + html.slice(j);
  return html + snippet;
}

/** Insert html right after <head> (or <html>, or at the start). */
export function injectInHead(html, snippet) {
  const m = /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + snippet + html.slice(m.index + m[0].length);
  return snippet + html;
}
