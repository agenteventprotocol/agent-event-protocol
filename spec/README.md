# spec/: AEP 0.1 draft suite

The documents below are the normative source. Each carries its status in its
header table, and the Locks column names what that document fixes.

| Doc | Title | Locks |
|---|---|---|
| [AEP-0001](AEP-0001-core-and-envelope.md) | Purpose, Architecture, and Event Envelope | envelope (16 attrs + `data`), ordering/replay contract, severity/capture, conformance, governance |
| [AEP-0002](AEP-0002-taxonomy-and-types.md) | Event Taxonomy and the Mandatory Type Set | 13 categories, 14 mandatory types + payload schemas, attention lifecycle, registry rules, source mappings (Annex A) |
| [AEP-0003](AEP-0003-bindings-and-lifecycle.md) | Transport Bindings, Connection Lifecycle, and Subscriptions | JSONL/HTTP/SSE/WS, `hello`, attr-match, resume, backpressure, identity/auth, adapter redaction |
| [AEP-0004](AEP-0004-control-profile.md) | Control Profile (`experimental`) | command/ack/nack/outcome, idempotency, gating, ack windows, 4 commands |
| [AEP-0005](AEP-0005-bridges.md) | Bridge Annexes (CloudEvents, OTLP, and OCSF) | B1-B5 mapping (lossless, round-trip-tested), OTLP LogRecord export, capture enforcement |
| [AEP-0006](AEP-0006-structured-input-requests.md) | Structured Input Requests (`kind: "form"`) | `attention.requested` `kind:"form"` + `field_spec`, `attention.answered` `answer.values`, type-dependent capture gating |
| [AEP-0007](AEP-0007-message-stream-subprofile.md) | Message and Stream Sub-Profile | proposes (Draft): `message.*` durable facts + new `stream` category for live deltas, `debug`-severity flood control, cross-delta redaction rule, AG-UI mapping annex |
| [AEP-0008](AEP-0008-text-answers-and-response-channels.md) | Text Answers and Response-Channel Declarations | receiver text-to-option mapping on option requests (never-permissive rule for `kind:"permission"`), `respond_via` as the request's authoritative channel declaration |
| [AEP-0009](AEP-0009-assessment.md) | Assessment: Evaluation Results and Human Feedback | new `assessment` category (closed-set change), 3 OPTIONAL `experimental` types (`evaluation.recorded` with the de-jure GenAI evaluation names, `feedback.received`, `guardrail.recorded`), envelope-carried targeting (`run`/`session`/`cause`), no relay behavior change |

The design arguments behind each decision live in that document's own Rationale
section; cite them, don't re-argue.

Statuses are defined in AEP-0001 §13, and the process in
[`../GOVERNANCE.md`](../GOVERNANCE.md), including the stability, deprecation,
and graduation policy in its §5. The suite is pre-`v0.1`: no compatibility
obligation exists before the first tag ([`../RELEASING.md`](../RELEASING.md)
§1). The protocol name is **AEP**, with `dev.aep.`, `aep://`, and `@aep/*` as
real identifiers. Prose is [CC-BY 4.0](LICENSE); new proposals start from
[`AEP-TEMPLATE.md`](AEP-TEMPLATE.md).
