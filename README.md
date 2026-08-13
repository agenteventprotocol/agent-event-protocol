# AEP: Agent Event Protocol

**An open, vendor-neutral protocol for agent activity events and control.**

Any agent emits lifecycle, tool, progress, and **attention** events once, over
stdio (JSONL), HTTP, SSE, or WebSocket; and any dashboard, bridge, logger, or
automation consumes them once, for every agent. Instead of N bespoke per-agent
ingesters, one contract; and three things no incumbent protocol carries:

- **A routable attention lifecycle**: *agent-needs-a-human* as a first-class
  event (`attention.requested/answered/resolved/timeout`), routable to a phone,
  a channel, or an automation.
- **An acknowledged control round-trip**: approve, cancel, pause, or answer
  from anywhere; commands are events, so every control action is audit-logged
  by construction (`experimental` profile).
- **Spec-guaranteed session replay**: `(epoch, seq)` resume with no gaps and
  idempotent redelivery; kill a consumer, reattach, and receive exactly the tail.

CloudEvents and OpenTelemetry shops are served by **normative day-one bridges**
(AEP-0005): you never choose between AEP and your existing pipeline.

> **Status: pre-release.** The specifications are v0.1 under the AEP process;
> each document's status (Draft or Accepted) is listed in
> [Specifications](#specifications) below. Identifiers (`dev.aep.` type root,
> `aep://` scheme, `@agenteventprotocol/*` / `agenteventprotocol` package names) are final; nothing is
> published to any registry yet.

## The envelope in one glance

Every Event is a self-describing JSON object: **16 context attributes +
`data`** (AEP-0001 §5). Sixteen bytes of discipline buy fleet-wide ordering,
causality, privacy levels, and replay:

```json
{
  "aep": "0.1", "id": "01JZX7Q4R8T0V2W4X6Y8Z0AB1C",
  "source": "aep://host-1/agent/claude-code/session/s_9f2c",
  "type": "tool.completed", "subject": "Bash",
  "agent": "claude-code", "session": "s_9f2c", "run": "r_01",
  "step": "turn-3", "seq": 42, "epoch": 1,
  "time": "2026-07-04T12:00:00.000Z",
  "cause": "01JZX7Q4R8T0V2W4X6Y8Z0AB0B",
  "severity": "info", "capture": "metadata",
  "data": { "tool": { "name": "Bash", "call_id": "t_91" },
            "status": "success", "duration_ms": 412 }
}
```

## Repository layout

This is the standard: spec, schemas, conformance fixtures, and explanatory
docs, versioned together because every normative change must land **with** its
conformance fixtures in the same commit (the SEP rule, AEP-0001 §13).

| Path | Contents |
|---|---|
| [spec/](spec/) | The AEP 0.1 draft suite, AEP-0001..AEP-0009 ([index](spec/README.md)); CC-BY 4.0 |
| [schemas/](schemas/) | JSON Schema 2020-12 registry (envelope + 44 payload schemas) and codegen → TypeScript, pydantic v2, AsyncAPI 3.0 |
| [conformance/](conformance/) | Golden fixtures and independent runners: the arbiter for every normative claim |
| [docs/](docs/index.md) | Explanatory documentation: concepts, component internals, and builder/user guides ([index](docs/index.md)); the spec stays the normative source |
| [site/](site/README.md) | Static site generator that builds `docs/` into the published documentation site |

## Quickstart

Node ≥ 22 and Python ≥ 3.10.

```bash
./ci.sh          # schema gate + conformance + docs QA — runs offline
```

`ci.sh` runs the schema/codegen diff gate, the conformance runner, and a strict
typecheck of the generated TypeScript; a second docs job (`docs/check-docs.sh`)
runs the offline documentation QA gate.

## Ecosystem

The runnable code that implements this standard lives in sibling repositories:

