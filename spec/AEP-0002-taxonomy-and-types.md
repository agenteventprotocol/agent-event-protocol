# AEP-0002: Event Taxonomy and the Mandatory Type Set

| Field | Value |
|---|---|
| **AEP** | 0002 |
| **Title** | Event Taxonomy and the Mandatory Type Set |
| **Type** | Standards Track — Core |
| **Status** | Draft |
| **Sponsor** | AEP maintainers |
| **Created** | 2026-07-03 |
| **Requires** | AEP-0001 |
| **Supersedes / Superseded-by** | n/a |

> Provenance (non-normative): categories and members were validated against five
> source vocabularies (Claude Code 29 hook events, Codex 10, AG-UI 33,
> OpenClaw 6 families, A2A 9 task states + 2 update events). Granularity is
> governed by the fleet-observer test (AEP-0001 §3.2).

## Abstract

Defines the thirteen normative event categories, the registered core type set for
AEP 0.1, the **fourteen mandatory types** every conformant consumer must understand,
the payload (`data`) schemas for every registered type, mandatory (§5.3) and
optional (§5.4), with per-field capture levels, the attention lifecycle,
and the registry/extension rules. The machine-readable registry
(`schemas/registry/`, JSON Schema 2020-12) is the single source of truth from which
SDK types are generated; where prose and registry disagree, the registry is
authoritative and the disagreement is a defect.

## 1. Conformance vocabulary for types

- A **registered core type** is listed in §4 (or added later through the AEP process).
- A **mandatory type** (subset of core, §4.1) is one a conformant *consumer* MUST
  understand well enough to display, store, and route correctly. Emitters emit
  whatever subset applies to them; there is no minimum emission set beyond honesty:
  an emitter MUST NOT misuse a registered type for a different meaning.
- An **optional core type** (§4.2) is registered with defined semantics; consumers
  SHOULD handle it and MUST tolerate it (unknown-type tolerance, AEP-0001 §6).
- A **vendor extension type** (`x.{vendor}.*`) is any type outside the core namespace
  (§6).

## 2. Structural conventions

1. **Start/finish pairing.** Long operations emit paired Events (`*.started` /
   terminal) sharing correlation ids (`run`, `tool.call_id`, or `subject`), with the
   terminal Event's `cause` SHOULD-linking the starting Event's `id`. Durations and
   hang detection derive from pairs.
2. **Distinct terminal states.** Success, failure, and cancellation are distinct
   types, not a status field on one type (`run.finished` / `run.failed` /
   `run.cancelled`): a fleet observer routes on `type` alone.
3. **Facts, past tense.** Core types state what happened. Imperatives exist only in
   `control.*` (AEP-0004).
4. **Payload minimalism.** Every payload field must earn its place at `metadata`
   level or be capture-gated (§5).
5. **Terminal exclusivity.** A lifecycle unit reaches at most one terminal: an
   emitter MUST NOT emit a second terminal Event for the same unit. For a run
   (one `run` value within a session), `run.finished` / `run.failed` /
   `run.cancelled` are mutually exclusive and unrepeatable across the session's
   lifetime (all epochs); the attention terminals are governed by §7. For a
   session, `session.ended` is likewise unrepeatable: an emitter MUST NOT emit
   a second distinct `session.ended` for the same session (all epochs).

   Session-scoped Events arriving after a terminal stay legal (asynchronous
   hook runtimes deliver late completions); only a second END is the violation.
   Zero terminals stays legal (§4.1's emitter-completeness note: arrival is
   never guaranteed).

   Exclusivity binds the *emitter*; delivery is still at-least-once, so
   consumers deduplicate redelivery of the same terminal Event (AEP-0001 §7)
   rather than treat it as a violation.

## 3. Categories (normative, closed set for 0.1)

An AEP type's first segment MUST be one of:

| Category | Scope | Meaning | 0.1 members |
|---|---|---|---|
| `agent` | agent-scoped | emitter presence, health, liveness | §4.2 |
| `session` | session | conversation/work-unit lifecycle | §4.1, §4.2 |
| `run` | session | activation lifecycle (turn/task/job) and steps | §4.1, §4.2 |
| `progress` | session | intermediate status, plans, artifacts | §4.2 |
| `tool` | session | tool/capability invocation lifecycle | §4.1 |
| `delegation` | session | subagent/delegate lifecycle | §4.2 |
| `attention` | session | human-needed moments; the lifecycle in §7 | §4.1, §4.2 |
| `resource` | session | external resources an agent touches | §4.2 (`experimental`) |
| `error` | session | faults not tied to a specific tool/run terminal | §4.2 |
| `state` | session | agent-owned state snapshots/deltas | §4.2 |
| `assessment` | session | evaluation results and human feedback about work; the home AEP is AEP-0009 | §4.2 (`experimental`) |
| `message` | session | conversational content; **optional sub-profile** | §4.3 stub |
| `control` | session | inbound commands and their acks | AEP-0004 |
| `x` (custom) | any | vendor extension namespace | §6 |

Adding, removing, or re-scoping a category requires a Standards-Track AEP.

## 4. Registered core types for 0.1

### 4.1 Mandatory types (14)

Chosen by two criteria: (a) they cover the founding scenarios (fleet timeline,
attention routing, unified history) end-to-end; (b) each is evidenced in at least two
of the five mapped source vocabularies. Payload schemas in §5.

| Type | One-line semantics |
|---|---|
| `session.started` | a session began; carries lineage (`parent`) and client info |
| `session.ended` | terminal for a session |
| `run.started` | an activation began within the session |
| `run.finished` | run reached success |
| `run.failed` | run reached failure (incl. rejection; `data.reason`) |
| `run.cancelled` | run was cancelled (by user, control, or policy); not a failure |
| `tool.requested` | a tool invocation is about to execute (pre-execution fact) |
| `tool.completed` | tool invocation succeeded |
| `tool.failed` | tool invocation errored |
| `tool.denied` | tool invocation was blocked pre-execution by policy/runtime; no human loop involved |
| `attention.requested` | the agent needs a human (or policy delegate); severity >= `notice` RECOMMENDED |
| `attention.answered` | a response to the request was produced (by human via control, or out-of-band) |
| `attention.resolved` | the request's lifecycle closed (answered/auto/dismissed) |
| `attention.timeout` | the request expired unanswered; terminal |

> **Emitter completeness (non-normative).** Mandatory status is a consumer
> obligation (§1): a conformant consumer understands all fourteen. It is not
> an emitter obligation: there is no minimum emission set, and real sources
> fall short of the fourteen for structural reasons. One of the five mapped
> vocabularies exposes no session-end hook, so `session.ended` never arrives
> from it, and no mapped hook surface distinguishes cancellation, so
> `run.cancelled` arrives only from control-capable emitters (AEP-0004 §5).
>
> The mandatory set is therefore not an arrival guarantee: a session may
> never end and a run may never reach a terminal, and correct consumers
> degrade gracefully (recency-based retention rather than end-gated cleanup).

### 4.2 Optional core types (registered, non-mandatory)

| Type | Semantics | Evidence anchor |
|---|---|---|
| `session.compacted` | context compaction occurred; emitted once at completion (§5.4) | CC `PreCompact`/`PostCompact` |
| `run.step.started` / `run.step.finished` | sub-run phase boundaries; set envelope `step` | AG-UI `STEP_*`, CC loop |
| `progress.status` | free-form progress heartbeat for a run | AG-UI `ACTIVITY_*`, A2A `WORKING` |
| `progress.task.planned` / `progress.task.completed` | plan-item lifecycle | CC `TaskCreated/Completed`, A2A `SUBMITTED` |
| `progress.artifact.produced` | an output artifact exists | A2A `TaskArtifactUpdateEvent` |
| `delegation.subagent.started` / `delegation.subagent.stopped` | subagent lifecycle; child session lineage via its `session.started.data.parent` | CC/Codex `Subagent*` |
| `attention.routed` | a router/sink delivered the request onward (emitted by consumers) | AEP attention lifecycle §7 |
| `agent.presence` | emitter presence changed (`online`/`offline`/`busy`) | OpenClaw `presence` |
| `agent.idle` | agent became idle/awaiting work | CC `TeammateIdle` |
| `agent.health` | health report (`ok`/`degraded`/`failing` + detail) | OpenClaw `health` |
| `agent.heartbeat` | liveness tick | OpenClaw `heartbeat` |
| `error.raised` | a fault outside tool/run terminals | common |
| `state.snapshot` / `state.delta` | agent-owned state image / JSON-Patch delta | AG-UI `STATE_*` |
| `resource.retrieval.requested` / `resource.retrieval.returned` / `resource.retrieval.reranked` | retrieval against an external corpus, with document provenance, and the rerank step that scores/reorders the result (§5.4) | vendor retriever / reranker span kinds (document id/content/score) |
| `resource.citation.recorded` | a produced answer's citations: which claim of the generated answer cites which source span, with the source ref, an offset (char/page/block), and the cited text (§5.4) | frontier answer-attribution shapes (source ref + cited-text span + char/page/block offset) |
| `assessment.evaluation.recorded` / `assessment.feedback.received` / `assessment.guardrail.recorded` | an assessment about work: an automated/LLM-judge evaluation result, a human feedback signal (rating/label/comment/correction), or an automated content-safety verdict already taken (a guardrail/filter fired on an input or output) (§5.4) | `gen_ai.evaluation.result` (name/score.value/score.label/explanation); feedback and guardrail outcomes are de-jure whitespace |

