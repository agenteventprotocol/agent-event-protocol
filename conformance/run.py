#!/usr/bin/env python3
"""AEP 0.1 conformance runner (Python).

Independent second implementation: everything here is written from the spec text
(AEP-0001/0003/0005), NOT from impl/shared/*.js. Both implementations must agree
on the same fixtures; disagreement means the spec text is ambiguous — file it.

Checks: envelope schema (golden pass / invalid fail) · payload schemas · seq
monotonicity · unknown-type consumer tolerance · attr-match corpus · CE bridge
(forward vs pins, inverse, round-trip identity) · OTLP projection vs pins ·
kind:"form" values rules + capture-gating corpus (AEP-0006) · downlevel corpus
(AEP-0001 §8.2 incl. the §8.2(e) redacted-provenance boundary) · redaction
corpus (AEP-0003 §9.4) · lifecycle/ordering/dedupe stream invariants · Annex-A
mapping pins (spec side: schema validity + wire facts; run.js pins the
adapter impl).

Usage: python3 run.py [--pin] [--json <path|->]
    --pin regenerates the ce-expected/otlp-expected pins
    --json writes the machine-readable conformance report; `-` puts the report
    on stdout and moves the human lines to stderr
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import jsonschema

HERE = Path(__file__).parent
SCHEMAS = HERE.parent / "schemas"
FIX = HERE / "fixtures"

# ---- args (--json <path|->: machine-readable report; `-` puts the report on
# stdout and moves the human lines to stderr) --------------------------------
JSON_OUT: str | None = None
if "--json" in sys.argv:
    i = sys.argv.index("--json")
    if i + 1 >= len(sys.argv):
        print("usage: python3 run.py [--pin] [--json <path|->]", file=sys.stderr)
        sys.exit(2)
    JSON_OUT = sys.argv[i + 1]
JSON_STDOUT = JSON_OUT == "-"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


STARTED_AT = utc_now()

failures: list[str] = []
results: list[dict] = []


def human(line: str) -> None:
    print(line, file=sys.stderr if JSON_STDOUT else sys.stdout)


def check(name: str, ok: bool, detail: str = "") -> None:
    human(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))
    results.append({"name": name, "ok": ok, "detail": detail})
    if not ok:
        failures.append(name)


# ---- kind:"form" rules (AEP-0002 §5.3 / AEP-0006), independent implementation ----
CAP_ORDER = ["none", "metadata", "redacted", "full"]


def form_values_error(fields, values):
    """The MUST-reject rule: values covers every required field_spec; a select
    answer is a choices[].id unless the field carries other:true."""
    if not isinstance(values, dict):
        return "answer.values must be an object"
    for f in fields or []:
        if f.get("required") and f["id"] not in values:
            return f"missing required field: {f['id']}"
        if f["id"] not in values or f.get("type") != "select":
            continue
        ids = {c["id"] for c in f.get("choices", [])}
        v = values[f["id"]]
        for e in v if isinstance(v, list) else [v]:
            if e in ids or (isinstance(e, str) and f.get("other")):
                continue
            return f"not a choices[].id for select field {f['id']}"
    return None


def gate_form_values(fields, values, ceiling):
    """Type-dependent gating: number/boolean/closed-select survive at metadata;
    string fields and `other` free text need redacted+. Unknown keys drop."""
    content_ok = CAP_ORDER.index(ceiling) >= CAP_ORDER.index("redacted")
    by_id = {f["id"]: f for f in fields or []}
    out = {}
    for k, v in (values or {}).items():
        f = by_id.get(k)
        if not f:
            continue
        if f["type"] in ("number", "boolean"):
            out[k] = v
        elif f["type"] == "select":
            ids = {c["id"] for c in f.get("choices", [])}
            if all(e in ids for e in (v if isinstance(v, list) else [v])):
                out[k] = v  # closed choice: structural
            elif content_ok:
                out[k] = v  # `other` free text
        elif content_ok:
            out[k] = v  # string field: free text
    return out


# ---- ordering (AEP-0001 §7.2), independent impl -----------------------------------
def ordering_error(events):
    """Position uniqueness per (source, session, epoch): seq strictly increases
    within an epoch; epoch never regresses (a new epoch is declared, never
    inferred). Session identity is emitter-scoped (AEP-0001 §5.2): distinct
    emitters carrying one session string are distinct sessions with
    independent counters."""
    last: dict = {}
    for ev in events:
        if "session" in ev and "seq" in ev:
            pos = (ev.get("epoch", 0), ev["seq"])
            key = (ev.get("source"), ev["session"])
            lp = last.get(key)
            if lp is not None:
                if pos[0] < lp[0]:
                    return f"epoch regression in {ev['session']}: {pos[0]} < {lp[0]}"
                if pos[0] == lp[0] and pos[1] <= lp[1]:
                    return f"seq not monotonic in {ev['session']}: {pos[1]} after {lp[1]}"
            last[key] = pos
    return None


# ---- dedupe scope (AEP-0001 §5.1 #2 / §7.4), independent impl --------------------
def id_collision_error(events):
    """id is unique per emitter: the same (source, id) naming two DIFFERENT
    Events is a collision; a byte-identical repeat is legal redelivery."""
    seen: dict = {}
    for ev in events:
        key = (ev.get("source"), ev.get("id"))
        if key in seen and seen[key] != ev:
            return f"(source, id) collision: {key[1]} names two different Events"
        seen[key] = ev
    return None


# ---- lifecycle invariants (AEP-0002 §2 convention 5 / §7.2), independent impl ----
RUN_TERMINALS = {"run.finished", "run.failed", "run.cancelled"}


def lifecycle_error(events):
    """Terminal exclusivity: at most one run terminal per (source, session,
    run) and at most one DISTINCT session.ended per (source, session) — a
    byte-identical repeat is legal redelivery. Close-before-end: a
    session.ended with a pending attention.requested (no attention.resolved/
    attention.timeout naming it via subject) fails. Lifecycle state is keyed
    by (source, session) — session identity is emitter-scoped (AEP-0001
    §5.2)."""
    terminals: set = set()
    pending: set = set()
    ended: dict = {}
    for ev in events:
        if ev.get("session") is None:
            continue
        s = (ev.get("source"), ev["session"])
        t = ev["type"]
        if t in RUN_TERMINALS and "run" in ev:
            key = (s, ev["run"])
            if key in terminals:
                return f"second terminal for run {ev['run']} in session {ev['session']}"
            terminals.add(key)
        elif t == "attention.requested":
            pending.add((s, ev["id"]))
        elif t in ("attention.resolved", "attention.timeout"):
            pending.discard((s, ev.get("subject")))
        elif t == "session.ended":
            dangling = sorted(i for (ss, i) in pending if ss == s)
            if dangling:
                return f"session {ev['session']} ended with pending attention {dangling[0]}"
            if s in ended and ended[s] != ev:
                return f"second session.ended for session {ev['session']}"
            ended[s] = ev
    return None


# ---- ack exclusivity (AEP-0004 §3), independent impl -----------------------------
ACK_TYPES = {"control.accepted", "control.rejected"}


def ack_exclusivity_error(events):
    """One ack decision per deduplicated command: two DIFFERENT ack Events
    answering one command are a violation; a byte-identical repeat is legal
    re-acknowledgement (redelivery). Acks pair to commands via cause; the
    checker keys (ack source, cause) — under a cross-emitter command-id
    collision inside one session view the pairing is ambiguous (the AEP-0001
    §7.4 accepted-in-0.1 bare-id residual) and the checker conservatively
    surfaces such streams."""
    seen: dict = {}
    for ev in events:
        if ev.get("type") not in ACK_TYPES or "cause" not in ev:
            continue
        key = (ev.get("source"), ev["cause"])
        if key in seen and seen[key] != ev:
            return f"second ack decision for command {ev['cause']}"
        seen[key] = ev
    return None


# ---------------------------------------------------------------- fixtures/schemas
ENVELOPE = json.loads((SCHEMAS / "aep-event.schema.json").read_text())
REGISTRY = json.loads((SCHEMAS / "registry" / "types.json").read_text())
SEVERITY = json.loads((SCHEMAS / "registry" / "severity.json").read_text())
ENV_VALIDATOR = jsonschema.Draft202012Validator(ENVELOPE)
PAYLOAD_VALIDATORS = {
    t["type"]: jsonschema.Draft202012Validator(
        json.loads((SCHEMAS / "types" / t["schema"]).read_text()))
    for t in REGISTRY["types"] if t["schema"]
}
GOLDEN = [json.loads(l) for l in (FIX / "golden" / "golden.jsonl").read_text().splitlines() if l.strip()]

# ---------------------------------------------------------------- 1. envelope
for i, ev in enumerate(GOLDEN):
    errs = list(ENV_VALIDATOR.iter_errors(ev))
    check(f"golden[{i}] {ev['type']} envelope-valid", not errs,
          "; ".join(e.message for e in errs[:2]))

for case in json.loads((FIX / "invalid" / "cases.json").read_text())["cases"]:
    # a case is one event or a stream ("events"); reject on any envelope error,
    # payload-schema error, or kind:"form" cross-event values violation
    bad = False
    pending_fields: dict[str, list] = {}
    for ev in case.get("events") or [case["event"]]:
        if list(ENV_VALIDATOR.iter_errors(ev)):
            bad = True
            break
        v = PAYLOAD_VALIDATORS.get(ev["type"])
        d = ev.get("data", {})
        if v and "data" in ev and list(v.iter_errors(d)):
            bad = True
            break
        if ev["type"] == "attention.requested" and d.get("kind") == "form":
            pending_fields[ev["id"]] = d.get("fields", [])
        if ev["type"] == "attention.answered" and ev.get("subject") in pending_fields:
            vals = (d.get("answer") or {}).get("values")
            if vals is not None and form_values_error(pending_fields[ev["subject"]], vals):
                bad = True
                break
    stream = case.get("events") or [case["event"]]
    if not bad and (lifecycle_error(stream) or id_collision_error(stream)
                    or ordering_error(stream) or ack_exclusivity_error(stream)):
        bad = True
    check(f"invalid rejected: {case['name']}", bad, f"violates {case['rule']} but validated")

# consumer tolerance: unknown member in a known category is envelope-legal
tolerant = {"aep": "0.1", "id": "TOL1", "type": "progress.some_future_member",
            "time": "2026-07-03T10:00:00Z", "source": "aep://h/agent/a",
            "agent": "a", "session": "s1", "seq": 0, "futureext": "x"}
check("unknown-type tolerance (envelope accepts unregistered member + unknown ext attr)",
      not list(ENV_VALIDATOR.iter_errors(tolerant)))

# ---------------------------------------------------------------- 2. payloads
for i, ev in enumerate(GOLDEN):
    v = PAYLOAD_VALIDATORS.get(ev["type"])
    if v and "data" in ev:
        errs = list(v.iter_errors(ev["data"]))
        check(f"golden[{i}] {ev['type']} payload-valid", not errs,
              "; ".join(e.message for e in errs[:2]))

# ---------------------------------------------------------------- 2b. kind:"form" round-trip in golden
GOLDEN_FORMS = {ev["id"]: ev["data"]["fields"] for ev in GOLDEN
                if ev["type"] == "attention.requested" and ev.get("data", {}).get("kind") == "form"}
check("golden carries a kind=form round-trip", bool(GOLDEN_FORMS))
for ev in GOLDEN:
    if ev["type"] != "attention.answered" or ev.get("subject") not in GOLDEN_FORMS:
        continue
    fields = GOLDEN_FORMS[ev["subject"]]
    values = ev["data"]["answer"].get("values", {})
    check("golden form answer satisfies the values rules", form_values_error(fields, values) is None,
          str(form_values_error(fields, values)))
    kept = gate_form_values(fields, values, ev.get("capture", "metadata"))
    declared = {k for k in values if any(f["id"] == k for f in fields)}
    check("golden form answer capture-honest (free text only at redacted+)",
          declared == set(kept), f"gated out: {declared - set(kept)}")

# ---------------------------------------------------------------- 3. seq monotonicity
check("golden seq strictly monotonic per (source, session, epoch)", ordering_error(GOLDEN) is None,
      str(ordering_error(GOLDEN)))
_epoch_sess = {(e.get("epoch", 0)) for e in GOLDEN if e.get("session") == "s_epoch"}
check("golden carries an epoch bump with seq reset (restart discipline, AEP-0001 §7.2)",
      _epoch_sess == {0, 1})

# ---------------------------------------------------------------- 3b. lifecycle invariants
check("golden honors lifecycle invariants (one terminal per run; attention closed before session.ended)",
      lifecycle_error(GOLDEN) is None, str(lifecycle_error(GOLDEN)))

# ---------------------------------------------------------------- 3c. dedupe scope
check("golden has no (source,id) collision", id_collision_error(GOLDEN) is None,
      str(id_collision_error(GOLDEN)))
_dups = [e for e in GOLDEN if e["id"] == "01JX9YBXDUPID000000000GOLD"]
check("golden carries the cross-source same-id pair (dedupe scope is (source,id), never bare id)",
      len(_dups) == 2 and _dups[0]["source"] != _dups[1]["source"])
_shared = [e for e in GOLDEN if e.get("session") == "s_shared"]
check("golden carries the cross-source same-session pair (session identity is emitter-scoped, AEP-0001 §5.2)",
      len(_shared) == 2 and _shared[0]["source"] != _shared[1]["source"]
      and _shared[0]["seq"] == _shared[1]["seq"] == 0)

# ---------------------------------------------------------------- 3d. ack exclusivity
check("golden has one ack decision per command (AEP-0004 §3)",
      ack_exclusivity_error(GOLDEN) is None, str(ack_exclusivity_error(GOLDEN)))
_cmds = [e for e in GOLDEN if e["type"].startswith("control.")
         and e["type"] not in ACK_TYPES]
_acked = {e["cause"] for e in GOLDEN if e["type"] in ACK_TYPES and "cause" in e}
check("golden acks every command it carries", bool(_cmds)
      and all(c["id"] in _acked for c in _cmds))

# ---------------------------------------------------------------- 4. attr-match (independent impl)
SEV_ORDER = SEVERITY["order"]
FILTERABLE = {"id", "type", "subject", "source", "agent", "session", "run", "step",
              "epoch", "cause", "severity", "capture"}
CORE = FILTERABLE | {"time", "seq", "aep", "data", "traceparent"}


def filter_error(f):
    if not isinstance(f, dict):
        return "not an object"
    for key, pred in f.items():
        if key in {"time", "seq", "aep", "data"}:
            return f"not filterable: {key}"
        is_ext = re.fullmatch(r"[a-z0-9]{1,20}", key) and key not in CORE
        if key not in FILTERABLE and not is_ext:
            return f"unknown key: {key}"
        if key == "severity" and isinstance(pred, dict):
            if set(pred) - {"gte", "lte"} or any(v not in SEV_ORDER for v in pred.values()):
                return "bad severity comparison"
            continue
        alts = pred if isinstance(pred, list) else [pred]
        if not alts:
            return "empty inclusion"
        for v in alts:
            if not isinstance(v, (str, int, bool)):
                return "non-scalar"
            if isinstance(v, str) and "*" in v:
                if key != "type" or not re.fullmatch(r"([a-z0-9_-]+\.)+\*", v):
                    return f"bad pattern: {v}"
    return None


def attr_match(f, ev):
    for key, pred in f.items():
        val = ev.get(key)
        if key == "severity" and val is None:
            val = "info"
        if key == "capture" and val is None:
            val = "metadata"
        if key == "epoch" and val is None:
            val = 0
        if key == "severity" and isinstance(pred, dict):
            r = SEV_ORDER.index(val)
            if "gte" in pred and r < SEV_ORDER.index(pred["gte"]):
                return False
            if "lte" in pred and r > SEV_ORDER.index(pred["lte"]):
                return False
            continue
        if val is None:
            return False
        alts = pred if isinstance(pred, list) else [pred]
        hit = False
        for alt in alts:
            if key == "type" and isinstance(alt, str) and alt.endswith(".*"):
                if str(val).startswith(alt[:-1]):
                    hit = True
                    break
            elif val == alt:
                hit = True
                break
        if not hit:
            return False
    return True


AM = json.loads((FIX / "attr-match" / "cases.json").read_text())
for case in AM["match"]:
    err = filter_error(case["filter"])
    ok = err is None and attr_match(case["filter"], case["event"]) == case["match"]
    check(f"attr-match: {case['name']}", ok, err or "wrong verdict")
for case in AM["invalid"]:
    check(f"attr-match rejects: {case['name']}", filter_error(case["filter"]) is not None)

# ---------------------------------------------------------------- 5. CE bridge (independent impl, AEP-0005)
ROOT = "dev.aep."
ATTR_TABLE = [("aep", "aepversion"), ("agent", "aepagentid"), ("session", "aepsessionid"),
              ("run", "aeprunid"), ("step", "aepstep"), ("seq", "aepsequence"),
              ("epoch", "aepepoch"), ("cause", "aepcausationid"),
              ("severity", "aepseverity"), ("capture", "aepcapture")]


def to_ce(ev):
    ce = {"specversion": "1.0", "id": ev["id"], "source": ev["source"],
          "type": ROOT + ev["type"]}
    if "subject" in ev:
        ce["subject"] = ev["subject"]
    ce["time"] = ev["time"]
    if "data" in ev:
        ce["datacontenttype"] = "application/json"
    for a, c in ATTR_TABLE:
        if a in ev:
            ce[c] = ev[a]
    if "traceparent" in ev:
        ce["traceparent"] = ev["traceparent"]
    for k, v in ev.items():
        if k not in {a for a, _ in ATTR_TABLE} | {"id", "source", "type", "subject",
                                                  "time", "traceparent", "data"}:
            ce[k] = v
    if "data" in ev:
        ce["data"] = ev["data"]
    return ce


def from_ce(ce):
    if not str(ce.get("type", "")).startswith(ROOT):
        return None
    inv = {c: a for a, c in ATTR_TABLE}
    ev = {"aep": ce.get("aepversion", "0.1"), "id": ce["id"],
          "type": ce["type"][len(ROOT):]}
    if "subject" in ce:
        ev["subject"] = ce["subject"]
    ev["time"] = ce["time"]
    ev["source"] = ce["source"]
    for k, v in ce.items():
        if k in {"specversion", "datacontenttype", "id", "source", "type", "subject",
                 "time", "data", "traceparent"}:
            continue
        if k in inv:
            if inv[k] != "aep":
                ev[inv[k]] = v
        elif re.fullmatch(r"[a-z0-9]{1,20}", k):
            ev[k] = v
    if "traceparent" in ce:
        ev["traceparent"] = ce["traceparent"]
    if "data" in ce:
        ev["data"] = ce["data"]
    return ev


ce_pin_path = FIX / "ce-roundtrip" / "ce-expected.jsonl"
if "--pin" in sys.argv:
    ce_pin_path.parent.mkdir(parents=True, exist_ok=True)
    ce_pin_path.write_text("".join(json.dumps(to_ce(e), separators=(",", ":")) + "\n" for e in GOLDEN))
    print(f"pinned {ce_pin_path}")
CE_PINS = [json.loads(l) for l in ce_pin_path.read_text().splitlines() if l.strip()]
check("CE pins cover golden corpus", len(CE_PINS) == len(GOLDEN))
for i, (ev, pin) in enumerate(zip(GOLDEN, CE_PINS)):
    fwd = to_ce(ev)
    check(f"CE forward[{i}] matches pin ({ev['type']})", fwd == pin)
    check(f"CE round-trip identity[{i}]", from_ce(fwd) == ev)
foreign = {"specversion": "1.0", "id": "F1", "source": "s", "type": "com.example.thing",
           "time": "2026-07-03T10:00:00Z"}
check("foreign CE event out of bridge scope", from_ce(foreign) is None)

# Inbound preserve-path (AEP-0005 §2 rule 2): hand-authored inbound CE objects
# fed to the inverse directly — the golden-derived pins above only exercise
# round-trips of attributes the golden corpus already carries. Exact-match plus
# envelope-schema validity of each expected (this runner is the independent,
# schema-authoritative side).
for case in json.loads((FIX / "ce-roundtrip" / "inbound-cases.json").read_text())["cases"]:
    got = from_ce(case["ce"])
    check(f"CE inbound: {case['name']}", got == case["expected"],
          f"{case['rule']}: got {json.dumps(got)[:160]}")
    errs = list(ENV_VALIDATOR.iter_errors(case["expected"]))
    check(f"CE inbound expected validates: {case['name']}", not errs,
          "; ".join(e.message for e in errs[:2]))

# ---------------------------------------------------------------- 6. OTLP projection (independent impl, AEP-0005 §3)
def to_otlp(ev, max_capture="metadata"):
    order = ["none", "metadata", "redacted", "full"]
    sev = ev.get("severity", "info")
    # exact integer nanos: float timestamp() arithmetic writes rounding
    # artifacts into the pins for sub-second fractions that are inexact in
    # binary (e.g. .310), and the two runners then disagree per fraction
    delta = datetime.fromisoformat(ev["time"].replace("Z", "+00:00")) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    rec = {
        "time_unix_nano": (delta.days * 86400 + delta.seconds) * 10**9 + delta.microseconds * 1000,
        "event_name": ROOT + ev["type"],
        "severity_text": SEVERITY["otlp"][sev]["severity_text"],
        "severity_number": SEVERITY["otlp"][sev]["severity_number"],
        "resource": {"service.name": ev["agent"]},
        "attributes": {"aep.agent_id": ev["agent"], "aep.event_id": ev["id"],
                       "aep.capture": ev.get("capture", "metadata"),
                       "aep.source": ev["source"]},
    }
    if "traceparent" in ev:
        _, tid, sid, flg = ev["traceparent"].split("-")
        rec["trace_id"], rec["span_id"], rec["flags"] = tid, sid, int(flg, 16)
    for k, attr in [("session", "aep.session_id"), ("run", "aep.run_id"),
                    ("step", "aep.step"), ("seq", "aep.sequence"),
                    ("epoch", "aep.epoch"), ("cause", "aep.causation_id"),
                    ("subject", "aep.subject")]:
        if k in ev:
            rec["attributes"][attr] = ev[k]
    data = ev.get("data", {})
    if order.index(ev.get("capture", "metadata")) > order.index(max_capture):
        data = {}  # conservative down-level without annotations (exporter uses them)
    body = {}
    for k, v in data.items():
        if k.startswith("gen_ai."):
            rec["attributes"][k] = v  # mirror-rule hoisting
        else:
            body[k] = v
    if body:
        rec["body"] = body
    return rec


otlp_pin_path = FIX / "otlp" / "otlp-expected.json"
OTLP_CASES = [3, 13, 15, 24]  # worked example (traceparent + gen_ai hoisting) · warning severity · error severity at capture redacted (body down-leveled) · agent-scoped
if "--pin" in sys.argv:
    otlp_pin_path.parent.mkdir(parents=True, exist_ok=True)
    otlp_pin_path.write_text(json.dumps(
        {str(i): to_otlp(GOLDEN[i]) for i in OTLP_CASES}, indent=2) + "\n")
    print(f"pinned {otlp_pin_path}")
OTLP_PINS = json.loads(otlp_pin_path.read_text())
for i in OTLP_CASES:
    check(f"OTLP projection[{i}] matches pin ({GOLDEN[i]['type']})",
          to_otlp(GOLDEN[i]) == OTLP_PINS[str(i)])
check("OTLP severity table complete",
      all(l in SEVERITY["otlp"] for l in SEV_ORDER))

# ---------------------------------------------------------------- 6b. OCSF projection (independent impl, AEP-0005 §4)
# (class_uid, category_uid, activity_id, fixed status/disposition) per AEP-0005
# §4.2/§4.5; families outside the table deliberately project to no record.
OCSF_MAP = {
    "session.started":     (3002, 3, 1, {"status_id": 1}),
    "session.ended":       (3002, 3, 2, {"status_id": 1}),
    "tool.requested":      (1007, 1, 1, {}),
    "tool.completed":      (1007, 1, 2, {"status_id": 1}),
    "tool.failed":         (1007, 1, 2, {"status_id": 2}),
    "tool.denied":         (1007, 1, 1, {"status_id": 2, "disposition_id": 2}),
    "attention.requested": (2004, 2, 1, {"status_id": 1}),
    "attention.answered":  (2004, 2, 2, {"status_id": 2}),
    "attention.resolved":  (2004, 2, 3, {"status_id": 4}),
    "attention.timeout":   (2004, 2, 3, {"disposition_id": 16}),
}


def to_ocsf(ev, max_capture="metadata"):
    m = OCSF_MAP.get(ev["type"])
    if m is None:
        return None
    class_uid, category_uid, activity_id, fixed = m
    order = ["none", "metadata", "redacted", "full"]
    data = ev.get("data", {})
    if order.index(ev.get("capture", "metadata")) > order.index(max_capture):
        data = {}  # §3.3 rule shared by §4.7: down-level before projection
    delta = datetime.fromisoformat(ev["time"].replace("Z", "+00:00")) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    rec = {
        "class_uid": class_uid, "category_uid": category_uid,
        "activity_id": activity_id,
        "type_uid": class_uid * 100 + activity_id,
        "time": (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000,
        "severity_id": SEVERITY["ocsf"][ev.get("severity", "info")],
        "message": ev["type"],
        "metadata": {"version": OCSF_CLASSES["version"], "uid": ev["id"],
                     "original_time": ev["time"],
                     "product": {"name": ev["agent"]}},
        "unmapped": {"aep": {k: v for k, v in ev.items() if k != "data"}},
    }
    rec.update(fixed)
    if "cause" in ev:
        rec["metadata"]["correlation_uid"] = ev["cause"]
    if class_uid == 3002:
        rec["user"] = {"name": ev["agent"]}
        rec["session"] = {"uid": ev["session"]}
    elif class_uid == 1007:
        rec["actor"] = {"app_name": ev["agent"]}
        host = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]+)", ev["source"])
        rec["device"] = ({"type_id": 0, "hostname": host.group(1)} if host
                         else {"type_id": 0, "name": ev["source"]})
        proc = {"name": ev["subject"]}
        call_id = data.get("tool", {}).get("call_id")
        if call_id:
            proc["uid"] = call_id
        rec["process"] = proc
    else:  # 2004 — finding_info.uid = the attention-request id (AEP-0002 §5 correlation)
        rec["finding_info"] = {
            "uid": ev["id"] if ev["type"] == "attention.requested" else ev["subject"],
            "title": ev["type"]}
        if ev["type"] == "attention.resolved" and data.get("resolution") == "dismissed":
            rec["disposition_id"] = 16
    if "disposition_id" in rec:  # dispositions ride the security_control profile
        rec["metadata"]["profiles"] = ["security_control"]
    if data:
        rec["unmapped"]["data"] = data
    return rec


ocsf_pin_path = FIX / "ocsf" / "ocsf-expected.json"
OCSF_CLASSES = json.loads((FIX / "ocsf" / "ocsf-classes.json").read_text())
OCSF_CASES = [0, 3, 4, 9, 13, 15, 19, 23]  # Logon · Terminate/success · Create at redacted (envelope-only) · the honesty pin (answered → NO disposition) · Blocked · Terminate/failure at redacted (payload down-leveled) · terminal timeout · Logoff
if "--pin" in sys.argv:
    ocsf_pin_path.write_text(json.dumps(
        {str(i): to_ocsf(GOLDEN[i]) for i in OCSF_CASES}, indent=2) + "\n")
    print(f"pinned {ocsf_pin_path}")
OCSF_PINS = json.loads(ocsf_pin_path.read_text())
for i in OCSF_CASES:
    if str(i) not in OCSF_PINS:
        continue  # --pin fills the set; the hand-authored seed case drives RED
    rec = to_ocsf(GOLDEN[i])
    check(f"OCSF projection[{i}] matches pin ({GOLDEN[i]['type']})",
          rec == OCSF_PINS[str(i)])
    cls = OCSF_CLASSES["classes"][str(rec["class_uid"])]
    unknown = [k for k in rec if k not in cls["attributes"]]
    check(f"OCSF projection[{i}] uses only class attributes", not unknown, str(unknown))
    check(f"OCSF projection[{i}] ids are enum-legal and type_uid is derived",
          rec["category_uid"] == cls["category_uid"]
          and str(rec["activity_id"]) in cls["activity"]
          and str(rec["severity_id"]) in cls["severity"]
          and rec["type_uid"] == rec["class_uid"] * 100 + rec["activity_id"]
          and ("status_id" not in rec or str(rec["status_id"]) in cls["status"])
          and ("disposition_id" not in rec or str(rec["disposition_id"]) in cls["disposition"]))
check("OCSF severity table complete",
      all(l in SEVERITY["ocsf"] for l in SEV_ORDER))
check("OCSF honesty rule: answered resolution carries no disposition",
      "disposition_id" not in to_ocsf(GOLDEN[9]))
check("OCSF unmapped families produce no record",
      to_ocsf(GOLDEN[25]) is None and to_ocsf(GOLDEN[5]) is None)

# ---------------------------------------------------------------- 7. capture-gating corpus (AEP-0006)
CG = json.loads((FIX / "capture-gating" / "cases.json").read_text())
for case in CG["cases"]:
    out = gate_form_values(case["fields"], case["values"], case["ceiling"])
    check(f"capture-gating: {case['name']}", out == case["expect"], json.dumps(out)[:160])

# ---------------------------------------------------------------- 7b. downlevel corpus (AEP-0001 §8.2 at a fan-out hop)
# Independent implementation from the spec text: prune fields above the new
# level via the x-aep-capture annotations (AEP-0002 §5.1 r3), degrade the
# §5.3 [metadata*] exception fields structurally below `redacted` (a hop has
# no source context to synthesize or classify), and honor §8.2(e): `redacted`
# is a provenance claim a mechanical hop can never mint — a redacted ceiling
# on a full event lands on `metadata`.


def load_capture_annotations(types_dir):
    """{type: {dottedFieldPath: minLevel}} — nested props as a.b, array items as a[].b."""
    out = {}
    for f in sorted(types_dir.glob("*.schema.json")):
        sch = json.loads(f.read_text())
        ann = {}

        def walk(node, base):
            for prop, psch in (node.get("properties") or {}).items():
                p = f"{base}.{prop}" if base else prop
                ann[p] = psch.get("x-aep-capture", "metadata")
                walk(psch, p)
                if psch.get("items"):
                    walk(psch["items"], p + "[]")

        walk(sch, "")
        out[f.name[: -len(".schema.json")]] = ann
    return out


def _degrade_exceptions(ev, data, rank):
    """AEP-0002 §5.3 [metadata*] fields below `redacted`: prompt -> the §9.2
    synthesis shape, labels -> structural ids, answer.values -> number/boolean
    entries only (a string may be free text; an array's ids can't be verified
    without the request's field_spec — dropping more is always legal, §8.2b)."""
    if rank >= CAP_ORDER.index("redacted"):
        return data
    if ev["type"] == "attention.requested":
        out = dict(data)
        if isinstance(out.get("prompt"), str):
            subj = f": {ev['subject']}" if ev.get("subject") else ""
            out["prompt"] = f"{ev['agent']} requests {out.get('kind', 'attention')}{subj}"
        if isinstance(out.get("options"), list):
            out["options"] = [{**o, "label": str(o["id"])} for o in out["options"]]
        if isinstance(out.get("fields"), list):
            out["fields"] = [
                {**f, "label": str(f["id"]),
                 **({"choices": [{**c, "label": str(c["id"])} for c in f["choices"]]}
                    if isinstance(f.get("choices"), list) else {})}
                for f in out["fields"]
            ]
        return out
    if (ev["type"] in ("attention.answered", "control.attention.respond")
            and isinstance(data.get("answer"), dict)
            and isinstance(data["answer"].get("values"), dict)):
        values = {k: v for k, v in data["answer"]["values"].items()
                  if isinstance(v, bool) or (isinstance(v, (int, float)) and not isinstance(v, bool))}
        return {**data, "answer": {**data["answer"], "values": values}}
    return data


def downlevel(ev, ceiling, annotations):
    ev_cap = ev.get("capture", "metadata")
    if CAP_ORDER.index(ceiling) >= CAP_ORDER.index(ev_cap):
        return ev
    # §8.2(e): a mechanical hop never rewrites full -> redacted
    target = "metadata" if ceiling == "redacted" and ev_cap == "full" else ceiling
    out = {**ev, "capture": target}
    if target == "none" or "data" not in ev:
        out.pop("data", None)
        return out
    ann = annotations.get(ev["type"])
    if not ann:
        out.pop("data", None)
        return out
    rank = CAP_ORDER.index(target)

    def prune(val, path):
        if isinstance(val, list):
            return [prune(x, path + "[]") for x in val]
        if not isinstance(val, dict):
            return val
        return {k: prune(v, f"{path}.{k}") for k, v in val.items()
                if CAP_ORDER.index(ann.get(f"{path}.{k}", "metadata")) <= rank}

    keep = {k: prune(v, k) for k, v in ev["data"].items()
            if CAP_ORDER.index(ann.get(k, "metadata")) <= rank}
    out["data"] = _degrade_exceptions(ev, keep, rank)
    return out


ANNOTATIONS = load_capture_annotations(SCHEMAS / "types")
DL = json.loads((FIX / "downlevel" / "cases.json").read_text())
for case in DL["cases"]:
    out = downlevel(case["event"], case["ceiling"], ANNOTATIONS)
    data_ok = ("data" not in out) if case["expect_data"] is None else out.get("data") == case["expect_data"]
    check(f"downlevel: {case['name']}",
          out["capture"] == case["expect_capture"] and data_ok,
          json.dumps({"capture": out.get("capture"), "data": out.get("data")})[:200])

# ---------------------------------------------------------------- 7c. redaction corpus (AEP-0003 §9.4)
# Independent implementation of the pipeline — (a) secrets/credentials,
# (b) operator-configured values, (c) home paths, (d) PII, in order. The
# corpus also pins hardening beyond the normative floor (§9.4 allows
# redacting more): quoted credential assignments, lowercase bearer,
# well-known bare token shapes, any-user home paths, credential-named keys.

SECRET_RES = [
    re.compile(r"-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*", re.IGNORECASE),
    re.compile(r"\b(password|passwd|secret|api[_-]?key|token|authorization)\b[\"']?\s*[=:]\s*[\"']?\S+",
               re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b"),
]
PII_RES = [
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"(?<![\d\w])\+?\d[\d\s().-]{6,}\d(?![\d\w])"),
]
HOME_RES = [
    re.compile(r"(?:/home|/Users)/[^/\s\"']+"),
    re.compile(r"[A-Za-z]:\\Users\\[^\\\s\"']+"),
]
SECRET_KEY_RE = re.compile(
    r"^(password|passwd|secret|api[_-]?key|token|authorization|credentials?|private[_-]?key|access[_-]?key)$",
    re.IGNORECASE)


def redact_text(text, opts):
    if not isinstance(text, str) or not text:
        return text
    out = text
    for r in SECRET_RES:
        out = r.sub("[REDACTED:secret]", out)
    for v in opts.get("secretValues") or []:
        if v and len(v) >= 4:
            out = out.replace(v, "[REDACTED:secret]")
    home = opts.get("home")
    if home and home != "/":
        out = out.replace(home, "~")
    for r in HOME_RES:
        out = r.sub("~", out)
    if opts.get("pii") is not False:
        for r in PII_RES:
            out = r.sub("[REDACTED:pii]", out)
    return out


def redact_value(v, opts):
    if isinstance(v, str):
        return redact_text(v, opts)
    if isinstance(v, list):
        return [redact_value(x, opts) for x in v]
    if isinstance(v, dict):
        return {k: ("[REDACTED:secret]" if SECRET_KEY_RE.match(k) and x is not None
                    else redact_value(x, opts))
                for k, x in v.items()}
    return v


RED = json.loads((FIX / "redaction" / "cases.json").read_text())


def red_ok(out, case):
    return (all(s not in out for s in case.get("must_not_contain", []))
            and all(s in out for s in case.get("must_contain", [])))


for case in RED["text_cases"]:
    out = redact_text(case["input"], {"home": "/nonexistent-home", **(case.get("opts") or {})})
    check(f"redact text: {case['name']}", red_ok(out, case), json.dumps(out)[:120])
for case in RED["value_cases"]:
    out = json.dumps(redact_value(case["input"], {"home": "/nonexistent-home", **(case.get("opts") or {})}))
    check(f"redact value: {case['name']}", red_ok(out, case), out[:120])

# ---------------------------------------------------------------- 8. Annex-A mapping pins (spec side)
# run.js pins the adapter's mapping module against expected_data; this runner has
# no adapter implementation, so it checks what the spec can: each pinned payload
# is schema-valid and shows the wire facts AEP-0006 requires of the mapping
# (kind form, one field per question, select+other:true always — AskUserQuestion
# always offers "Other" — multi mirroring multiSelect, label exception at metadata).
MAPS = json.loads((FIX / "mappings" / "claude-code.json").read_text())
AUQ = MAPS["ask_user_question"]
QS = AUQ["input"]["questions"]
for key in ("expected_data", "expected_data_metadata"):
    data = AUQ[key]
    errs = list(PAYLOAD_VALIDATORS["attention.requested"].iter_errors(data))
    check(f"mapping pin schema-valid ({key})", not errs, "; ".join(e.message for e in errs[:2]))
    facts = (data.get("kind") == "form" and len(data.get("fields", [])) == len(QS)
             and all(f.get("type") == "select" and f.get("other") is True and f.get("required") is True
                     for f in data["fields"])
             and all((f.get("multi") is True) == (q.get("multiSelect") is True)
                     for f, q in zip(data["fields"], QS))
             and all(len(f.get("choices", [])) == len(q.get("options", []))
                     for f, q in zip(data["fields"], QS)))
    check(f"mapping pin wire facts ({key})", facts)
content_labels = [f["label"] for f in AUQ["expected_data"]["fields"]]
placeholder_labels = [f["label"] for f in AUQ["expected_data_metadata"]["fields"]]
check("mapping pins show the [metadata*] label exception (content at redacted, placeholders at metadata)",
      all(q["question"] in l for q, l in zip(QS, content_labels))
      and placeholder_labels == [f["id"] for f in AUQ["expected_data_metadata"]["fields"]])

# --------------------------- Annex-A mapping pins: MCP elicitation -> form
# run.js pins the adapter's pure mapping module; this runner checks what the
# spec can: pinned payloads are schema-valid and show the wire facts the
# elicitation mapping must guarantee — field ids are the schema property
# keys, the four MCP primitive shapes land on the four field_spec types,
# enum fields are CLOSED selects (no other:true escape), required mirrors
# the requested schema, and labels degrade to the structural key/value at
# metadata per the [metadata*] exception.
ELI = MAPS["elicitation"]
ELI_PROPS = ELI["input"]["requestedSchema"]["properties"]
ELI_REQ = set(ELI["input"]["requestedSchema"].get("required", []))
for key in ("expected_data", "expected_data_metadata"):
    data = ELI[key]
    errs = list(PAYLOAD_VALIDATORS["attention.requested"].iter_errors(data))
    check(f"elicitation pin schema-valid ({key})", not errs, "; ".join(e.message for e in errs[:2]))
    fields = {f["id"]: f for f in data.get("fields", [])}
    def shape(prop):
        if "enum" in prop:
            return "select"
        return {"number": "number", "integer": "number", "boolean": "boolean"}.get(prop.get("type"), "string")
    facts = (data.get("kind") == "form" and set(fields) == set(ELI_PROPS)
             and all(fields[k]["type"] == shape(p) for k, p in ELI_PROPS.items())
             and all(fields[k].get("required") is (k in ELI_REQ) for k in ELI_PROPS)
             and all(f.get("other") is not True for f in fields.values())
             and all(len(fields[k].get("choices", [])) == len(p["enum"])
                     for k, p in ELI_PROPS.items() if "enum" in p))
    check(f"elicitation pin wire facts ({key})", facts)
check("elicitation pins show the [metadata*] label exception",
      all(str(p.get("title")) == f["label"]
          for (k, p), f in zip(ELI_PROPS.items(), ELI["expected_data"]["fields"]) if p.get("title"))
      and all(f["label"] == f["id"] for f in ELI["expected_data_metadata"]["fields"]))

# ------------------------------------- Annex-A mapping pins: the Codex table
# run.js pins the Codex adapter's pure mapping module (map-hooks.js) against
# these expectations; this runner — no adapter implementation — checks what
# the spec can: pinned payloads are schema-valid where a payload schema
# exists, and the Annex A wire facts hold (10 hooks -> 10 core types, the
# PostCompact-only compaction deviation, the permission-kind attention
# request over control, the vendor-extension fallback for unknown hooks).
CODEX = json.loads((FIX / "mappings" / "codex.json").read_text())
CODEX_HOOKS = CODEX["hooks"]
for name, entry in CODEX_HOOKS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"codex pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("codex pins: every mapped hook lands on a core type (10 -> 10)",
      all(not e["expected"]["type"].startswith("x.")
          for e in CODEX_HOOKS.values() if e["expected"]))
