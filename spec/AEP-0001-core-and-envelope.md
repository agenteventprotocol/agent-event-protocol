# AEP-0001: Purpose, Architecture, and Event Envelope

| Field | Value |
|---|---|
| **AEP** | 0001 |
| **Title** | Purpose, Architecture, and Event Envelope |
| **Type** | Standards Track — Core |
| **Status** | Draft |
| **Sponsor** | AEP maintainers |
| **Created** | 2026-07-03 |
| **Requires** | n/a |
| **Supersedes / Superseded-by** | n/a |

> Provenance (non-normative): this document consolidates the wire format,
> connection & lifecycle model, and envelope & taxonomy into one normative
> contract. It states only the resulting contract, not the design arguments
> behind it.

## Abstract

This document defines the purpose, scope, layered architecture, and event **envelope**
of the Agent Events Protocol (**AEP**: working title; all identifiers using the
`AEP` / `dev.aep.` / `@agenteventprotocol/*` roots are placeholders frozen at the naming decision).
AEP is an open, vendor-neutral protocol for **agent activity events and control**: any
agent emits lifecycle, progress, tool, resource, error, and attention events once
(over stdio, HTTP, SSE, or WebSocket), and any monitor, history store, notifier,
automation, or other agent consumes them once, for every agent.

This document establishes the event unit, its context attributes, the correlation
and replay model, severity and capture semantics, per-layer conformance, and the
AEP evolution process. The event-type dictionary is defined in AEP-0002; transport
bindings in AEP-0003; the control profile in AEP-0004; the CloudEvents, OTLP, and
OCSF bridge annexes in AEP-0005.

## 1. Motivation

Agents increasingly run concurrently and autonomously, yet there is no common way to
observe their activity, retain portable history, notify humans at the moments that
need them, or drive automation across vendors. Each runtime ships bespoke hooks with
*convergent* vocabularies but divergent spellings, and each integration re-implements
the same "an agent did X" signal. AEP standardizes that signal, and the return path
for acting on it. Non-goals are normative (§3.2).

## 2. Terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as
described in RFC 2119 and RFC 8174.

- **Event**: one AEP envelope instance (§5): a single self-describing JSON object
  describing one unit of agent activity, complete and meaningful in isolation.
- **Emitter**: a party that produces Events: an agent runtime, or an **adapter**
  translating a runtime's native hooks into Events.
- **Consumer**: a party that receives Events: dashboard, channel sink, history store,
  bridge, actioner, or another agent.
- **Endpoint**: any party terminating an AEP binding (AEP-0003); a party MAY be
  emitter and consumer simultaneously.
- **Relay (broker)**: an OPTIONAL intermediary that ingests, routes, fans out, and MAY
  keep a bounded replay buffer. AEP works without one.
- **Session**: the unit of agent conversation/work an emitter groups Events under.
- **Run**: one activation within a session (a turn, task, or job).
- **Step**: an optional sub-run grouping (an agentic-loop phase).
- **Control Event**: an Event delivered *to* an emitter to influence behavior
  (AEP-0004).
- **Attention request**: an Event signaling that an agent needs a human (or a
  policy delegate) to act.

## 3. Scope

### 3.1 In scope

The activity-event vocabulary and envelope; correlation, ordering, and replay
metadata; transport bindings and connection lifecycle; the consumer subscription and
filter model; the control profile; capture (content-privacy) semantics; conformance;
bridges to CloudEvents and OpenTelemetry; the AEP governance process.

### 3.2 Non-goals (normative)

AEP owns exactly one axis: **agent → humans & automations, fleet scope, durable,
bidirectional.** AEP **MUST NOT** be construed as, and this specification's evolution
**MUST NOT** grow into, any of the following:

