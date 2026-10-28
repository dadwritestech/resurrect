// URL identity and local-path mapping.
//
// Two ideas drive this file:
//  - a *key* decides when two URLs are "the same page" (www vs bare host,
//    /dir/ vs /dir/index.html, case, default ports). Old sites mix all of these.
//  - a *local path* is where that page lives in the output folder. It is
//    derived from the key, so every link to the same page lands on one file.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const INDEX_FILE = /\/(index|default|home)\.(html?|shtml|php3?|asp|aspx|cfm|jsp)$/i;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export const ASSET_EXT = new Set([
  'gif', 'jpg', 'jpeg', 'png', 'bmp', 'ico', 'svg', 'webp', 'tif', 'tiff', 'xbm',
  'css', 'js', 'swf', 'flv', 'dcr', 'class', 'jar',
  'mid', 'midi', 'wav', 'mp3', 'au', 'aif', 'aiff', 'ra', 'ram', 'rm', 'ogg', 'mp4', 'mov', 'avi', 'mpg', 'mpeg', 'wmv',
  'pdf', 'doc', 'xls', 'ppt', 'rtf', 'txt', 'zip', 'gz', 'tar', 'exe', 'hqx', 'sit',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'xml', 'rss', 'json',
]);

/** Add http:// when the user typed a bare domain. */
export function withScheme(raw) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

/**
 * Old pages sometimes contain links already pointing into the Wayback Machine
 * (copied from an archived copy, or saved by a previous mirror). Turn
 * `http://web.archive.org/web/1999.../http://site/page` back into the original.
 */
export function unwrapWayback(raw) {
  const m = /^(?:(?:https?:)?\/\/(?:web\.|www\.)?archive\.org)?\/web\/(\d{1,14})(?:[a-z]{2}_|\*)?\/(.+)$/i.exec(raw);
  if (!m) return null;
  let url = m[2].replace(/^(https?):\/(?!\/)/i, '$1://');
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  return { ts: m[1], url };
}

/** Parse and normalise a URL relative to a base; null for anything unfetchable. */
export function resolve(raw, base) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/&amp;/gi, '&').replace(/[\r\n\t]/g, '');
  if (!s || s.startsWith('#')) return null;
  if (/^(javascript|mailto|data|about|tel|news|ftp|file|irc|aim|gopher):/i.test(s)) return null;
  const unwrapped = unwrapWayback(s);
  if (unwrapped) s = unwrapped.url;
  let u;
  try { u = new URL(s, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u;
}

/** {host, path, search} in canonical form; see urlKey. */
export function urlParts(input) {
  const u = typeof input === 'string' ? new URL(withScheme(input)) : input;
  let host = u.hostname.toLowerCase().replace(/^www\d*\./, '');
  if (u.port) host += `:${u.port}`;
  let path = u.pathname.replace(/\/{2,}/g, '/');
  try { path = decodeURIComponent(path); } catch { /* keep encoded */ }
  path = path.toLowerCase().replace(INDEX_FILE, '/');
  if (path.endsWith('/')) path = path.slice(0, -1);
  const search = u.search && u.search !== '?' ? u.search.toLowerCase() : '';
  return { host, path, search };
}

/** Canonical identity of a URL: `host/path?query`, no scheme, no fragment. */
export function urlKey(input) {
  const { host, path, search } = urlParts(input);
  return host + path + search;
}

/**
 * The part of the web we are resurrecting. `geocities.com/Area51/1234/` scopes
 * to that directory; `example.com` scopes to the whole host.
 */
export function makeScope(startUrl) {
  const u = new URL(withScheme(startUrl));
  const { host, path } = urlParts(u);
  const last = path.split('/').pop();
  // /dir/page.html -> scope /dir ; /dir or /dir/ -> scope /dir
  const prefix = last && /\.[a-z0-9]{1,5}$/i.test(last) ? path.slice(0, path.lastIndexOf('/')) : path;
  return { host, prefix, start: u.href, cdxUrl: `${host}${prefix}/` };
}

export function inScope(url, scope) {
  const { host, path } = urlParts(url);
  if (host !== scope.host) return false;
  return path === scope.prefix || path.startsWith(`${scope.prefix}/`);
}

export function extOf(url) {
  const { path } = urlParts(url);
  const m = /\.([a-z0-9]{1,5})$/.exec(path.split('/').pop() || '');
  return m ? m[1] : '';
}

export function looksLikeAsset(url) {
  return ASSET_EXT.has(extOf(url));
}

function sanitizeSegment(seg) {
  let s = seg.replace(/[^a-z0-9._~-]/g, '_').slice(0, 100);
  if (s === '.' || s === '..' || !s) s = '_';
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  return s;
}

function shortHash(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

/**
 * Where a resource is written in the output folder (posix, relative to root).
 *   site.com/               -> index.html
 *   site.com/about/         -> about/index.html
 *   site.com/about          -> about/index.html     (pages)
 *   site.com/cgi/show.php?3 -> cgi/show__1a2b3c4d.php.html
 *   other.com/pic.gif       -> _ext/other.com/pic.gif
 */
export function localPath(url, scope, isPage) {
  const { host, path, search } = urlParts(url);
  const own = inScope(url, scope);
  const rest = own ? path.slice(scope.prefix.length) : path;
  const segs = (own ? [] : ['_ext', host]).concat(rest.split('/').filter(Boolean)).map(sanitizeSegment);
  if (isPage) {
    const last = segs.at(-1);
    const ext = last ? posix.extname(last) : '';
    if (!rest || !ext) segs.push('index.html');
    else if (!/^\.html?$/.test(ext)) segs[segs.length - 1] = `${last}.html`;
  } else if (!rest) {
    segs.push('_root');
  }
  if (search) {
    const last = segs.pop();
    const dot = last.indexOf('.');
    const tag = `__${shortHash(search)}`;
    segs.push(dot > 0 ? last.slice(0, dot) + tag + last.slice(dot) : last + tag);
  }
  return segs.join('/');
}

/** Relative href from one output file to another, always explicit (works on file://). */
export function relativeHref(fromLocal, toLocal) {
  const rel = posix.relative(posix.dirname(fromLocal), toLocal);
  return rel || posix.basename(toLocal);
}
