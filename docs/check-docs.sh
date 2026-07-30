#!/usr/bin/env bash
# Docs QA gate — runs over the whole docs/ tree (the Mintlify site root).
# Six checks, all offline, zero external deps (Node only, matching the repo
# toolchain):
#   1. every fenced ```mermaid block is structurally valid (lint.js)
#   2. every internal link resolves — root-relative site links against the
#      docs root, plain relative links on disk (+ #anchor if a page)
#   3. spec-term consistency: flag banned synonyms STYLE.md forbids
#   4. running-count consistency: count-bearing phrases ("ten adapters",
#      "five inbound channels") must match the declared counts in lint.js —
#      the one source of truth; also covers ../README.md and ../spec/README.md
#   5. generated site pages (specification/draft + community) match their
#      canonical sources — spec/*.md and the root files (render-site.js)
#   6. the generated agents matrices match the fixture corpus + the reviewed
#      capability record — mappings/*.json + docs/data/agents.json
#      (gen-agents.js)
# The site link gate (npx mint broken-links) runs as a separate CI step: it
# needs the network, so it complements — never replaces — this offline floor.
# Not wired into ci.sh automatically — see the note at the bottom.
set -euo pipefail
cd "$(dirname "$0")"

fail=0
node ./lint.js . || fail=1
node ./render-site.js --check || fail=1
node ./gen-agents.js --check || fail=1

if [ "$fail" -ne 0 ]; then
  echo "DOCS: FAIL"
  exit 1
fi
echo "DOCS: OK"