check("codex pins: compaction emitted once, at PostCompact (documented deviation)",
      CODEX_HOOKS["PreCompact"]["expected"] is None
      and CODEX_HOOKS["PostCompact"]["expected"]["type"] == "session.compacted")
CODEX_PR = CODEX_HOOKS["PermissionRequest"]["expected"]["data"]
check("codex pins: PermissionRequest is a permission-kind attention request over control",
      CODEX_PR["kind"] == "permission" and CODEX_PR["respond_via"] == ["control"]
      and [o["id"] for o in CODEX_PR["options"]] == ["allow", "deny"])
check("codex pins: unknown hooks fall back to the vendor extension namespace",
      re.fullmatch(r"x\.codex\.session\.[a-z][a-z0-9_]*",
                   CODEX["fallback"]["expected"]["type"]) is not None)
check("codex pins: identity facts (thread -> session, turn -> run)",
      CODEX["identity"]["session_from"] == "session_id"
      and CODEX["identity"]["run_from"] == "turn_id")

GEMINI = json.loads((FIX / "mappings" / "gemini-cli.json").read_text())
GEMINI_HOOKS = GEMINI["hooks"]
for name, entry in GEMINI_HOOKS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"gemini pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
GEMINI_CORE = {"SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent",
               "BeforeTool", "AfterTool", "AfterTool-error", "PreCompress", "Notification"}
