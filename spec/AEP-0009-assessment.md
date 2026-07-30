# AEP-0009: Assessment (Evaluation Results and Human Feedback)

| Field | Value |
|---|---|
| **AEP** | 0009 |
| **Title** | Assessment: Evaluation Results and Human Feedback |
| **Type** | Standards Track — Core |
| **Status** | Accepted (2026-07-23: normative text, schemas, fixtures, and prototype landed in one change per GOVERNANCE.md §2) |
| **Sponsor** | AEP maintainers (per GOVERNANCE.md §2) |
| **Created** | 2026-07-23 |
| **Requires** | AEP-0001 (envelope, fleet-observer test, unknown-type tolerance), AEP-0002 (category set, taxonomy, `usage` precedent), AEP-0003 (capture levels and redaction) |
| **Supersedes / Superseded-by** | n/a (additive: a new category and three `experimental` optional types) |

## Abstract

A new event category, `assessment`, and its members carry a
judgment *about* an agent's work back onto the event stream:

1. **`assessment.evaluation.recorded`**: an automated or LLM-judge (or code)
   evaluation result, namely a named metric with a numeric score and/or a
   categorical label, an optional rationale, and the evaluator's identity. Its
   field names mirror the de-jure GenAI evaluation convention verbatim.
2. **`assessment.feedback.received`**: a human or end-user feedback signal,
   namely a numeric rating and/or categorical label, an optional free-text
   comment, an optional correction, and the feedback's source.
3. **`assessment.guardrail.recorded`**: an automated content-safety verdict
   already taken, namely a guardrail / safety-filter / content-moderation check
   that fired on an input or an output, with its verdict, the violated
   categories, an optional per-category score, the detector, and an optional
   rationale. De-jure whitespace (the observability track carries no guardrail
   attribute), so named natively via a `guardrail` common object.

An assessment targets the run or output it judges through the **envelope**
(`run`, `session`, and `cause` pointing at the assessed event), so no payload
carries a target id. All three types are **emitter-asserted** and land
**`experimental`** (advertised under `capabilities.experimental`, AEP-0003 §4);
adding the category is a Standards-Track change to the closed category set
(AEP-0002 §3). No relay behavior changes.

## Motivation

The taxonomy (AEP-0002) records what an agent *did* (runs, tools, progress,
retrievals) but has no way to express a judgment *about* that work. Four
concrete cases the fleet cannot currently express:

- **An automated evaluator scored a run.** An LLM-judge or a code metric rates
  an answer's relevance/faithfulness/correctness. Today an emitter can only
  bury this in a vendor `x.*` type or an unrelated `progress.status`, so a
  fleet observer watching for low-scoring outputs across a fleet has nothing
  uniform to match on.
- **A human gave feedback.** A thumbs-down, a star rating, a written comment,
  or a corrected answer arrives, often out-of-band and after the run finished.
  There is no core type for it; the signal that most directly tells an operator
  "this output was bad" is unrepresentable.
- **A consumer wants to correlate quality with behavior.** Because neither
  signal is a first-class event, a consumer cannot join "this run scored 0.2
  and got a thumbs-down" to the run's tool calls and usage without
  vendor-specific glue.
- **A guardrail blocked or flagged content.** An automated safety filter /
  moderation model / guard model scored an input or an output and took a
  verdict (allowed it, flagged it, blocked it, or rewrote it) against one or
  more policy categories. Today an emitter can only bury this in a vendor `x.*`
  type, so a fleet observer watching "N sessions hit a jailbreak block this
  hour" has nothing uniform to match on. This is
  `assessment.guardrail.recorded` (§6), grounded in the cross-producer
  convergence.

These pass the **fleet-observer test** (AEP-0001 §3.2): a fleet observer acts
on "an output scored below threshold", on "a human flagged this output", and on
"a guardrail blocked this content", and these drive dashboards, alerts, and
triage. They are distinct moments (an automated score and a human signal are
produced by different actors, carry different fields, and are reacted to
differently), which is why the category has separate members rather than one
discriminated type.

