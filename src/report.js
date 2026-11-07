// Human-readable outputs: REPORT.md and the "this page is lost" placeholder.

export function renderReport(r) {
  const n = (a) => a.length;
  const drifted = [...r.pages.recovered, ...r.assets.recovered].filter((i) => i.via !== 'best');
  const archives = r.archives || [{ name: 'wayback', label: "Internet Archive's Wayback Machine", used: 1 }];
  const used = archives.filter((a) => a.used);
  const credit = (used.length ? used : archives).map((a) => a.label).join(' and ');
  const sources = (r.index.sources || []).map((s) => `${s.archive} ${s.error ? `unavailable (${s.error})` : `${s.captures} captures`}`).join(', ');
  const lines = [
    `# resurrect report: ${r.scope}`,
    '',
    `Rebuilt as of **${r.target}** (${r.targetFrom}). Captures used span ${r.capturesSpan ? r.capturesSpan.join(' to ') : 'n/a'}.`,
    `The archive indexes held ${r.index.captures} captures of ${r.index.distinctUrls} distinct URLs${r.index.truncated ? ' (index truncated)' : ''}${sources ? `: ${sources}` : ''}.`,
    ...(archives.length > 1 ? ['', `Files recovered per archive: ${archives.map((a) => `${a.name} ${a.used}`).join(', ')}.`] : []),
    '',
    '| | recovered | lost | skipped (limits) |',
    '|---|---:|---:|---:|',
    `| pages | ${n(r.pages.recovered)} | ${n(r.pages.lost)} | ${n(r.pages.skipped)} |`,
    `| assets | ${n(r.assets.recovered)} | ${n(r.assets.lost)} | ${n(r.assets.skipped)} |`,
    '',
    `Links to other websites: ${r.externalLinks} (pointed at their archived copies).`,
    '',
  ];
  if (drifted.length) {
    lines.push('## Filled from other snapshots', '',
      'The closest capture was missing or broken, so these came from a neighbouring snapshot:', '',
      '| file | captured | days from target | how | archive |', '|---|---|---:|---|---|');
    for (const i of drifted) lines.push(`| \`${i.file}\` | ${i.captured} | ${i.driftDays} | ${i.via} | ${i.archive || ''} |`);
    lines.push('');
  }
  const lostTable = (title, items) => {
    if (!items.length) return;
    lines.push(`## Lost ${title}`, '', 'Linked from the site but not in any archive we asked, at any date:', '');
    for (const i of items) lines.push(`- ${i.url}${i.linkedFrom.length ? `  (linked from ${i.linkedFrom.join(', ')})` : ''}`);
    lines.push('');
  };
  lostTable('pages', r.pages.lost);
  lostTable('assets', r.assets.lost);
  lines.push('## Recovered pages', '', '| file | captured | days from target | archive |', '|---|---|---:|---|');
  for (const i of r.pages.recovered) lines.push(`| \`${i.file}\` | ${i.captured} | ${i.driftDays} | ${i.archive || ''} |`);
  lines.push('', `_Generated ${r.generatedAt} by resurrect. Content courtesy of ${credit.startsWith('Internet') ? 'the ' : ''}${credit}._`, '');
  return lines.join('\n');
}

export function lostPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Lost page</title>
<style>
  body{font:16px/1.5 Georgia,serif;max-width:36em;margin:4em auto;padding:0 1em;color:#333;background:#fdfcf8}
  code{word-break:break-all;background:#eee;padding:2px 4px}
  a{color:#36c}
</style></head><body>
<h1>This page was not archived</h1>
<p>The original site linked to</p>
<p><code id="u">(unknown)</code></p>
<p>but none of the web archives resurrect asked has a working copy of it from any date, so it could not be resurrected.</p>
<p>Search yourself: <a id="wb" href="https://web.archive.org/">Wayback Machine</a> &middot; <a id="aq" href="https://arquivo.pt/">Arquivo.pt</a> &middot; <a id="at" href="https://archive.ph/">archive.today</a> &middot; <a href="javascript:history.back()">Go back</a></p>
<script>
  var u = decodeURIComponent(location.hash.slice(1));
  if (u) {
    document.getElementById('u').textContent = u;
    document.getElementById('wb').href = 'https://web.archive.org/web/*/' + u;
    document.getElementById('aq').href = 'https://arquivo.pt/wayback/*/' + u;
    document.getElementById('at').href = 'https://archive.ph/' + u;
  }
</script>
</body></html>
`;
}