check("gemini pins: lifecycle/tool/compaction/notification hooks land on core types",
      all(not GEMINI_HOOKS[n]["expected"]["type"].startswith("x.") for n in GEMINI_CORE))
check("gemini pins: the model plane stays in the vendor namespace by design",
      all(GEMINI_HOOKS[n]["expected"]["type"].startswith("x.gemini-cli.session.")
          for n in ("BeforeModel", "AfterModel", "BeforeToolSelection")))
check("gemini pins: tool errors map to tool.failed honestly (tool_response.error)",
      GEMINI_HOOKS["AfterTool-error"]["expected"]["type"] == "tool.failed"
      and GEMINI_HOOKS["AfterTool"]["expected"]["type"] == "tool.completed")
check("gemini pins: compaction emitted at the vendor's only exposed (pre) moment",
      GEMINI_HOOKS["PreCompress"]["expected"]["type"] == "session.compacted"
      and GEMINI_HOOKS["PreCompress"]["expected"]["data"].get("trigger") == "auto")
check("gemini pins: Notification is observability-only — progress.status, never attention.*",
      GEMINI_HOOKS["Notification"]["expected"]["type"] == "progress.status"
      and not any(e["expected"]["type"].startswith("attention.")
                  for e in GEMINI_HOOKS.values() if e["expected"]))
