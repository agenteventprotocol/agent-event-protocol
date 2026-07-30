# conformance/ — fixtures + dual runners

Two **independent** implementations run the same corpus: `run.py` is written from
the spec text alone and runs in this repository's CI (`./ci.sh`); `run.js`
exercises the reference implementation and runs in the reference repository's CI
([`agenteventprotocol/reference`](https://github.com/agenteventprotocol/reference)), which vendors these
fixtures at a pinned revision. Disagreement between them
is by definition a spec-ambiguity bug — file it, don't patch around it.

- `fixtures/golden/golden.jsonl` — 64 valid events covering the envelope surface
  and every mandatory type (AEP-0002 §4.1): full worked example, attention
  lifecycle, commands (seq-less), `attention.routed` (foreign-emitter),
  agent-scoped, vendor type, extension attribute, bash-floor minimal,
  `kind:"form"` round-trip (AEP-0006, session `s_form`), the
  failure/terminal arc — a policy `tool.denied`, a `tool.failed` →
  `run.failed` chain, an unanswered request closed by `attention.timeout`,
  `control.cancel` → ack → `run.cancelled` (the AEP-0004 §5 outcome
  contract), and `session.ended` — and the roster-frame corpus (duplicate,
  epoch-reset, and shared-session shapes across two agents, AEP-0003 §4.1).
- `fixtures/invalid/cases.json` — 28 cases that MUST fail, each naming its rule
  (a case with `events` is a stream, validated together — the AEP-0006
  cross-event `values` rule).
- `fixtures/attr-match/cases.json` — 14 match verdicts + 10 fail-closed filters.
- `fixtures/ce-roundtrip/ce-expected.jsonl` — pinned CloudEvents form of every
  golden event; both runners assert forward-match and round-trip identity
  (AEP-0005 §5.1).
- `fixtures/ce-roundtrip/inbound-cases.json` — hand-authored inbound CE events
  pinning the §2 rule 2 preserve path directly (legal `aep*`-prefixed name
  preserved; plain legal name preserved; grammar-illegal name dropped while
  the rest maps) — the inverse fed directly, since the golden-derived pins
  cannot carry an inbound-only attribute (AEP-0005 §5.5).
- `fixtures/otlp/otlp-expected.json` — pinned LogRecord projections (severity
  table incl. the `warning`/`error` rows, `gen_ai.*` hoisting, traceparent
  parsing, body down-leveling for above-ceiling capture).
- `fixtures/ocsf/ocsf-expected.json` — pinned OCSF records for the AEP-0005
  §4.2 families (all three classes, the `tool.denied` → Blocked disposition,
  the answered-carries-no-disposition honesty rule, envelope-only projection
  for above-ceiling capture); `fixtures/ocsf/ocsf-classes.json` pins the
  targeted OCSF class subset (attribute-name sets + value sets) so both
  runners check class-validity offline. Both runners hold independent
  projection implementations.
- `fixtures/redaction/cases.json` — AEP-0003 §9.4 text-pipeline adversarial
  corpus; `run.js` exercises `impl/shared/redact.js`, `run.py` an independent
  implementation from the spec text.
- `fixtures/capture-gating/cases.json` — AEP-0006 type-dependent gating of
  `attention.answered.answer.values` (free text `redacted`+, structural values
  survive `metadata`); `run.js` exercises `impl/shared/aep.js` `gateFormValues`,
  `run.py` an independent implementation from the spec text.
- `fixtures/mappings/claude-code.json` — AEP-0002 Annex A machine-usable mapping
  pins (first entry: `AskUserQuestion → kind:"form"`, pinned at both capture
  ceilings); `run.js` pins the adapter's own mapping module, `run.py` checks
  schema validity + required wire facts.
- `fixtures/downlevel/cases.json` — AEP-0001 §8.2 hop down-leveling: nested
  annotated fields pruned, `[metadata*]` exception content degraded
  structurally below `redacted`, and the §8.2(e) boundary (a mechanical hop
  never mints the `redacted` provenance claim — a `redacted` ceiling on a
  `full` event lands on `metadata`); `run.js` exercises `impl/shared/aep.js`
  `downlevel` (the relay's ceiling enforcement), `run.py` an independent
  implementation from the spec text.

Run: `python3 run.py` and `node run.js` (both exit non-zero on any failure).
`python3 run.py --pin` regenerates pins — only after a deliberate, logged mapping
change. Per the SEP-style rule (AEP-0001 §13): **every accepted spec change lands
with fixtures here.**

## Conformance classes

Conformance is claimed per layer and per role (AEP-0001 §10); the fixture corpus
and the live checker below map onto the roles like this:

| Class | What it must get right | Normative anchor | How to check |
|---|---|---|---|
| **Emitter** | envelope validity; registered or legal `x.{vendor}.*` types; monotonic `seq` per session/epoch; content honoring the declared `capture` | AEP-0001 §5–§8, AEP-0002 §5 | validate your emitted JSONL against the golden/invalid corpus rules (the runners are the executable reading of them) |
| **Consumer** | dedupe on `(source, id)`; unknown-type/attribute tolerance; `attr-match` + `(session, epoch, seq)` resume on supported bindings | AEP-0001 §7/§10, AEP-0003 §6–§7 | drive your consumer from `fixtures/golden/golden.jsonl` (it deliberately contains unknown-to-you shapes: vendor type, extension attribute, foreign-emitter events) — recipe in [write-a-consumer](../docs/guides/write-a-consumer.md#certify-it); [Mission Control's suite](https://github.com/agenteventprotocol/mission-control/blob/main/app/test/conformance.test.ts) is the shipped worked example |
| **Collector / relay** | discovery; version gate; envelope rejection; filtered fan-out; buffered resume; capture ceiling enforcement; `hello` rules when duplex; control never flows on an unauthenticated binding | AEP-0003 §3–§8, AEP-0004 §4.1 | `live.js` (below) against your running endpoint |
| **Control-capable party** | `control.accepts` declared and authoritative; ack/nack within the window; idempotent dedupe on command `(source, id)` with the recorded ack re-emitted byte-identically on a retransmit; cause-linked outcomes | AEP-0004 §7 | `live.js --control-session <session>` (below) against a connected target; the cancel outcome check is opt-in via `--control-cancel <run>`. The profile is `experimental` — checking against it is exactly the usage evidence GOVERNANCE §5's graduation bar asks for |

## Self-certification: the live endpoint checker

[`live.js`](live.js) checks a **running** collector/relay the way the fixture
corpus checks static artifacts — zero dependencies, Node ≥ 22:

```sh
node conformance/live.js http://127.0.0.1:8787 [--token T] [--checks LIST]
```

Checks, each citing the section it verifies: `discovery` (§3.4 document shape),
`version-gate` (§3.2 — 426 + versions), `reject-invalid` (§3.2 — 400 on a bad
envelope), `ingest-fanout` (batch POST → filtered SSE delivery, envelopes
intact, `(epoch, seq)` ascending), `resume` (`from` replays strictly-after with
no duplicates), `capture-downlevel` (a `redacted`-gated field must not reach a
`metadata`-ceiling subscriber), `hello-ws` (hello-first, version intersection —
skipped when no socket endpoint is advertised), `subscribe-limits` (AEP-0003
§6.5 — subscribe rejection is in-band from the closed code set and
per-request: an over-size `from` and a malformed one are each answered with
`subscribed`/`error`, never a dropped connection; same skip as `hello-ws`),
and `control-auth-gate`
(control flows only on authenticated bindings, unconditionally — AEP-0004
§4.1 / AEP-0003 §8.1: on a run given no `--token` against an endpoint that
admits its duplex anyway, a probe command must never reach a target; the
check skips on authenticated runs, so probe your development posture by
running the checker once without a token).

**Control-capable targets** (AEP-0004 §7) are checked by the same tool,
opt-in — the checker sends real commands, so it never probes unasked:

```sh
node conformance/live.js http://127.0.0.1:8787 \
  --control-session <session> \        # a session whose owner is a connected target
  [--control-accepts TYPE] \           # a declared command type to probe (default control.attention.respond)
  [--control-undeclared TYPE] \        # an undeclared type (default control.pause)
  [--control-cancel <run>] \           # DESTRUCTIVE: actually cancels this run (§5 outcome check)
  [--ack-window MS]                    # sender-side window; default 10 000 (§3)
```

`control-ack` (a declared type gets one cause-linked ack decision within the
window, never `unsupported` — §3/§4.2), `control-nack-unsupported`
(an undeclared type is nacked `unsupported` by the target or by the relay on
its behalf — §4.2), `control-dedupe` (a retransmitted command `id` is the
same command: one ack decision — a still-remembered command is re-acked
byte-identically, a second DISTINCT ack fails — §2.3/§3), and `control-cancel`
(accepted, then exactly one `run.cancelled` cause-linked to the command or its
ack — §5/§6; runs only when `--control-cancel` names a run). The control profile is `experimental`;
running these checks against it is precisely the usage evidence GOVERNANCE
§5's graduation bar calls for.

### The report format

All three tools emit a machine-readable report with `--json <path>`:

```sh
node conformance/live.js http://127.0.0.1:8787 --json report.json
node conformance/run.js --json report.json
python3 conformance/run.py --json report.json
```

Pass `-` as the path to send the report to stdout: in that mode stdout
carries only the JSON (one pretty-printed object with a trailing newline)
and every human line (header, per-check lines, footer) moves to stderr,
so the output pipes cleanly. Exit codes are unchanged either way, and
with a file path the human output is unchanged too. The shape, shared
exactly across the three tools:

```json
{
  "format": "aep-conformance-report",
  "formatVersion": 1,
  "aep": "0.1",
  "tool": "live",
  "target": "http://127.0.0.1:8787",
  "startedAt": "2026-07-22T12:00:00.000Z",
  "finishedAt": "2026-07-22T12:00:02.500Z",
  "checks": [
    { "name": "discovery", "status": "pass" },
    { "name": "resume", "status": "skip", "detail": "skipped: ..." }
  ],
  "summary": { "pass": 1, "fail": 0, "skip": 1, "total": 2 },
  "ok": true
}
```

Field semantics: `tool` is `"live"`, `"run-js"`, or `"run-py"`; `target`
is the checked base URL for the live checker and `null` for the fixture
runners; timestamps are ISO 8601. Each check's `status` is `pass`,
`fail`, or `skip` (the fixture runners never emit `skip`); `detail` is
human text explaining a skip or a failure, and the key is omitted when
there is nothing to say. `summary.total` always equals `checks.length`,
and `ok` is `true` exactly when `summary.fail` is zero.

`formatVersion` is `1`; any breaking change to this shape bumps it. The
emitted report is the publishable self-certification artifact: publish
it alongside the class(es) you claim from the table above.

### Eviction coverage (opt-in)

AEP-0003 §10 records two classes that need a live, cooperating endpoint
rather than fixtures: `replay-exhausted` under real buffer eviction, and
envelope-over-binding byte-identity. `--evict` covers both with the
operator's cooperation. It floods a fresh `live-` session
with more events than the advertised `capabilities.replay.buffer`
holds, then replays from a position that now predates the buffer, on
both bindings. It is opt-in because it writes many events: run it
against a development instance, and run the target with a small replay
buffer. The checker refuses to flood past a buffer larger than
`--evict-max` (default 512) and skips instead; the reference relay's
knob is the `AEP_BUFFER` environment variable, e.g. `AEP_BUFFER=8`.
Without `--evict`, both checks report `skip`.

- `evict-replay-exhausted` (AEP-0003 §5, §3.3.3): on both bindings the
  replay-exhausted marker (the SSE comment line, the WS frame) arrives
  before the first replayed event, both bindings agree on the earliest
  retained position, that position is later than the requested one, and
  delivery then starts exactly there, ascends strictly, and ends at the
  last posted event. How deep the relay evicts is
  implementation-defined; the check asserts coherence, not a particular
  depth.
- `evict-byte-identity` (AEP-0003 §10): what each binding delivers
  after eviction is the event that was posted. It passes at one of two
  grades, told apart in its `detail`: strict (every delivered payload
  on both bindings is byte-identical to the posted line) or
  core-envelope-intact (core context attributes and `data` survive
  unchanged while the relay re-serialized the event or added extension
  attributes in flight, which AEP-0001 §4.2 permits). It fails when a
  core attribute or `data` differs from what was posted, or when the
  two bindings deliver different objects for the same `(source, id)`.

It posts a few synthetic events under agent identity `aep-live-check` into
sessions prefixed `live-` — run it against a development instance, not a
production stream. Exit 0 with every check passing (plus a green fixture-corpus
run for the artifacts you produce) is the bar for claiming 0.1 conformance for
the classes the checker covers. `live-selftest.js` keeps the checker itself
honest in this repository's CI: it must go all-green against a compliant stub
(control checks skipped without a target, green with one), and **fail**
against stubs with a deliberately broken resume, a double-acking target, a
target that never acks, and a target that re-decides a retried command
instead of re-emitting its recorded ack.
