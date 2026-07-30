# aep-docs-site

Static build of the documentation in `../docs`, driven by `../docs/docs.json`.

Run: `npm install`, then `npm run dev`: build, serve, watch, and reload the
browser on every change. Port 4173, overridable with `PORT`. Output goes to
`dist/` (not committed). `npm run build` builds once; `npm run serve` serves
`dist/` as-is.

## Configuration

Copy `.env.example` to `.env` (gitignored) and uncomment what you need;
`env.mjs` loads it on startup. Every variable is optional, and a variable set
in the real environment wins over the file, so CI can set one as a workflow
variable without a local `.env` shadowing it.

| Variable | Default | Effect |
| --- | --- | --- |
| `SITE_URL` | unset | Absolute origin, no trailing slash. Emits `<link rel="canonical">` and `og:url` on every page, and writes `sitemap.xml` + `robots.txt`. Unset omits all four rather than guessing a host — the other link-preview tags render either way. |
| `PORT` | `4173` | Port for `pnpm serve` and `pnpm dev`. |

## Fonts

Inter and Geist Mono are self-hosted in `assets/fonts/` (committed), so the
published site makes no third-party request. `npm run vendor-fonts` re-downloads
them from Google Fonts and regenerates `assets/fonts/fonts.css`; run it
deliberately and review the diff. Only the `latin` and `latin-ext` subsets are
kept, and `unicode-range` means a browser fetches only the faces a page needs.

## Build outputs

Beyond one directory per page, a build writes:

| Output | Notes |
| --- | --- |
| `404.html` | Styled, with the full nav and search. `serve.mjs` returns it for misses. |
| `assets/search-index.json` | Section-level index, fetched lazily on first ⌘K/Ctrl-K. |
| `assets/nav.js` | Client nav bundle, in `docs.json` order. |
| `sitemap.xml`, `robots.txt` | Only when `SITE_URL` is set. |
| `<route>/index.md` | Raw markdown behind "Copy page" / "View as Markdown". |

Each page shows a "Last updated" date read from `git log`. A shallow clone
reports one date for every file, so the build drops the dates entirely rather
than print wrong ones — use `fetch-depth: 0` on the job that publishes.

## What `pnpm dev` watches

| Change | Runs |
| --- | --- |
| `docs/**`, `site/assets/**`, `site/{build,mdx,nav}.mjs` | `build.mjs` |
| `spec/*.md`, root `GOVERNANCE`/`CONTRIBUTING`/`CODE_OF_CONDUCT`/`SECURITY`/`VERSIONING`/`CHANGELOG` | `render-site.js` → `build.mjs` |
| `conformance/fixtures/mappings/*.json`, `docs/data/agents.json` | `gen-agents.js` → `build.mjs` |

Generated pages are not watched: `docs/specification/draft/*`,
`docs/community/*`, `docs/updates.mdx`,
`docs/agents/{feature,control}-matrix.md`. Edit the canonical source instead.

- Startup runs both generators, so `pnpm dev` writes into `docs/`.
- `dev.mjs` and `serve.mjs` are not hot-reloaded; restart to pick them up.
- A failed generator or build logs the error, sends no reload, and leaves the
  last good `dist/` in place.
- Live reload is dev-only. `serve.mjs` injects its client at serve time, so
  `dist/` is byte-identical to what `pnpm build` produces.