check("gemini pins: unknown hooks fall back to the vendor extension namespace",
      re.fullmatch(r"x\.gemini-cli\.session\.[a-z][a-z0-9_]*",
                   GEMINI["fallback"]["expected"]["type"]) is not None)
check("gemini pins: identity facts (session_id -> session; runs are adapter-synthesized)",
      GEMINI["identity"]["session_from"] == "session_id"
      and GEMINI["identity"]["run_from"] is None)

QWEN = json.loads((FIX / "mappings" / "qwen-code.json").read_text())
QWEN_HOOKS = QWEN["hooks"]
for name, entry in QWEN_HOOKS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"qwen pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("qwen pins: every mapped hook lands on a core type",
      all(not e["expected"]["type"].startswith("x.")
          for e in QWEN_HOOKS.values() if e["expected"]))
check("qwen pins: PermissionRequest is a permission-kind attention request over control",
      QWEN_HOOKS["PermissionRequest"]["expected"]["data"]["kind"] == "permission"
      and QWEN_HOOKS["PermissionRequest"]["expected"]["data"]["respond_via"] == ["control"])
check("qwen pins: the permission_prompt notification is suppressed (first-class hook covers it)",
      QWEN_HOOKS["Notification_permission"]["expected"] is None
      and QWEN_HOOKS["Notification_other"]["expected"]["type"] == "progress.status")
check("qwen pins: compaction once, at the post moment (PreCompact deliberately silent)",
      QWEN_HOOKS["PreCompact"]["expected"] is None
      and QWEN_HOOKS["PostCompact"]["expected"]["type"] == "session.compacted")
check("qwen pins: the todo validation phase is suppressed (the persisted postWrite fact is the event)",
      QWEN_HOOKS["TodoCreated_validation"]["expected"] is None
      and QWEN_HOOKS["TodoCompleted_validation"]["expected"] is None
      and QWEN_HOOKS["TodoCreated_validation"]["input"]["phase"] == "validation"
      and QWEN_HOOKS["TodoCreated"]["input"]["phase"] == "postWrite"
      and QWEN_HOOKS["TodoCreated"]["expected"]["type"] == "progress.task.planned")
check("qwen pins: StopFailure carries the vendor error taxonomy as run.failed.reason",
      QWEN_HOOKS["StopFailure"]["expected"]["data"]["reason"] == "rate_limit")
check("qwen pins: unknown hooks fall back to the vendor extension namespace",
      re.fullmatch(r"x\.qwen-code\.session\.[a-z][a-z0-9_]*",
                   QWEN["fallback"]["expected"]["type"]) is not None)
check("qwen pins: identity (session_id -> session; runs synthesized; tool_use_id pairs)",
      QWEN["identity"]["session_from"] == "session_id" and QWEN["identity"]["run_from"] is None)

VSCODE = json.loads((FIX / "mappings" / "vscode.json").read_text())
VSCODE_HOOKS = VSCODE["hooks"]
for name, entry in VSCODE_HOOKS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"vscode pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("vscode pins: every mapped hook lands on a core type",
      all(not e["expected"]["type"].startswith("x.")
          for e in VSCODE_HOOKS.values() if e["expected"]))
