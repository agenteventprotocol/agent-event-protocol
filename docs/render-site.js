#!/usr/bin/env node
// Site-page renderer for the Mintlify docs site rooted at docs/. Offline,
// no deps. Generates the Specification and Community pages from their
// canonical sources — spec/*.md and the root governance files — so the
// site never carries a second hand-maintained copy of normative or
// governance text. The generated pages are build artifacts, checked in so
// the site needs no build step; `--check` regenerates to memory and fails
// if any checked-in page is stale (wired into the docs CI job).
//
//   node docs/render-site.js          # (re)write the generated pages
//   node docs/render-site.js --check  # verify checked-in pages are current
//
// Transform per page: drop the H1 (the frontmatter title renders instead),
// add `title:`/`description:` frontmatter (description = first sentence of
// the first prose paragraph unless overridden below), inject a provenance
// callout pointing at the canonical file, and rewrite repo-relative links
// to site URLs (or GitHub URLs for targets with no site page). Everything
// else is byte-preserved. Fenced code blocks are never rewritten.

const fs = require('fs');
const path = require('path');

const DOCS = __dirname;
const REPO = path.resolve(DOCS, '..');
const GH = 'https://github.com/agenteventprotocol/agent-event-protocol';

// ---- canonical-source manifest ----------------------------------------------
// out paths are relative to docs/; src relative to the repo root.
const SPEC_PAGES = [
  { src: 'spec/README.md', out: 'specification/draft/index.md', title: 'AEP 0.1 draft suite', sidebarTitle: 'Overview' },
  { src: 'spec/AEP-0001-core-and-envelope.md', out: 'specification/draft/aep-0001-core-and-envelope.md', sidebarTitle: 'AEP-0001: Core & envelope' },
  { src: 'spec/AEP-0002-taxonomy-and-types.md', out: 'specification/draft/aep-0002-taxonomy-and-types.md', sidebarTitle: 'AEP-0002: Taxonomy & types' },
  { src: 'spec/AEP-0003-bindings-and-lifecycle.md', out: 'specification/draft/aep-0003-bindings-and-lifecycle.md', sidebarTitle: 'AEP-0003: Bindings & lifecycle' },
  { src: 'spec/AEP-0004-control-profile.md', out: 'specification/draft/aep-0004-control-profile.md', sidebarTitle: 'AEP-0004: Control profile' },
  { src: 'spec/AEP-0005-bridges.md', out: 'specification/draft/aep-0005-bridges.md', sidebarTitle: 'AEP-0005: Bridges' },
  { src: 'spec/AEP-0006-structured-input-requests.md', out: 'specification/draft/aep-0006-structured-input-requests.md', sidebarTitle: 'AEP-0006: Structured input' },
  { src: 'spec/AEP-0007-message-stream-subprofile.md', out: 'specification/draft/aep-0007-message-stream-subprofile.md', sidebarTitle: 'AEP-0007: Message & stream' },
  { src: 'spec/AEP-0008-text-answers-and-response-channels.md', out: 'specification/draft/aep-0008-text-answers-and-response-channels.md', sidebarTitle: 'AEP-0008: Text answers' },
  { src: 'spec/AEP-0009-assessment.md', out: 'specification/draft/aep-0009-assessment.md', sidebarTitle: 'AEP-0009: Assessment' },
];
const COMMUNITY_PAGES = [
  { src: 'GOVERNANCE.md', out: 'community/governance.md', title: 'Governance' },
  // .mdx: Mintlify's page scan skips files named contributing.md (repo-meta
  // convention); the MCP reference repo ships this page as .mdx for the same
  // reason. MDX forbids HTML comments, so the generated marker switches form.
  { src: 'CONTRIBUTING.md', out: 'community/contributing.mdx', title: 'Contributing',
    description: 'How to propose changes, what needs an AEP-numbered proposal, and the gates every PR must pass.' },
  { src: 'CODE_OF_CONDUCT.md', out: 'community/code-of-conduct.md', title: 'Code of Conduct' },
  { src: 'SECURITY.md', out: 'community/security.md', title: 'Security' },
  { src: 'VERSIONING.md', out: 'community/versioning.md', title: 'Versioning' },
  // .mdx for the same page-scan reason as contributing.mdx above.
  { src: 'CHANGELOG.md', out: 'updates.mdx', title: 'Updates',
    description: 'The protocol changelog: every notable change to the spec, schemas, fixtures, and documentation.' },
];

// ---- repo path → site/GitHub URL --------------------------------------------
// The one mapping rule for every internal link on the site. Exported for the
// docs tree's own tooling. `fromRepoPath` is the linking file's repo-relative
// path; `target` is the raw link target (may carry a #anchor).
const SPEC_SITE = new Map(SPEC_PAGES.map((p) => [p.src, '/' + p.out.replace(/\/index\.mdx?$/, '').replace(/\.mdx?$/, '')]));
const COMMUNITY_SITE = new Map(COMMUNITY_PAGES.map((p) => [p.src, '/' + p.out.replace(/\.mdx?$/, '')]));

