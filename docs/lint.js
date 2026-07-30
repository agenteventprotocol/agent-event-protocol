#!/usr/bin/env node
// Docs linter for docs/check-docs.sh. Offline, no deps. Walks a tree of .md
// files and runs four checks; prints every failure and exits non-zero if any.
//
//   1. mermaid: each ```mermaid block has a recognized diagram header, a
//      non-empty body, balanced () [] {} and paired quotes, and (for the type)
//      at least one plausible directive. This is a STRUCTURAL check — it does
//      not render (no browser here); it catches the mistakes that actually
//      break rendering (bad header, unbalanced brackets, empty block).
//   2. links: every internal markdown link target resolves. Site pages link
//      root-relative (Mintlify style: "/concepts/what-and-why" resolves
//      against this docs root, extensionless, with "/index.md" fallback for
//      directory URLs); plain relative targets still resolve on disk. If the
//      target is a page and the link has a #anchor, the anchor exists as a
//      GitHub-style slug of some heading in that file.
//   3. terms: banned synonyms from STYLE.md's vocabulary table, in prose only
//      (skips code fences, inline code, mermaid, and links).
//   4. counts: every count-bearing phrase ("ten adapters", "five inbound
//      channels", "the sixteenth fixture table") agrees with the declared
//      running counts below — the one source of truth.

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
let errors = 0;
const err = (file, msg) => { errors++; console.error(`  ✗ ${path.relative(root, file)}: ${msg}`); };

// ---- collect .md files ------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    // skip _-prefixed files (templates/partials): they carry placeholder links
    else if (name.endsWith('.md') && !name.startsWith('_')) out.push(p);
  }
  return out;
}
const files = walk(root).sort();

// ---- heading slug index (for anchor checks) ---------------------------------
function slug(text) {
  return text.trim().toLowerCase()
    .replace(/[^\w\s-]/g, '')   // GitHub drops punctuation
    .replace(/\s/g, '-');       // each space → one dash (GitHub does NOT collapse:
                                // "a — b" slugs to "a--b" once the dash drops)
}
const slugsByFile = new Map();
for (const f of files) {
  const set = new Set();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) set.add(slug(m[1]));
  }
  slugsByFile.set(f, set);
}

// ---- 1. mermaid structural check --------------------------------------------
const MERMAID_TYPES = [
  { re: /^graph\s+(TB|TD|BT|RL|LR)\b/, name: 'graph' },
  { re: /^flowchart\s+(TB|TD|BT|RL|LR)\b/, name: 'flowchart' },
  { re: /^sequenceDiagram\b/, name: 'sequenceDiagram' },
  { re: /^stateDiagram-v2\b/, name: 'stateDiagram-v2' },
  { re: /^erDiagram\b/, name: 'erDiagram' },
  { re: /^classDiagram\b/, name: 'classDiagram' },
];