check("vscode pins: compaction at the PRE moment (no post moment exists — the documented deviation)",
      VSCODE_HOOKS["PreCompact"]["expected"]["type"] == "session.compacted"
      and "PostCompact" not in VSCODE_HOOKS)
check("vscode pins: success-only tool surface — tool.failed/run.failed/session.ended have no vendor moment",
      all(e["expected"]["type"] not in ("tool.failed", "run.failed", "session.ended")
          for e in VSCODE_HOOKS.values() if e["expected"])
      and VSCODE_HOOKS["PostToolUse"]["expected"]["type"] == "tool.completed")
check("vscode pins: the 8-event VSCode-target set is covered exactly",
      sorted(VSCODE_HOOKS.keys()) == sorted([
          "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
          "PreCompact", "SubagentStart", "SubagentStop", "Stop"]))
check("vscode pins: unknown hooks fall back to the vendor extension namespace",
      re.fullmatch(r"x\.vscode\.session\.[a-z][a-z0-9_]*",
                   VSCODE["fallback"]["expected"]["type"]) is not None)
check("vscode pins: identity (optional session_id -> session; runs synthesized; tool_use_id pairs)",
      VSCODE["identity"]["session_from"] == "session_id" and VSCODE["identity"]["run_from"] is None)

KIMI = json.loads((FIX / "mappings" / "kimi-code.json").read_text())
KIMI_HOOKS = KIMI["hooks"]
for name, entry in KIMI_HOOKS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"kimi-code pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("kimi-code pins: the 16-event enum is covered exactly (multi-decision results as variants)",
      sorted({e["input"]["hook_event_name"] for e in KIMI_HOOKS.values()}) == sorted([
          "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure",
          "Interrupt", "PreToolUse", "PostToolUse", "PostToolUseFailure",
          "PermissionRequest", "PermissionResult", "SubagentStart", "SubagentStop",
          "PreCompact", "PostCompact", "Notification"]))
check("kimi-code pins: the failure twin exists (PostToolUseFailure -> tool.failed; StopFailure -> run.failed with the required reason)",
      KIMI_HOOKS["PostToolUseFailure"]["expected"]["type"] == "tool.failed"
      and KIMI_HOOKS["StopFailure"]["expected"]["type"] == "run.failed"
      and "reason" in KIMI_HOOKS["StopFailure"]["expected"]["data"])
check("kimi-code pins: the Interrupt hook is the vendor-named cancellation (run.cancelled by user)",
      KIMI_HOOKS["Interrupt"]["expected"]["type"] == "run.cancelled"
      and KIMI_HOOKS["Interrupt"]["expected"]["data"]["by"] == "user")
check("kimi-code pins: the permission pair is observe-only oob — no options claimed, answers ride oob",
      KIMI_HOOKS["PermissionRequest"]["expected"]["data"]["respond_via"] == ["oob"]
      and "options" not in KIMI_HOOKS["PermissionRequest"]["expected"]["data"]
      and KIMI_HOOKS["PermissionResult_approved"]["expected"]["data"]["via"] == "oob")
check("kimi-code pins: a cancelled result dismisses with no answered moment; an error result degrades to the fallback",
      KIMI_HOOKS["PermissionResult_cancelled"]["expected"]["type"] == "attention.resolved"
      and KIMI_HOOKS["PermissionResult_cancelled"]["expected"]["data"]["resolution"] == "dismissed"
      and KIMI_HOOKS["PermissionResult_error"]["expected"]["type"].startswith("x.kimi-code."))
check("kimi-code pins: compaction once, at the post moment (PreCompact degrades — both moments exist)",
      KIMI_HOOKS["PostCompact"]["expected"]["type"] == "session.compacted"
      and KIMI_HOOKS["PreCompact"]["expected"]["type"].startswith("x.kimi-code."))
check("kimi-code pins: a steer submission never opens a run",
      KIMI_HOOKS["UserPromptSubmit_steer"]["expected"]["type"].startswith("x.kimi-code.")
      and KIMI_HOOKS["UserPromptSubmit"]["expected"]["type"] == "run.started")
check("kimi-code pins: Notification is an observability heartbeat, never an attention loop",
      KIMI_HOOKS["Notification"]["expected"]["type"] == "progress.status")
check("kimi-code pins: unknown hooks fall back to the vendor extension namespace",
      re.fullmatch(r"x\.kimi-code\.session\.[a-z][a-z0-9_]*",
                   KIMI["fallback"]["expected"]["type"]) is not None)
check("kimi-code pins: identity (session_id -> session, optional; runs synthesized; tool_call_id pairs)",
      KIMI["identity"]["session_from"] == "session_id" and KIMI["identity"]["run_from"] is None)

# The Kimi web channel (kap-server WS stream): the two-mode discipline on the
# family's first WS channel. Inputs are self-contained wire envelopes
# (oracle-captured lifecycle/approval shapes; the question loop is
# source-derived and labeled so in the block comment).
KIMI_WS_MODES = KIMI["ws_modes"]["modes"]
for name, entry in KIMI_WS_MODES.items():
    exp = entry["primary"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"kimi-web primary pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("kimi-web pins: volatile frames and the internal bus echoes never emit in either mode",
      KIMI_WS_MODES["volatile_status"]["companion"] is None
      and KIMI_WS_MODES["volatile_status"]["primary"] is None
      and KIMI_WS_MODES["bus_echo_permission"]["companion"] is None
      and KIMI_WS_MODES["bus_echo_permission"]["primary"] is None)
check("kimi-web companion pins: every emitted moment is x.kimi-code.web.* (the dedup rule; the hook adapter is the core authority)",
      all(e["companion"] is None or e["companion"]["type"].startswith("x.kimi-code.web.")
          for e in KIMI_WS_MODES.values())
      and any(e["companion"] is not None for e in KIMI_WS_MODES.values()))
check("kimi-web primary pins: the read-only channel advertises no answer path on any ask",
      KIMI_WS_MODES["approval_requested"]["primary"]["type"] == "attention.requested"
      and "options" not in KIMI_WS_MODES["approval_requested"]["primary"]["data"]
      and "respond_via" not in KIMI_WS_MODES["approval_requested"]["primary"]["data"]
      and "options" not in KIMI_WS_MODES["question_requested"]["primary"]["data"]
      and "respond_via" not in KIMI_WS_MODES["question_requested"]["primary"]["data"])
check("kimi-web primary pins: the vendor's REAL turn boundaries carry the run pair (no synthesis, no fabricated session lifecycle)",
      KIMI_WS_MODES["turn_started"]["primary"]["type"] == "run.started"
      and KIMI_WS_MODES["turn_ended_completed"]["primary"]["type"] == "run.finished"
      and KIMI_WS_MODES["turn_ended_cancelled"]["primary"]["type"] == "run.cancelled"
      and not any((e["primary"] or {}).get("type", "").startswith("session.")
                  for e in KIMI_WS_MODES.values()))
check("kimi-web primary pins: the tool result stays receiver-paired (the wire names no tool; the pure pin is null)",
      KIMI_WS_MODES["tool_call_started"]["primary"]["type"] == "tool.requested"
      and KIMI_WS_MODES["tool_result"]["primary"] is None)
check("kimi-web primary pins: a decision-less approval resolve dismisses; a decision answers via oob",
      KIMI_WS_MODES["approval_resolved_dismissed"]["primary"]["type"] == "attention.resolved"
      and KIMI_WS_MODES["approval_resolved_dismissed"]["primary"]["data"]["resolution"] == "dismissed"
      and KIMI_WS_MODES["approval_resolved_rejected"]["primary"]["data"]["via"] == "oob")

OPENCODE = json.loads((FIX / "mappings" / "opencode.json").read_text())
OC_MOMENTS = OPENCODE["moments"]
for name, entry in OC_MOMENTS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"opencode pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("opencode pins: lifecycle/tool/permission moments land on core types",
      all(not OC_MOMENTS[n]["expected"]["type"].startswith("x.")
          for n in ("session_created", "session_deleted", "session_idle", "session_compacted",
                    "message_user", "tool_before", "tool_after", "permission_ask", "permission_replied")))
check("opencode pins: the machinery plane stays in the vendor namespace by design",
      all(OC_MOMENTS[n]["expected"]["type"].startswith("x.opencode.")
          for n in ("session_error", "message_assistant", "file_edited", "command_executed", "server_connected")))
check("opencode pins: the hold-open ask is a permission-kind attention request over control",
      OC_MOMENTS["permission_ask"]["expected"]["data"]["kind"] == "permission"
      and OC_MOMENTS["permission_ask"]["expected"]["data"]["respond_via"] == ["control"])
check("opencode pins: bus permission.updated and todo.updated are deliberately silent",
      OC_MOMENTS["permission_updated"]["expected"] is None
      and OC_MOMENTS["todo_updated"]["expected"] is None)
check("opencode pins: todo snapshots diff into planned/completed transitions only",
      {e["type"] for e in OPENCODE["todos"]["expected"]}
      == {"progress.task.planned", "progress.task.completed"})
check("opencode pins: no tool.failed on this surface (typed hooks expose no error), errors ride session-scoped",
      all(e["expected"] is None or e["expected"]["type"] != "tool.failed" for e in OC_MOMENTS.values())
      and OC_MOMENTS["session_error"]["expected"]["type"] == "x.opencode.session.error")
check("opencode pins: a child session names its parent (the delegation shape)",
      OC_MOMENTS["session_created_child"]["expected"]["data"]["parent"]["session"]
      == OC_MOMENTS["session_created"]["input"]["event"]["properties"]["info"]["id"])
check("opencode pins: unknown bus types fall back mechanically to x.opencode.*",
      re.fullmatch(r"x\.opencode\.[a-z0-9_.]+", OPENCODE["fallback"]["expected"]["type"]) is not None)
check("opencode pins: identity (bus sessionID rides; runs synthesized on idle boundaries)",
      OPENCODE["identity"]["run_from"] is None)

KILOCODE = json.loads((FIX / "mappings" / "kilocode.json").read_text())
KC_MOMENTS = KILOCODE["moments"]
for name, entry in KC_MOMENTS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"kilocode pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("kilocode pins: lifecycle/tool/permission moments land on core types",
      all(not KC_MOMENTS[n]["expected"]["type"].startswith("x.")
          for n in ("session_created", "session_deleted", "session_idle", "session_compacted",
                    "message_user", "tool_before", "tool_after", "permission_ask", "permission_replied")))
check("kilocode pins: the machinery plane stays in the vendor namespace by design",
      all(KC_MOMENTS[n]["expected"]["type"].startswith("x.kilocode.")
          for n in ("session_error", "message_assistant", "file_edited", "command_executed", "server_connected")))
check("kilocode pins: the hold-open ask is a permission-kind attention request over control",
      KC_MOMENTS["permission_ask"]["expected"]["data"]["kind"] == "permission"
      and KC_MOMENTS["permission_ask"]["expected"]["data"]["respond_via"] == ["control"])
check("kilocode pins: bus permission.updated and todo.updated are deliberately silent",
      KC_MOMENTS["permission_updated"]["expected"] is None
      and KC_MOMENTS["todo_updated"]["expected"] is None)
check("kilocode pins: todo snapshots diff into planned/completed transitions only",
      {e["type"] for e in KILOCODE["todos"]["expected"]}
      == {"progress.task.planned", "progress.task.completed"})
check("kilocode pins: no tool.failed on this surface (typed hooks expose no error), errors ride session-scoped",
      all(e["expected"] is None or e["expected"]["type"] != "tool.failed" for e in KC_MOMENTS.values())
      and KC_MOMENTS["session_error"]["expected"]["type"] == "x.kilocode.session.error")
check("kilocode pins: a child session names its parent (the delegation shape)",
      KC_MOMENTS["session_created_child"]["expected"]["data"]["parent"]["session"]
      == KC_MOMENTS["session_created"]["input"]["event"]["properties"]["info"]["id"])
