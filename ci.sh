#!/usr/bin/env bash
# Full verification for the AEP standard repo: schema/codegen diff gate, the
# spec-derived conformance runner, and a strict typecheck of the generated
# TypeScript. Exit 0 = the standard is internally consistent.
#
# The reference stack and the SDKs live in their own repositories and run their
# own CI (the five-beat demo, adapter smokes, SDK typechecks/smokes, and the
# Node conformance runner that exercises the reference implementation). This
# script covers what the standard itself owns.
set -euo pipefail
cd "$(dirname "$0")"

echo "== schemas: metaschema + registry + codegen diff gate =="
bash schemas/ci-check.sh

echo "== conformance: spec-derived runner (independent implementation) =="
report_dir="$(mktemp -d)"
python3 conformance/run.py --json "$report_dir/conformance-report.json"

echo "== conformance: machine-readable report shape (--json) =="
python3 - "$report_dir/conformance-report.json" <<'EOF'
import json
import sys
from datetime import datetime

r = json.load(open(sys.argv[1]))
assert r["format"] == "aep-conformance-report", r["format"]
assert r["formatVersion"] == 1, r["formatVersion"]
assert r["aep"] == "0.1", r["aep"]
assert r["tool"] == "run-py", r["tool"]
assert r["target"] is None, r["target"]
for k in ("startedAt", "finishedAt"):
    datetime.fromisoformat(r[k].replace("Z", "+00:00"))
statuses = [c["status"] for c in r["checks"]]
assert all("name" in c and c["status"] in ("pass", "fail") for c in r["checks"])
s = r["summary"]
assert s["total"] == len(r["checks"]) == s["pass"] + s["fail"] + s["skip"], s
assert s["pass"] == statuses.count("pass") and s["fail"] == statuses.count("fail"), s
assert s["skip"] == 0, s
assert r["ok"] == (s["fail"] == 0) and r["ok"] is True, r["ok"]
print(f"report OK: {s['pass']} pass / {s['fail']} fail / {s['total']} total")
EOF
rm -rf "$report_dir"

echo "== conformance: live-checker selftest (compliant stub green, broken stub caught) =="
node conformance/live-selftest.js

echo "== generated TS strict typecheck =="
npx --yes -p typescript@6.0.3 tsc --noEmit --strict schemas/gen/ts/aep-types.ts

echo "ALL GREEN"