| Repo | What it is |
|---|---|
| [reference](https://github.com/agenteventprotocol/reference) | The runnable reference stack: the relay, the `aep` CLI (observe, capture, replay, validate, diagnose, answer/cancel), twelve agent adapters, CloudEvents/OTLP outbound and six inbound capture bridges, an MCP server, and a one-command five-beat demo. CI self-certifies two conformance classes (collector and control-capable target) against this repo's own live checker |
| [mission-control](https://github.com/agenteventprotocol/mission-control) | Mission Control, the fleet operator console: several relays in one window, live session lanes, an attention inbox with tap-to-respond, run cancel with stream-settled outcomes, replay and causal graphs; self-certifies the consumer conformance class from the golden corpus in CI |
| [typescript-sdk](https://github.com/agenteventprotocol/typescript-sdk) | `@agenteventprotocol/sdk`: emit/consume/control helpers (sender and target sides) over the generated types |
| [python-sdk](https://github.com/agenteventprotocol/python-sdk) | `agenteventprotocol` (PyPI): the same, for Python, sync and asyncio |

## Specifications

| Doc | Title | Status |
|---|---|---|
| [AEP-0001](spec/AEP-0001-core-and-envelope.md) | Purpose, Architecture, and Event Envelope | Draft |
| [AEP-0002](spec/AEP-0002-taxonomy-and-types.md) | Event Taxonomy and the Mandatory Type Set (14 types) | Draft |
| [AEP-0003](spec/AEP-0003-bindings-and-lifecycle.md) | Transport Bindings, Connection Lifecycle, and Subscriptions | Draft |
| [AEP-0004](spec/AEP-0004-control-profile.md) | Control Profile (`experimental`) | Draft |
| [AEP-0005](spec/AEP-0005-bridges.md) | Bridge Annexes: CloudEvents, OTLP, and OCSF | Draft |
| [AEP-0006](spec/AEP-0006-structured-input-requests.md) | Structured Input Requests (`kind: "form"`) | Accepted |
| [AEP-0007](spec/AEP-0007-message-stream-subprofile.md) | Message and Stream Sub-Profile | Draft |
| [AEP-0008](spec/AEP-0008-text-answers-and-response-channels.md) | Text Answers and Response-Channel Declarations | Accepted |
| [AEP-0009](spec/AEP-0009-assessment.md) | Assessment: Evaluation Results and Human Feedback | Accepted |

## Documentation

Explanatory docs, for **users** (run the stack, watch a fleet) and **builders**
(write adapters, consumers, SDK apps), live in **[docs/](docs/index.md)**:
[concepts](docs/concepts/), [component internals](docs/components/), and
[guides](docs/guides/). The docs *explain*; the spec above
*defines*. Every page links into the normative text rather than restating it.

The published site, [agenteventprotocol.io](https://agenteventprotocol.io),
is built from `docs/` by the static generator in **[site/](site/README.md)**:

```bash
cd site && npm install && npm run dev   # build, serve, watch, live-reload
```

`docs/docs.json` also conforms to the [Mintlify](https://mintlify.com) schema,
so `npx mint dev` from `docs/` previews the same content and CI uses
`mint broken-links` as a second link gate. The specification and governance
pages under `docs/` are generated from `spec/` and the root files by
`docs/render-site.js`, never edited directly.

## Contributing & governance

Spec changes follow the AEP proposal process: see
[GOVERNANCE.md](GOVERNANCE.md) and [CONTRIBUTING.md](CONTRIBUTING.md); start
from the [proposal template](spec/AEP-TEMPLATE.md). The one rule that never
bends: **normative text changes land with conformance fixtures in the same
change, and `./ci.sh` stays green.** How versions work (the protocol
version, package SemVer, and the compatibility commitments between them)
is stated in [VERSIONING.md](VERSIONING.md); the release procedure is
[RELEASING.md](RELEASING.md).

## License

Code, schemas, and generated types: [Apache-2.0](LICENSE). Specification prose
(`spec/*.md`): [CC-BY 4.0](spec/LICENSE).