check("kilocode pins: unknown bus types fall back mechanically to x.kilocode.*",
      re.fullmatch(r"x\.kilocode\.[a-z0-9_.]+", KILOCODE["fallback"]["expected"]["type"]) is not None)
check("kilocode pins: identity carries the fork's parent shape (bus sessionID; runs synthesized)",
      KILOCODE["identity"]["run_from"] is None)

CLINE = json.loads((FIX / "mappings" / "cline.json").read_text())
CL_HOOKS = CLINE["hooks"]
for name, entry in [*CL_HOOKS.items(), ("fallback", CLINE["fallback"])]:
    for exp in entry["expected"]:
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"cline pin schema-valid ({name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("cline pins: the run lifecycle rides REAL boundaries on core types",
      CL_HOOKS["agent_start"]["expected"][0]["type"] == "run.started"
      and CL_HOOKS["agent_resume"]["expected"][0]["data"]["trigger"] == "resume"
      and CL_HOOKS["agent_end"]["expected"][0]["type"] == "run.finished")
check("cline pins: abort is a cancellation, error a failure (the vendor distinction kept)",
      CL_HOOKS["agent_abort"]["expected"][0]["type"] == "run.cancelled"
      and CL_HOOKS["agent_abort"]["expected"][0]["data"]["by"] == "user"
      and CL_HOOKS["agent_error"]["expected"][0]["type"] == "run.failed"
      and CL_HOOKS["agent_error"]["expected"][0]["data"]["reason"] == "ApiError")
check("cline pins: the typed error field splits tool.completed/tool.failed honestly",
      CL_HOOKS["tool_result_ok"]["expected"][0]["type"] == "tool.completed"
      and CL_HOOKS["tool_result_error"]["expected"][0]["type"] == "tool.failed"
      and CL_HOOKS["tool_result_error"]["expected"][0]["data"]["error"]["type"] == "tool_error")
check("cline pins: a typed parent id opens and closes the delegation pair",
      CL_HOOKS["agent_start_parented"]["expected"][0]["type"] == "delegation.subagent.started"
      and CL_HOOKS["agent_end_parented"]["expected"][-1]["type"] == "delegation.subagent.stopped"
      and CL_HOOKS["agent_start_parented"]["expected"][0]["subject"] == "agent_child")
check("cline pins: prompt_submit stays vendor-namespaced (message.user.submitted is reserved)",
      CL_HOOKS["prompt_submit"]["expected"][0]["type"].startswith("x.cline."))
check("cline pins: compaction lands at the vendor's only exposed (pre) moment, paths gated",
      CL_HOOKS["pre_compact"]["expected"][0]["type"] == "session.compacted"
      and "context_json_path" not in CL_HOOKS["pre_compact"]["expected"][0]["data"])
check("cline pins: observe-only — nothing on this surface maps to attention.*",
      all(not e["type"].startswith("attention.")
          for entry in [*CL_HOOKS.values(), CLINE["fallback"]] for e in entry["expected"]))
check("cline pins: the iteration counter stamps the envelope step (no run.step.* synthesis)",
      CL_HOOKS["tool_call"]["expected"][0]["step"] == "1"
      and all(not e["type"].startswith("run.step.")
              for entry in CL_HOOKS.values() for e in entry["expected"]))
check("cline pins: unknown hook names fall back mechanically to x.cline.*",
      re.fullmatch(r"x\.cline\.[a-z0-9_.]+", CLINE["fallback"]["expected"][0]["type"]) is not None)
check("cline pins: identity (taskId rides; run boundaries real, run id adapter-minted)",
      CLINE["identity"]["session_from"] == "taskId" and CLINE["identity"]["run_from"] is None)

HERMES = json.loads((FIX / "mappings" / "hermes.json").read_text())
HM_HOOKS = HERMES["hooks"]
for name, entry in [*HM_HOOKS.items(), ("fallback", HERMES["fallback"])]:
    for exp in entry["expected"]:
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"hermes pin schema-valid ({name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("hermes pins: the drift sentinel rides in every input envelope",
      all(entry["input"]["extra"].get("telemetry_schema_version") == "hermes.observer.v1"
          for entry in [*HM_HOOKS.values(), HERMES["fallback"]]))
check("hermes pins: the three-way tool status splits completed/failed/DENIED honestly",
      HM_HOOKS["post_tool_call_ok"]["expected"][0]["type"] == "tool.completed"
      and HM_HOOKS["post_tool_call_error"]["expected"][0]["type"] == "tool.failed"
      and HM_HOOKS["post_tool_call_blocked"]["expected"][0]["type"] == "tool.denied"
      and HM_HOOKS["post_tool_call_blocked"]["expected"][0]["data"]["by"] == "policy")
check("hermes pins: the vendor gate is observed read-only WITH the vendor menu as data (oob channel declared)",
      HM_HOOKS["pre_approval_request"]["expected"][0]["data"]["kind"] == "permission"
      and [o["id"] for o in HM_HOOKS["pre_approval_request"]["expected"][0]["data"]["options"]]
      == ["once", "session", "always", "deny"]
      and HM_HOOKS["pre_approval_request"]["expected"][0]["data"]["respond_via"] == ["oob"])
check("hermes pins: the human decision rides via oob; a timeout choice maps to attention.timeout",
      HM_HOOKS["post_approval_response_deny"]["expected"][0]["data"]["via"] == "oob"
      and HM_HOOKS["post_approval_response_timeout"]["expected"][0]["type"] == "attention.timeout")
check("hermes pins: the per-turn boundary closes RUNS (the source-pinned naming trap)",
      HM_HOOKS["on_session_end_completed"]["expected"][0]["type"] == "run.finished"
      and HM_HOOKS["on_session_end_interrupted"]["expected"][0]["type"] == "run.cancelled"
      and HM_HOOKS["on_session_end_interrupted"]["expected"][0]["data"]["by"] == "user"
      and all(e["type"] != "session.ended" for n in ("on_session_end_completed", "on_session_end_interrupted")
              for e in HM_HOOKS[n]["expected"]))
check("hermes pins: the session end comes from finalize ALONE; reset announces the successor on the vendor plane",
      HM_HOOKS["on_session_finalize"]["expected"][0]["type"] == "session.ended"
      and HM_HOOKS["on_session_reset"]["expected"][0]["type"] == "x.hermes.session.reset"
      and all(e["type"] != "session.ended" for e in HM_HOOKS["on_session_reset"]["expected"]))
_HM_CLARIFY_PRE = HM_HOOKS["pre_tool_call (clarify: the form overlay, vendor choice normalization)"]["expected"]
check("hermes pins: the clarify form overlay rides BESIDE the pinned tool trio (kind form, one select field with other:true, respond_via oob)",
      _HM_CLARIFY_PRE[0]["type"] == "tool.requested"
      and _HM_CLARIFY_PRE[1]["type"] == "attention.requested"
      and _HM_CLARIFY_PRE[1]["data"]["kind"] == "form"
      and _HM_CLARIFY_PRE[1]["data"]["respond_via"] == ["oob"]
      and _HM_CLARIFY_PRE[1]["data"]["fields"][0]["type"] == "select"
      and _HM_CLARIFY_PRE[1]["data"]["fields"][0]["other"] is True
      and [c["id"] for c in _HM_CLARIFY_PRE[1]["data"]["fields"][0]["choices"]] == ["1", "2", "3", "4"])
check("hermes pins: a picked clarify choice is its STRUCTURAL 1-based id; the Other path is content; timeouts and dismissals never fabricate answers",
      HM_HOOKS["post_tool_call (clarify: a picked choice is its structural id)"]["expected"][1]["data"]
      == {"answer": {"values": {"1": "3"}}, "via": "oob"}
      and HM_HOOKS["post_tool_call (clarify: the Other path is free text, redacted-gated)"]["expected"][1]["data"]["answer"]["values"]["1"]
      == "ship them both"
      and HM_HOOKS["post_tool_call (clarify: the CLI timeout sentinel)"]["expected"][1]["type"] == "attention.timeout"
      and HM_HOOKS["post_tool_call (clarify: cancelled by the user, dismissed)"]["expected"][1]["data"]["resolution"] == "dismissed"
      and HM_HOOKS["post_tool_call (clarify: blocked before the ask, dismissed beside the pinned denial)"]["expected"][0]["type"] == "tool.denied")
check("hermes pins: the delegation pair lands on the parent session (child as subject)",
      HM_HOOKS["subagent_start"]["expected"][0]["type"] == "delegation.subagent.started"
      and HM_HOOKS["subagent_start"]["expected"][0]["subject"]
      == HM_HOOKS["subagent_start"]["input"]["extra"]["child_session_id"]
      and HM_HOOKS["subagent_start"]["input"]["session_id"]
      == HM_HOOKS["subagent_start"]["input"]["extra"]["parent_session_id"])
check("hermes pins: run identity is REAL (extra.turn_id), not synthesized",
      "turn_id" in HERMES["identity"]["run_from"])
check("hermes pins: the api plane stays vendor-namespaced; no compaction moment is invented",
      HM_HOOKS["api_request_error"]["expected"][0]["type"] == "x.hermes.api.error"
      and all(e["type"] != "session.compacted"
              for entry in [*HM_HOOKS.values(), HERMES["fallback"]] for e in entry["expected"]))
check("hermes pins: unregistered hook names fall back mechanically to x.hermes.*",
      re.fullmatch(r"x\.hermes\.[a-z0-9_.]+", HERMES["fallback"]["expected"][0]["type"]) is not None)

ANTIGRAVITY = json.loads((FIX / "mappings" / "antigravity.json").read_text())
AG_HOOKS = ANTIGRAVITY["hooks"]
for name, entry in [*AG_HOOKS.items(), ("fallback", ANTIGRAVITY["fallback"])]:
    for exp in entry["expected"]:
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"antigravity pin schema-valid ({name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("antigravity pins: every entry names its hook (no payload carries an event name)",
      all("hook" in entry and entry["hook"]
          for entry in [*AG_HOOKS.values(), ANTIGRAVITY["fallback"]]))
check("antigravity pins: the invocation pair is wire-indistinguishable (argv is the discriminator)",
      AG_HOOKS["pre_invocation"]["input"] == AG_HOOKS["post_invocation"]["input"]
      and AG_HOOKS["pre_invocation"]["expected"][0]["type"] == "run.step.started"
      and AG_HOOKS["post_invocation"]["expected"][0]["type"] == "run.step.finished")
check("antigravity pins: invocationNum sets the envelope step on the boundary pair",
      AG_HOOKS["pre_invocation"]["expected"][0]["step"]
      == str(AG_HOOKS["pre_invocation"]["input"]["invocationNum"])
      and AG_HOOKS["post_invocation"]["expected"][0]["step"]
      == str(AG_HOOKS["post_invocation"]["input"]["invocationNum"]))
check("antigravity pins: the join supplies the name the thin PostToolUse lacks",
      "toolCall" not in AG_HOOKS["post_tool_use_ok_joined"]["input"]
      and AG_HOOKS["post_tool_use_ok_joined"]["join"]["name"]
      == AG_HOOKS["post_tool_use_ok_joined"]["expected"][0]["data"]["tool"]["name"]
      and AG_HOOKS["post_tool_use_ok_joined"]["expected"][0]["type"] == "tool.completed"
      and AG_HOOKS["post_tool_use_error_joined"]["expected"][0]["type"] == "tool.failed")
check("antigravity pins: unjoined completions fall back honestly (a name is never invented)",
      "join" not in AG_HOOKS["post_tool_use_unjoined"]
      and AG_HOOKS["post_tool_use_unjoined"]["expected"][0]["type"] == "x.antigravity.step.completed"
      and AG_HOOKS["post_tool_use_unjoined_error"]["expected"][0]["data"]["failed"] is True
      and all("tool" not in e["data"]
              for n in ("post_tool_use_unjoined", "post_tool_use_unjoined_error")
              for e in AG_HOOKS[n]["expected"]))