function checkMermaid(file, block, startLine) {
  // strip %% comment lines and blank lines
  const lines = block.split('\n')
    .map((l) => l.replace(/%%.*$/, '').trimEnd());
  const body = lines.filter((l) => l.trim() !== '');
  if (body.length === 0) { err(file, `mermaid block at line ${startLine} is empty`); return; }

  const header = body[0].trim();
  const type = MERMAID_TYPES.find((t) => t.re.test(header));
  if (!type) {
    err(file, `mermaid block at line ${startLine}: unrecognized diagram header "${header}" (STYLE.md lists the allowed types)`);
    return;
  }
  if (body.length < 2) {
    err(file, `mermaid ${type.name} at line ${startLine} has a header but no content`);
  }

  // balanced brackets and paired quotes across the whole block
  const joined = body.join('\n');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    const o = (joined.match(new RegExp('\\' + open, 'g')) || []).length;
    const c = (joined.match(new RegExp('\\' + close, 'g')) || []).length;
    if (o !== c) err(file, `mermaid ${type.name} at line ${startLine}: unbalanced ${open}${close} (${o} vs ${c})`);
  }
  const quotes = (joined.match(/"/g) || []).length;
  if (quotes % 2 !== 0) err(file, `mermaid ${type.name} at line ${startLine}: odd number of double-quotes`);

  // `;` separates statements in the sequence grammar, so one inside a message
  // silently truncates it and the block fails to render at all.
  if (type.name === 'sequenceDiagram') {
    body.forEach((line, i) => {
      const msg = line.match(/^\s*\w+\s*--?>>?\s*\w+\s*:(.*)$/);
      if (msg && msg[1].includes(';'))
        err(file, `mermaid sequenceDiagram at line ${startLine + i + 1}: ";" in a message truncates it (use a comma)`);
    });
  }

  // light per-type sanity: the diagram should have at least one edge/transition/relation
  if (type.name === 'sequenceDiagram' && !/(->>|-->>|->|-->|participant)/.test(joined))
    err(file, `mermaid sequenceDiagram at line ${startLine}: no participants or messages`);
  if (type.name === 'stateDiagram-v2' && !/-->/.test(joined))
    err(file, `mermaid stateDiagram-v2 at line ${startLine}: no transitions (-->)`);
  if ((type.name === 'graph' || type.name === 'flowchart') && !/(--?>|---|===?>?)/.test(joined))
    err(file, `mermaid ${type.name} at line ${startLine}: no edges`);
}

// ---- 2 & 3. per-file link + term checks -------------------------------------
const BANNED = [
  // [regex, message] — prose-only banned synonyms (STYLE.md vocabulary table)
  [/\bbroker\b/i, 'use "relay" not "broker"'],
  [/\bsubscriber\b/i, 'use "consumer" not "subscriber"'],
  [/\bbackfill\b/i, 'use "replay" / "(epoch, seq) resume" not "backfill"'],
  [/\bprivacy level\b/i, 'use "capture level" not "privacy level"'],
];
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

// ---- 4. running-count declarations -------------------------------------------
// ONE source of truth for the ecosystem's running counts: when the ecosystem
// grows, bump the value here and this check flags every prose site still
// carrying the old number. The conventions are part of the declaration:
//   adapters        — agent-runtime adapters shipped in the reference stack
//   inboundChannels — inbound capture sidecars (OTLP, OpenCode SSE, Kilo
//                     SSE, AG-UI, ACP, OpenHands)
//   outboundBridges — CloudEvents + OTLP out
//   bridgeSidecars  — outboundBridges + inboundChannels
//   adoptedMappings — Annex A source-vocabulary mappings; Codex (hooks + OTel
//                     channel), OpenCode (plugin + SSE channel), and the
//                     VS Code agent (hooks + OTel channel) each count ONCE;
//                     includes the docs-only OpenClaw Gateway and A2A
//   fixtureTables   — source-channel mapping tables pinned under
//                     conformance/fixtures/mappings/ — TABLES, not files (one
//                     file may pin several channels' tables); prose ordinals
//                     ("the sixteenth fixture table") must never EXCEED this
//   mandatoryTypes / categories — AEP-0002 §4.1 / §3
// Scope: this docs tree plus ../README.md and
// ../spec/README.md. Spec normative text is out of scope by design: it only
// changes through the change-control process, which reviews its own numbers.
// The scanners deliberately force precision: a subset claim that happens to
// match a pattern ("three adapters do X") gets reworded, not exempted.
const COUNTS = {
  adapters: 12,
  inboundChannels: 6,
  outboundBridges: 2,
  bridgeSidecars: 8,
  adoptedMappings: 17,
  fixtureTables: 19,
  mandatoryTypes: 14,
  categories: 13,
};
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const ORDINAL_WORDS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
};
const NUM = `(\\d+|${Object.keys(NUM_WORDS).join('|')})`;
const ORD = `(${Object.keys(ORDINAL_WORDS).join('|')})`;
const numOf = (s) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s.toLowerCase()]);
// [regex, key, key…] — every captured number must EQUAL its declared count
const COUNT_CHECKS = [
  [new RegExp(`\\b${NUM}\\s+(?:agent\\s+)?adapters\\b`, 'gi'), 'adapters'],
  [new RegExp(`adapters\\s*\\(${NUM}\\s+agent\\s+runtimes\\)`, 'gi'), 'adapters'],
  [new RegExp(`\\b${NUM}\\s+inbound(?:\\s+capture)?\\s+(?:channels?|sidecars?)\\b`, 'gi'), 'inboundChannels'],
  [new RegExp(`\\b${NUM}\\s+bridge\\s+sidecars?\\b`, 'gi'), 'bridgeSidecars'],
  [new RegExp(`\\(${NUM}\\s+outbound,\\s*${NUM}\\s+inbound\\)`, 'gi'), 'outboundBridges', 'inboundChannels'],
  [new RegExp(`\\b${NUM}\\s+(?:source-vocabulary\\s+)?mappings\\b`, 'gi'), 'adoptedMappings'],
  [new RegExp(`\\b${NUM}\\s+fixture\\s+tables\\b`, 'gi'), 'fixtureTables'],
  [new RegExp(`\\bthe\\s+${NUM}\\s+mandatory\\s+(?:event\\s+)?types\\b`, 'gi'), 'mandatoryTypes'],
  [new RegExp(`\\b${NUM}\\s+categories,\\s*${NUM}\\s+mandatory\\s+types\\b`, 'gi'), 'categories', 'mandatoryTypes'],
];
const ORDINAL_CHECKS = [
  [new RegExp(`\\b${ORD}\\s+fixture\\s+table\\b`, 'gi'), 'fixtureTables'],
];

