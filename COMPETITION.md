# Competition check (2026-10-28)

Searched with `gh search repos` (sorted by stars). Several multi-word queries
(`wayback rebuild website`, `wayback machine static site`, `resurrect website archive`,
`archive.org restore site static`) returned **zero** repositories. The first pass hit the
GitHub search rate limit and was retried after reset.

## Downloaders (the big ones): "get the files"

| stars | repo | what it does | gap |
|---:|---|---|---|
| 5,962 | hartator/wayback-machine-downloader | Ruby gem, downloads every file of a domain from the latest (or a chosen) timestamp | Output is a pile of files at their original paths: absolute links still point at the dead domain, `/dir` vs `/dir/index.html` are not unified, no gap filling, no report. Many forks exist only to patch this. |
| 3,239 | jsvine/waybackpack | Downloads *every capture* of a single URL | Single URL, for diffing history, not a browsable site. |
| 131 | bitdruid/python-wayback-machine-downloader | Python downloader | Same "download files" angle. |
| 109 | erlange/wbm-dl | Downloader | Same. |
| 108 | birbwatcher/wayback-machine-downloader | Downloader for webmasters / OSINT / SEO | Same. |

## URL listers (recon tools, a different market)

lc/gau (5,150), tomnomnom/waybackurls (4,598), xnl-h4ck3r/waymore (2,783): list
archived URLs for bug bounty recon. These do not rebuild anything.

## Browse-through-the-archive

richardg867/WaybackProxy (781): an HTTP proxy that lets old browsers or computers surf
the Wayback Machine. Nostalgic and adjacent, but it gives you a proxy, not a site you own.

## The closest: "restore a site"

| stars | repo | notes |
|---:|---|---|
| 15 | **obra/wayback-restorer** (Feb 2026) | **The real competitor.** Python, zero-deps. Pipeline: paginated CDX, `id_` mode, relative link rewriting, coverage/gap/provenance reports. The design is very close to ours. Differences: it is configured through flags (`--domain --canonical-host --equivalent-host --from-date --to-date --modern-cutoff-date`); it picks one capture per URL inside a date window; it has no "as of year" default, no neighbour fallback per URL, no in-page credit footer, and no placeholder page for lost links. It started as a one-site recovery (Something Positive). |
| 0 | punprapor/wayback_restore, AmrElshabrawyDev/wayback-restore, jestemkojak/wayback-restore, Markovnin/wayback-machine-restore-website, … | Many zero-star attempts in 2025-2026, mostly for SEO domain flippers ("restore expired domain content"). None has traction. |

## Angle for resurrect

Downloaders give you **files**. resurrect gives you **the website back, working**:

1. **One argument.** `npx github:dadwritestech/resurrect myoldblog.com`. Host equivalence, the date window and the
   target moment are all inferred: the default is the busiest archived year, counted by
   *distinct URLs* so that parked-domain re-crawls are ignored.
2. **Time travel.** `--year 2003` rebuilds the site as it was that year, choosing the closest
   capture *per page*. When the closest capture is broken, it falls back to the next one.
3. **Every link works or explains itself.** Internal links point to local files. Lost pages go to a
   "this page was not archived" placeholder. External links go to the Wayback copy from the
   same date.
4. **Honest by default.** Every page has a footer crediting the Internet Archive with the capture
   date, every page is `noindex`, and a `REPORT.md` lists what was recovered and what was lost.
5. **Viral loop (not in v0).** A public gallery of resurrected sites, plus "deploy to GitHub Pages".

Risk: obra/wayback-restorer could add a one-command UX. Jesse Vincent (obra) has a big
following (superpowers). Our moat is the consumer-facing nostalgia packaging (gallery,
before/after, one command), not the pipeline.