check("antigravity pins: the typed terminationReason closes runs (bounded terminations are completions)",
      AG_HOOKS["stop_model_stop"]["expected"][0]["type"] == "run.finished"
      and AG_HOOKS["stop_max_steps_exceeded"]["expected"][0]["type"] == "run.finished"
      and AG_HOOKS["stop_max_steps_exceeded"]["expected"][0]["data"]["termination_reason"] == "max_steps_exceeded"
      and AG_HOOKS["stop_error"]["expected"][0]["type"] == "run.failed"
      and AG_HOOKS["stop_error"]["expected"][0]["data"]["reason"] == "error")
check("antigravity pins: observe-only — nothing maps to attention.* or tool.denied",
      all(not e["type"].startswith("attention.") and e["type"] != "tool.denied"
          for entry in [*AG_HOOKS.values(), ANTIGRAVITY["fallback"]] for e in entry["expected"]))
check("antigravity pins: the vendor's interaction tools are observed as tools",
      AG_HOOKS["pre_tool_use_question_tool"]["expected"][0]["type"] == "tool.requested")
check("antigravity pins: identity (conversationId -> session verbatim; runs synthesized)",
      ANTIGRAVITY["identity"]["session_from"] == "conversationId"
      and ANTIGRAVITY["identity"]["run_from"] is None)
check("antigravity pins: unknown hook event names fall back mechanically to x.antigravity.hook.*",
      re.fullmatch(r"x\.antigravity\.hook\.[a-z0-9_.]+", ANTIGRAVITY["fallback"]["expected"][0]["type"]) is not None)

ACP = json.loads((FIX / "mappings" / "acp.json").read_text())
ACP_MOMENTS = ACP["moments"]
for name, entry in [*ACP_MOMENTS.items(), ("fallback", ACP["fallback"])]:
    for exp in [*entry["expected"], *entry.get("deltas_expected", [])]:
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"acp pin schema-valid ({name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("acp pins: the stop reason decides the run terminal honestly",
      ACP_MOMENTS["response_prompt_end_turn"]["expected"][0]["type"] == "run.finished"
      and ACP_MOMENTS["response_prompt_max_tokens"]["expected"][0]["type"] == "run.finished"
      and ACP_MOMENTS["response_prompt_cancelled"]["expected"][0]["type"] == "run.cancelled"
      and ACP_MOMENTS["response_prompt_cancelled"]["expected"][0]["data"]["by"] == "user"
      and ACP_MOMENTS["response_prompt_refusal"]["expected"][0]["type"] == "run.failed"
      and ACP_MOMENTS["response_prompt_refusal"]["expected"][0]["data"]["reason"] == "refusal")
check("acp pins: the editor gate is observed READ-ONLY (no options, no respond_via; count as metadata)",
      "options" not in ACP_MOMENTS["request_permission"]["expected"][0]["data"]
      and "respond_via" not in ACP_MOMENTS["request_permission"]["expected"][0]["data"]
      and ACP_MOMENTS["request_permission"]["expected"][0]["data"]["options_count"] == 2)
check("acp pins: outcomes ride via oob; a cancelled outcome resolves as dismissed",
      ACP_MOMENTS["response_permission_selected"]["expected"][0]["data"]["via"] == "oob"
      and ACP_MOMENTS["response_permission_cancelled"]["expected"][0]["data"]["resolution"] == "dismissed")
check("acp pins: the tool status forks honestly onto the trio",
      ACP_MOMENTS["update_tool_call"]["expected"][0]["type"] == "tool.requested"
      and ACP_MOMENTS["update_tool_completed"]["expected"][0]["type"] == "tool.completed"
      and ACP_MOMENTS["update_tool_failed"]["expected"][0]["type"] == "tool.failed"
      and ACP_MOMENTS["update_tool_in_progress"]["expected"][0]["type"].startswith("x.acp."))
check("acp pins: the id-less plan stays vendor-scoped as status counts (never invented tasks)",
      ACP_MOMENTS["update_plan"]["expected"][0]["type"] == "x.acp.plan.updated"
      and ACP_MOMENTS["update_plan"]["expected"][0]["data"]["entries_pending"] == 2
      and all(not e["type"].startswith("progress.task.")
              for entry in ACP_MOMENTS.values() for e in entry["expected"]))
check("acp pins: chunks are suppressed by default and fork only under the opt-in",
      ACP_MOMENTS["update_agent_chunk"]["expected"] == []
      and ACP_MOMENTS["update_agent_chunk"]["deltas_expected"][0]["type"].startswith("x.acp.")
      and all(not e["type"].startswith("message.")
              for entry in ACP_MOMENTS.values()
              for e in [*entry["expected"], *entry.get("deltas_expected", [])]))
check("acp pins: vendor types always carry two segments after the token",
      all(len(e["type"].split(".")) >= 4
          for entry in [*ACP_MOMENTS.values(), ACP["fallback"]]
          for e in [*entry["expected"], *entry.get("deltas_expected", [])]
          if e["type"].startswith("x.acp.")))
check("acp pins: identity is real wire identity (sessionId verbatim; prompt-request run id)",
      "sessionId" in ACP["identity"]["session_from"] and "JSON-RPC id" in ACP["identity"]["run_from"])

SSE_MODES = OPENCODE["sse_modes"]["modes"]
for name, entry in SSE_MODES.items():
    exp = entry["primary"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"opencode-sse primary pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("opencode-sse companion pins: ZERO core types on the channel (the dedup rule)",
      all(e["companion"] is not None and e["companion"]["type"].startswith("x.opencode.")
          for e in SSE_MODES.values()))
check("opencode-sse primary pins: the read-only channel advertises no answer path",
      SSE_MODES["permission_updated"]["primary"]["type"] == "attention.requested"
      and "options" not in SSE_MODES["permission_updated"]["primary"]["data"]
      and "respond_via" not in SSE_MODES["permission_updated"]["primary"]["data"])
check("opencode-sse primary pins: core lifecycle flows in SSE-only deployments",
      SSE_MODES["session_created"]["primary"]["type"] == "session.started"
      and SSE_MODES["message_user"]["primary"]["type"] == "run.started"
      and SSE_MODES["session_idle"]["primary"]["type"] == "run.finished")

# The Kilo Code SSE channel: the same two-mode discipline on the fork's own
# namespace. The fork's runtime diverged at >=7.4.6 (the design record
# addendum): the block carries the OpenCode mirror moment for moment on
# x.kilocode.* PLUS the fork-only ask/settle moments — a strict superset,
# with the divergence names pinned explicitly.
KC_SSE_MODES = KILOCODE["sse_modes"]["modes"]
KC_DIVERGENCE = ["permission_asked", "question_asked", "question_replied"]
check("kilocode-sse mode names = the opencode mirror + the >=7.4.6 divergence moments",
      [k for k in KC_SSE_MODES if k not in KC_DIVERGENCE] == list(SSE_MODES.keys())
      and all(k in KC_SSE_MODES for k in KC_DIVERGENCE))
for name, entry in KC_SSE_MODES.items():
    exp = entry["primary"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"kilocode-sse primary pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("kilocode-sse companion pins: ZERO core types on the channel (the dedup rule)",
      all(e["companion"] is not None and e["companion"]["type"].startswith("x.kilocode.")
          for e in KC_SSE_MODES.values()))
check("kilocode-sse primary pins: the read-only channel advertises no answer path",
      KC_SSE_MODES["permission_updated"]["primary"]["type"] == "attention.requested"
      and "options" not in KC_SSE_MODES["permission_updated"]["primary"]["data"]
      and "respond_via" not in KC_SSE_MODES["permission_updated"]["primary"]["data"])
check("kilocode-sse primary pins: core lifecycle flows in SSE-only deployments",
      KC_SSE_MODES["session_created"]["primary"]["type"] == "session.started"
      and KC_SSE_MODES["message_user"]["primary"]["type"] == "run.started"
      and KC_SSE_MODES["session_idle"]["primary"]["type"] == "run.finished")

AGUI = json.loads((FIX / "mappings" / "agui.json").read_text())
AGUI_EVENTS = AGUI["events"]
for name, entry in AGUI_EVENTS.items():
    exp = entry["expected"]
    if exp is None:
        continue
    validator = PAYLOAD_VALIDATORS.get(exp["type"])
    if validator is not None and exp["data"]:
        errs = list(validator.iter_errors(exp["data"]))
        check(f"agui pin schema-valid ({name} -> {exp['type']})", not errs,
              "; ".join(e.message for e in errs[:2]))
check("agui pins: real vendor identity, no synthesis (a first)",
      AGUI["identity"]["run_from"].startswith("runId"))
check("agui pins: lifecycle/steps/tools/state land on core types",
      all(not AGUI_EVENTS[n]["expected"]["type"].startswith("x.")
          for n in ("run_started", "run_finished", "run_error", "step_started",
                    "tool_call_start", "tool_call_result_joined", "state_snapshot", "state_delta")))
check("agui pins: token and argument deltas are suppressed at the default posture, opt-in to the vendor plane",
      AGUI_EVENTS["text_message_content"]["expected"] is None
      and AGUI_EVENTS["text_message_content"]["deltas_expected"]["type"] == "x.agui.text_message.content"
      and AGUI_EVENTS["tool_call_args"]["expected"] is None)
check("agui pins: the encrypted reasoning value maps to nothing, ever (no deltas fork)",
      AGUI_EVENTS["reasoning_encrypted_value"]["expected"] is None
      and "deltas_expected" not in AGUI_EVENTS["reasoning_encrypted_value"])
check("agui pins: the reply terminal stays vendor while message.agent.replied is reserved",
      AGUI_EVENTS["text_message_end_assistant"]["expected"]["type"] == "x.agui.text_message.end"
      and AGUI_EVENTS["text_message_end_user"]["expected"] is None)
check("agui pins: STEP_* stamps the envelope step",
      AGUI_EVENTS["step_started"]["expected"]["step"] == "plan")
check("agui pins: deprecated THINKING_* aliases map identically",
      AGUI_EVENTS["thinking_start_deprecated_alias"]["expected"]
      == AGUI_EVENTS["reasoning_start"]["expected"])
check("agui pins: unknown event types fall back mechanically to x.agui.*",
      re.fullmatch(r"x\.agui\.[a-z0-9_.]+", AGUI["fallback"]["expected"]["type"]) is not None)

# ---- the OpenHands agent-server table: spec-side checks (schema validity + wire
# facts); the JS runner pins the bridge's own pure module against the same file
OPENHANDS = json.loads((FIX / "mappings" / "openhands.json").read_text())
OH_EVENTS = OPENHANDS["events"]
OH_ALL = [*OH_EVENTS.values(), OPENHANDS["fallback"]]
for name, entry in OH_EVENTS.items():
    for pin_key in ("expected", "deltas_expected"):
        exp = entry.get(pin_key)
        if exp is None:
            continue
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"openhands pin schema-valid ({name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("openhands pins: inputs anchor the TRANSPORT shape (parent_id never on the wire)",
      all("parent_id" not in e["input"] for e in OH_ALL))
check("openhands pins: the tool trio splits on the typed observation error fact",
      OH_EVENTS["observation_ok"]["expected"]["type"] == "tool.completed"
      and OH_EVENTS["observation_error"]["expected"]["type"] == "tool.failed"
      and OH_EVENTS["observation_error"]["expected"]["data"]["error"]["type"] == "tool_error"
      and OH_EVENTS["agent_error"]["expected"]["type"] == "tool.failed")
check("openhands pins: a user rejection is a human decision, not a policy block",
      OH_EVENTS["user_reject_user"]["expected"]["type"] == "x.openhands.user_reject.observation"
      and OH_EVENTS["user_reject_hook"]["expected"]["type"] == "tool.denied"
      and OH_EVENTS["user_reject_hook"]["expected"]["data"]["by"] == "policy")