function checkCounts(file, prose) {
  for (const { n, text } of prose) {
    // keep link TEXT (counts live there); drop inline code and link targets
    const cleaned = text.replace(/`[^`]*`/g, '').replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');
    for (const [re, ...keys] of COUNT_CHECKS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        keys.forEach((key, i) => {
          const got = numOf(m[i + 1]);
          if (got !== COUNTS[key]) {
            err(file, `line ${n}: "${m[0]}" — ${key} is ${COUNTS[key]} (update the text, or bump COUNTS in docs/lint.js if the ecosystem grew)`);
          }
        });
      }
    }
    for (const [re, key] of ORDINAL_CHECKS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const got = ORDINAL_WORDS[m[1].toLowerCase()];
        if (got > COUNTS[key]) {
          err(file, `line ${n}: "${m[0]}" exceeds the declared ${key} total (${COUNTS[key]})`);
        }
      }
    }
  }
}

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  // strip fenced blocks; also extract mermaid blocks for check 1
  const lines = raw.split('\n');
  let inFence = false, fenceLang = '', buf = [], bufStart = 0;
  const prose = [];
  lines.forEach((line, i) => {
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      if (!inFence) { inFence = true; fenceLang = fence[1]; buf = []; bufStart = i + 2; }
      else {
        if (fenceLang === 'mermaid') checkMermaid(file, buf.join('\n'), bufStart);
        inFence = false; fenceLang = '';
      }
      return;
    }
    if (inFence) { buf.push(line); return; }
    prose.push({ n: i + 1, text: line });
  });
  if (inFence) err(file, `unclosed \`\`\` fence`);

  // links (over the whole file — links don't live in fences here)
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(raw)) !== null) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) {
      // in-page anchor: check it resolves in this file
      if (target.startsWith('#')) {
        const a = target.slice(1);
        if (!slugsByFile.get(file).has(a))
          err(file, `in-page anchor "${target}" has no matching heading`);
      }
      continue;
    }
    let anchor = '';
    const hash = target.indexOf('#');
    if (hash >= 0) { anchor = target.slice(hash + 1); target = target.slice(0, hash); }
    if (target === '') continue;
    let resolved;
    if (target.startsWith('/')) {
      // site URL: resolve against the docs root, extensionless page paths
      const page = target === '/' ? 'index' : target.replace(/^\/+/, '').replace(/\/+$/, '');
      resolved = [`${page}.md`, `${page}.mdx`, `${page}/index.md`, page]
        .map((c) => path.resolve(root, c))
        .find((c) => fs.existsSync(c));
      if (!resolved) { err(file, `broken site link → ${m[1]}`); continue; }
    } else {
      resolved = path.resolve(dir, target);
      if (!fs.existsSync(resolved)) { err(file, `broken link → ${m[1]}`); continue; }
    }
    if (anchor && resolved.endsWith('.md') && slugsByFile.has(resolved)) {
      if (!slugsByFile.get(resolved).has(anchor))
        err(file, `link anchor not found → ${m[1]}`);
    }
  }

  // generated pages are exempt from the prose checks: the mirrors
  // (specification/, community/) because their canonical sources — spec/*.md
  // and the root governance files — own their own wording and numbers
  // (render-site.js --check pins them byte-for-byte), and the two agents
  // matrices because gen-agents.js derives them from the fixture corpus +
  // docs/data/agents.json (its --check pins them the same way). Mermaid +
  // links stay checked for all of them.
  const relFromRoot = path.relative(root, file);
  const isGenerated = /^(specification|community)[\\/]/.test(relFromRoot)
    || /^agents[\\/](feature-matrix|control-matrix)\.md$/.test(relFromRoot);

  // running counts
  if (!isGenerated) checkCounts(file, prose);

  // banned terms in prose (strip inline code + link syntax first).
  // STYLE.md is exempt: it *defines* the banned list, so it must name the words.
  if (path.basename(file) === 'STYLE.md' || isGenerated) continue;
  for (const { n, text } of prose) {
    const cleaned = text.replace(/`[^`]*`/g, '').replace(LINK_RE, '');
    for (const [re, msg] of BANNED) {
      if (re.test(cleaned)) err(file, `line ${n}: ${msg}`);
    }
  }
}

// the count check also covers the repo front door and the spec index — the
// two highest-traffic count-bearing pages outside this tree
for (const extra of [path.resolve(root, '..', 'README.md'), path.resolve(root, '..', 'spec', 'README.md')]) {
  if (!fs.existsSync(extra)) continue;
  let inFence = false;
  const prose = [];
  fs.readFileSync(extra, 'utf8').split('\n').forEach((line, i) => {
    if (/^```/.test(line)) { inFence = !inFence; return; }
    if (!inFence) prose.push({ n: i + 1, text: line });
  });
  checkCounts(extra, prose);
}

console.log(`checked ${files.length} docs`);
if (errors) { console.error(`\n${errors} problem(s) found`); process.exit(1); }
console.log('mermaid + links + terms + counts OK');
