// Web archives resurrect can rebuild from.
//
// The Wayback Machine is the biggest, but it is one organisation: pages get
// excluded on request, and it has gone offline before. Any archive that runs
// the standard CDX index + replay URL scheme (pywb, OpenWayback) works the same
// way, so the sources are data, not code paths:
//
//   index:  <cdx>?url=<prefix>&matchType=prefix
//   raw:    <base><14-digit timestamp>id_/<original url>   (bytes as captured)
//   view:   <base><timestamp>/<original url>               (the archive's own page)

export const ARCHIVES = {
  wayback: {
    name: 'wayback',
    label: "Internet Archive's Wayback Machine",
    base: 'https://web.archive.org/web/',
    cdx: 'https://web.archive.org/cdx/search/cdx',
    flavour: 'wayback',
  },
  arquivo: {
    name: 'arquivo',
    label: 'Arquivo.pt',
    base: 'https://arquivo.pt/wayback/',
    cdx: 'https://arquivo.pt/wayback/cdx',
    flavour: 'pywb',
  },
};

export const DEFAULT_ARCHIVES = ['wayback', 'arquivo'];

/**
 * Resolve a list of names and/or replay URLs into archive records.
 * A URL is treated as a pywb collection: https://host/coll/ -> CDX at https://host/coll/cdx.
 */
export function pickArchives(list = DEFAULT_ARCHIVES) {
  const out = [];
  for (const raw of list) {
    if (raw && typeof raw === 'object') { out.push(raw); continue; } // already resolved
    const s = String(raw).trim();
    if (!s) continue;
    if (ARCHIVES[s.toLowerCase()]) { out.push(ARCHIVES[s.toLowerCase()]); continue; }
    let u;
    try { u = new URL(s); } catch { throw new Error(`unknown archive "${s}" (use ${Object.keys(ARCHIVES).join(', ')} or a pywb URL like https://host/collection/)`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`archive URL must be http(s): ${s}`);
    const base = u.href.endsWith('/') ? u.href : `${u.href}/`;
    out.push({ name: u.host, label: u.host, base, cdx: `${base}cdx`, flavour: 'pywb' });
  }
  if (!out.length) throw new Error('no archives selected');
  return out.filter((a, i) => out.findIndex((b) => b.base === a.base) === i);
}

export const rawUrl = (a, ts, original) => `${a.base}${ts}id_/${original}`;
export const viewUrl = (a, ts, original) => `${a.base}${ts}/${original}`;

/** The archive a URL belongs to, if any. */
export function archiveOf(url, archives) {
  return archives.find((a) => url.startsWith(a.base) || url.startsWith(a.cdx)) || null;
}

/** Undo rawUrl/viewUrl for a URL served by archive `a` (e.g. after a redirect to the nearest capture). */
export function unwrapReplay(a, url) {
  if (!url.startsWith(a.base)) return null;
  const m = /^(\d{1,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(url.slice(a.base.length));
  if (!m) return null;
  let original = m[2].replace(/^(https?):\/(?!\/)/i, '$1://');
  if (!/^[a-z]+:\/\//i.test(original)) original = `http://${original}`;
  return { ts: m[1].padEnd(14, '0'), url: original };
}