The `resource.*` and `assessment.*` rows are **`experimental`** (§6), advertised
under `capabilities.experimental` (AEP-0003 §4). The three `resource.retrieval.*`
types are the first `resource` members, and `resource.citation.recorded` is a
further one carrying the answer-to-source link beside the retrieval step's fetch.
The three `assessment.*` types are the first `assessment` members; their home AEP
is **AEP-0009**.

### 4.3 `message` sub-profile stub

`message.user.submitted` and `message.agent.replied` are **reserved** names for the
conversational sub-profile (content-bearing, capture-gated `redacted`+). Their full
schemas and the AG-UI mapping annex are deferred to the sub-profile AEP (an
open question for a future revision); 0.1 consumers MUST tolerate them as
unknown types.

## 5. Payload schemas for the mandatory types

### 5.1 Capture gating of payload fields (normative mechanism)

Every property in a payload schema carries an `x-aep-capture` annotation naming the
**minimum capture level at which the field may be present**: `metadata`, `redacted`,
or `full`. Rules:

1. An emitter MUST omit any field whose level exceeds the Event's `capture`.
2. A field marked `redacted` carries free text; at `capture: redacted` its content
   MUST have passed the redaction rules of AEP-0003 §9; at `capture: full` it may be
   verbatim.
3. Down-leveling a hop (AEP-0001 §8.2) means: drop every field above the new level
   and rewrite `capture`. The annotation makes this mechanical, with one boundary:
   `redacted` cannot be the *result* of a mechanical rewrite from `full`, because
   rule 2's provenance guarantee is not established by dropping fields. A hop
   holding a `full` Event against a `redacted` ceiling rewrites to `metadata`
   unless it applies the AEP-0003 §9.4 pipeline itself (AEP-0001 §8.2(e)).
4. Fields without the annotation default to `metadata`.

### 5.2 Common payload objects

- **`tool_ref`** `{ name: string (metadata), call_id?: string (metadata) }`
- **`error_info`** `{ type?: string (metadata), message?: string (redacted) }`
- **`usage`**: token accounting; field names mirror OTel GenAI verbatim:
  `{ "gen_ai.usage.input_tokens"?: int, "gen_ai.usage.output_tokens"?: int }`
  (metadata).
- **`cost`**: monetary cost of the work the Event accounts for. The de-jure
  GenAI conventions deliberately omit cost (token counts only; cost is treated
  as a derived estimate), so AEP names it natively:

  `{ currency: string REQ [metadata], total?: number, prompt?: number,
  completion?: number, cache?: number, reasoning?: number }` (all amounts
  [metadata])

  `currency` is an **ISO 4217 alpha-3 code** (e.g. `"USD"`) and is REQUIRED
  whenever `cost` is present: an amount is never a bare float without its unit.
  Amounts are non-negative decimals in that one currency; `total` is the whole
  cost and the breakdown members (prompt/completion/cache/reasoning) are
  optional and need not sum to `total`.

  Cost is **emitter-asserted**: it states what the emitter computed, never a
  value the relay or a consumer derives. Like `usage`, the object is open, so a
  vendor MAY carry additional cost members (they default to metadata capture,
  §5.1 rule 4).
- **`document`**: one retrieved document's provenance, carried in the
  `resource.retrieval.returned` documents array (§5.4). The provenance is the
  fact worth recording; the retrieved text is sensitive and gated:

  `{ id?: string [metadata], score?: number [metadata], content_redacted?:
  string [redacted], content?: string [full], metadata?: object [metadata] }`

  - `id` is the corpus/document identifier and `score` the emitter's
    relevance/similarity score. Both are **emitter-asserted**: the value the
    emitter computed, never relay-derived. `score` is unbounded, since a
    similarity may be negative and the emitter states its own scale.
  - `content` carries the retrieved text verbatim ([full]);
    `content_redacted` carries it through the AEP-0003 §9 redaction pipeline
    ([redacted]). This is the same two-field pattern as `tool.completed`'s
    `result`/`result_redacted`, so a `redacted`-ceiling hop keeps the redacted
    form and a `metadata` ceiling drops both content fields mechanically (§5.1).
  - `metadata` is an open object for structural provenance (a source or uri
    token, a rank).

  The object is open: a vendor MAY carry additional document members (they
  default to metadata capture, §5.1 rule 4).
- **`citation`**: one answer-side attribution, a span of a *produced answer*
  bound to the **source** it cites, carried in the `resource.citation.recorded`
  citations array (§5.4). The source ref plus offset is the fact worth
  recording; the quoted span is sensitive and gated:

  `{ source: { id?: string [metadata], uri?: string [redacted], title?:
  string [redacted] } REQ [metadata], cited_text_redacted?: string
  [redacted], cited_text?: string [full], offset?: { char?: { start?: int,
  end?: int }, page?: { page?: int, start?: int, end?: int }, block?: {
  block?: int, start?: int, end?: int } } [metadata], document_index?: int
  [metadata] }`

  - `source` is REQUIRED, since a citation with no source is not a citation,
    but its members are individually optional: a source may be named by a
    corpus/document `id`, a `uri`, or a human `title`. `id` is a structural
    identifier ([metadata]), while `uri` and `title` are content-capable (a URI
    may carry a path or query) and gated ([redacted]), as
    `progress.artifact.produced`'s `uri`/`name` are.
  - `cited_text` carries the quoted span verbatim ([full]);
    `cited_text_redacted` carries it through the AEP-0003 §9 redaction pipeline
    ([redacted]). This is the same two-field pattern as the `document` object's
    `content`/`content_redacted`, so a `redacted`-ceiling hop keeps the redacted
    span and a `metadata` ceiling drops both text fields mechanically (§5.1).
  - `offset` locates the span within the source. It is an object with three
    OPTIONAL variant members: `char` (character offsets), `page` (a page number
    with an optional in-page span), and `block` (a content-block index with an
    optional span), **at most one populated** for a given citation. The shape is
    open (§5.1), so the one-variant rule is stated here and pinned by the golden
    vector, not closed by `additionalProperties`.
  - `document_index` points into an ordered source set the answer knows (e.g.
    the `resource.retrieval.returned` documents), when one exists.

  The object is **emitter-asserted** and neutral-native: no de-jure dotted name
  exists across the surveyed answer-attribution shapes, so AEP models the common
  object, and the offset-variant union generalizes the character/page/block
  location shapes those emit. It is open, so a vendor MAY carry additional
  citation members (they default to metadata capture, §5.1 rule 4).
- **`guardrail`**: one automated content-safety verdict already taken, a
  guardrail / safety-filter / content-moderation check that fired on an input or
  an output, carried by `assessment.guardrail.recorded` (§5.4). The verdict and
  its categories are the fact worth recording; a rationale can quote the
  offending content, so it is gated:

  `{ stage?: enum(input|output) [metadata], verdict?: enum(allowed|flagged|
  blocked|modified) [metadata], categories?: [{ name: string [metadata],
  score?: number [metadata] }] [metadata], detector?: { name?: string
  [metadata], version?: string [metadata] } [metadata], explanation?: string
  [redacted] }`

  - `stage` names what was scored (a prompt/input or a produced output).
  - `verdict` is the convergent union across the surveyed producer vocabularies:
    `allowed` (nothing fired), `flagged` (a soft warn, not a hard stop),
    `blocked` (a hard stop / refusal), `modified` (the guard rewrote or redacted
    the content).
  - `categories` are the violated/evaluated policy categories. `name` is a
    **free vendor-taxonomy string, deliberately NOT a closed enum**: the
    taxonomies diverge, so closing it would bless one vendor or force a lossy
    mapping, and injection/jailbreak is one such `name`, not its own type.
    `score` is the emitter's per-category score, **emitter-asserted** and
    unbounded; the emitter states its own scale.
  - `detector` names the guard model / filter / rule engine that produced the
    verdict, a value with its version companion, the common-object idiom. Any
    real model name is genericized in fixtures.
  - `explanation` is a free-text rationale. It can quote the offending content,
    so it routes through the AEP-0003 §9 redaction pipeline ([redacted]) and
    drops at a `metadata` ceiling, leaving the verdict/categories/detector fact.

  The object is **emitter-asserted** and neutral-native: the de-jure
  observability track carries no guardrail attribute and the producer names
  diverge, so AEP models the common object, and the `verdict` values are the
  convergent union, naming no single producer. It is open, so a vendor MAY carry
  additional guardrail members (they default to metadata capture, §5.1 rule 4).
