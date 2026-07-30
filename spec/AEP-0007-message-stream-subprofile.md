# AEP-0007: Message and Stream Sub-Profile

| Field | Value |
|---|---|
| **AEP** | 0007 |
| **Title** | Message and Stream Sub-Profile |
| **Type** | Standards Track — Core |
| **Status** | Draft |
| **Sponsor** | AEP maintainers |
| **Created** | 2026-07-10 |
| **Requires** | AEP-0001 (envelope, capture), AEP-0002 (taxonomy, registry), AEP-0003 §8.4 (backpressure) + §9 (redaction pipeline) |
| **Supersedes / Superseded-by** | n/a (fills the AEP-0002 §4.3 reservation) |

## Abstract

Specifies the conversational surface AEP 0.1 deliberately left out: the
`message` category's reserved types (`message.user.submitted`,
`message.agent.replied`) as **durable full-content facts**, and a new
`stream` category (`stream.started` / `stream.delta` / `stream.finished`) as
the **live incremental view** of text being produced: model output,
reasoning summaries, streamed tool arguments. Both are optional core types
forming one sub-profile: emitters opt in, consumers already tolerate them
(unknown-type tolerance), and nothing becomes mandatory.

Content is capture-gated `redacted`+ with structural fallbacks at `metadata`,
deltas default to severity `debug` so existing backpressure rules shed them
first, and the redaction pipeline is required to hold across delta boundaries.
An annex maps AG-UI's event vocabulary onto the sub-profile.

## Motivation

AEP 0.1 scoped conversational content out of the core on purpose
(AEP-0001 §3.2: token-stream transport is sub-profile territory; `message.*`
reserved in AEP-0002 §4.3). The costs of leaving it unspecified are now
concrete:

- A fleet console can show that a session ran, which tools it touched, and
  what needs attention, but not *what the agent said or was asked*, which is
  the first thing an operator wants when a session looks wrong. History
  stores face the same hole: a session's replay reconstructs everything
  except the conversation.
- Every source vocabulary AEP maps carries this surface natively: AG-UI is
  *mostly* message/stream events (text-message and tool-call streaming
  triads, reasoning streams), and agent transcripts (Claude Code, Codex)
  are message sequences. Adapters today must drop that content or smuggle it
  through vendor types with no common shape.
- Consumers MUST already tolerate the reserved types as unknown
  (AEP-0002 §4.3): the wire is prepared; only the shape is missing.

The fleet-observer test (AEP-0001 §3.2) shapes the split this AEP makes:
*that* a message happened, from whom, of what size. A fleet observer acts on
that (activity, audit, history), so `message.*` facts belong in the
registered core as optional types.

Individual token deltas are meaningful only to a rendering surface (they fail
the test for core-mandatory status), which is exactly why `stream.*` is
specified as an opt-in sub-profile with drop-first backpressure semantics
rather than as a consumer obligation.

## Specification

### 1. Sub-profile, not new obligations

The types below are **optional core types** (AEP-0002 §4.2 status). No
consumer obligation is added: a consumer that ignores them stays conformant;
a consumer that renders them follows the rules here. Emitters declare the
categories they emit through the existing `hello` capability hints
(AEP-0003 §4); no new negotiation surface is introduced.

### 2. The `stream` category (addition to AEP-0002 §3)

The closed category set of AEP-0002 §3 gains one row (a category addition is
exactly a Standards-Track AEP's power, per §3's own rule):

| Category | Scope | Meaning | 0.x members |
|---|---|---|---|
| `stream` | session | live incremental content production | `stream.started`, `stream.delta`, `stream.finished` |

### 3. Correlation: `subject` carries the stream/message identity

Exactly as the attention lifecycle uses `subject` for its request id
(AEP-0002 §7.1):

1. Every `stream.*` Event MUST set `subject` to the **stream id**: an
   emitter-unique identifier for one production of content.
2. Every `message.*` Event MUST set `subject` to the **message id**.
3. A `stream.finished` Event SHOULD set `cause` to the `id` of its
   `stream.started` (the §2.1 pairing convention of AEP-0002);
   `stream.delta` Events MAY omit `cause` (`subject` correlates them).
4. When a stream produces a message (§5), the `message.*` Event SHOULD set
   `cause` to the `id` of the `stream.finished` Event.

### 4. Types and payload schemas

Conventions as AEP-0002 §5 (all fields OPTIONAL unless REQ; capture levels in
brackets; machine-readable schemas land in `schemas/types/` at acceptance).

**`message.user.submitted`**: a user-authored message entered the session.
**`message.agent.replied`**: an agent-authored message completed.