The evaluation half is standardized de-jure: the GenAI observability track
defines an evaluation-result event with a metric name, a score value, a score
label, and an explanation. AEP mirrors those names verbatim, the same posture
`usage` takes toward the token-count names (AEP-0002 §5.2).

The human-feedback half is **de-jure whitespace** (no surveyed convention
defines a feedback event), with vendor precedent (annotation/score APIs that
unify automated and human signals under one object with a producer
discriminator). AEP names the feedback shape natively and neutrally, grounded in
the cross-vendor field tokens (a numeric magnitude, a categorical label, a
free-text comment, a correction) without adopting any one vendor's schema.

## Specification

RFC 2119/8174 keywords. The normative payload summary also appears in
AEP-0002 §5.4; this section is authoritative for the three types.

### 1. The category

`assessment` is added to the closed category set (AEP-0002 §3), scope
`session`. An `assessment.*` type's envelope MUST satisfy the session-scoped
requirements of AEP-0001 §5.2 (a `session`, a `seq`). Adding the category is a
Standards-Track change to `schemas/registry/categories.json` and to the
envelope `type` pattern (`schemas/aep-event.schema.json`).

### 2. Targeting (normative)

An assessment MUST target the work it judges through the envelope, not a
payload field:

- the assessed run and session are named by the envelope's `run` and
  `session`;
- the specific assessed event (e.g. a `run.finished`, a `tool.completed`, a
  `message.agent.replied`) SHOULD be named by the envelope's `cause`.

A payload MUST NOT introduce a separate response/target id: the envelope is the
link, the same rule `usage` and `cost` follow (AEP-0002 §5.2).

### 3. `assessment.evaluation.recorded`

An automated, LLM-judge, or code evaluation result. All fields OPTIONAL; the
payload schema is OPEN (AEP-0002 §5.1). Field names mirror the de-jure GenAI
evaluation convention verbatim:

- `gen_ai.evaluation.name`, string [metadata]: the evaluation metric's name.
- `gen_ai.evaluation.score.value`, number [metadata]: the numeric score. It is
  **emitter-asserted and unbounded**, and the evaluator states its own scale.
  A consumer MUST NOT assume a fixed range.
- `gen_ai.evaluation.score.label`, string [metadata]: the categorical verdict
  (e.g. `pass`, `fail`, `relevant`).
- `gen_ai.evaluation.explanation`, string [**redacted**]: the evaluator's
  free-text rationale. It MAY contain sensitive content, so it routes through
  AEP-0003 §9 redaction and drops at a `metadata` ceiling.
- `evaluator`, string [metadata]: a native token identifying the judge or
  check that produced the result (an LLM-judge model id or a code-check name).

The score *kind* is carried structurally, as a numeric `score.value`, a string
`score.label`, or both, not by a data-type discriminator field.

### 4. `assessment.feedback.received`

A human or end-user feedback signal. All fields OPTIONAL; the schema is OPEN.
De-jure whitespace, so named natively:

- `rating`, number [metadata]: a numeric feedback magnitude (a thumbs `±1`, a
  1-5 star). Emitter-asserted and unbounded, like the evaluation score.
- `label`, string [metadata]: a categorical verdict (e.g. `thumbs_up`).
- `comment`, string [**redacted**]: free-text feedback. Content-bearing, so
  gated through AEP-0003 §9.
- `correction`, string [**redacted**]: a corrected or ground-truth output the
  human supplied. Content-bearing, so gated.
- `source`, string [metadata]: where the feedback came from (e.g. `human`,
  `end_user`). This is the feedback's author, which the envelope's emitter
  identity (the relay or adapter that forwarded it) does not carry.

### 5. Capture and redaction (normative)