- **`field_spec`** (AEP-0006): one typed field of a `kind: "form"` attention
  request; deliberately restricted to flat primitives (the same
  string/number/boolean/enum subset MCP elicitation's `requestedSchema` uses):

  ```
  field_spec = {
    id:          string                                    REQ [metadata]
    type:        enum(string|number|boolean|select)        REQ [metadata]
    label:       string                                    REQ [metadata*]  (same exception rule as prompt/options[].label: structural placeholder at metadata, real content at redacted+)
    required:    boolean                                       [metadata]  (default false)
    multi:       boolean                                       [metadata]  (default false; only meaningful when type:"select": multiple choices may be selected)
    other:       boolean                                       [metadata]  (default false; type:"select" only: the responder MAY answer with free text instead of a choices[].id; see the values gating rule under attention.answered)
    choices:     [{ id: string [metadata], label: string [metadata*] }]  [metadata]  (REQUIRED when type:"select"; same label exception as above)
    min:         number                                        [metadata]  (type:"number" only)
    max:         number                                        [metadata]  (type:"number" only)
  }
  ```

### 5.3 Per-type schemas

Machine-readable versions: `schemas/types/{type}.schema.json`. All fields OPTIONAL
unless marked REQ. Levels in brackets.

**`session.started`**: `label?: string [redacted]` (human title; may quote the task),
`parent?: { session: string, run?: string, agent?: string } [metadata]` (subagent
lineage), `client?: { name: string, version?: string } [metadata]`,
`"gen_ai.request.model"?: string [metadata]`, `cwd?: string [redacted]`.

**`session.ended`**: `reason?: enum(normal|error|timeout|killed|compaction)
[metadata]`, `duration_ms?: int [metadata]`, `runs?: int [metadata]`.

**`run.started`**: `trigger?: enum(user|schedule|agent|control|resume) [metadata]`,
`prompt?: string [redacted]`, `usage? [metadata]`, `cost? [metadata]` (§5.2).

**`run.finished`**: `duration_ms?: int [metadata]`, `usage? [metadata]`,
`cost? [metadata]` (§5.2), `summary?: string [redacted]`.

**`run.failed`**: `reason: string REQ [metadata]` (machine token, e.g. `error`,
`rejected`, `budget_exceeded`), `error?: error_info`, `duration_ms?: int [metadata]`.

**`run.cancelled`**: `by?: enum(user|control|policy|shutdown) [metadata]`,
`reason?: string [redacted]`, `duration_ms?: int [metadata]`.

**`tool.requested`**: `tool: tool_ref REQ`, `args_digest?: string [metadata]`
(stable hash of arguments: correlation without content), `args?: object [full]`,
`args_redacted?: object [redacted]`.

**`tool.completed`**: `tool: tool_ref REQ`, `duration_ms?: int [metadata]`,
`status?: string [metadata]` (default `success`), `result_digest?: string [metadata]`,
`result?: object|string [full]`, `result_redacted?: object|string [redacted]`,
`usage? [metadata]`, `cost? [metadata]` (§5.2).

**`tool.failed`**: `tool: tool_ref REQ`, `error: error_info REQ`,
`duration_ms?: int [metadata]`.

**`tool.denied`**: `tool: tool_ref REQ`, `by: enum(policy|user_setting|runtime) REQ
[metadata]`, `rule?: string [metadata]` (the matching policy identifier).

**`attention.requested`**: `kind: enum(permission|input|auth|review|form|other)
REQ [metadata]`, `prompt: string REQ [metadata*]`, `options?: [{ id: string
[metadata], label: string [metadata*] }] [metadata]`, `fields?: [field_spec]
[metadata]`, `expires_at?: RFC3339 [metadata]`, `respond_via?:
array(enum(control|oob)) [metadata]`, `context?: object [full]`. Per field:

- `kind`: `form` denotes a structured multi-field request (AEP-0006); see
  `fields` below.
- `prompt`: what the human must read. *Gated by exception*: at capture
  `metadata` the content MUST be synthesized from structural metadata only, per
  AEP-0003 §9.2; at `redacted`+ it may carry hook-provided text passed through
  the AEP-0003 §9.4 pipeline. For `kind: "form"` it carries the form's overall
  message or title under the same rule.
- `options`: closed-choice answers. *Labels gated by exception, same rule as
  `prompt`*: at capture `metadata` a `label` MUST be a structural placeholder
  (e.g. the option's 1-based index as a string), never model-generated content;
  at `redacted`+ it may carry the real label through the AEP-0003 §9.4 pipeline.
- `fields`: present only when `kind: "form"`; see §5.2.
- `respond_via`: how a response can be delivered; when present it is the
  emitter's authoritative declaration for THIS request: consumers SHOULD offer
  control delivery only if `control` is listed, and a present value without
  `control` marks the request informational on the bus, with its answer arriving
  by the stated channel, e.g. `oob` for a decision made in the agent's own UI;
  see AEP-0008.

**`attention.answered`**: `answer: { option?: string [metadata], text?: string
[redacted], values?: object [metadata*] } REQ`, `by?: string [metadata]`
(responder identity label), `via?: enum(control|oob) [metadata]`.

`values` is present only answering a `kind: "form"` request (AEP-0006). It is a
flat map of `field_spec.id` to the field's answer: a string for `type:"string"`,
a number for `type:"number"`, a boolean for `type:"boolean"`, a `choices[].id`
string for single-select, an array of `choices[].id` strings for `multi:true`.
For a `select` field with `other: true`, a free-text string that is not a
`choices[].id` is also allowed.

*Gated by exception, type-dependent*: a `string`-typed field's value (and an
`other` free-text value on a `select` field) is user-authored text and follows
the same rule as `answer.text` (`redacted` minimum, never `metadata`);
`number`/`boolean`/closed single- or multi-`select` values are structural
(ids/primitives, never model- or user-authored prose) and stay `[metadata]`.

An emitter MUST reject (`control.rejected{reason:"invalid"}`) a
`control.attention.respond` whose `values` does not cover every `field_spec` with
`required: true`, or that carries a non-`choices[].id` string for a `select` field
whose `other` is absent/false.

*Text answers against `options` (AEP-0008).* When a `control.attention.respond`
carries `text` and no `option` answering a request that offered `options`, the
receiving emitter SHOULD treat text that, after trimming, case-insensitively
equals an option's `id`, or exactly one option's `label`, as that option,
recording the mapped choice as `answer.option` on `attention.answered` (the
matched word is the decision itself, not accompanying text).

For `kind: "permission"` requests, unmatched text MUST NOT be applied as the
permissive choice: the emitter SHOULD either apply its refusing option with the
text preserved as the stated reason (under `answer.text`'s capture rule) or
reject the command (`control.rejected{reason:"invalid"}`).

The recorded `answer` always states what was actually applied. Consumers
MUST NOT depend on text mapping: `option` remains the lossless channel.

**`attention.resolved`**: `resolution: enum(answered|auto|dismissed) REQ [metadata]`,
`latency_ms?: int [metadata]` (request → resolution).

**`attention.timeout`**: `after_ms?: int [metadata]`.

### 5.4 Per-type schemas for the optional core types

The optional core types (§4.2) carry payload schemas under the same rules as
§5.3: machine-readable versions at `schemas/types/{type}.schema.json`, all
fields OPTIONAL unless marked REQ, levels in brackets, and the same capture
gating (§5.1).

The schemas are **open**: an emitter MAY carry additional vendor fields in
`data` (they validate as extensions and default to `metadata` capture, §5.1
rule 4), so a schema names the cross-vendor fields without closing the payload.
A consumer MUST tolerate unknown members (AEP-0001 §6); these schemas type the
known ones.

**`session.compacted`**: `trigger?: string [metadata]` (why compaction ran, e.g. `auto`,
`manual`, `threshold`), `strategy?: string [metadata]` (how, e.g. `truncate-middle`),
`estimated_token_count?: int [metadata]` (context size at compaction),
`forgotten?: int [metadata]` (count of dropped items), `"gen_ai.usage.input_tokens"?: int`,
`"gen_ai.usage.output_tokens"?: int [metadata]` (§5.2 usage, flat as in `run.started`).

**Emission is single, at completion**: an emitter emits `session.compacted`
once, after a compaction has occurred, as a fact, not as a paired start/finish.
An emitter with a distinct pre-moment marker MAY `cause`-link it via the
envelope, but no pair is required or implied.

**`run.step.started`**: `name?: string [redacted]` (a phase label; content-capable, so gated),
`initial_num_steps?: int [metadata]` (planned step count). The step id itself rides the
envelope `step` (AEP-0001 §5), not the payload.

**`run.step.finished`**: `status?: string [metadata]` (outcome token; `success` by convention).

**`progress.status`**: `message?: string [redacted]` (human-readable status text),
`phase?: string [metadata]` (structural phase token), `percent?: number [metadata]` (0-100).

**`progress.task.planned`**: `task?: { id?: string [metadata], title?: string [redacted] }
[metadata]` (the plan item; `title` is content-capable), `parent?: string [metadata]`
(parent task id for nested plans).

**`progress.task.completed`**: `task?: { id?: string [metadata], title?: string [redacted] }
[metadata]`, `status?: string [metadata]` (how it ended; `completed` by convention).

**`progress.artifact.produced`**: `artifact?: { id?: string [metadata],
name?: string [redacted], mime?: string [metadata], bytes?: int [metadata],
uri?: string [redacted] } [metadata]` (`name`/`uri` may carry content or paths, so gated).

**`delegation.subagent.started`**: `child?: { session?: string, run?: string, agent?: string }
[metadata]` (the child's lineage handle; the full lineage is on the child's own
`session.started.data.parent`, §5.3), `agent_type?: string [metadata]` (a structural type
label), `role?: string [metadata]`.

**`delegation.subagent.stopped`**: `child?: { session?: string, run?: string, agent?: string }
[metadata]`, `agent_type?: string [metadata]`, `status?: string [metadata]` (outcome token),
`duration_ms?: int [metadata]`.

**`attention.routed`**: `to?: string [metadata]` (the surface the request was routed to, a
destination token, e.g. `slack`), `via?: string [metadata]` (the router mechanism token). The
correlation to the request rides the envelope `subject` (§7.1); `attention.routed` is
foreign-emitter and session-scoped to the original session, and MUST omit `seq` (§7.3).

**`agent.presence`**: `state: enum(online|offline|busy) REQ [metadata]`.

**`agent.idle`**: `since_ms?: int [metadata]` (how long idle), `reason?: string [metadata]`
(a structural reason token, e.g. `awaiting_input`).

**`agent.health`**: `status: enum(ok|degraded|failing) REQ [metadata]`,
`detail?: string [redacted]` (the human-readable detail).

**`agent.heartbeat`**: `tick?: int [metadata]` (a monotonic liveness counter, distinct from
the envelope `seq`), `interval_ms?: int [metadata]` (the expected cadence, so a watcher knows
the staleness threshold).

**`error.raised`**: `error?: error_info` (§5.2: `{ type?: string [metadata],
message?: string [redacted] }`), `code?: string [metadata]` (a machine error-code token),
`fatal?: boolean [metadata]` (whether it ended the run or session).

**`state.snapshot`**: `state?: object [redacted]` (the agent-owned state image; free-form
content passed through the redaction pipeline, so `redacted`), `key?: string [metadata]`
(which state channel), `rev?: int [metadata]` (the snapshot revision).

**`state.delta`**: `delta?: array [redacted]` (an RFC 6902 JSON-Patch operations array against
the last snapshot for `key`; content-bearing, so `redacted`), `key?: string [metadata]`,
`rev?: int [metadata]` (the target revision). The `delta` array is the change; a bare change
count is a vendor extension, not this field.

The three **`resource.retrieval.*`** types are **`experimental`** (§6), the first
members of the `resource` category (§3), advertised under
`capabilities.experimental` (AEP-0003 §4). They model a retrieval against an
external corpus, the request/return lifecycle the taxonomy uses elsewhere
(`tool.requested`/`tool.completed`), plus the optional rerank step a RAG pipeline
runs to score and reorder the returned set.

The de-jure observability track names only a bare `retrieval` operation; the
document-provenance and rerank shapes are standardized only at the vendor layer
(first-class retriever / reranker span kinds carrying document id/content/score),
so AEP names them natively and neutrally.

**`resource.retrieval.requested`**: `query?: string [redacted]` (the retrieval query;
content-bearing, so gated), `query_digest?: string [metadata]` (a stable hash of the query:
correlation without content, mirroring `tool.requested`'s `args_digest`), `corpus?: string
[metadata]` (which corpus/index, a structural token), `top_k?: int [metadata]` (how many
documents were requested).

**`resource.retrieval.returned`**: `documents?: [document] [metadata]` (the result set as an
array of the `document` common object, §5.2; each document's *fields* self-gate, so at
`capture: metadata` the documents carry only id/score/metadata and the content fields drop),
`count?: int [metadata]` (number of documents returned), `corpus?: string [metadata]` (echoes
the request), `duration_ms?: int [metadata]` (retrieval latency). The document text is
`[redacted]`/`[full]`-gated per the `document` object (§5.2): the provenance/score is the
fact, the content routes through AEP-0003 §9 redaction.

**`resource.retrieval.reranked`**: the optional rerank step that scores and reorders a
candidate set (the pre-registered follow-up to the retrieval lifecycle above).

- `query?: string [redacted]` (the rerank query; content-bearing, so gated) and
  `query_digest?: string [metadata]` (its stable hash) mirror
  `resource.retrieval.requested`.
- `model?: string [metadata]` names the reranker model (a structural token,
  emitter-stated); `top_k?: int [metadata]` is how many documents the rerank kept.
- `input_documents?: [document] [metadata]` is the candidate set the rerank scored
  and `output_documents?: [document] [metadata]` the scored/reordered result. Both
  are arrays of the `document` common object (§5.2), so each document's *fields*
  self-gate exactly as the returned set's do (`score` now the rerank score,
  `content`/`content_redacted` `[full]`/`[redacted]` through AEP-0003 §9).
- `count?: int [metadata]` (number of output documents) and `duration_ms?: int
  [metadata]` (rerank latency) close it.

`input_documents`/`output_documents`/`top_k` are neutral structural fields: the shape
is informed by the vendor reranker span kinds but names nothing of them.

The **`resource.citation.recorded`** type is **`experimental`** (§6), a further `resource`
member modeling **answer-side attribution**: which claim of a *produced answer* cites which
source span. It is distinct from the retrieval lifecycle above. `resource.retrieval.*` models
what was *fetched* (the document provenance); `resource.citation.recorded` models what the
*answer cited* (the answer-to-source link).

The surveyed frontier answer-attribution shapes converge on the concept (a source ref +
a cited-text span + a character/page/block offset) but their dotted names diverge, and
the de-jure observability track names none of it, so AEP models the **`citation` common
object** natively (§5.2). **`citations?: [citation]` [metadata]** carries the answer's
citations, and **`count?: int [metadata]`** is their number. Each citation's *fields*
self-gate (§5.2), so at `capture: metadata` a citation keeps its source `id`, `offset`,
and `document_index` and drops the `cited_text*` plus `uri`/`title`.

The event targets the produced answer it attributes **through the envelope**, the same
rule `assessment.*` follows (§7 / AEP-0009 §2): the assessed run and session are the
envelope's `run`/`session`, and the specific produced event SHOULD be the envelope's
`cause`. That produced event is a `run.finished`, or a `message.agent.replied` once the
message sub-profile lands. No payload carries a target id (the `usage`/`cost`/`assessment`
precedent, §5.2).

The three **`assessment.*`** types are **`experimental`** (§6), the first members of the
`assessment` category (§3), advertised under `capabilities.experimental` (AEP-0003 §4). Their
home AEP is **AEP-0009**, which carries the full motivation, rationale, and backward-compatibility
argument; the payload shapes below are the normative summary.

An assessment is a judgment *about* work (an evaluation, a human signal, or a safety
verdict), not a phase *of* the work. It targets the run/output it assesses through the
envelope (`run`, `session`, and `cause` pointing at the assessed event, e.g. a
`run.finished`), so no payload carries a target id. All three are **emitter-asserted**:
they state what an evaluator computed, what a human supplied, or what a guard produced,
never a value the relay derives.

**`assessment.evaluation.recorded`** (an automated / LLM-judge / code evaluation): the field
names mirror the de-jure GenAI evaluation convention verbatim, as `usage` mirrors the token
counts.

- `gen_ai.evaluation.name?: string [metadata]` (the metric name).
- `gen_ai.evaluation.score.value?: number [metadata]` (the numeric score; unbounded, and
  the evaluator states its own scale).
- `gen_ai.evaluation.score.label?: string [metadata]` (the categorical verdict, e.g.
  `pass`/`fail`).
- `gen_ai.evaluation.explanation?: string [redacted]` (the evaluator's free-text
  rationale; may carry sensitive content, so gated).
- `evaluator?: string [metadata]` (a native token naming the judge or check that produced
  this: an LLM-judge model or a code-check id).

The kind is carried structurally (a numeric `score.value` and/or a string `score.label`), not
by a data-type discriminator.

**`assessment.feedback.received`** (a human or end-user feedback signal): de-jure whitespace, so
AEP names it natively and neutrally.

- `rating?: number [metadata]` (a numeric magnitude: a thumbs `±1`, a 1-5 star).
- `label?: string [metadata]` (a categorical verdict, e.g. `thumbs_up`).
- `comment?: string [redacted]` (free-text feedback; content-bearing, so gated).
- `correction?: string [redacted]` (a corrected/ground-truth output the human supplied;
  content-bearing, so gated).
- `source?: string [metadata]` (where the feedback came from, e.g. `human`/`end_user`: the
  feedback's author, which the emitter identity, the relay/adapter, does not carry).

**`assessment.guardrail.recorded`** (an automated content-safety verdict already taken) is the
third `assessment` member. A guardrail / safety-filter / content-moderation check fired on an
input or an output, with its verdict, the violated categories, an optional per-category score,
the detector, and an optional rationale.

It is distinct from the two siblings above: an *evaluation* is a quality judgment
(a metric name + score), a guardrail is a *safety* verdict (a verdict + violated
categories) produced by a moderation/guard model or rule engine.

It is also distinct from the interactive approval gate
(`attention.*`/`control.*`, where a *human* is ASKED and answers in-band, while a
guardrail is automated, no question, no pending answer), from `tool.denied` (a
TOOL policy deny; a guardrail scores *content*, tool-independent), and from
`error.raised` (a block is a *successful* policy action, not a fault).

The de-jure observability track carries no guardrail attribute and the producer
names diverge, so AEP models the **`guardrail` common object** natively (§5.2).
The payload is that one object, **`guardrail?: guardrail`**, and its *fields*
self-gate (§5.2), so at `capture: metadata` the event keeps
`stage`/`verdict`/`categories`/`detector` and drops the `explanation`.

Like its siblings it targets the scored work **through the envelope**
(§7 / AEP-0009 §2): the scored run and session are the envelope's
`run`/`session`, and the specific scored event (a `run.finished`, a
`tool.requested`, a produced answer) SHOULD be the envelope's `cause`. No
payload carries a target id.

## 6. Registry and extension rules

- The registry files (`schemas/registry/categories.json`, `types.json`,
  `severity.json`, `capture.json`) enumerate the closed sets above; `types.json`
  records each type's status (`mandatory` | `optional` | `reserved`), scope
  (`session` | `agent` | `command`; the third marks the foreign-emitter
  control commands of AEP-0004 §2.2), and payload-schema reference.
- Vendor types `x.{vendor}.{category}.{rest}` MUST NOT appear in the registry's core
  namespace; vendors SHOULD publish their own schema files. Promotion path:
  vendor extension → `experimental` core (registered, flagged) → core, each step an
  AEP.
- Adding an optional core type is an additive, minor-version change through the AEP
  process; adding a **mandatory** type is a major-version change (it creates new
  consumer obligations).

## 7. The attention lifecycle (normative)

```
attention.requested ──▶ [attention.routed]* ──▶ attention.answered ──▶ attention.resolved
        │                                                                    ▲
        └───────────────────────── attention.timeout ────────────────────────┘ (terminal alternative)
```

1. Every lifecycle Event after `attention.requested` MUST set `subject` to the
   `id` of the `attention.requested` Event (stable correlation for consumers that
   missed intermediate hops), and SHOULD set `cause` to the `id` of its immediate
   cause (which for `attention.resolved` may be a `control.attention.respond`
   command; see AEP-0004).
2. An emitter that raises `attention.requested` MUST eventually emit a terminal
   lifecycle Event for it: `attention.resolved` or `attention.timeout`; and, if
   it ends the session, MUST emit that terminal before the session's
   `session.ended`: a session never ends with a request its emitter raised still
   pending (close unanswered requests with
   `attention.resolved{resolution:"dismissed"}` or `attention.timeout`). For
   sessions that never end (§4.1 note), "eventually" stays unbounded.
3. `attention.routed` MAY be emitted by any consumer that forwarded the request to a
   human surface; it is the only core type routinely emitted by consumers, and it is
   session-scoped to the *original* session with its own emitter identity
   (`agent` = the router). As a foreign-emitter session Event it MUST omit `seq`
   (AEP-0001 §5.2 exception).
4. `attention.answered` without `attention.resolved` is legal transiently; the
   emitter owns resolution (it may auto-resolve immediately after applying the
   answer).

## 8. Security considerations

*This section is informative; every rule it mentions is defined where cited.*

- **The capture annotations are the confidentiality mechanism, and the `[metadata*]`
  exceptions are its sharpest edge.** Every content-bearing payload field is gated by
  `x-aep-capture` (§5.1). The starred fields (`attention.requested.prompt`,
  `options[].label`, `field_spec.label`/`choices[].label`, and the type-dependent
  `answer.values` rule in §5.3) additionally require that what appears at
  `capture: metadata` is *synthesized or structural*, never model- or user-authored
  text (AEP-0003 §9.2).

  Smuggling real content through a metadata-level field defeats the operator's
  ceiling and is the defect class the capture-gating conformance fixtures exist
  to catch. The type-dependent `values` gating cuts both ways: over-gating drops
  legitimate structural data, under-gating leaks free text above the ceiling
  (see AEP-0006's security section for the fuller analysis).
- **Attention content is a social-engineering surface aimed at the operator.**
  `attention.requested` carries agent- or model-authored text (`prompt`, option and
  field labels) that consumer UIs render directly beside answer controls, and the
  answer flows back with real authority (AEP-0004 `control.attention.respond`). A
  misbehaving or manipulated agent can phrase a request to induce approval of
  something harmful. Consumer surfaces mitigate by rendering provenance (the
  `agent`/`session` identity next to the content), visually separating quoted agent
  text from UI chrome, and never auto-answering on content alone.
- **Severity and type are emitter-asserted.** Routing and alerting key on `type` and
  `severity` (AEP-0003 §6), so automation built on them inherits the emitter's trust
  level: an emitter can under- or over-state severity, and honesty about type
  semantics (§1) is a conformance obligation, not an enforced property. Weight by
  emitter identity (AEP-0003 §8.2) where it matters.
- **Vendor types are unreviewed content.** Unknown-type tolerance (AEP-0001 §6)
  means consumers routinely receive and may render `x.{vendor}.*` Events whose
  payloads follow no registered schema; the untrusted-input posture of AEP-0001 §12
  applies to them in full. The closed core namespace and registry (§6) prevent
  squatting on core semantics, nothing more.
- **Form answers validate at the emitter.** The `attention.answered` reject rule
  (§5.3: missing `required` fields or a non-choice string without `other: true` is
  nacked `invalid`) keeps required-field bypass and choice-forgery out of the
  answered record; consumers treat an `attention.answered` as the emitter's
  validated statement, not the responder's raw input.

## Annex A (normative): source-vocabulary mappings

Seventeen source-vocabulary mappings are adopted as the normative adapter
guidance. Adapters implementing these sources SHOULD follow the mappings
verbatim; deviations MUST be documented in the adapter.

Two things in this annex are normative: the adoption of each mapping (its
existence, direction, identity rules, and stated posture, meaning observe-only,
suppressions, and honest gaps) and the key rules stated below. The machine-usable
pins in `conformance/fixtures/mappings/` are the normative per-field statement
where they exist, and are the most precise statement of a mapping. The reference
adapters embody the full per-hook mappings as implementations of this annex, not
as part of its definition; they and the verification-status bullets below are
informative.

### A.1 Claude Code hooks

Claude Code hooks (29 events → 20 core/sub-profile + 9 `x.claude-code.*`).

Key rules carried into adapters:

- CC `PermissionRequest` → `attention.requested (kind=permission)`
- CC `PermissionDenied` → `tool.denied`
- CC `Elicitation`/`ElicitationResult` (MCP elicitation) →
  `attention.requested (kind=form)` with `field_spec` derived from the
  requested schema, then `attention.answered`/`attention.resolved`
  (machine-usable pin: `conformance/fixtures/mappings/claude-code.json`)
- CC `Notification` splits by subtype (`attention.requested` vs
  `progress.status`)
- CC turn = AEP `run`

*Verification status (informative):*

- **Claude Code**: validated against live installations end to end, including
  the permission and structured-input loops; the machine-usable pins in
  `conformance/fixtures/mappings/` cover the structured-input mapping
  (AEP-0006) and the MCP-elicitation mapping (fixture-proven; the
  elicitation hooks themselves await live validation).

### A.2 Codex hooks

Codex hooks (10 → 10 core).

Key rules carried into adapters:

- Codex `turn`/`thread` scopes = AEP `run`/`session`

*Verification status (informative):*

- **Codex**: **validated against a live installation end to end**
  (session/run/tool observation and the sovereign `control.cancel`
  refusal, driven through the full guided session); the
  full hook table stays pinned machine-usably in
  `conformance/fixtures/mappings/codex.json` (both conformance runners check
  it) and the reference adapter drives all ten hooks through the pinned
  mapping in its CI smoke.

  The interrupt-drain rule (a stale run closes `run.cancelled` at the next
  prompt) is smoke-proven; its live validation is still pending.
- **Codex OTel channel** (the inbound telemetry sidecar): specified from
  the vendor's published telemetry documentation and **fixture-proven**:
  pinned machine-usably in `conformance/fixtures/mappings/codex-otel.json`
  in BOTH sidecar modes (companion: the channel-visible `x.codex.otel.*`
  family only, the hook adapter remaining the sole core-type authority;
  primary: `session.started`, `tool.completed`/`tool.failed`, and
  `tool.denied` for config/automation denies only: a user deny is a human
  decision, not a policy block, and maps to nothing).

  Both runners check the pins; the reference sidecar drives them through real
  OTLP nesting in its CI smoke. Live validation pending alongside the hook
  channel's.

### A.3 Gemini CLI hooks

Gemini CLI hooks (11 → 8 on core types + the 3 model-plane hooks in
`x.gemini-cli.*` by design).

Key rules carried into adapters:

- Gemini CLI `session_id` = AEP `session`, with runs adapter-synthesized per
  `BeforeAgent`/`AfterAgent` pair (no turn id exposed).
- `tool_response.error` → `tool.failed`.
- `PreCompress` → `session.compacted` at the vendor's only exposed (pre)
  moment.
- `Notification` → `progress.status`, observability-only: never
  `attention.requested`, since the hook cannot grant or deny.

*Verification status (informative):*

- **Gemini CLI**: specified from the vendor's published hook documentation
  (fetched at mapping time) and **fixture-proven**: the full hook table is
  pinned machine-usably in `conformance/fixtures/mappings/gemini-cli.json`
  (both conformance runners check it) and the reference adapter drives all
  eleven hooks through the pinned mapping in its CI smoke.

  Validation against a live Gemini CLI session is still pending.

### A.4 Qwen Code hooks

Qwen Code hooks (16 → core, the Claude-Code-shaped sibling).

Key rules carried into adapters:

- Qwen Code mirrors the Claude Code key rules:
  - `PermissionRequest` → `attention.requested (kind=permission)` over control,
    with the `permission_prompt` notification suppressed against the
    first-class hook.
  - Runs synthesized (no turn id) with `tool_use_id` pairing.
  - Compaction once at the post moment (the hook set includes `PostCompact`).
  - `TodoCreated/Completed` → `progress.task.*`.

*Verification status (informative):*

- **Qwen Code**: specified from the vendor's published hook documentation
  (fetched at mapping time) and **fixture-proven**: the full 16-hook table
  is pinned machine-usably in `conformance/fixtures/mappings/qwen-code.json`
  (both conformance runners check it) and the reference adapter drives all
  sixteen hooks, including the hold-open `PermissionRequest` control
  round-trip, in its CI smoke.

  Validation against a live Qwen Code session is still pending.

### A.5 VS Code agent hooks

VS Code agent hooks (the 8-event Preview surface, a Claude-Code-family
member → session/run/tool/compaction/delegation on core types with runs
synthesized per prompt/Stop pair, the success-only `PostToolUse` and the
pre-moment-only compaction deviation stated; observe-only by default).

Key rules carried into adapters:

- VS Code agent `session_id` = AEP `session` (OPTIONAL in the vendor envelope;
  a missing one degrades to the adapter's unknown lane).
- Runs are SYNTHESIZED per `UserPromptSubmit`/`Stop` pair (no turn id is
  documented); `tool_use_id` pairs the tool events exactly.
- `PostToolUse` fires on success ONLY: `tool.failed` has no vendor moment, the
  gap stated, with the vendor's telemetry channel the named failure-visibility
  follow-up.
- Compaction is carried at the vendor's only exposed (pre) moment, a documented
  deviation from the post-moment rule.
- `transcript_path` (a workstation-local file path) is deliberately never
  forwarded.
- The steering verb is vendor-scoped (`x.vscode.control.instruct`), with queued
  deliveries draining on the next eligible hook reply (no session-end drain
  moment exists).

*Verification status (informative):*

- **VS Code agent**: specified from the pinned vendor source (the typed
  hook surface: the VSCode-target event map, the per-event stdin payload
  contracts, and the hook service's consumption sites; the agent-hooks
  feature ships as **Preview**, "configuration format and behavior might
  change", a standing re-verify).

  **Fixture-proven**: the 8-event table is pinned machine-usably in
  `conformance/fixtures/mappings/vscode.json` (both conformance runners
  check it, including the success-only `PostToolUse` honesty and the
  pre-moment-only compaction deviation) and the reference adapter drives
  the real hook shim (stdin JSON exactly as the vendor's hook service
  delivers it) in its CI smoke, including the opt-in held permission
  gate and the opt-in steering verb (`x.vscode.control.instruct`; queued
  deliveries drain on the next eligible hook reply; no session-end
  drain moment exists on this surface).

  Validation against a live VS Code agent session is still pending.
- **VS Code agent OTel channel** (the inbound telemetry sidecar's second
  vendor profile): specified from the vendor source read at the pinned
  tag (the `copilot_chat.*` LogRecord family behind the opt-in
  `github.copilot.chat.otel.enabled` setting; the exporter stamps
  `session.id` at the OTLP resource level) and **fixture-proven**: pinned
  machine-usably in `conformance/fixtures/mappings/vscode-otel.json` in
  BOTH sidecar modes (companion: the channel-visible `x.vscode.otel.*`
  family only, the hook adapter remaining the sole core-type authority;
  primary: the `session.started` frame plus `tool.completed`/`tool.failed`
  from `copilot_chat.tool.call`, the vendor's own `error.type` token,
  with turn/edit/inference visibility staying vendor-namespaced).

  Two vendor ceilings are pinned as invariants: this channel never emits
  `tool.denied` (the hook decision tier never reaches OTel) and never
  synthesizes `session.ended` (session end does not exist on this vendor
  surface).

  Both runners check the pins; the reference sidecar drives them through real
  OTLP nesting in its CI smoke. Live validation pending alongside the hook
  channel's.

### A.6 Kimi Code CLI hooks

Kimi Code CLI hooks (the 16-event external-hooks surface, hook-shaped like the
Claude Code family but registered in the vendor's one global config →
session/run/tool/attention/compaction/delegation/progress on core types with
runs synthesized per prompt, the vendor-named `Interrupt` cancellation, the
full failure twins, and the approval prompt observed as an out-of-band
permission pair (no options claimed, the vendor owns the choice surface);
observe-only by default; plus the Kimi web channel, the kap-server WS stream
carried in the same fixture's `ws_modes` block).

*Verification status (informative):*

- **Kimi Code CLI**: specified from the pinned vendor source (the
  16-event enum, the per-event payload builders in both hook scopes, and
  the structured-output rule: only the literal `permissionDecision`
  "deny" blocks; the decision surface is binary, no ask tier), with the
  six lifecycle payload shapes additionally **oracle-verified against
  the shipped binary** (a headless run against a mock provider proved
  live dispatch, the content-part prompt array, and the snake_case
  field set).

  **Fixture-proven**: the 16-event table is pinned machine-usably in
  `conformance/fixtures/mappings/kimi-code.json`
  (both conformance runners check it, including the post-moment
  compaction rule, the observe-only out-of-band permission pair, and
  the never-a-run steer submission).

  The reference adapter drives the real command shim in its CI smokes,
  including the opt-in held
  `PreToolUse` gate (its answerable surface offers option parity with
  the vendor's native four-way decision, `allow` / `allow_session` /
  `deny` / `cancel`, carried as AEP-0008 `options[]` instance data,
  mapped down onto the binary hook reply: `allow`/`allow_session`
  resolve "no hook objection" while `deny`/`cancel` block with a
  rendered reason; the vendor's own permission flow still runs
  downstream on an allow) and the opt-in steering verb
  (`x.kimi-code.control.instruct`; delivery on the one
  context-accepting reply surface, with a session-end drop).

  **Live-validated:** a five-beat live run against the shipped 0.28.1
  proved the full guide: lifecycle, the tool pair with the failure
  twin, the permission pair (the live proof of the source-derived
  entries), the dedicated `Interrupt` cancellation, and both opt-in
  controls.
- **Kimi web channel** (the kap-server WS stream: the control twin of
  the hook adapter): specified from the pinned vendor source
  (`packages/kap-server` + `packages/protocol`: REST `/api/v1/*` with
  the `{code, msg, data}` envelope, WS `/api/v1/ws` behind the
  `kimi-code.bearer.` subprotocol) with the lifecycle and approval wire
  shapes additionally **oracle-captured from the shipped 0.28.1** (a
  scratch `kimi web` against a mock provider proved the seq-ordered
  frame envelope, the volatile marker, the `event.approval.*` loop
  end-to-end over REST, and the external-hooks parity: one approval
  object serves both surfaces).

  **Fixture-proven**: the `ws_modes`
  block of `conformance/fixtures/mappings/kimi-code.json` pins every
  wire moment in BOTH bridge modes (companion: the channel-visible
  `x.kimi-code.web.*` family only, the hook adapter remaining the sole
  core-type authority; primary: the wire mapping for stream-only
  deployments: the vendor's REAL turn boundaries carrying the run
  pair, no fabricated session lifecycle, volatile frames and the
  internal bus echoes never emitting, and every ask shedding options
  and `respond_via`; a read-only channel advertises no way to
  answer). The question loop is source-derived and labeled so.

  Both runners check the pins; the reference bridge drives them through
  real WS framing, including a reconnect and the opt-in controls
  (the approval decision and the run abort: the vendor's own REST
  writes, outcomes riding its own broadcasts), in its CI smokes.

  Scope honesty: the channel reaches kap-hosted (`kimi web`) sessions
  only: the interactive terminal TUI runs its agent in-process with
  no server surface, unreachable by vendor design and recorded
  unsupported rather than worked around.

### A.7 OpenCode moments

OpenCode moments (the plugin bus + interception hooks →
lifecycle/tool/attention on core types with the machinery plane in
`x.opencode.*` by design).

Key rules carried into adapters:

- OpenCode bus `sessionID` = AEP `session`, with runs adapter-synthesized on
  user-message/idle boundaries (no turn id exposed) and `callID` pairing tool
  events.
- The hold-open `permission.ask` hook → `attention.requested(kind=permission)`
  over control, with bus `permission.updated` suppressed against it.
- `todo.updated` snapshots are diffed into
  `progress.task.planned`/`progress.task.completed` transitions.
- NO `tool.failed` on this surface: the typed hooks expose no error, and
  failures ride session-scoped in `x.opencode.session.error`.
- Compaction is carried at the vendor's announced (post) moment.

*Verification status (informative):*

- **OpenCode**: specified from the vendor's published plugin/SDK
  documentation AND the published TypeScript types (`@opencode-ai/plugin`,
  `@opencode-ai/sdk` v1; strictly stronger than the prose: the types name
  the ask moment `permission.updated` where the docs say "permission.asked")
  and **fixture-proven**: the moment table is pinned machine-usably in
  `conformance/fixtures/mappings/opencode.json` (both conformance runners
  check it, including the pure snapshot-to-transition todo diff) and the
  reference adapter drives the real plugin file, including the hold-open
  `permission.ask` control round-trip, in its CI smoke.

  Validation against a live OpenCode session is still pending.
- **OpenCode SSE channel** (the zero-install observation bridge):
  specified alongside the plugin mapping and **fixture-proven**: the
  `sse_modes` block of `conformance/fixtures/mappings/opencode.json` pins
  every bus moment in BOTH bridge modes (companion: the channel-visible
  `x.opencode.*` family only, the plugin adapter remaining the sole
  core-type authority; primary: the full bus mapping for SSE-only
  deployments, with `permission.updated` → `attention.requested` carrying
  NO options or `respond_via`; a read-only channel advertises no way to
  answer).

  Both runners check the pins; the reference bridge drives them through real
  `text/event-stream` framing, including a reconnect, in its CI smoke. Live
  validation pending alongside the plugin channel's.

### A.8 Kilo Code moments

Kilo Code moments (the OpenCode fork: an identical published bus union at the
pinned versions, carried whole on its own identity with the machinery plane in
`x.kilocode.*`).

Key rules carried into adapters:

- Kilo Code carries the OpenCode key rules whole on its own identity (the
  fork's published bus union is identical at the pinned versions): bus
  `sessionID` = AEP `session`, runs adapter-synthesized, `callID` pairing,
  snapshot-diffed todos, no `tool.failed` (failures ride
  `x.kilocode.session.error`), and machinery/UI planes in `x.kilocode.*`.
- The permission surface is DUAL, where the fork diverged at runtime:
  - `<=7.4.5`: the hold-open `permission.ask` over control, with bus
    `permission.updated` suppressed.
  - `>=7.4.6`: bus `permission.asked` → `attention.requested(kind=permission)`
    with the vendor's `once`/`always`/`reject` reply enum as options, answers
    delivered over the server reply routes, bus `permission.replied` settling
    either way, and `question.asked`/`question.replied` as an
    `attention.requested(kind="form")` round-trip.

*Verification status (informative):*

- **Kilo Code**: specified from the vendor's published TypeScript types
  (`@kilocode/plugin` + `@kilocode/sdk` 7.4.5, published in lockstep with
  the CLI; the CLI core is an OpenCode fork and the published bus union
  was verified byte-identical to `@opencode-ai/sdk` v1's, member by
  member, at mapping time), **runtime-verified against the shipped
  7.4.11 binary**: at 7.4.11 the fork DIVERGES from both its upstream
  and its own published npm types (which lag the runtime): the
  hold-open `permission.ask` hook and the bus
  `permission.updated` member are gone at `>=7.4.6`, replaced by bus
  `permission.asked`/`permission.replied` plus a followup-question
  surface (`question.asked`/`question.replied`, mapped to
  `attention.requested(kind:"form")` on the AskUserQuestion shape).

  The table carries BOTH surfaces, and is **fixture-proven**: the moment
  table is pinned machine-usably in
  `conformance/fixtures/mappings/kilocode.json` (both conformance
  runners check it, including the pure snapshot-to-transition todo diff)
  and the reference adapter drives the real plugin file, the hold-open
  `permission.ask` control round-trip (`<=7.4.5`) AND the `>=7.4.6`
  reply-route loop (options mirroring the vendor's
  `once`/`always`/`reject` reply enum verbatim, delivery via the
  server's permission/question reply routes, vendor-side settles
  standing the pending card down), in its CI smoke.

  The `>=7.4.6` reply-route shapes were confirmed empirically against a
  headless 7.4.11 server; validation inside a live interactive Kilo Code
  session is still pending.
- **Kilo Code SSE channel** (the zero-install observation bridge: the
  fork twin of the OpenCode SSE channel): specified alongside the Kilo
  plugin mapping and **fixture-proven**: the `sse_modes` block of
  `conformance/fixtures/mappings/kilocode.json` pins every bus moment in
  BOTH bridge modes (companion: the channel-visible `x.kilocode.*` family
  only, the plugin adapter remaining the sole core-type authority;
  primary: the full bus mapping for SSE-only deployments, with EVERY
  mapped ask (`permission.updated` on `<=7.4.5` builds,
  `permission.asked`/`question.asked` on `>=7.4.6`) shedding its answer
  affordances (options, `respond_via`; a form's fields stay, the
  question content IS the observation); a read-only channel advertises
  no way to answer).

  The published bus unions read byte-identical at the published-type pins (`@kilocode/sdk` 7.4.11 vs `@opencode-ai/sdk`
  1.18.3, member by member), but the SHIPPED 7.4.11 runtime diverges
  from its own published types (see the plugin entry above): the block
  carries the OpenCode-mirrored moments on Kilo's own namespace PLUS the
  `>=7.4.6` ask/settle moments in both modes.

  Both runners check the pins; the reference bridge drives them through real
  `text/event-stream` framing, including a reconnect, in its CI smoke. Live
  validation pending alongside the plugin channel's.

### A.9 Cline subprocess hooks

Cline subprocess hooks (10 zod-typed events → run/tool/delegation lifecycle on
core types with the honest `tool.completed`/`tool.failed` split;
observe-only).

Key rules carried into adapters:

- Cline `taskId` = AEP `session`, with REAL run boundaries: `agent_start`/
  `agent_resume` open, `agent_end`/`agent_abort`/`agent_error` close. Abort is
  `run.cancelled`, error is `run.failed`, and the vendor distinction is kept.
- The typed `ToolCallRecord.error` splits `tool.completed`/`tool.failed`
  honestly, and typed parent ids open and close the `delegation.subagent.*`
  pair.
- `prompt_submit` is vendor-scoped (`message.user.submitted` stays reserved).
- Compaction is carried at the vendor's only exposed (pre) moment.
- The per-turn `iteration` stamps the envelope `step` (no `run.step.*`
  synthesis).

*Verification status (informative):*

- **Cline**: specified from the vendor's published TypeScript types
  (`@cline/shared` 0.0.59: the zod hook schemas ship in the published
  package, so fixture provenance needs no repository pinning) and
  **fixture-proven**: the ten-event subprocess hook table is pinned
  machine-usably in `conformance/fixtures/mappings/cline.json` (both
  conformance runners check it, including the typed
  `tool.completed`/`tool.failed` split and the delegation pair) and the
  reference adapter drives the real hook shim (stdin JSON exactly as the
  vendor's loader delivers it) in its CI smoke.

  Observe-only by design (approvals ride the vendor's hub channel, a recorded
  deferred decision). Validation against a live Cline session is still
  pending.

### A.10 Hermes Agent shell hooks

Hermes Agent shell hooks (a 23-event vocabulary, 12 observation events mapped
→ run/tool/ attention/delegation on core types with the three-way
`tool.completed`/`tool.failed`/`tool.denied` split and the vendor's own
approval gate observed read-only; observe-only).

Key rules carried into adapters:

- Hermes `session_id` = AEP `session`, with the vendor's REAL per-turn
  `turn_id` riding verbatim as the run id. The per-turn hook closes RUNS, never
  sessions: the real session end comes from the finalize moment alone. The reset
  moment fires after the vendor mints the SUCCESSOR session id, so it rides the
  vendor plane as `x.hermes.session.reset`; mapping it to `session.ended` would
  end a session at its birth.
- The three-state tool result splits
  `tool.completed`/`tool.failed`/`tool.denied (by=policy)`.
- The vendor's own approval gate is observed read-only, with the vendor's
  four-way decision menu carried as `options` data and `respond_via` `["oob"]`
  declared: the decision is made in the agent's own UI, stated on the event
  itself (AEP-0008; answers via `oob`; a timeout choice → `attention.timeout`).
- Typed parent ids ride the delegation pair.
- NO compaction moment: the surface exposes no compaction hook.

*Verification status (informative):*

- **Hermes Agent**: specified from **source** (the vendor publishes no
  typed schema artifact: payload shapes were read from the repository at
  the pinned tag named in the design record, and every payload's own
  `telemetry_schema_version` string is pinned in the fixture as the
  drift sentinel).

  **Fixture-proven**: the mapped shell-hook table is pinned machine-usably in
  `conformance/fixtures/mappings/hermes.json` (both conformance runners check
  it, including the three-way tool split, the read-only approval pair (carried
  with the vendor's own decision menu as `options` data and `respond_via`
  `["oob"]` declared (AEP-0008)), the `clarify` form overlay (kind `form`
  beside the pinned tool trio, `respond_via` `["oob"]`, the vendor-delivered
  answer as structural choice ids or gated free text, AEP-0006), and the
  per-turn run boundary) and the reference adapter drives the real hook shim
  (stdin JSON exactly as the vendor's dispatcher delivers it) in its CI smoke.

  Observe-only by design. Early live operator sessions have exercised the
  observation path; full live validation is still pending.

### A.11 Antigravity hooks

Antigravity hooks (the five-hook `hooks.json` system shared by Antigravity 2.0
and the Antigravity CLI; tool/step/run lifecycle on core types via the
(conversationId, stepIdx) join with an honest unjoined fallback; observe-only
via the vendor's own empty-decision reply).

Key rules carried into adapters:

- Antigravity `conversationId` = AEP `session` (verbatim; `session.started`
  synthesized on first sight, no session end exposed).
- Runs are synthesized: opened at the first `PreInvocation` boundary, closed by
  `Stop`'s typed `terminationReason` (`model_stop` / `max_steps_exceeded` →
  `run.finished` with the reason as metadata, since bounded terminations are
  completions; `error` → `run.failed`).
- `PreInvocation`/`PostInvocation` → `run.step.started`/`run.step.finished`,
  with `invocationNum` setting the envelope `step`.
- The (conversationId, `stepIdx`) join carries `PreToolUse`'s name onto the thin
  `PostToolUse`'s `tool.completed`/`tool.failed` split. Unjoined completions
  fall back to `x.antigravity.step.completed`: a name is never invented, and
  dangling requests synthesize nothing.
- The required `PreToolUse` decision is answered with the vendor's own
  safely-handled empty string, never a named decision, never `"continue"`.
- NO `attention.*`/`tool.denied` claims: approval outcomes are not hook-visible.

*Verification status (informative):*

- **Antigravity**: specified from the vendor's published hook
  documentation (fetched at mapping time; the docs' worked examples are
  the fixture inputs' basis) plus the vendor's public changelog, which
  pins the three load-bearing behaviors: the safely-handled empty
  decision string at CLI 1.0.16 (the adapter's minimum version and its
  observe-only neutral reply), the global hooks path at 1.0.8, and
  workspace hook loading at 1.1.1.

  **Fixture-proven**: the hook table is
  pinned machine-usably in `conformance/fixtures/mappings/antigravity.json`
  (both conformance runners check it, including both join forks and all
  three `Stop` terminals) and the reference adapter drives the real
  argv-discriminated shim (the event name rides the registration, since
  no payload names its own event) in its CI smoke, with the neutral
  replies asserted byte-exact.

  There is NO payload schema-version sentinel: the docs page and the vendor
  changelog are the drift watch, and the binary is closed (docs provenance,
  stated).

  Approval outcomes are not hook-visible on this surface (a denied tool is
  indistinguishable from a running one), so the mapping claims no
  `tool.denied` and no `attention.*`; the gap is stated rather than papered
  over. Validation against a live Antigravity session is still pending.

### A.12 pi extension-bus events

pi extension-bus events (the in-process notification subset →
session/run/step/tool lifecycle on core types with agent-loop runs closed by
the typed `stopReason`, the vendor `turnIndex` on the envelope step, and the
message boundary facts in `x.pi.*` pending the message sub-profile;
observe-only by non-subscription: no interception surface is ever registered).

Key rules carried into adapters:

- pi session id (read in-process from the session manager) = AEP `session`.
- Runs are synthesized per AGENT LOOP: `agent_start` opens, `agent_end` closes
  on the LAST assistant message's typed `stopReason` (`error` → `run.failed`,
  `aborted` → `run.cancelled` with no `by` claim, `stop`/`length`/`toolUse` →
  `run.finished` with the reason and token usage as metadata). A retried loop is
  a NEW run, with the vendor's `agent_settled` riding `x.pi.agent.settled` as
  the final-settlement fact.
- `turn_start`/`turn_end` → `run.step.started`/`run.step.finished`, with the
  vendor's own `turnIndex` setting the envelope `step`.
- `toolCallId` pairs the tool trio, with the typed `isError` splitting
  `tool.completed`/`tool.failed`.
- Compaction is carried at the vendor's announced (post) moment with its typed
  reason.
- Message boundary facts are vendor-scoped
  (`x.pi.message.submitted`/`.replied`: the reserved-type refusal), with stream
  updates behind the deltas opt-in.
- NO `attention.*`/`tool.denied` claims: approvals are not bus-visible, and the
  fork's typed approval pair is the named trigger.

*Verification status (informative):*

- **pi**: specified from the vendor's published TypeScript types
  (`@earendil-works/pi-coding-agent@0.80.6`: the extension-event union
  ships in the published package, and the tarball carries the vendor's
  own documentation at the same version; the docs' printed event list is
  stale against the shipped union, so the types are the sole authority)
  and **fixture-proven**: the extension-bus table is pinned machine-usably
  in `conformance/fixtures/mappings/pi.json` (both conformance runners
  check it, including the typed-`stopReason` run terminals, the
  `turnIndex` step pair, the honest `isError` split, and the
  stream-update opt-in forks) and the reference adapter drives the real
  extension file (the factory registered exactly as pi's loader would
  call it) in its CI smoke.

  Observe-only **by non-subscription**: pi registers handlers per event, and
  the adapter never registers an interception surface (no `tool_call`,
  `tool_result`, `context`, `input`, `before_provider_*`, or
  `session_before_*`).

  Approval outcomes are not visible on this bus: the mapping claims no
  `tool.denied` and no `attention.*`; the fork Oh-My-Pi's typed
  `tool_approval_requested/resolved` pair is the named trigger, and the
  fork (`@oh-my-pi/pi-coding-agent@16.4.6`) is expected-compatible but
  UNANCHORED: its union diverges from upstream's. The message boundary
  facts stay in `x.pi.*` while `message.user.submitted` /
  `message.agent.replied` remain reserved.

  Validation against a live pi session is still pending.

### A.13 ACP

ACP (the Agent Client Protocol, editor-agent: the prompt-turn run, the tool
status forks, and the editor's permission gate observed read-only through a
byte-transparent tee; message/thought chunks suppressed pending the
message/stream sub-profile).

Key rules carried into adapters:

- ACP `sessionId` = AEP `session` (verbatim), with the `session/prompt` turn as
  the run. `stopReason` decides the terminal: bounded terminations are
  completions with the stop reason as metadata, `cancelled` →
  `run.cancelled(by=user)`, `refusal` → `run.failed`.
- `tool_call`/`tool_call_update` status forks onto the tool trio.
- The editor's `session/request_permission` gate is observed read-only (no
  options, no `respond_via`; outcomes via `oob`, a cancelled outcome →
  dismissed).
- Plan updates are vendor-scoped: the schema's plan entries carry no id, and
  diffing would invent identity.
- Message/thought chunks are suppressed by default.

*Verification status (informative):*

- **ACP**: specified from the protocol's published JSON schema (the
  canonical repository's `schema/v1/schema.json` at the release pinned in
  the design record; the npm and crate packages publish the same types)
  and **fixture-proven**: the moment table is pinned machine-usably in
  `conformance/fixtures/mappings/acp.json` (both conformance runners
  check it, including the delta-opt-in forks and the tool status forks)
  and the reference tee drives it through real newline-framed JSON-RPC
  (a stub editor and a stub agent around the real bridge, with
  byte-transparency asserted in both directions) in its CI smoke.

  The attach shape (a command-substitution tee) is wire-compatible in every
  ACP editor and not blessed by the ACP specification, stated here and in the
  bridge documentation. Identity is real wire identity (`sessionId` verbatim;
  the prompt request id scopes the run).

  Validation against a live editor-agent pairing is still pending.

### A.14 AG-UI

AG-UI (the 31-type stream union at `@ag-ui/core` 0.0.57 → lifecycle/tool/state
on core; token deltas suppressed pending the message/stream sub-profile).

Key rules carried into adapters:

- AG-UI `STEP_*` → `run.step.*` + envelope `step`.

*Verification status (informative):*

- **AG-UI**: specified from the published protocol documentation AND the
  published TypeScript types (`@ag-ui/core` 0.0.57: the count and shapes
  come from the types; pre-1.0 drift is a re-verify) and
  **fixture-proven**: the event table is pinned machine-usably in
  `conformance/fixtures/mappings/agui.json` (both runners, including the
  delta-opt-in forks) and the reference tee-proxy bridge drives it through
  real streamed framing in its CI smoke.

  Identity is real vendor identity (`threadId`/`runId`, no synthesis). The
  reply terminal stays in the vendor namespace while `message.agent.replied`
  is reserved. Validation against a live AG-UI framework is still pending.

### A.15 OpenHands agent-server events

OpenHands agent-server events (the typed Pydantic union served over the
vendor's own HTTP/WebSocket surface, taken at the transport envelope →
tool/attention/state/session lifecycle on core types, with runs synthesized
from the server's own execution-status facts and the wire-visible approval
loop observed read-only; observe-only by the never-send posture: the auth
frame is the only socket write).

Key rules carried into adapters:

- OpenHands `conversation_id` = AEP `session` (the events socket scopes it).
- Runs are synthesized from the server's own `execution_status` transitions,
  with terminals per its `is_terminal()` set: `finished` → `run.finished`,
  `error`/`stuck` → `run.failed`, `deleting` → `run.cancelled` +
  `session.ended(reason=killed)` (the enum's closest honest classification for
  an external deletion). `running`→`idle` without a terminal closes with
  `reason=idle`; `paused`/`waiting_for_confirmation` never close.
- The typed observation `is_error` splits `tool.completed`/`tool.failed`, with
  `AgentErrorEvent` joining the call by `tool_call_id`.
- The wire-visible approval loop is observed READ-ONLY:
  `waiting_for_confirmation` → `attention.requested` with NO options and NO
  `respond_via`; `UserRejectObservation` with `rejection_source=hook` →
  `tool.denied(by=policy)`, while a USER rejection stays vendor-scoped as a
  human decision, not a policy block, the Codex-OTel rule.
- `llm_response_id` stamps the envelope `step` (a grouping fact; no
  `run.step.*` synthesis).
- Message boundaries are vendor-scoped (`message.*` stays reserved), and
  streaming deltas sit behind the opt-in with `TokenEvent` mapping to nothing
  ever.
- Naive server-local vendor timestamps ride at metadata under a receive-time
  envelope `ts`, and fixtures anchor the transport envelope (`parent_id` never
  on the wire).

*Verification status (informative):*

- **OpenHands agent server**: specified from **source at a pinned sha**
  (`OpenHands/software-agent-sdk` @ `cf6c2a3a`, release v1.35.0, PyPI
  `openhands-agent-server` 1.35.0 lockstep; types outrank prose) and
  **fixture-proven**: the event table AND the pure status-transition
  table behind run synthesis are pinned machine-usably in
  `conformance/fixtures/mappings/openhands.json` (both conformance
  runners check them, including the delta-opt-in forks and the
  TokenEvent refusal), with inputs anchored on the TRANSPORT envelope
  (`event_transport_dump`: `parent_id` stripped, `exclude_none`),
  never raw SDK dumps.

  The reference bridge attaches to the vendor's own multi-observer WebSocket
  fan-out and drives the pins through the real first-message-auth + replay
  protocol against a stub agent server in its CI smoke; the never-send posture
  (the auth frame is the only frame ever written; the approval actuator is
  never called) is asserted there.

  Validation against a live `openhands-agent-server` is still pending.

### A.16 OpenClaw Gateway

OpenClaw Gateway (6 families → `run.*`, `message.*`, `agent.*`, `progress.*`).

*Verification status (informative):*

- **OpenClaw Gateway, A2A**: specified from the published protocol
  documentation of each source; no reference implementation exists yet
  (the vendor-surface survey records the buildability verdicts: OpenClaw
  deferred, A2A deferred).

### A.17 A2A task states

A2A task states (11 → `progress.*`, `run.*`, `attention.*`).

Key rules carried into adapters:

- A2A `INPUT_REQUIRED`/`AUTH_REQUIRED` →
  `attention.requested(kind=input|auth)`
- A2A `REJECTED` → `run.failed(reason= "rejected")`

*Verification status (informative):*

see the combined OpenClaw Gateway and A2A entry under A.16.

## References

- AEP-0001 (envelope, conformance, capture).
- AEP-0003 §9 (redaction rules).
- AEP-0004 (control types).
- JSON Schema 2020-12.
- OpenTelemetry GenAI semantic conventions (mirrored names, pinned per AEP
  version; Development-status upstream).