- agent-to-agent delegation and task exchange (A2A's plane);
- frontend/UI rendering and generative UI (AG-UI's and A2UI's planes);
- tool and context provisioning (MCP's plane);
- editor-agent driving (ACP's plane);
- distributed tracing and APM (OpenTelemetry's plane; AEP bridges to it, AEP-0005);
- token-stream transport in the core (sub-profiles only);
- a required broker, or any normative channel/dashboard product (consumers are never
  specification surface);
- per-vendor payload quirks in the core namespace (`x.*` extensions exist for this).

The **fleet-observer test** is the scope court for every future addition: a core event
type or attribute MUST carry meaning for an observer watching *many* sessions they did
not initiate. Anything meaningful only inside one rendering surface belongs to a
neighbor protocol or an optional AEP sub-profile.

## 4. Architecture

### 4.1 Layers

AEP is specified in layers; conformance is claimed per layer (§10).

| Layer | Name | Contents | Where |
|---|---|---|---|
| L0 | Envelope | the Event unit and its context attributes | this document |
| L1 | Taxonomy | categories, registered types, payload schemas | AEP-0002 |
| L2 | Transports | JSONL, HTTP, SSE, WebSocket bindings; connection lifecycle; subscriptions | AEP-0003 |
| L3 | Control | bidirectional command profile (`experimental` in 0.1) | AEP-0004 |
| L4 | Extensions | vendor types, extension attributes, experimental capabilities | §11, AEP-0002 §6 |

Bridges (AEP-0005) are normative annexes of the specification, versioned and released
with it.

### 4.2 Topologies and the connection-optional principle

Direct (emitter → consumer) and relayed (emitter → relay → consumers) topologies are
both first-class. An Event's meaning and validity **MUST NOT** depend on topology,
transport, or the existence of any connection: the same JSON object is a valid Event
on stdout, in an append-only file, in an HTTP POST body, in an SSE `data:` field, and
in a WebSocket text frame. A relay **MUST NOT** alter core context attributes of
Events it forwards; it MAY add extension attributes (§5.4).

## 5. The Event envelope

An Event is a single JSON object (RFC 8259; UTF-8) consisting of **sixteen context
attributes** plus an optional **`data`** payload. Attributes 1 to 16 are the routing
surface: relays operate on them and **MUST NOT** require parsing `data`. Filters
address the filterable subset AEP-0003 §6.2 names. `data` is never filterable, and
four context attributes (`aep`, `time`, `seq`, `traceparent`) are carried, not
filtered.

### 5.1 Context attributes

| # | Attribute | Type | Requirement | Semantics |
|---|---|---|---|---|
| 1 | `aep` | string | REQUIRED | Protocol version of this Event's envelope, e.g. `"0.1"`. Doubles as the format marker for sniffing JSONL lines |
| 2 | `id` | string | REQUIRED | Unique per emitter (per `source`); the idempotency key: consumers MUST dedupe on `(source, id)` (§7). ULID RECOMMENDED (time-sortable) |
| 3 | `type` | string | REQUIRED | Bare AEP type, `{category}.{rest}` (§6); vendor extensions `x.{vendor}.{category}.{rest}` |
| 4 | `subject` | string | OPTIONAL | The acted-upon entity: tool name, file, task id, attention-request id |
| 5 | `time` | string | REQUIRED | RFC 3339 timestamp with timezone. Display/join metadata only; ordering authority is `seq` (§7), never `time` |
| 6 | `source` | URI string | REQUIRED | Identifies the emitting agent/session. RECOMMENDED form `aep://{host}/agent/{agent}/session/{session}`. Kept verbatim by the CE bridge |
| 7 | `agent` | string | REQUIRED | Stable logical identity of the emitting agent (e.g. `claude-code`) |
| 8 | `session` | string | Conditional (§5.2) | Session grouping key, unique within the emitting agent, never globally (§5.2) |
| 9 | `run` | string | OPTIONAL | Run/turn grouping within the session |
| 10 | `step` | string | OPTIONAL | Sub-run grouping (agentic-loop phase) |
| 11 | `seq` | integer >= 0 | Conditional (§5.2) | Per-session monotonic counter assigned emitter-side; ordering, replay, and resume basis (§7) |
| 12 | `epoch` | integer >= 0 | OPTIONAL (default `0`) | Restart generation of the emitter-side counter (§7) |
| 13 | `cause` | string | OPTIONAL | `id` of the immediately causing Event; the causal DAG edge |
| 14 | `traceparent` | string | OPTIONAL | W3C Trace Context header value, name kept verbatim (OTel interop) |
| 15 | `severity` | enum | OPTIONAL (default `info`) | `debug` < `info` < `notice` < `warning` < `error` < `critical` (§8.1) |
| 16 | `capture` | enum | OPTIONAL (default `metadata`) | Content-capture level: `none`, `metadata`, `redacted`, `full` (§8.2) |
| 17 | `data` | object | OPTIONAL | Type-specific payload (schemas: AEP-0002); see the `gen_ai.*` mirror rule below |

Absent OPTIONAL attributes MUST be omitted, not set to `null`. Consumers **MUST**
apply the stated defaults for `epoch`, `severity`, and `capture` when absent.

Where a `data` payload field has a stable OpenTelemetry `gen_ai.*` equivalent, its
name mirrors that equivalent verbatim, pinned per AEP version.

### 5.2 Session-scoped and agent-scoped Events

Events are **session-scoped** unless their category is `agent` (AEP-0002 §3).
Session-scoped Events **MUST** carry `session` and `seq`. **Agent-scoped** Events
(`agent.*`: presence, health, heartbeat) describe the emitter itself, not a session;
they **MUST** omit `session`, `run`, `step`, and `seq`, and are ordered by `time`
only.

One deliberate exception exists: **foreign-emitter session Events**. An
Event addressed to or about a session whose sequence counter its emitter does not
own (inbound `control.*` commands, AEP-0004 §2.2; consumer-emitted
`attention.routed`, AEP-0002 §7.3) carries `session` but **MUST omit `seq`**. Such
Events are ordered within the session view by `time` and by their `cause` links;
only the session owner's stream carries `(epoch, seq)` positions.

Session identity is scoped exactly like Event identity (§5.1 #2): a `session`
value is unique within its emitting agent, never globally. Every session has
exactly ONE owning emitter, the party that assigns its `(epoch, seq)` positions
(§7.1). Distinct emitters carrying the same `session` string are distinct
sessions that happen to share a name, not one session. Consumers that aggregate
streams from more than one emitter therefore key per-session state by
`(source, session)`, and the stream validators do the same.

Two surfaces still address a session by bare `session` in 0.1: control-command
routing (AEP-0004 §2.2, with the relay obligation of §4.5) and resume tokens
(§7.6). Both presume a unique live claimant at the point of use. The residual
ambiguity of a colliding name at those points is stated where it applies rather
than papered over.

### 5.3 Worked example (non-normative)

```json
{
  "aep": "0.1",
  "id": "01JX9YB3P4T9",
  "type": "tool.completed",
  "subject": "Bash",
  "time": "2026-07-03T10:15:04.221Z",
  "source": "aep://host-a/agent/claude-code/session/s_8f2c",
  "agent": "claude-code",
  "session": "s_8f2c",
  "run": "r_0042",
  "step": "turn-3",
  "seq": 187,
  "epoch": 0,
  "cause": "01JX9YB2Z1QK",
  "severity": "info",
  "capture": "metadata",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "data": {
    "tool": { "name": "Bash", "call_id": "t_91" },
    "status": "success",
    "duration_ms": 1240,
    "gen_ai.usage.input_tokens": 142,
    "gen_ai.usage.output_tokens": 87
  }
}
```

### 5.4 Extension attributes

Producers MAY add envelope attributes beyond §5.1. Extension attribute names **MUST**
match `[a-z0-9]{1,20}` (lowercase alphanumeric; deliberately the CloudEvents
extension-attribute constraint, so the AEP-0005 bridge passes them through verbatim),
**MUST NOT** collide with core attribute names, **SHOULD** begin with the vendor's
name, and **MUST** carry JSON string, integer, or boolean values only. Consumers
**MUST** ignore unknown envelope attributes without failure; relays **MUST** preserve
them. Core attributes are never reinterpreted by extensions.

An emitting library **MUST** refuse an extension attribute that would violate this
section: a name colliding with a core attribute (§5.1), an ill-formed name, or a
non-scalar value. It surfaces the error to its caller rather than emitting the
non-conformant envelope.

The collision case is why this rule binds the producing boundary. On the wire, a
core attribute overwritten by an "extension" is indistinguishable from the
attribute itself, so silent last-write-wins merging cannot be detected
downstream, only refused at the source.

## 6. Type naming and categories

An AEP `type` is a lowercase, dot-separated string `{category}.{rest}` where
`category` is one of the thirteen registered categories (AEP-0002 §3) and `rest` is
one or more `[a-z0-9_]+` tokens (e.g. `tool.completed`, `run.step.started`). In
vendor extension types the `{vendor}` token additionally allows `-`
(e.g. `x.claude-code.session.config_change`). Verbs are past-tense for facts; imperative
forms appear only in `control.*` (AEP-0004).

Types are **bare on the wire**: no reverse-DNS prefix inside an AEP stream. The
frozen reverse-DNS root (`dev.aep.` placeholder) is applied only at the CE and OTLP
bridges (AEP-0005) and at naming time.

Vendor extension types **MUST** use `x.{vendor}.{category}.{rest}` and **MUST NOT**
occupy the core namespace. Consumers **MUST** tolerate unknown types without failure
(unknown-type tolerance is a conformance fixture class).

## 7. Ordering, replay, and the `(epoch, seq)` contract

1. `seq` is a per-session monotonic counter **assigned by the emitter side** (the
   agent or its adapter, the party that owns session order), monotonically
   increasing within one `epoch`.
2. **Gaps are legal; regressions are not.** Consumers MUST tolerate gaps (dropped
   `debug` events, crashed adapter).

   Emitter-side: within one `epoch` an emitter MUST NOT assign a `seq` at or
   below one it already assigned, and MUST NOT assign one `(epoch, seq)`
   position to two different Events. That position-uniqueness invariant is what
   replay and resume rest on. Emitters MUST increment `epoch` on restart of a
   non-durable counter and MUST NOT reuse an earlier `epoch` within a session,
   which takes durable epoch memory or a monotonic seed such as a startup
   timestamp. An emitter that can guarantee neither MUST start a new session
   instead: without epoch monotonicity, resume tokens (rule 6) are ambiguous.

   Consumer-side: a below-high-water position is one of exactly two things. It
   is redelivery of an already-assigned Event (legal: dedupe on `(source, id)`,
   rule 4), or it is **backfill**, a not-yet-seen position delivered late (a
   second relay, a buffered replay). Consumers MUST order backfill by
   `(epoch, seq)` like any Event and MUST NOT infer a new epoch from it; a new
   epoch is only ever declared by the emitter via the `epoch` attribute. Two
   different Events claiming one position is an emitter fault consumers SHOULD
   surface rather than silently reorder.
3. The pair `(epoch, seq)` totally orders Events within a session, lexicographically.
   `time` MUST NOT be used as ordering authority.
4. Delivery on all bindings is **at-least-once**; consumers MUST dedupe on
   `(source, id)`: `id` is unique per emitter (§5.1 #2), never globally, so two
   emitters may legally mint the same `id` and a bare-`id` dedupe key silently
   drops one of them. Bare-`id` references (`cause`; the attention lifecycle's
   `subject`, AEP-0002 §7.1) resolve within one session's view, where every
   sequenced Event shares one emitter; their residual ambiguity against a
   colliding foreign-emitter Event's `id` is accepted in 0.1.
5. **Replay obligations split:** a live endpoint MAY keep a bounded replay buffer and
   MUST advertise its depth when it does (AEP-0003 §5); complete-history replay is a
   history consumer's product surface, not a relay duty. The specification guarantees
   *reconstructability* (emitter orders, the envelope makes every Event
   self-contained, a history consumer stores), not any single component's retention.
6. Resume tokens are `(session, epoch, seq)` triples; binding-specific carriage is
   defined in AEP-0003 (SSE `Last-Event-ID`, WS `subscribe.from`).

## 8. Severity and capture

### 8.1 Severity

Six levels, totally ordered, aligned to MCP/syslog practice:
`debug < info < notice < warning < error < critical`. Filters MAY compare severities
by this order (AEP-0003 §6). Endpoints under backpressure MAY drop `debug`/`info`
Events toward a slow consumer but MUST NOT silently drop `notice` and above
(AEP-0003 §8.4).

### 8.2 Capture

`capture` declares how much operation *content* the Event carries, and is enforced at
the source:

| Level | Meaning |
|---|---|
| `none` | envelope only; no payload content |
| `metadata` | structural metadata (names, ids, counts, durations, statuses); no free text |
| `redacted` | free text present with secrets/PII redacted per AEP-0003 §9 |
| `full` | verbatim content |

Rules:

(a) An Event's `data` MUST honor its declared `capture` level; payload schemas mark
each field's minimum level (AEP-0002 §5).

(b) Any party re-emitting or fanning out an Event MAY **down-level** content (strip
fields to a lower level, rewriting `capture` accordingly) and MUST NOT up-level.

(c) Subscription capture ceilings (AEP-0003 §6) are enforced by fan-out.

(d) The default emitter posture is `metadata`; content is opt-in.

(e) `redacted` is a **provenance claim**: it asserts the Event's free text passed
the redaction pipeline of AEP-0003 §9.4, and down-leveling can never mint that
claim mechanically.

A hop enforcing a `redacted` ceiling on a `full` Event MUST rewrite to
`metadata` (or lower) instead, unless the hop itself applies the §9.4 pipeline
to every `redacted`-gated field it keeps. Such a hop is a **redacting
re-emitter**, carrying the same incident-grade responsibility as an emitting
adapter. A `redacted`-source Event passes a `redacted` ceiling unchanged,
because its claim was minted at the source.

## 9. Emit paths

Programmatic (runtime/hook-driven) and LLM-fired (model-invoked, e.g. via an MCP
`emit_event` tool) emit paths **MUST** produce identical envelopes; consumers **MUST
NOT** rely on distinguishing them. Emitters **SHOULD NOT** use the LLM-fired path for
Events derivable programmatically.

## 10. Conformance

Conformance is claimed per layer and per role; layers above one's declared tier are
never required.

> An **emitter** is AEP-0.1 conformant if:
>
> - every Event it produces validates against the envelope schema;
> - every `type` is a registered core type or a legal `x.{vendor}.*` extension;
> - `seq` is monotonic per session within an `epoch`;
> - content honors the Event's declared `capture` level;
> - it emits at most one terminal Event per run and at most one `session.ended`
>   per session, and closes pending attention requests before `session.ended`
>   (AEP-0002 §2 convention 5, §7.2).
>
> A **consumer** is conformant if it deduplicates on `(source, id)`, tolerates
> unknown types and attributes without failure, and, on bindings it supports,
> implements `attr-match` subscription and `(session, epoch, seq)` resume as
> specified in AEP-0003.
>
> A **control-capable** party is additionally conformant only if it declares
> `control.accepts` at `hello`, nacks unknown or unauthorized commands, and
> acknowledges within the negotiated window (AEP-0004).

The conformance suite (golden fixtures + `aep validate` + protocol harness) is
normative for the badge; every accepted specification change MUST land with
conformance fixtures. Bridge conformance (CE round-trip identity) is defined in
AEP-0005 §5.

## 11. Versioning and evolution

- **Envelope version:** every Event carries `aep` (§5.1 #1) so connectionless
  bindings need no negotiation. Connection-level version negotiation is defined in
  AEP-0003 §4 (`hello`; one version per connection).
- **Evolution bias (additive only within a major):** new event types, new OPTIONAL
  envelope attributes, new capabilities. Core attributes and registered types are
  never repurposed or removed within a major version. A breaking change requires a
  major version and a superseding Standards-Track AEP.
- **Extension surfaces:** vendor types (§6), extension attributes (§5.4), and
  `capabilities.experimental` (AEP-0003 §4) are the three sanctioned extension
  points. The promotion path is extension → experimental core → core, via the AEP
  process (§13).

## 12. Security considerations

- **Content privacy:** default `capture: metadata`; content is opt-in, enforced at
  source (§8.2), down-levelable at every hop, and enforced again at the OTLP
  exporter (AEP-0005 §3.3).
- **Identity:** producer naming (`agent`, `source`) is REQUIRED; binding
  authentication is REQUIRED for off-host transports and unconditionally for
  control (RECOMMENDED on localhost; AEP-0003 §8); optional signed
  identity documents (JWS, A2A AgentCard shape) are specified as `experimental`
  (AEP-0003 §8.3). Identity is not authorization: who may command whom is
  deployment policy, not protocol surface, in 0.1.
- **Control is privileged:** authenticated duplex bindings only, capability-gated,
  acknowledged, idempotent, audit-visible by construction (AEP-0004).
- **Transport security:** TLS REQUIRED for anything off-host (AEP-0003 §8).
- **Event signing** for audit-grade history is deferred (revisit before any
  multi-tenant relay).
- **Identity is asserted, not proven, in 0.1:** `agent` and `source` are
  producer-supplied names. Binding authentication (AEP-0003 §8.1) establishes that a
  producer may emit at all, not that its claimed identity is true: an authenticated
  but misbehaving emitter can emit under another agent's name. Verifying claimed
  identity is a consumer policy (AEP-0003 §8.2); the signed identity document
  (AEP-0003 §8.3) is the `experimental` strengthening path.
- **Duplicates and replay:** delivery is at-least-once and consumers dedupe on
  `(source, id)` (§7), which bounds redelivery of the *same* Event. Re-emission of old content under
  fresh `id`s is indistinguishable from new activity at the protocol layer; the
  boundary against it is emit-side authentication (AEP-0003 §8.1), and audit-grade
  provenance awaits event signing (above).
- **Metadata still discloses:** even at `capture: metadata` (and in the envelope at
  `none`), Events reveal structure: tool names, `subject` values such as file or
  task identifiers, session cadence, and timing. Operators for whom that surface is
  sensitive have `capture: none` and the subscription ceiling (AEP-0003 §6.4);
  emitters keep `subject` to identifiers rather than content by construction (§5.1).
- **Extension attributes are untrusted input:** they are producer-controlled scalars
  that relays preserve (§5.4) and bridges forward (AEP-0005). Consumers that render
  them, template them into queries, or key automation on them are consuming
  unvalidated producer data and treat it with the same care as payload content.
- **Correlation identifiers are untrusted input too:** `session`, `run`, `step`,
  and `subject` are producer-supplied strings with no charset or length
  guarantee. Adapters pass vendor ids through verbatim, and at least one
  adopted source's session ids are contractually arbitrary. The schema
  constrains them only to non-empty strings by design, since rejection at the
  envelope would break conformant sources; consumers that use them as
  filesystem paths, URL segments, or query fragments encode or sanitize first
  (AEP-0003 §9.6).

  They are also not proof of identity: any authenticated emitter can claim any
  `session` string. That is why session identity is emitter-scoped (§5.2), why
  cross-emitter aggregation keys on `(source, session)`, and why a relay never
  routes a command on an ambiguous claim (AEP-0004 §4.5). A claimed name can
  deny control, surfaced at the sender, but never divert it.

## 13. Governance: the AEP process

AEP-numbered documents (`AEP-0001` onward) carry types **Standards Track — Core /
Binding / Annex**, **Informational**, or **Process**, and statuses
`Draft → Review → Accepted → Final` (or `Rejected` / `Withdrawn`). Requirements
adopted from MCP's SEP process: motivation/specification/rationale/backward-compat
sections; a sponsor once co-maintainers exist; **prototype and conformance fixtures
required before Accepted**. Breaking changes to the core namespace require a major
version and a superseding Standards-Track AEP.

**Governance firewall (normative):** no behavior ships in `aep-relay` or any
reference artifact before the corresponding specification change is Accepted. The
relay's feature ceiling (ingest, attr-match, fan-out, bounded replay, token auth;
nothing else) is fixed by the governance process.

Licenses: Apache-2.0 for code, SDKs, and schemas; CC-BY 4.0 for specification prose.

## 14. References

- RFC 2119, RFC 8174.
- RFC 8259 (JSON).
- RFC 3339 (timestamps).
- W3C Trace Context.
- CloudEvents 1.0 (bridge target, AEP-0005).
- OpenTelemetry Logs Data Model and GenAI semantic conventions (bridge target,
  AEP-0005).
- JSON Schema 2020-12 (normative schema language).
- MCP 2025-11-25 (lifecycle and governance patterns).
- ULID spec.