The content-bearing fields are classed **`redacted`** (AEP-0003 §9):
`assessment.evaluation.recorded`'s `gen_ai.evaluation.explanation`,
`assessment.feedback.received`'s `comment` and `correction`, and
`assessment.guardrail.recorded`'s `guardrail.explanation` (§6). At a `metadata`
capture ceiling they drop mechanically, and the scores, labels, metric name,
evaluator, rating, source, and the guardrail verdict/categories/detector
survive: a metadata-only consumer keeps the *fact and magnitude* of the
assessment and loses the sensitive text. All other fields are `metadata`.

### 6. `assessment.guardrail.recorded`

An automated content-safety verdict already taken: a guardrail / safety-filter
/ content-moderation check that fired on an input or an output. All fields
OPTIONAL; the payload schema is OPEN. De-jure whitespace (the observability
track carries no guardrail/moderation attribute, and the producer names
diverge), so named natively via one `guardrail` common object (AEP-0002 §5.2):

- `guardrail.stage`, enum(`input`|`output`) [metadata]: what was scored, a
  prompt/input or a produced output.
- `guardrail.verdict`, enum(`allowed`|`flagged`|`blocked`|`modified`)
  [metadata]: the convergent union across the surveyed producer vocabularies.
  `allowed` (nothing fired), `flagged` (a soft warn, not a hard stop), `blocked`
  (a hard stop / refusal), `modified` (the guard rewrote or redacted the
  content).
- `guardrail.categories`, array [metadata] of `{ name: string [metadata],
  score?: number [metadata] }`: the violated / evaluated policy categories.
  `name` is a **free vendor-taxonomy string, deliberately NOT a closed enum**:
  the producer taxonomies diverge, so closing it would bless one vendor or force
  a lossy mapping (**injection / jailbreak is one such category name**, not its
  own type). `score` is the emitter's per-category score, **emitter-asserted
  and unbounded**; the emitter states its own scale.
- `guardrail.detector`, `{ name?: string [metadata], version?: string
  [metadata] }` [metadata]: the guard model / filter / rule engine that produced
  the verdict, with its version companion.
- `guardrail.explanation`, string [**redacted**]: a free-text rationale. It MAY
  quote the offending content, so it routes through AEP-0003 §9 redaction and
  drops at a `metadata` ceiling.

A guardrail outcome is a judgment *about content-safety*, an automated
assessment produced by a guard model or rule engine, so it is a sibling of
`assessment.evaluation.recorded`, not a phase of the work. It targets the scored
work through the **envelope** (§2): the scored run and session are the
envelope's `run`/`session`, and the specific scored event (a `run.finished`, a
`tool.requested`, a produced answer) SHOULD be the envelope's `cause`; no
payload carries a target id.

## Conformance fixtures

Landing in the same change (GOVERNANCE.md §2, the SEP rule):

- `conformance/fixtures/golden/golden.jsonl` gains an assessment session: an
  `assessment.evaluation.recorded` (a named metric with a numeric score, a
  `fail` label, a redacted explanation, and an evaluator) and an
  `assessment.feedback.received` (a `-1` rating, a `thumbs_down` label, a
  redacted comment and correction, and a `human` source), both `cause`-linked
  to the assessed run's terminal. The runners assert both are envelope-valid
  and payload-valid, and the CloudEvents round-trip is identity-preserving.
- `conformance/fixtures/downlevel/cases.json` gains **DL14** and **DL15**,
  pinning the per-field content gating: at a `metadata` ceiling the redacted
  fields (`explanation`; `comment`/`correction`) drop while the metadata
  provenance (name/score/label/evaluator; rating/label/source) survives.

The guardrail member (§6) extends the same fixtures:

- `golden.jsonl` gains an `assessment.guardrail.recorded` on the same assessment
  session (a `blocked` `output` verdict over a violated category with a score,
  a generic detector, and a redacted explanation), `cause`-linked to the same
  assessed run's terminal; the runners assert it envelope- and payload-valid and
  CE-identity-preserving.
- `cases.json` gains **DL18**: at a `metadata` ceiling the redacted
  `guardrail.explanation` drops while the verdict/stage/categories/detector
  survive.

## Prototype

