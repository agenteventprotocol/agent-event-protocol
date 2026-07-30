---
title: "Hermes Agent adapter: design record"
sidebarTitle: "Hermes Agent adapter"
description: "Design and implementation record for the Hermes Agent adapter mapping shell hook events to AEP."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0004]
---

<Info>

**Status: SHIPPED.** The adapter lives in the reference repository
(`impl/adapter-hermes/`: the stdin-JSON `hermes-hook.js` shim, the
daemon with the approval pre/post pairing, and the pure
`map-hooks.js`). The mapping is pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/hermes.json` (both runners).

Hermes publishes no typed schema artifact: hook payloads exist only as
call-site keyword arguments, so every claim here is read from the
source at the pinned tag (the PyPI package ships the runtime modules,
so the enumeration is importable, just not typed). Every hook payload
carries `telemetry_schema_version: "hermes.observer.v1"`; the fixture
pins that string as the drift sentinel.

Verified against `NousResearch/hermes-agent` tag `v2026.7.7.2`
(= PyPI `hermes-agent` 0.18.2).

</Info>

## What Hermes exposes

Three hook systems: **shell hooks** (a `hooks:` block in
`~/.hermes/config.yaml`; subprocess, JSON on stdin, one bounded
response on stdout; CLI + gateway), **Python plugin hooks**
(in-process), and **gateway drop-in hooks** (a different vocabulary).
Shell and plugin hooks share one dispatcher and one 23-event
vocabulary (`VALID_HOOKS`). The stdin envelope is uniform:
`{hook_event_name, tool_name|null, tool_input|null, session_id, cwd,
extra:{...}}`. The observation-relevant payloads:

- `pre_tool_call`: `tool_name`, `args`, `session_id`, `task_id`,
  `turn_id`, `tool_call_id` (the pairing id), `api_request_id`.
- `post_tool_call`: the same plus `result`, `duration_ms`, and
  `status: "ok" | "error" | "blocked"` with
  `error_type`/`error_message`: a three-state result.
- `pre_llm_call`: `session_id`, `task_id`, `turn_id`, `user_message`,
  `conversation_history`, `is_first_turn`, `model`, `platform`.
- `on_session_start`: once per brand-new session.
- `on_session_end`: fired at the end of EVERY turn, despite the name,
  with `turn_id`, `completed`, `interrupted`
  (`agent/turn_finalizer.py:488-503`). The real session end is
  `on_session_finalize`, which carries the dying session's id on every
  path (`/new`/`/reset` fire it before the id rotates; shutdown and
  idle expiry fire it with the then-current id).
- `on_session_reset` is NOT a session end: the vendor mints a new
  session id on `/new`/`/reset` and fires this hook after the swap,
  with the SUCCESSOR's id (the finalize-then-reset order is
  test-pinned upstream).
- `subagent_start`/`subagent_stop`: typed `parent_session_id`,
  `parent_turn_id`, `child_session_id`, `child_role`, `child_status`,
  `duration_ms`.
- `pre_approval_request`/`post_approval_response`: observer-only
  visibility of Hermes's own human approval gate (`command`,
  `pattern_key`, `session_key`, `surface`; on post
  `choice: "once" | "session" | "always" | "deny" | "timeout"`); hooks
  cannot veto or pre-answer. Neither fire site passes a session kwarg,
  so every approval payload carries `session_id: ""`; the only
  identity aboard is `extra.session_key` (CLI: the agent session id;
  gateway: a platform-scoped `ns:platform:chat_type:chat_id` key).
- `pre_api_request`/`post_api_request`/`api_request_error`: the
  model-API plane.
- `pre_verify`, `transform_*`, `pre_gateway_dispatch`, `kanban_*`:
  verify-loop, mutation, and machinery planes (the transform hooks are
  Python-plugin-only mutations).

Output contract (`agent/shell_hooks.py:566-620`): `pre_tool_call` may
block (both `{"action":"block"}` and the Claude-Code-style
`{"decision":"block"}`); `pre_verify` may answer the stop-gate; every
other event accepts only `{"context": ...}`, consumed solely by
`pre_llm_call` and joined into the user message. Failures are
fail-open (timeout, spawn, and JSON errors warn and proceed). There is
no held-open answer loop on any shell hook, no compaction hook, and no
run id beyond `turn_id` (per user turn, `{session}:{task}:{uuid8}`).

## Surface and posture

The adapter registers twelve observation events through one command
shim (the template shared with the Claude Code, Codex, and Qwen
adapters): the tool pair, `pre_llm_call`, the four session-boundary
hooks, the subagent pair, the approval pair, and `api_request_error`.
The TUI-gateway JSON-RPC stream and the per-run SSE endpoint are
bridge-shaped second channels, deferred; the gateway drop-in
vocabulary is out of scope. *Rejected:* the API request pair
(duplicates what `pre_llm_call`/`post_tool_call` bind, at much higher
weight; `api_request_error` alone is kept); the Python plugin surface
(an observer does not live inside the agent when a subprocess surface
exists); the mutation planes.

The default posture is observe-only: the shim answers `{}` to every
hook, no block, no context, ever: an observer that changes what it
observes has broken capture honesty. Two independent opt-in gates
invert specific moments: `AEP_HERMES_CONTROL=1` (the operator-deny
gate) and `AEP_INSTRUCT=1` (steering). Under every combination the
vendor's own approval gate stays observed read-only: pre-answering it
is the one thing the vendor forbids. The gated-off hello declares
read-only (`control: { accepts: [], ack_window_ms: 10000 }`) so the
relay can refuse control sender-side; gated on, it declares the
accepted verbs.

## Identity

`session_id` → AEP `session`; `turn_id` → the AEP `run` id, verbatim.
`pre_llm_call` opens the run (`trigger: "user"`; `is_first_turn`
metadata); `on_session_end` closes it (`completed` → `run.finished`,
`interrupted` → `run.cancelled` `by: "user"`) because that hook fires
per turn, not per session. The session end maps from
`on_session_finalize` ALONE. `on_session_reset` carries the
successor's id and rides the vendor plane as `x.hermes.session.reset`:
mapping it to `session.ended` would end each fresh session at birth, a
violation of terminal exclusivity (AEP-0002 §2 convention 5).
`tool_call_id` pairs the tool trio; the envelope `agent` is `hermes`;
extensions live in `x.hermes.*`.

## The mapping

- `pre_tool_call` → `tool.requested` (`call_id` = `tool_call_id`; args
  digest at metadata, content at redacted+).
- `post_tool_call` → the three-way split on `status`: `"ok"` →
  `tool.completed`; `"error"` → `tool.failed` (`error_type` metadata,
  `error_message` redacted-gated); `"blocked"` → `tool.denied`. The
  registry REQUIRES `by` on `tool.denied`; a Hermes block comes from a
  blocking policy hook, so `by: "policy"`, with the block message as
  the schema's `rule` at redacted+.
- `pre_llm_call` → `run.started` (the heavy
  `user_message`/`conversation_history` are digested at metadata,
  never carried whole below `redacted`).
- `on_session_end` → `run.finished`/`run.cancelled`;
  `on_session_start` → `session.started`; `on_session_finalize` →
  `session.ended` (`reason: "normal"`; vendor free-text reasons stay
  out of the enum); `on_session_reset` → `x.hermes.session.reset`
  (vendor `reason` verbatim).
- `subagent_start`/`subagent_stop` →
  `delegation.subagent.started`/`.stopped` (subject
  `child_session_id`; parent ids, `child_status`, `duration_ms`
  metadata).
- The approval pair → the observed approval card (below).
- `api_request_error` → `x.hermes.api.error` at `error` severity.
- No compaction mapping (no hook exists; the Annex A row says so
  rather than inventing a moment). Unknown hook names →
  `x.hermes.<name>`.

*Rejected:* `pre_verify` onto core progress (an agent-loop internal);
`on_session_end` as `session.ended` (the name says session, the source
says turn: source wins).

## Fixtures, drift, home

`hermes.json` is generated from the pure mapping module against
payloads reconstructed from the call sites at the pinned tag; the
repository's own `_DEFAULT_PAYLOADS` (`hermes_cli/hooks.py:107-194`)
are the cross-check. The fixture's `$comment` records tag + source
paths and pins the `hermes.observer.v1` sentinel: a bump there is the
re-verify trigger. The approval vectors carry the vendor-true
`session_id: ""`.

`impl/adapter-hermes/`: the shim, the daemon (default
`127.0.0.1:8393`), `map-hooks.js`, and a CI smoke driving the real
shim per event exactly as the vendor's `hooks:` config would. Port
band 19040-19044.

## The opt-in operator-deny gate

`AEP_HERMES_CONTROL=1`, read by the daemon and inherited by the shim,
is the entire opt-in. Gated off, the shim is byte-for-byte the
observation path. Gated on, exactly one moment changes: a
`pre_tool_call` whose tool name matches `AEP_HERMES_GATE_TOOLS`
(regex, default every tool) is POSTed to a held route and becomes an
answerable `attention.requested` (kind `permission`, options
allow/deny, `respond_via: ["control"]`, `expires_at` = now +
`AEP_ATTENTION_TIMEOUT_MS`, default 55 000). The verb is the core
`control.attention.respond` (AEP-0004 §5); no vendor verb is minted;
the pure mapping and fixture do not move (the gated loop is daemon
state, smoke-pinned).

The vendor facts that make the gate sound:

- The hold window is vendor-supported configuration: every hook entry
  takes a per-hook `timeout:` (default 60 s, clamped 1-300 s); at
  expiry the dispatcher kills the shim, warns, and PROCEEDS: the
  vendor's own fail-open. The default hold sits under the vendor's
  default timeout, and the README states the invariant: the
  vendor-side `timeout:` must exceed the hold window.
- The veto path is vendor-directed: "use `pre_tool_call` to block a
  tool before it reaches approval" (`hermes_cli/plugins.py:175-180`);
  the block is the vendor's designed veto, not a loophole.
- The block contract: `{"action":"block","message":...}`; a non-empty
  message is required; the first directive wins; `pre_tool_call` fires
  exactly once per tool execution.
- The outcome chain is deterministic and pairable: a honored block
  yields the model-visible `{"error": message}` AND `post_tool_call`
  `status:"blocked"`, `error_type:"plugin_block"`, the same
  `tool_call_id` as the held call.
- Hold containment equals the vendor's own gate's: `pre_tool_call`
  fires inside the same tool-dispatch paths the vendor's own approval
  gate blocks for up to 300 s fail-closed; a bounded fail-open hold
  there changes no containment property the vendor has not accepted
  for itself.

Release semantics: **allow** → `{}`; the call proceeds into the
vendor's own downstream gates; the gate mints no permission.
**deny** → the vendor block shape, the message being the operator's
reason or the documented default. **expiry** → `attention.timeout` +
a `{}` release (the vendor's own hook-timeout semantics, stated).
**Socket closed before release** → `attention.resolved` (`dismissed`);
a later answer is `control.rejected` (`refused`). **Text answers**
(the AEP-0008 receiver rule): an option word (`allow`/`deny`,
case-insensitive, trimmed) IS that option, recorded as `answer.option`
with no text residue; any other free text applies the refusing option
with the text as the stated reason (unrecognized input refuses, never
grants); an empty answer, `values`, or a foreign option earn
`control.rejected` (`invalid`).

The outcome is `attention.answered { answer: {option, text?}, via:
"control" }` (cause = the command id) plus the chained
`attention.resolved` (`answered`, `latency_ms`), emitted at the
release, which IS the actuation: the directive is consumed by the shim
the daemon just answered; no asynchronous vendor round-trip exists.
The observed `post_tool_call` rides the pinned mapping unchanged
(`tool.denied by:"policy"`, cause-linked via `tool_call_id`). Human
attribution lives on the attention pair; `tool.denied.by` stays
inside the schema enum `policy|user_setting|runtime` (AEP-0002 §5.3).

Ack discipline is the synchronous family shape: dedupe on
(source, id), byte-identical re-acks, ack window 10 000,
`control.accepted` at the release, `control.rejected` with
`invalid`/`refused`/`unsupported`. `healthz` carries `control` (true
only when the gate is on). Not adopted, honestly: `control.cancel` (no
vendor cancel write exists; the `on_session_end` `interrupted` fact
remains the observed cancel) and `control.pause`/`control.resume` (no
pause plane). The gate sits BEFORE the vendor's own approval gate: an
allow releases the call INTO it, never past it.

*Rejected:* a two-entry registration (a config edit plus a second
subprocess spawn per tool call for every user); gating only the daemon
while the shim always waits (a gated-off shim must not add latency);
`tool.denied by:"user"` (schema-illegal); an
`x.hermes.tool.denied_by_user` duplicate (the attention pair already
carries the attribution); holding the answered event until
`post_tool_call` arrives (would invent an async settlement this
surface lacks); consumer-side text-to-option rewriting (option-id
meaning belongs to the adapter); suppressing the free-text affordance
(free text is load-bearing for deny reasons); mapping unmatched text
to the permissive option (ambiguity must not grant).

## Steering: `x.hermes.control.instruct`

The [steering family design](/components/control-steering-design)
applies verbatim: opt-in `AEP_INSTRUCT=1`, declared in hello
`control.accepts`, a per-session FIFO queue capped at 20 × 4000 chars,
shared (source, id) ack dedupe, cause-linked
`x.hermes.instruction.delivered { queued_ms }` /
`x.hermes.instruction.dropped { reason }` audits. Two Hermes facts are
source-pinned:

- **One eligible moment.** The parser accepts `{"context": ...}` on
  every non-gate event, but the runtime consumes context at exactly
  one site: the `pre_llm_call` invoke at turn start, joined into the
  user message, never the system prompt. The eligible set is
  `{pre_llm_call}` alone; a context return anywhere else would claim
  an injection that never happens. Eligibility is a consumption
  property.
- **The drop moment.** `on_session_end` closes the run, so the queue
  survives turn boundaries; drops ride the real session end alone
  (`on_session_finalize` → `session.ended`), audited before the
  terminal.

With the gate on, the shim prints the daemon's `/hook` reply for
`pre_llm_call` verbatim: `{}` (empty queue or any failure) or the
vendor's `{"context": ...}` shape; not a held loop. A gated
`pre_tool_call` reply carries the permission decision and never
steering; the two gates never mix semantics in one reply.
*Rejected:* delivering on any other hook reply (dead context); the
plugin surface (in-process); `pre_verify`'s continue/message return (a
different answer plane, unregistered); waiting for the TUI-gateway
channel (deferred).

## The observed approval card

The read-only `pre_approval_request` card carries the vendor's own
decision menu as data (`options` = `once`/`session`/`always`/`deny`,
the vendor's labels) and `respond_via: ["oob"]`: the card says on the
event itself that its answer arrives out-of-band, so a consumer can
render the menu as information without inviting an answer the daemon
must nack. Sourcing honesty: the hook payload does not carry the menu;
the options ride the vendor's **return contract**, the exact choice
set `post_approval_response` can deliver, not a per-prompt render
claim (under tirith content warnings the vendor hides `always` locally
and degrades a typed `always` to `session`; the returned choice stays
in the four-way set). The menu's "Show full command" entry never
returns as a choice and is not carried. The vendor's own prompt fails
closed: typed input honors `o/once`, `s/session`, `a/always` and maps
anything else to `deny`; timeout, EOF, and interrupt all return
`deny`.

`post_approval_response` → `attention.answered` (the `choice`) +
`attention.resolved`, except `choice: "timeout"` →
`attention.timeout`. The daemon pairs post to pre by (`session_key`,
`pattern_key`) with `tool_call_id` as tiebreaker. Because approval
payloads carry `session_id: ""`, the daemon joins `session_key`
against session ids already seen on the envelope and otherwise keeps
the event on the `unknown` lane: a gateway key must never mint a lane.

The parity ceiling, cited: the vendor's approval prompt cannot be held
or decided from this channel. `_fire_approval_hook` discards callback
results (`tools/approval.py:51-77`: "the approval flow is
safety-critical, plugin observability is not"), and the only
programmatic decision channel is in-process
(`tools.terminal_tool.set_approval_callback`, which the vendor's own
ACP server swaps in: the client IS the UI there), unreachable from a
subprocess hook by construction. The verdict would hold even given a
mechanism: pre-deciding a live terminal user's own prompt from the bus
fails the sovereignty criterion. For operators who deliberately
consolidate decisions on the AEP gate, the README documents a
one-decision-point posture from the vendor's own knobs
(`--yolo`/`/yolo`, `approvals.mode`, the persistent allowlist), with
the `approvals.deny` + hard-deny floor stated as un-loosenable from
the bus.

Upstream drift, named: the vendor's main branch grows another approval
surface (`surface: "smart"`, post
`choice: "smart_approve" | "smart_deny"`, `decided_by: "aux_llm"`),
the same fire-site contract, still no session kwarg; no tagged or PyPI
release carries it, and the pinned mapping moves only when one does.
The TUI-gateway JSON-RPC channel (its `approval.request` verb
included) stays the deferred second channel.

*Rejected:* carrying the vendor menu on the answerable gate card (the
gate cannot honor `once`/`session`/`always`: it mints no permission);
a vendor-namespaced menu payload (generic `options[]` carries instance
data); omitting `respond_via` in favor of consumer capability
inference (request-scoped declarations cannot go stale).

## The clarify form overlay

The `clarify` ask-the-user tool maps an OBSERVED form card (AEP-0006
`kind: "form"`) beside its pinned tool events; the tool trio never
moves.

The tool contract (`tools/clarify_tool.py`): args `{question REQ,
choices? ≤4}` (`MAX_CHOICES = 4`); the UI always appends a fifth
"Other (type your answer)"; choices are normalized once at the
platform-agnostic entry point (`_flatten_choice`: dict unwrap
`label`/`description`/`text`/`title`, trim, join lists, drop empties,
cap 4; an empty list degrades to open-ended); the result is a
self-contained JSON string `{question, choices_offered,
user_response}`, or `{"error": ...}`. The interaction blocks inside tool
execution, so `pre_tool_call` fires before the user is asked (question
+ choices aboard) and `post_tool_call` after the answer (result
aboard): the whole human loop is visible on two already-registered
events. CLI: a modal prompt, `CLI_CONFIG.clarify.timeout` default
120 s; gateway: a thread-blocking event queue. Return-contract
sentinels (static vendor strings at the tag): CLI timeout "The user
did not provide a response within the time limit. Use your best
judgement to make the choice and proceed."; CLI interrupt "The user
cancelled. Use your best judgement to proceed."; gateway timeout
`[user did not respond within {N}m]` (a bounded pattern); gateway
send-failure "[clarify prompt could not be delivered]". An `error` key
in the result derives `status: "error"`; a plugin block is
`status: "blocked"`, so only the timeout/cancel classification rides
the sentinels.

The overlay is pure mapping; the card is observed. A `pre_tool_call`
(clarify) with a valid non-empty question additionally emits
`attention.requested { kind: "form", prompt: "hermes asks a question",
fields: [one field], respond_via: ["oob"] }` (the prompt is structural
at every ceiling). The field mirrors the Claude Code adapter's form
shape: `select` with `other: true` and 1-based structural choice ids
when choices exist (labels content-gated per the AEP-0006 `[metadata*]`
exception), a `string` field when open-ended; the pre card applies the
vendor's own entry-point normalization, so the wire shows what the
user is shown, never the raw model args. `respond_via: ["oob"]` is the
honest channel: no result-consuming hook exists on this surface, so a
bus-answerable card would claim a channel the vendor never reads. A
question-less clarify mints no card. The daemon pairs by
`tool_call_id` (`pendingClarify` beside `pendingApproval`),
cause-links to the `tool.requested`, chains `attention.resolved`
(`answered`), and the `session.ended` sweep drains dangling clarifies
`dismissed` exactly as it drains dangling approvals.

The post result classifies the terminal, never fabricating an answer:
`status "blocked"`/`"error"` → `attention.resolved` (`dismissed`)
beside the pinned `tool.denied`/`tool.failed`. On `status "ok"`: the
timeout sentinels → `attention.timeout`; the cancel/undeliverable
sentinels and an empty `user_response` → `resolved` (`dismissed`);
anything else is the answer, `attention.answered { answer: { values },
via: "oob" }`, a picked choice as its structural 1-based id
(metadata-legal), Other/open-ended text gated through the shared
`gateFormValues` (redacted minimum). An unparseable ok-result makes no
lifecycle claim: the session sweep drains the card (degrade toward
less claimed).

Gate interplay: under the operator-deny gate a matching clarify call
raises BOTH cards, the answerable permission gate first, then the
observed form card. An allow releases the call into the vendor's own
ask; a deny lands `status "blocked"` → the form card resolves
`dismissed` beside `tool.denied`: the agent did ask, policy killed the
ask before the user saw it. The permission card's answer rides
`control`, the form card's rides `oob`, never mixed.

*Rejected:* an answerable card riding the gate's deny `message` as the
tool result (the text would reach the model as a BLOCKED tool's error;
the card would claim an answer the vendor never consumed as one);
`kind: "input"` + options (AEP-0006 exists to retire that shape);
suppressing the tool trio for clarify calls (the pinned mapping is the
vendor truth; the overlay adds the human-loop fact beside it);
daemon-state emission (every overlay fact is payload-derivable, so the
pure mapping is fixture-grade in both runners); building the pre card
from raw `tool_input.choices` (a shape the vendor never renders);
mapping cancel/undeliverable to `attention.timeout` (neither is a
timeout); mapping the CLI timeout's "agent will decide" sentence as an
answer (the model reads it as its instruction to proceed, but no human
answered; `answered` via `oob` asserts a human decision).