check("openhands pins: the message boundary stays vendor while message.* is reserved",
      OH_EVENTS["message_agent"]["expected"]["type"] == "x.openhands.message.event"
      and OH_EVENTS["message_user"]["expected"]["type"] == "x.openhands.message.event")
check("openhands pins: deltas opt in; token-id planes map to nothing even under the opt-in",
      OH_EVENTS["streaming_delta"]["expected"] is None
      and OH_EVENTS["streaming_delta"]["deltas_expected"]["type"] == "x.openhands.streaming.delta"
      and OH_EVENTS["token_event"]["expected"] is None
      and OH_EVENTS["token_event"]["deltas_expected"] is None)
check("openhands pins: llm_response_id stamps the envelope step as a string",
      isinstance(OH_EVENTS["action_event"]["expected"]["step"], str)
      and OH_EVENTS["action_event"]["expected"]["step"]
      == OH_EVENTS["action_event"]["input"]["llm_response_id"])
check("openhands pins: the naive vendor timestamp rides at metadata, never as the envelope ts",
      OH_EVENTS["action_event"]["expected"]["data"]["vendor_ts"]
      == OH_EVENTS["action_event"]["input"]["timestamp"])
check("openhands pins: vendor types carry two segments after the token",
      all(re.fullmatch(r"x\.openhands\.[a-z0-9_]+(\.[a-z0-9_]+)+", t) is not None
          for t in (e[k]["type"] for e in OH_ALL
                    for k in ("expected", "deltas_expected") if e.get(k))
          if t.startswith("x.")))
OH_TRANS = OPENHANDS["status_transitions"]
for name, t in OH_TRANS.items():
    for m in t["expected"]:
        validator = PAYLOAD_VALIDATORS.get(m["type"])
        if validator is not None and m["data"]:
            errs = list(validator.iter_errors(m["data"]))
            check(f"openhands transition pin schema-valid ({name} -> {m['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("openhands pins: terminals close per the server's own is_terminal set",
      [m["type"] for m in OH_TRANS["running_finished"]["expected"]] == ["run.finished"]
      and [m["type"] for m in OH_TRANS["running_error"]["expected"]] == ["run.failed"]
      and [m["type"] for m in OH_TRANS["running_stuck"]["expected"]] == ["run.failed"]
      and [m["type"] for m in OH_TRANS["running_deleting"]["expected"]]
      == ["run.cancelled", "session.ended"])
check("openhands pins: paused/waiting never close the run; running->idle closes honestly",
      OH_TRANS["running_paused"]["expected"] == []
      and OH_TRANS["paused_running"]["expected"] == []
      and OH_TRANS["running_idle"]["expected"][0]["data"].get("reason") == "idle")
check("openhands pins: the approval loop rides the attention legs READ-ONLY (no options, no respond path)",
      OH_TRANS["running_waiting"]["expected"][0]["type"] == "attention.requested"
      and "options" not in OH_TRANS["running_waiting"]["expected"][0]["data"]
      and "respond_via" not in OH_TRANS["running_waiting"]["expected"][0]["data"]
      and OH_TRANS["waiting_running"]["expected"][0]["data"]["resolution"] == "answered"
      and OH_TRANS["waiting_paused"]["expected"][0]["data"]["resolution"] == "dismissed")

CODEX_OTEL = json.loads((FIX / "mappings" / "codex-otel.json").read_text())
OTEL_RECORDS = CODEX_OTEL["records"]
for name, entry in OTEL_RECORDS.items():
    for mode in ("companion", "primary"):
        exp = entry[mode]
        if exp is None:
            continue
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"codex-otel pin schema-valid ({mode} {name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("codex-otel pins: companion mode NEVER emits a core type (the dedup rule)",
      all(e["companion"]["type"].startswith("x.codex.otel.")
          for e in list(OTEL_RECORDS.values()) + [CODEX_OTEL["unknown"]]))
check("codex-otel pins: primary mode's core subset is exactly the designed one",
      {e["primary"]["type"] for e in OTEL_RECORDS.values()
       if e["primary"] and not e["primary"]["type"].startswith("x.")}
      == {"session.started", "tool.completed", "tool.failed", "tool.denied"})
check("codex-otel pins: a user deny maps to nothing in primary mode (human decision, not policy)",
      OTEL_RECORDS["tool_decision_user_deny"]["primary"] is None
      and OTEL_RECORDS["tool_decision_config_deny"]["primary"]["data"]["by"] == "policy")
check("codex-otel pins: prompt/transport internals stay vendor-namespaced in BOTH modes",
      all(OTEL_RECORDS[n]["primary"]["type"].startswith("x.codex.otel.")
          for n in ("user_prompt", "api_request", "sse_event", "websocket_event")))
check("codex-otel pins: identity (conversation.id -> session; no run synthesis)",
      CODEX_OTEL["identity"]["session_from"] == "conversation.id"
      and CODEX_OTEL["identity"]["run_from"] is None)

# ---- the VS Code agent OTel-inbound channel (the second vendor profile) --------
VSCODE_OTEL = json.loads((FIX / "mappings" / "vscode-otel.json").read_text())
VSC_OTEL_RECORDS = VSCODE_OTEL["records"]
for name, entry in VSC_OTEL_RECORDS.items():
    for mode in ("companion", "primary"):
        exp = entry[mode]
        if exp is None:
            continue
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"vscode-otel pin schema-valid ({mode} {name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("vscode-otel pins: companion mode NEVER emits a core type (the dedup rule)",
      all(e["companion"]["type"].startswith("x.vscode.otel.")
          for e in list(VSC_OTEL_RECORDS.values()) + [VSCODE_OTEL["unknown"]]))
check("vscode-otel pins: primary mode's core subset is exactly the designed one",
      {e["primary"]["type"] for e in VSC_OTEL_RECORDS.values()
       if e["primary"] and not e["primary"]["type"].startswith("x.")}
      == {"session.started", "tool.completed", "tool.failed"})
check("vscode-otel pins: the hook-only tiers never ride this channel "
      "(no tool.denied — the decision tier never reaches OTel; "
      "no session.ended — it does not exist on this vendor surface)",
      all(e[mode] is None or e[mode]["type"] not in ("tool.denied", "session.ended")
          for e in list(VSC_OTEL_RECORDS.values()) + [VSCODE_OTEL["unknown"]]
          for mode in ("companion", "primary")))
check("vscode-otel pins: turn/edit/inference visibility stays vendor-namespaced in BOTH modes",
      all(VSC_OTEL_RECORDS[n]["primary"]["type"].startswith("x.vscode.otel.")
          for n in ("agent_turn", "inference_details", "edit_feedback")))
check("vscode-otel pins: identity (resource session.id -> session; no run synthesis)",
      VSCODE_OTEL["identity"]["session_from"] == "resource:session.id"
      and VSCODE_OTEL["identity"]["run_from"] is None)

PI = json.loads((FIX / "mappings" / "pi.json").read_text())
PI_MOMENTS = PI["moments"]
for name, entry in [*PI_MOMENTS.items(), ("fallback", PI["fallback"])]:
    for exp in (entry.get("expected"), entry.get("deltas_expected")):
        if exp is None:
            continue
        validator = PAYLOAD_VALIDATORS.get(exp["type"])
        if validator is not None and exp["data"]:
            errs = list(validator.iter_errors(exp["data"]))
            check(f"pi pin schema-valid ({name} -> {exp['type']})", not errs,
                  "; ".join(e.message for e in errs[:2]))
check("pi pins: lifecycle/turns/tools land on core types",
      all(not PI_MOMENTS[n]["expected"]["type"].startswith("x.")
          for n in ("session_start", "session_shutdown", "session_compact", "agent_start",
                    "agent_end_stop", "turn_start", "turn_end",
                    "tool_execution_start", "tool_execution_end_ok", "tool_execution_end_error")))
check("pi pins: the typed stopReason closes runs (bounded terminations are completions)",
      PI_MOMENTS["agent_end_stop"]["expected"]["type"] == "run.finished"
      and PI_MOMENTS["agent_end_error"]["expected"]["type"] == "run.failed"
      and PI_MOMENTS["agent_end_error"]["expected"]["data"]["reason"] == "error"
      and PI_MOMENTS["agent_end_aborted"]["expected"]["type"] == "run.cancelled"
      and "by" not in PI_MOMENTS["agent_end_aborted"]["expected"]["data"])
check("pi pins: the vendor turnIndex stamps the envelope step on the boundary pair",
      PI_MOMENTS["turn_start"]["expected"]["type"] == "run.step.started"
      and PI_MOMENTS["turn_start"]["expected"]["step"]
      == str(PI_MOMENTS["turn_start"]["input"]["event"]["turnIndex"])
      and PI_MOMENTS["turn_end"]["expected"]["type"] == "run.step.finished")
check("pi pins: the honest isError split on the tool trio",
      PI_MOMENTS["tool_execution_end_ok"]["expected"]["type"] == "tool.completed"
      and PI_MOMENTS["tool_execution_end_error"]["expected"]["type"] == "tool.failed"
      and PI_MOMENTS["tool_execution_end_error"]["expected"]["data"]["error"]["type"] == "error")
check("pi pins: message boundaries stay vendor while message.* stays reserved",
      PI_MOMENTS["message_start_user"]["expected"]["type"] == "x.pi.message.submitted"
      and PI_MOMENTS["message_end_assistant"]["expected"]["type"] == "x.pi.message.replied"
      and PI_MOMENTS["message_start_assistant"]["expected"] is None
      and PI_MOMENTS["message_end_toolresult"]["expected"] is None)
check("pi pins: stream updates are suppressed at the default posture, opt-in to the vendor plane",
      PI_MOMENTS["message_update"]["expected"] is None
      and PI_MOMENTS["message_update"]["deltas_expected"]["type"] == "x.pi.message.delta"
      and PI_MOMENTS["tool_execution_update"]["expected"] is None
      and PI_MOMENTS["tool_execution_update"]["deltas_expected"]["type"] == "x.pi.tool.update")
check("pi pins: observe-only — nothing maps to attention.* or tool.denied",
      all(not e["type"].startswith("attention.") and e["type"] != "tool.denied"
          for entry in [*PI_MOMENTS.values(), PI["fallback"]]
          for e in (entry.get("expected"), entry.get("deltas_expected")) if e is not None))
check("pi pins: identity (ctx.sessionManager -> session; runs synthesized per agent loop)",
      PI["identity"]["session_from"].startswith("ctx.sessionManager")
      and PI["identity"]["run_from"] is None)
check("pi pins: unknown bus members fall back mechanically to x.pi.event.*",
      re.fullmatch(r"x\.pi\.event\.[a-z0-9_.]+", PI["fallback"]["expected"]["type"]) is not None)

# ---------------------------------------------------------------- verdict
human(f"\n{'OK' if not failures else 'FAILED'}: {len(failures)} failure(s)")
if JSON_OUT is not None:
    checks = []
    for r in results:
        c: dict = {"name": r["name"], "status": "pass" if r["ok"] else "fail"}
        if r["detail"]:
            c["detail"] = r["detail"]
        checks.append(c)
    summary = {
        "pass": sum(1 for c in checks if c["status"] == "pass"),
        "fail": sum(1 for c in checks if c["status"] == "fail"),
        "skip": 0,
        "total": len(checks),
    }
    report = {
        "format": "aep-conformance-report",
        "formatVersion": 1,
        "aep": "0.1",
        "tool": "run-py",
        "target": None,
        "startedAt": STARTED_AT,
        "finishedAt": utc_now(),
        "checks": checks,
        "summary": summary,
        "ok": summary["fail"] == 0,
    }
    text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if JSON_STDOUT:
        sys.stdout.write(text)
    else:
        Path(JSON_OUT).write_text(text)
sys.exit(1 if failures else 0)
