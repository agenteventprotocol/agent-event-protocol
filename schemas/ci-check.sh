#!/usr/bin/env bash
# Schema/codegen CI gate: the generated types must be exactly what the registry
# produces, and every schema must be a valid 2020-12 schema. The SDK packages
# live in their own repositories and verify the same generated output there via
# their own sync check; this gate covers the in-repo gen/ tree.
set -euo pipefail
cd "$(dirname "$0")"

python3 - <<'EOF'
import json, glob, jsonschema
files = sorted(glob.glob('types/*.schema.json')) + ['aep-event.schema.json']
for p in files:
    with open(p) as f:
        jsonschema.Draft202012Validator.check_schema(json.load(f))
print(f"metaschema OK ({len(files)} schemas)")
# registry <-> files consistency, both directions: every registry row's
# schema file exists, and every schema file is claimed by a registry row
# (an orphan schema would silently escape the single-source-of-truth rule).
reg = json.load(open('registry/types.json'))
claimed = set()
for t in reg['types']:
    if t['schema']:
        assert glob.glob(f"types/{t['schema']}"), f"missing schema file for {t['type']}"
        claimed.update(glob.glob(f"types/{t['schema']}"))
orphans = sorted(set(glob.glob('types/*.schema.json')) - claimed)
assert not orphans, f"schema files with no registry row: {orphans}"
print("registry OK (both directions)")
EOF

python3 codegen/generate.py

if ! git diff --exit-code -- gen/; then
  echo "ERROR: generated types are stale — commit the regenerated gen/ output" >&2
  exit 1
fi
echo "codegen diff gate OK"