The spec-derived conformance runner (`conformance/run.py`) validates the new
golden vectors against the new schemas and regenerates the CloudEvents pins;
the reference stack's Node runner (`conformance/run.js`, run over the vendored
copy) exercises the same corpus through the reference validator and the
capture-gating projection (DL14/DL15/DL18). The generated type models
(`schemas/gen/`) add `AssessmentEvaluationRecordedData`,
`AssessmentFeedbackReceivedData`, and `AssessmentGuardrailRecordedData`, and the
SDKs regenerate from the same schemas.

No reference-relay behavior changes: an assessment event ingests, matches, and
replays as any other session event. No adapter emits assessment events, so the
adapter smokes are unaffected (verified green).

## Rationale

**Why a new category, not an existing one.** An assessment is a judgment about
work, not a phase of it. It is not `run`/`tool` (the work's own lifecycle), not
`progress` (intermediate status produced by the worker; an assessment is
produced by an evaluator or a human, often after the fact and out-of-band), and
not `error` (a low score is not a fault). No existing category fits, so, per
AEP-0002 §3, a Standards-Track category addition.

**Why two types, not one discriminated type.** The dominant vendor precedent
is a single object with a producer discriminator. AEP splits instead because
the fleet-observer test separates the two moments and their payloads differ:
the automated half mirrors a shipped de-jure convention verbatim; the human
half is native whitespace and carries a correction the eval half never does.

One discriminated type would force one schema to carry both an OTel-style
mirror and a native-feedback shape, muddying both. Two focused three-segment
types match the taxonomy idiom (`resource.retrieval.*`, `delegation.subagent.*`).

**Why the envelope is the link.** Every surveyed vendor points a score back to
its target by an id. AEP already has that link natively (`run`, `session`, and
`cause`), so a payload target id would duplicate the envelope, exactly the
reasoning that keeps `usage`/`cost` free of a run id (AEP-0002 §5.2).

**Why no score-kind enum.** Only one vendor names a data-type discriminator;
the others encode kind structurally (a numeric score vs a string label). AEP
follows the structural convention, a `score.value` and/or a `score.label`, so
the shape stays open and a boolean/categorical/numeric result needs no closed
enum. Rejected: a `dataType` field.

**Why mirror the eval names verbatim but not the feedback names.** Directive:
where a de-jure name exists, mirror it verbatim (the `usage` posture); where it
does not, name natively and neutrally. The evaluation half has a shipped
convention (name/score.value/score.label/explanation), so it is mirrored. The
feedback half has none, so it is named natively
(rating/label/comment/correction/source),
grounded in the cross-vendor tokens without adopting a vendor schema.

**Why a guardrail outcome is a third `assessment` type, not folded into
evaluation and not a new category.** A guardrail verdict *is* a judgment about
work, an automated assessment of content-safety produced by a guard model or
rule engine, often after the fact, so it belongs to `assessment`, not a new
category (the same test the category itself passes).

It is not the *evaluation* type: an evaluation is a quality metric (a name + a
numeric/label score), a guardrail is a safety verdict
(allowed/flagged/blocked/modified) over violated policy categories, a different
actor, vocabulary, and reaction (a fleet observer acts on "a jailbreak block",
not "a low relevance score"). Hence a third focused three-segment type rather
than a widened evaluation schema.

Its names are native and neutral (de-jure whitespace: no observability-track
guardrail attribute, and the producer names diverge): the `verdict` enum is the
convergent union across the producers, and `categories[].name` is deliberately
an open string so no vendor taxonomy is blessed (injection/jailbreak is a
category name, not its own type).

It is distinct from the shipped interactive approval gate
(`attention.*`/`control.*`, where a human is ASKED, in-band), from
`tool.denied` (a TOOL policy deny; a guardrail scores content), and from
`error.raised` (a block is a successful policy action). Choice A of the decision
card: the existing `assessment` category, no new category, no envelope change,
no SDK-validator lockstep.

## Backward Compatibility

Purely additive within the 0.1 major (AEP-0001 §11, GOVERNANCE.md §4): a new
category and three OPTIONAL `experimental` types
(`assessment.evaluation.recorded`, `assessment.feedback.received`, and
`assessment.guardrail.recorded`, §6) with their OPEN payload schemas. No
existing type, category, attribute, or capability is repurposed or removed.
A new optional type in the already-open `assessment` category is
additive-minor, with no category, envelope, or SDK-validator change (the
`assessment` prefix is already admitted by the envelope `type` pattern and
the SDK type grammar).

- **Emitters** that do not produce assessments are unaffected; nothing becomes
  required.
- **Consumers** predating this AEP already tolerate unregistered members in a
  known category (AEP-0001 §6), and a consumer that predates the *category*
  treats `assessment.*` exactly as it treats any unknown type: the envelope is
  well-formed and the event passes through. The updated envelope `type` pattern
  only *widens* the accepted set.
- **Stored streams** are unchanged; no prior event is reinterpreted.

Because the types are `experimental`, the payload shapes MAY change before they
graduate (extension → experimental core → core, AEP-0002 §6). Graduation to
stable is itself a superseding AEP. Consumers SHOULD gate on
`capabilities.experimental` (AEP-0003 §4) before relying on the shape.

## Security considerations

Assessments carry potentially sensitive content, handled by the existing
capture model (AEP-0003 §9), not a new mechanism:

- The rationale (`gen_ai.evaluation.explanation`), the feedback `comment`
  and `correction`, and the guardrail `guardrail.explanation` are
  **`redacted`**-classed. An emitter at a `metadata`
  capture ceiling MUST drop them; the redaction pipeline applies as to any
  `redacted` field. A metadata-only consumer keeps the assessment's fact and
  magnitude and never sees the text. This is enforced mechanically by the
  per-field `x-aep-capture` annotations and pinned by DL14/DL15/DL18.

  The guardrail `explanation` is a specific hazard: it can *quote the offending
  content* the guardrail fired on (a jailbreak prompt, a disallowed output), so
  routing it through redaction is load-bearing. The verdict/categories/detector
  are the fact worth keeping at `metadata`.
- Scores, labels, ratings, verdicts, categories, and the `evaluator`/`source`/
  `detector` tokens are `metadata`;
  emitters SHOULD keep free-text or identifying content out of them (put it in
  the gated fields), the same discipline other metadata tokens follow.
- No control authorization (AEP-0004), identity, or bridge-capture (AEP-0005
  §3.3) surface changes: an assessment is an ordinary session event on the
  bus, subject to the same token auth and capture enforcement as any other.

## Open questions

- **Graduation criteria.** What adopter evidence promotes `assessment.*` from
  `experimental` to core: a threshold of emitters, or a settled feedback
  shape? Owner: AEP maintainers; resolve before any 0.x → 1.0 freeze.
- **Dataset / offline-evaluation linkage.** Some vendors link a score to a
  dataset run or a comparative experiment (an offline-eval concept). This AEP
  deliberately scopes to the *live fleet stream* and omits it; revisit only if
  an adopter shows a concrete live-stream need. Owner: AEP maintainers.
- **A rerank/aggregate assessment.** A roll-up of several evaluations into one
  verdict is unmodeled; the natural follow-up card if demand shows. Owner: AEP
  maintainers.

## References

- AEP-0001, Core and Envelope (§3.2 fleet-observer test, §5.2 session-scoped
  requirements, §6 unknown-type tolerance, §11 additive evolution).
- AEP-0002, Taxonomy and Types (§3 category set, §4.2 optional types, §5.1
  open-schema/capture rules, §5.2 `usage`/`cost`/common-object precedent, §5.4
  the normative payload summary, §6 the promotion path).
- AEP-0003, Bindings and Lifecycle (§4 `capabilities.experimental`, §9
  capture levels and redaction).
- GOVERNANCE.md §2 (the SEP rule), §4 (additive versioning).