Payload (both): `message_id: string REQ [metadata]` (mirrors `subject`),
`role?: string [metadata]` (defaults `user` / `assistant` per type; carries a
source's finer roles, e.g. `developer`, `system`), `text?: string [redacted]`
(the full content, through the AEP-0003 §9.4 pipeline at `redacted`),
`text_digest?: string [metadata]` (AEP-0003 §9.3 digest of the original
content), `chars?: int [metadata]`, `truncated?: boolean [metadata]`,
`usage? [metadata]` (AEP-0002 §5.2), `"gen_ai.request.model"?: string
[metadata]`.

**`stream.started`**: content production began. Payload:
`kind: enum(message|reasoning|tool_args|output) REQ [metadata]`,
`role?: string [metadata]`.

**`stream.delta`**: an increment of content. Payload:
`text?: string [redacted]`, `chars?: int [metadata]`. At capture `redacted`+
`text` is REQUIRED; at lower ceilings see §6.

**`stream.finished`**: production ended. Payload:
`reason?: enum(completed|aborted|error) [metadata]` (default `completed`),
`chars?: int [metadata]` (total).

Severity defaults (normative): `stream.delta` Events SHOULD carry
`severity: debug`; `stream.started`/`stream.finished` and `message.*` default
`info` as usual. This is load-bearing: the existing backpressure rules
(AEP-0003 §8.4, AEP-0001 §8.1) then shed deltas first toward slow consumers
and never silently drop the durable facts.

### 5. The durable-fact / live-view split (normative)

1. Deltas are a **live view**: relays and endpoints MAY drop `stream.delta`
   Events under backpressure (they are `debug`) and bounded replay buffers
   MAY evict them first. No correctness property may depend on a consumer
   having seen every delta.
2. The **durable fact** is the `message.*` Event: an emitter that streams a
   message SHOULD emit the assembled `message.*` Event at completion (with
   `cause` per §3.4). A consumer that missed every delta still reconstructs
   the conversation from `message.*` alone.
3. Ordering: `stream.*` Events are ordinary session-scoped Events:
   `(epoch, seq)` orders them (AEP-0001 §7); deltas for one `subject`
   concatenate in `seq` order. Emitters MAY coalesce consecutive deltas of
   one stream into fewer, larger deltas.
4. Streams of `kind: "tool_args"` complement, never replace, the core
   `tool.*` lifecycle: the assembled arguments surface through
   `tool.requested` (AEP-0002 §5.3) exactly as without streaming.

### 6. Capture gating (normative)

`text` fields are user- or model-authored free text: `redacted` minimum,
never present at `metadata`. There is **no `[metadata*]` synthesis
exception** in this sub-profile (unlike `attention.requested.prompt`, nothing
here must remain human-readable for the protocol to function). At ceilings
below `redacted`:

1. `message.*` Events MAY still be emitted with structural payload only
   (`message_id`, `role`, `chars`, `text_digest`, `usage`): the fleet
   observer keeps activity, size, and correlation without content.
2. Emitters SHOULD suppress `stream.delta` entirely (emit only
   `started`/`finished`); a delta carrying only `chars` is permitted but
   rarely worth its cost.
3. Down-leveling hops (AEP-0001 §8.2) drop `text` per the annotations,
   mechanically.

**Redaction across delta boundaries.** Applying the AEP-0003 §9.4 pipeline to
each fragment independently does not satisfy §9: a secret split across two
deltas would evade every pattern.

Emitters MUST apply the pipeline over a window spanning delta boundaries (e.g.
by retaining a bounded tail of not-yet-emitted text until no §9.4 pattern can
match across the boundary) and MUST re-run the pipeline over the assembled
content before emitting the `message.*` fact. The conformance fixtures (below)
pin the split-secret case.

### 7. Bridges (AEP-0005 interaction)

The mappings apply unchanged (`message.*`/`stream.*` are ordinary Events).
Operational guidance is normative only at one point: the OTLP exporter's
capture enforcement (AEP-0005 §3.3) applies to `text` like any gated field.
Exporters SHOULD default to excluding `stream.delta` from export filters
(volume; the durable facts export instead). Operators opt in deliberately.

### 8. Registry changes (land at acceptance, SEP rule)

`schemas/registry/categories.json` gains `stream`; `types.json` moves
`message.user.submitted` and `message.agent.replied` from `reserved` to
`optional` and adds the three `stream.*` rows as `optional`; payload schemas
under `schemas/types/`; codegen regenerates.

## Conformance fixtures

Required before Accepted (GOVERNANCE §2); this Draft specifies them:

- **Golden**: a streamed-message sequence (`stream.started` →
  3 x `stream.delta` → `stream.finished` → `message.agent.replied`) with
  `subject`/`cause` links per §3, plus a `message.user.submitted`; validated
  by both runners.
- **Invalid**: `stream.delta` without `subject`; `stream.started` without
  `kind`; `stream.delta` carrying `text` on an Event whose `capture` is
  `metadata` (gating violation); a `message.*` Event whose `message_id`
  differs from `subject`.
- **Capture-gating**: `message.agent.replied` at ceiling `metadata` keeps
  `message_id`/`role`/`chars`/`text_digest`, drops `text`; down-level from
  `redacted` to `metadata` does the same mechanically.
- **Redaction**: a secret split across two `stream.delta` fragments: the
  emitted deltas MUST NOT reveal it (the §6 window rule); the assembled
  `message.*` text carries the `[REDACTED:secret]` replacement.
- **Mappings**: `conformance/fixtures/mappings/agui.json`: the first
  Annex rows pinned machine-usably (text-message triad → `stream.*` +
  `message.agent.replied`).

## Prototype

Required before Accepted; the intended shape: an **AG-UI inbound adapter**
in the reference stack (AG-UI SSE stream → AEP Events per the Annex) driving
the relay, with the flagship consumer rendering a live message tail and the
assembled conversation from `message.*` facts, proving both halves of the
§5 split end to end, plus the §6 split-secret redaction case exercised in an
adapter smoke.

Claude Code's `MessageDisplay` hook is a second candidate inbound source for
the same prototype (vendor-native assistant text with no AG-UI dependency; see
the [vendor-surface survey](../docs/vendor-surfaces.md)).

## Rationale

- **Two surfaces, one profile.** The durable-fact/live-view split resolves
  the tension that kept this out of 0.1: deltas are high-volume and
  rendering-local (they fail the fleet-observer test), while message facts
  are exactly what fleet observers and history stores need.

  Specifying only facts would lose live tails; only deltas would make history
  reconstruction depend on lossy streams. The split gives each consumer class
  the half it can afford.
- **`severity: debug` on deltas** reuses machinery instead of inventing it:
  AEP-0003 §8.4 already lets endpoints shed `debug` first and forbids
  silently dropping `notice`+. The flood-control story for token streams
  falls out of two existing rules and one default.
- **`subject` as the stream id** mirrors the attention lifecycle
  (AEP-0002 §7.1), the established AEP pattern for multi-event
  correlation, rather than adding payload-level join keys consumers must
  learn separately.
- **A `stream` category rather than `message.delta`**: AG-UI streams
  reasoning summaries and tool arguments with the same triad shape it uses
  for messages; one generic category with a `kind` field maps all three
  without inventing parallel families. `output` covers process/CLI output
  streams the same way.
- **Flat `text`, no parts array**: multimodal content is deferred (Open
  questions): MCP-style content parts would triple the schema surface for
  a need no mapped source vocabulary forces today; AG-UI deltas are text.
- **AG-UI as the anchor vocabulary** (Annex): it is the protocol whose
  entire purpose overlaps this sub-profile, so mapping it fully is the
  strongest completeness check available; its deprecated `THINKING_*` →
  `REASONING_*` rename also previews the deprecation mechanics
  GOVERNANCE §5.3 defines.

## Backward compatibility

Additive throughout: a new category (via the AEP-0002 §3 sanctioned path),
five optional types (two of them already-reserved names, spellings
unchanged), no new consumer obligations, no envelope change. Existing
consumers see unknown types they already tolerate. Pre-`v0.1`-tag acceptance
folds into the 0.1 Draft in place (the AEP-0006 precedent; RELEASING.md §1:
no compatibility obligation exists before the first tag); post-tag it
ships in the next `0.x` per GOVERNANCE §5.4.

## Security considerations

This sub-profile is the highest-volume content-bearing surface in AEP.
Conversation text and reasoning summaries are exactly the data the capture
model exists to protect:

- **`redacted` floor, no synthesis exception** (§6): message and stream text
  never appears at `metadata`, and the structural fallback keeps observers
  functional without content. The threat the exception-free rule removes is
  content smuggled into ceilings operators believed were content-free
  (AEP-0002 §8).
- **Split-secret evasion** (§6): per-fragment redaction is structurally
  unsound for streams; the cross-boundary window rule plus the assembled-fact
  re-run make the §9.4 pipeline hold. Post-emission failures remain security
  incidents (AEP-0003 §9.4).
- **Reasoning exposure**: only *visible* reasoning (summaries a source
  chooses to surface) maps here. Opaque or encrypted reasoning carriers,
  designed precisely not to be read, are out of scope and MUST NOT be
  lifted into `text` (an adapter MAY pass them as vendor extension data,
  where the AEP-0001 §12 untrusted-input posture applies).
- **Volume as a vector**: delta floods are bounded by the `debug` default +
  backpressure shedding (§4 and §5); replay buffers evict deltas first, so a
  hostile or runaway stream cannot displace durable facts from bounded
  buffers.
- **Bridge egress** (§7): exporters default to facts-only; a deliberate
  opt-in is required before token-level content leaves AEP's capture model
  (AEP-0005 §6).

## Open questions

| # | Question | Owner | Resolve by |
|---|---|---|---|
| 1 | Multimodal content parts (images, structured data in messages): parts array vs. sibling types | maintainers | before Accepted if a mapped source forces it; else next revision |
| 2 | AG-UI `MESSAGES_SNAPSHOT` (bulk conversation state): map to a `message.*` replay, a `state.snapshot` projection, or leave unmapped | maintainers | with the prototype (the adapter must do *something* with it) |
| 3 | Delta coalescing bounds: should a maximum delta rate/size be RECOMMENDED numerically | maintainers | with prototype measurements |
| 4 | Encrypted-reasoning carry-over (opaque continuity blobs): permanently out of scope, or a dedicated opaque envelope later | maintainers | next revision |
| 5 | Should `message.*` ever join the mandatory set (a major-version question by construction, AEP-0002 §6) | maintainers | not before 1.0 |

## Annex (normative when Accepted): AG-UI mapping

*Verification status (informative): specified from the published AG-UI
protocol documentation (docs.ag-ui.com, "Events", fetched 2026-07-10,
including the reasoning family and chunk transformers current at that date);
no reference adapter exists yet. Rows marked ⊙ are provisional pending the
prototype.*

Lifecycle and state rows restate AEP-0002 Annex A where the core already
covers AG-UI; they are listed so this table is a complete adapter guide.

| AG-UI event | AEP mapping | Notes |
|---|---|---|
| `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` | `run.started` / `run.finished` / `run.failed` | core (AEP-0002 Annex A) |
| `STEP_STARTED` / `STEP_FINISHED` | `run.step.started` / `run.step.finished` + envelope `step` | core |
| `TEXT_MESSAGE_START` | `stream.started` `{kind:"message", role}`; `subject` = `messageId` | |
| `TEXT_MESSAGE_CONTENT` | `stream.delta` `{text: delta}` | `severity: debug` |
| `TEXT_MESSAGE_END` | `stream.finished` then the assembled fact: `role:"assistant"` → `message.agent.replied`, `role:"user"` → `message.user.submitted`; other roles → the fact-type matching the author with `role` carried in payload | §5.2 |
| `TEXT_MESSAGE_CHUNK` | expand per AG-UI's own chunk-transformer rules, then map as the triad | |
| `TOOL_CALL_START` | `stream.started` `{kind:"tool_args"}`; `subject` = `toolCallId` | |
| `TOOL_CALL_ARGS` | `stream.delta` | |
| `TOOL_CALL_END` | `stream.finished`, then core `tool.requested` with assembled args per its schema | §5.4 |
| `TOOL_CALL_RESULT` | `tool.completed` | core |
| `TOOL_CALL_CHUNK` | expand, then as the tool-call triad | |
| `STATE_SNAPSHOT` / `STATE_DELTA` | `state.snapshot` / `state.delta` | core optional |
| `MESSAGES_SNAPSHOT` | ⊙ unresolved (Open question 2) | |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | `progress.status` | core optional |
| `REASONING_MESSAGE_START` / `_CONTENT` / `_END` | `stream.started` `{kind:"reasoning"}` / `stream.delta` / `stream.finished`; `subject` = reasoning `messageId` | visible reasoning only |
| `REASONING_START` / `REASONING_END` | no separate Event: framing around the message triad above | ⊙ confirm with prototype |
| `REASONING_MESSAGE_CHUNK` | expand, then as the reasoning triad | |
| `REASONING_ENCRYPTED_VALUE` | not mapped (opaque continuity carrier; see Security considerations) | |
| `RAW` | not mapped (transport passthrough); an adapter MAY use `x.agui.raw` | |
| `CUSTOM` | `x.{vendor}.*` per AEP-0001 §6 | |
| `THINKING_*` (deprecated) | as their documented `REASONING_*` replacements | |

## References

- AEP-0001 §3.2/§7/§8, AEP-0002 §3 to §6, AEP-0003 §8.4/§9, AEP-0005 §3.3.
- AG-UI protocol documentation (docs.ag-ui.com, Events; fetched 2026-07-10).
- MCP sampling message shapes (role/content parity check).
- GOVERNANCE §5 (stability and deprecation mechanics).