function siteUrl(fromRepoPath, target) {
  if (/^(https?:|mailto:)/.test(target) || target.startsWith('#')) return target;
  let anchor = '';
  const hash = target.indexOf('#');
  if (hash >= 0) { anchor = target.slice(hash); target = target.slice(0, hash); }
  if (target === '') return anchor;
  const isDir = target.endsWith('/');
  // repo-relative path of the target, POSIX-normalized
  const rel = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromRepoPath), target)
  ).replace(/\/$/, '');

  if (SPEC_SITE.has(rel)) return SPEC_SITE.get(rel) + anchor;
  if (rel === 'spec') return '/specification/draft' + anchor;
  if (COMMUNITY_SITE.has(rel)) return COMMUNITY_SITE.get(rel) + anchor;
  if (rel === 'docs/README.md' || rel === 'docs/index.md') return '/' + (anchor || '');
  if (rel.startsWith('docs/') && rel.endsWith('.md'))
    return '/' + rel.slice('docs/'.length, -'.md'.length) + anchor;
  // no site page: point at the repository (files → blob, dirs → tree)
  return `${GH}/${isDir || !/\.[\w]+$/.test(rel) ? 'tree' : 'blob'}/main/${rel}` + anchor;
}

// ---- markdown helpers --------------------------------------------------------
const LINK_RE = /(\]\()([^)\s]+)(\))/g;

// Rewrite links and MDX-escape bare `{`, `}`, `<` — Mintlify parses every
// site page as MDX, where those characters open expressions/JSX in prose.
// Fenced blocks are untouched; inline code spans (which may cross line
// breaks) are honored by splitting on backtick pairs within each prose
// chunk. The canonical sources contain no autolinks (`<https://…>`), so the
// escape cannot break one.
function rewriteLinks(body, fromRepoPath) {
  const out = [];
  const buf = [];
  let inFence = false;
  const flush = () => {
    if (!buf.length) return;
    const chunk = buf.splice(0).join('\n');
    out.push(chunk.split(/(`[^`]*`)/g).map((seg, i) => (i % 2)
      // code span: joined onto one line — MDX's expression scanner trips on
      // spans that wrap across a line break
      ? seg.replace(/\n/g, ' ')
      : seg.replace(LINK_RE, (_, a, t, z) => a + siteUrl(fromRepoPath, t) + z)
           .replace(/[{}<]/g, (m) => '\\' + m)
    ).join(''));
  };
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) { flush(); inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    buf.push(line);
  }
  flush();
  return out.join('\n');
}

function firstSentence(body) {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (t === '' || /^[#>|]/.test(t) || /^[-*]\s/.test(t) || /^```/.test(t) || /^\|/.test(t) || /^\[/.test(t)) continue;
    const plain = t.replace(/\s+/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*\s][^*]*)\*/g, '$1').replace(/__([^_]+)__/g, '$1');
    const m = /^.*?[.!?](?=\s|$)/.exec(plain);
    return (m ? m[0] : plain).slice(0, 300);
  }
  return '';
}

function yamlQuote(s) { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

function render({ src, out, title, sidebarTitle, description: descOverride, kind }) {
  const raw = fs.readFileSync(path.join(REPO, src), 'utf8');
  const h1 = /^#\s+(.*)$/m.exec(raw);
  const body = raw.replace(/^#\s+.*$\n?/m, '');
  const pageTitle = title || (h1 ? h1[1].replace(/`/g, '') : path.basename(src, '.md'));
  const description = descOverride || firstSentence(body);
  const provenance = kind === 'spec'
    ? `<Note>\n\n**Draft**: the AEP suite is pre-\`v0.1\`; each document's status lives in its header table. This page is rendered from the canonical [\`${src}\`](${GH}/blob/main/${src}), which is the normative text.\n\n</Note>`
    : `<Note>\n\nThis page is rendered from the canonical [\`${src}\`](${GH}/blob/main/${src}) at the repository root, which is the source of truth.\n\n</Note>`;
  // MDX comment form even in .md pages: Mintlify parses every site page as
  // MDX, and HTML comments are a parse error there.
  const marker = `GENERATED by docs/render-site.js from ${src}; do not edit. Edit the source and re-run \`node docs/render-site.js\``;
  return [
    '---',
    `title: ${yamlQuote(pageTitle)}`,
    ...(sidebarTitle ? [`sidebarTitle: ${yamlQuote(sidebarTitle)}`] : []),
    `description: ${yamlQuote(description)}`,
    '---',
    '',
    `{/* ${marker} */}`,
    '',
    provenance,
    '',
    rewriteLinks(body, src).trimStart(),
  ].join('\n');
}

// ---- main ---------------------------------------------------------------------
if (require.main === module) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const page of [
    ...SPEC_PAGES.map((p) => ({ ...p, kind: 'spec' })),
    ...COMMUNITY_PAGES.map((p) => ({ ...p, kind: 'community' })),
  ]) {
    const rendered = render(page);
    const dest = path.join(DOCS, page.out);
    if (check) {
      const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
      if (current !== rendered) { stale++; console.error(`  ✗ stale generated page: docs/${page.out} (re-run node docs/render-site.js)`); }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, rendered);
    }
  }
  if (check) {
    if (stale) { console.error(`${stale} generated page(s) out of date`); process.exit(1); }
    console.log(`generated pages current (${SPEC_PAGES.length + COMMUNITY_PAGES.length})`);
  } else {
    console.log(`rendered ${SPEC_PAGES.length + COMMUNITY_PAGES.length} pages (specification/draft + community)`);
  }
}

module.exports = { siteUrl, rewriteLinks, SPEC_PAGES, COMMUNITY_PAGES };
