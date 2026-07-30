---
title: "OpenHands bridge: design record"
sidebarTitle: "OpenHands bridge"
description: "Design of the OpenHands bridge: a WebSocket observer on the agent server's event fan-out, mapping to AEP, with an opt-in control gate."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0003, AEP-0005]
---

<Info>

**Status: shipped.** The bridge lives in the reference repository
(`impl/bridge-openhands/`: the pure `map-events.js` with its
`statusMoments` transition table, plus `receiver.js`). The mapping and
the status-transition table are pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/openhands.json` (both conformance
runners, delta-opt-in forks included) and smoke-verified against stub
agent servers speaking the real auth and replay protocol. The default
posture is read-only; one opt-in gate (`AEP_OPENHANDS_CONTROL=1`)
enables five enumerated writes. The source survey lives in the
[protocol-sources table](/vendor-surfaces). Verified against OpenHands
`software-agent-sdk` v1.36.1 (commit `1d0a0b8`).

</Info>

## What the agent server exposes

The agent server (`openhands-agent-server`, the SDK's remote server) is
a standalone long-running service (uvicorn, default port 8000;
published image `ghcr.io/openhands/agent-server`). Three observation
channels; types outrank prose throughout:

- **WebSocket** `GET /sockets/events/{conversation_id}`: a pub/sub
  fan-out sized for multiple observers (`max_subscribers=50` per
  conversation), with replay on connect (`resend_mode=all`, or `since`
  plus `after_timestamp`) and first-message auth
  (`{"type": "auth", "session_api_key": ...}`, 10 s window). The socket
  is **read-write**: any non-auth inbound frame is validated as a
  `Message` and drives the conversation.
- **REST**: `GET /api/conversations/search` for discovery;
  `GET /api/conversations/{id}/events/search`, paged (limit ≤ 100) and
  filterable by `kind`/`source`/timestamp, over the persisted log.
  Lifecycle POSTs (start/pause/run/delete) live on the conversation
  router; `respond_to_confirmation {accept, reason}` lives on the event
  router (`POST /api/conversations/{id}/events/respond_to_confirmation`).
- **Webhooks**: config-declared batched POSTs to `{base_url}/events`
  (buffer 5, flush 30 s, 3 retries at 5 s, bounded queue 1000 with
  drop-oldest) and conversation info to `{base_url}/conversations`.

The event union is Pydantic v2, discriminated by `kind` (the class
name), `extra=forbid`, frozen. Base fields: `id` (uuid), `timestamp`
(ISO, **naive server-local**), `source` (`agent|user|environment|hook`),
`parent_id` (a conversation tree). Members at the pin: `MessageEvent`,
`ActionEvent`, `ObservationEvent`, `UserRejectObservation`,
`AgentErrorEvent`, `SystemPromptEvent`, `Condensation`,
`CondensationRequest`, `CondensationSummaryEvent`,
`ConversationStateUpdateEvent`, `ConversationErrorEvent`, `PauseEvent`,
`InterruptEvent`, `StreamingDeltaEvent`, `TokenEvent`,
`HookExecutionEvent`, `ACPToolCallEvent`, `LLMCompletionLogEvent`, plus
a resume-transcript member; bash terminal events ride a separate
`/sockets/bash-events` socket.

One transport fact governs everything downstream: at the HTTP/WS
boundary, `event_transport_dump` serializes with `exclude_none`,
**strips `parent_id`**, and filters unknown tool kinds out of `tools`
lists for older clients. An observer sees the transport shape, not a
raw SDK dump.

## Attach shape: an observer on the blessed fan-out, not a tee

`receiver.js` attaches to `/sockets/events/{conversation_id}` as one
consumer among the server's own fan-out capacity, discovers
conversations via `GET /api/conversations/search`, and republishes
mapped events onto the AEP relay. Nothing is interposed and nothing is
spawned: the server is standalone and multi-observer by design; the
operator runs it, and the bridge is a late-joining observer any
keyholder could equally run. *Rejected:* a tee/proxy (nothing to
interpose; the vendor blesses direct attach); webhook-first attach (see
the discovery section); driving conversations in order to observe them
(an observer that starts runs is not an observer).

## Read-only by default: a posture, not a permission

The events socket is read-write and the session API key carries **no
read-only scope**: any key that can observe can also drive.
Observe-only is therefore a bridge posture: by default the
first-message auth frame is the only frame the bridge ever writes, no
REST write is ever called, and the hello advertises
`control: { accepts: [] }`. Consequently `attention.requested` ships
with no options and no respond path: the server's own approval actuator
exists on the wire, and the ungated bridge never touches it.
Deployments must carry the vendor's own warnings: the server is
**unsecured by default** (an empty configured key list accepts
unconditionally), and a leaked observer key is a driver key. The
control gate below inverts this posture for five enumerated writes; it
mints no permission the key did not already carry. *Rejected:*
answerable attention by default (answering drives the conversation);
asking operators to mint a "read-only key" (no such scope exists;
pretending otherwise is a false security claim).

## Identity: the conversation is the session; the stream is the scope

`conversation_id` (the WS path / discovery id) maps to AEP `session`;
transport events do not repeat it, so the stream is the scope. The
vendor event `id` (uuid) is the dedupe key across replay and reconnect
and rides at `data.vendor_event_id` (metadata floor). `agent` =
`openhands` unless `AEP_AGENT_NAME` overrides; `session.started`
carries `client: {name: "openhands-agent-server"}` plus the server
host at metadata, and no `label` (the field is redaction-gated, and the
envelope `session` already carries the conversation id).
`ActionEvent.llm_response_id` groups the parallel tool calls of one LLM
response and stamps the envelope `step` on action/observation-derived
envelopes; there is **no `run.step.*` synthesis**, because the server
publishes no step-boundary fact and the bridge does not invent one.
*Rejected:* per-event conversation lookups (not on the transport);
synthesizing step boundaries from `llm_response_id` changes (an
inference, not a vendor fact).

## Run synthesis: the server's own execution-status facts

`ConversationStateUpdateEvent` is a key/value state sync (`key` is a
`ConversationState` field name or `full_state`). The bridge reads
`execution_status` from either shape and synthesizes runs from the
server's own enum (`idle`, `running`, `paused`,
`waiting_for_confirmation`, `finished`, `error`, `stuck`, `deleting`):

- → `running` opens `run.started` (id `run:<conversation_id>:<n>`).
- → `finished` closes `run.finished`.
- → `error` closes `run.failed` (`reason: error`; the typed detail
  rides the separate `error.raised` mapped from
  `ConversationErrorEvent`).
- → `stuck` closes `run.failed` (`reason: stuck`, the server's own
  loop-detection verdict).
- → `deleting` closes `run.cancelled` (`reason: deleting`) and ends the
  session: `session.ended.reason` is a closed enum, so deletion
  classifies as `killed`, with the deleting detail on the
  `run.cancelled` reason string.
- `running` → `idle` with no terminal closes `run.finished` honestly
  with `data.reason: idle` (the server treats idle as ready-for-tasks;
  a later `running` opens a new run).
- `paused` and `waiting_for_confirmation` do not close the run.

*Rejected:* bracketing runs on `ActionEvent`s (actions are steps of a
run; the status plane is the vendor's own lifecycle authority);
treating `paused` as terminal (the vendor resumes it).

## The attention loop: wire-visible approval

Status → `waiting_for_confirmation` emits `attention.requested`
(`kind: permission`); leaving it emits `attention.resolved`
(`resolution: answered`, or `dismissed` when the exit is `paused` or
`deleting`). By default the request carries no options and no respond
path; under the control gate it becomes answerable (below). The reject
outcome is typed: `UserRejectObservation` with `rejection_source: hook`
maps to `tool.denied` (`by: policy`); `rejection_source: user` ships
vendor-scoped as `x.openhands.user_reject.observation`, because the
`tool.denied` `by` vocabulary has no `user` value: a user rejection is
a human decision, not a policy block. The accept path needs no extra
emission: the real `ObservationEvent` arrives and maps normally.
*Rejected:* `attention.answered` on acceptance (the bridge did not
answer, and the server emits no discrete accept event; inferring one
from status flapping would fabricate an actor).

## Field maps: core where the fact is typed, `x.openhands.*` everywhere else

Core mappings, from the source models:

- `ActionEvent` → `tool.requested`: `tool.name` = `tool_name`,
  `call_id` = `tool_call_id`; the `action` arguments are
  redaction-gated, with a digest (`args_digest`) at metadata;
  `security_risk` (the LLM's own risk label) rides at metadata as
  `data.risk` when not `UNKNOWN`; `thought`, `reasoning_content`, and
  `thinking_blocks` never ride below redacted+; the optional `summary`
  is redaction-gated.
- `ObservationEvent` → the honest `is_error` split (the observation
  model types it): `is_error: false` → `tool.completed` (content
  redaction-gated, `result_digest` at metadata); `is_error: true` →
  `tool.failed` with `error` from the observation's error text
  (`tool.failed` requires `error`).
- `AgentErrorEvent` → `tool.failed` (`error` = its typed `error` field;
  it extends the observation base, so `tool_call_id` joins it to the
  call).
- `ConversationErrorEvent` → `error.raised` (`data.code` at metadata;
  `detail` redaction-gated); the run close itself comes from the status
  plane.
- `Condensation` → `session.compacted` (`data.forgotten` = count of
  `forgotten_event_ids`; `summary` redaction-gated).
- `ConversationStateUpdateEvent` → `state.snapshot` when `key` is
  `full_state`, else `state.delta` (`data.key` at metadata, value
  redaction-gated), in addition to the run-synthesis reads.

The vendor plane rides at `debug`, named mechanically from the `kind`:
snake-case it, drop a trailing `_event`, split family from leaf at the
last underscore, and append `.event` to single-segment names (the
envelope type grammar requires two segments after the vendor token).
So: `MessageEvent` → `x.openhands.message.event` (role and sender at
metadata, content redaction-gated; `message.user.submitted` and
`message.agent.replied` are **reserved** core types),
`StreamingDeltaEvent` → `x.openhands.streaming.delta`,
`CondensationRequest` → `x.openhands.condensation.request`,
`PauseEvent` → `x.openhands.pause.event`, `InterruptEvent` →
`x.openhands.interrupt.event`; every other and every future member
falls into the same rule with the payload redaction-gated (the union is
`extra=forbid` and grows by release; unknown kinds must degrade to
visibility, never to a crash or a guess). `StreamingDeltaEvent` is
suppressed by default; `AEP_OPENHANDS_DELTAS=1` opts in. The vendor
does not persist deltas to the conversation log, so replay after
reconnect legitimately lacks them. `TokenEvent` (raw token-id arrays)
maps to **nothing, ever**: token-id planes are not observability.
*Rejected:* mapping `MessageEvent` to the reserved core message types
(the sub-profile question stays with the taxonomy, not an adapter); a
`tool.requested`/`tool.completed` pair for `ACPToolCallEvent` (it
mirrors another protocol's tool plane; double-mapping would duplicate
calls the ACP bridge already observes when both are deployed).

## Timestamps: receive-time authority, vendor time preserved

Vendor timestamps are naive server-local ISO strings (the server even
normalizes REST search filters to its own zone); with no offset, any
conversion to an envelope `ts` invents one. The bridge stamps `ts` at
receive time (UTC) and carries the vendor string verbatim at
`data.vendor_ts` (metadata floor) for live, replayed, and REST-fetched
events alike; per-conversation ordering follows the socket's own
delivery order. *Rejected:* trusting a configured server-timezone
offset (a wrong guess silently corrupts every timestamp; receive time
is at least honestly ours); dropping the vendor time (it is the only
key into the server's own REST filters).

## Discovery: search polling; the webhook sink is a specified second channel

The bridge polls `GET /api/conversations/search` every
`AEP_OPENHANDS_POLL` seconds (default 15) and attaches a socket per
discovered conversation: first attach `resend_mode=all`; reconnect
`resend_mode=since` plus `after_timestamp` = the last seen vendor
timestamp, with vendor-id dedupe absorbing the overlap;
`session.started` on first sight.

The server's webhook push channel is the better cadence story, but it
requires the server's config to name the bridge's URL and an inbound
listener on our side. That channel is deferred, and specified rather
than vague: it subscribes to the same per-conversation fan-out (no
additional event kinds), yet posts raw `model_dump(mode="json")`, never
`event_transport_dump`, so `parent_id` lineage survives on that wire;
its conversation-info channel posts full `ConversationInfo` snapshots
at start/pause/interrupt/delete/update, making metadata-only changes (a
title rename mutates stored state without any
`ConversationStateUpdateEvent`) observable there and only there; resume
posts no conversation-info call (pause and interrupt do); auth is the
session key sent outbound (`X-Session-API-Key`). Build triggers: a
deployment where polling cadence or fan-out limits bite, or one that
needs the parent tree or bus-invisible metadata on the wire.
*Rejected:* webhook-first (config coupling into the observed system as
a prerequisite for any observation inverts the attach story); a fixed
conversation list (conversations come and go; discovery is the server's
whole point).

## Fixtures anchor the transport shape

`conformance/fixtures/mappings/openhands.json` anchors
**`event_transport_dump` output**: no `parent_id`, `exclude_none`
serialization, legacy-filtered `tools` lists, never raw SDK dumps. Two
consequences: the bridge makes no lineage claim (`event_transport_dump`
pops `parent_id` at exactly two call sites, the socket handler and the
REST search endpoint; only the deferred webhook channel retains it),
and fixture payloads omit absent optionals rather than carry `null`s.
Fixture values come from the pinned models' field definitions.
*Rejected:* fixtures from SDK-side `model_dump` (observers never see
that shape); fixtures from docs examples (types outrank prose).

## Home and conventions

`impl/bridge-openhands/` follows the daemon floor: pure `map-events.js`
(pinnable, no I/O) plus `receiver.js` (discovery loop, per-conversation
sockets, relay WebSocket with error-or-close reconnect, outbox, JSONL
log per session); healthz `{ok, relay, source}` on port 8397
(`AEP_OPENHANDS_PORT`; `source` = agent-server reachability). The smoke
drives a stub agent server speaking the real protocol (first-message
auth, replay modes, REST search) and asserts the approval loop, the
`is_error` split, every terminal status plus the idle close, deltas off
then on, reconnect-with-`since` dedupe, the no-`parent_id` transport
shape, and `aep validate` over everything that flowed. The real server
is a heavy Python service: CI drives the stub at the fixture-replay
bar, and live validation against a real `openhands-agent-server` is
deferred.

## The opt-in control gate

### One gate, five writes

`AEP_OPENHANDS_CONTROL=1` inverts the read-only posture for exactly
five writes: `respond_to_confirmation`, `POST /{id}/pause`,
`POST /{id}/run`, `POST .../events` (send input, `run` pinned false),
and `POST /{id}/interrupt`. Gated on, the hello declares
`control: { accepts: ["control.attention.respond", "control.pause",
"control.resume", "x.openhands.control.send_input",
"x.openhands.control.interrupt"], ack_window_ms: 10000 }`; gated off,
the hello declares `accepts: []` and the wire behavior is byte-identical
to the read-only bridge, provable because the gate wraps the only write
paths. The three core verbs are the AEP-0004 §5 registry; the two
vendor verbs follow the §5 extension rule. No schema, registry, or spec
text moves with the gate.

**The gate mints no permission**: the session API key has no read-only
scope, so an observer key always was a driver key; the gate changes
only what this bridge is willing to write with it. Driving the
conversation with the session key is one trust decision, so it is one
gate. Control rides REST exclusively: the events socket stays
auth-frame-only even under the gate (a socket write would drive the
conversation as an untyped `Message`; REST is the typed actuator the
vendor documents for each verb). *Rejected:* a CLI flag (the config
plane is environment variables); treating the gate as a security
boundary (it is a posture boundary; the key warnings stand); per-verb
gates (five writes, one trust decision); driving over the WebSocket (it
would blur the one-frame-ever auth invariant that makes the default
posture provable from code).

### The approval loop becomes answerable

Under the gate, the `attention.requested` for `waiting_for_confirmation`
gains approve/deny options and a respond path: a receiver-side
decoration; the pure `statusMoments` table, the pinned fixture, and the
gated-off payload are unchanged. Option `approve` →
`{"accept": true}`; option `deny` → `{"accept": false, "reason":
answer.text}` when the operator gave one, else the vendor's own default
(`"User rejected the action."`). A respond whose `subject` is not the
live pending request is nacked `refused`.

**One outcome source.** The vendor broadcasts the resolution as the
status flip out of `waiting_for_confirmation` (plus typed
`UserRejectObservation`s on deny): that observed flip is the outcome,
whoever caused it. A respond marks the pending entry *settling*, so
when the flip arrives the bridge emits `attention.answered` (the echoed
answer, redaction-gated) and `attention.resolved` cause-linked to the
command id per AEP-0004 §5/§6. A flip with no settling mark takes the
plain observed path; a REST failure before the flip nacks
(`refused`/`busy`) and clears the mark. Nothing is emitted that the
socket did not show. *Rejected:* emitting `attention.answered` at
REST-200 time (the 200 means "request accepted", not "resolved");
treating `UserRejectObservation` as the loop outcome (it is per-action;
a deny with several pending actions yields several rejections but one
resolution); options on the gated-off request (an option set the
channel cannot honor is the exact false claim the read-only posture
refuses).

### Pause and resume

Vendor semantics, from the source: the SDK's `pause()` is a silent
no-op unless the status is `idle` or `running`; from those it sets
`paused` and emits `PauseEvent`, taking effect between steps (the
current LLM call completes), and the REST `200 Success` does not imply
a transition. `POST /{id}/run` conflicts (409) only when already
running; from `paused` it resumes; from `idle` it starts work; from
`waiting_for_confirmation` it proceeds with the pending actions, a
silent accept.

`control.pause` → `POST /{id}/pause`, forwarded only when the
last-observed `execution_status` is `running`; everywhere else the
command is nacked `refused`, because acking a write the vendor will
silently ignore reports a pause that never happens. Pausing an `idle`
conversation is refused too: "paused" and "ready for tasks" differ only
in a flag no run exists to honor, and the verb's operator intent is to
suspend active work. `control.resume` → `POST /{id}/run`, forwarded
only when the last-observed status is `paused`. From `idle` it is
refused: `run()` there starts work, and an observer-turned-controller
that initiates runs is operating, not resuming. From
`waiting_for_confirmation` it is refused with a detail naming the
respond verb: the vendor's `run()` there silently accepts the pending
actions, so a resume that doubles as an approval would bypass the
answerable attention loop.

Outcomes, per the AEP-0004 §5 vendor-defined-pause clause: the vendor's
own `execution_status` flip to `paused` (or back to `running`) already
rides `state.delta`, and under a pending command it is cause-linked to
the command id via per-conversation `pendingPause`/`pendingResume`
notes; any status change clears the notes, so no stale links persist.
The vendor's `PauseEvent` keeps riding as `x.openhands.pause.event`
(debug), uncolored: one outcome, one cause link. *Rejected:* mapping
`control.pause` to `/interrupt` (more force than the verb asks; the
escalation stays vendor-scoped, below); synthesizing a dedicated pause
event type (`state.delta` already carries the vendor-defined state);
accepting resume from `waiting_for_confirmation` or `idle` (the two
dishonest resumes above); closing or reopening AEP runs on pause/resume
(run synthesis treats `paused` as non-terminal; a resumed run is the
same run).

### `control.cancel` is not adopted

No OpenHands write terminates a run: `/pause` and `/interrupt` both
land in resumable `paused`, and reporting `run.cancelled` off either
would fabricate a terminal the vendor does not have, for a run the
vendor will happily resume. `DELETE /{id}` does terminate, by
permanently deleting the conversation and its history: destruction, not
cancellation, and nothing an observer-turned-controller should carry
under a routine control verb. `/goal/stop` stops the goal loop, not the
conversation. So the gated hello does not list `control.cancel`, and
the relay refuses it sender-side off the declared accepts. *Rejected:*
`/interrupt` as scope-run cancel (a pause in cancel's clothing);
`DELETE` as scope-session cancel (the blast radius is the session's
entire persisted history); declaring cancel and nacking it locally (the
declaration is the consumer's discovery surface; declaring what will
always refuse is noise).

### `x.openhands.control.send_input`: user-plane input, never `instruct`

The [steering design](/components/control-steering-design)'s convergent
corpus is advisory context injection; OpenHands has no such surface.
`POST /api/conversations/{id}/events` takes `SendMessageRequest`:
`role` (the SDK asserts **user-only**), `content` (text/image parts),
and `run: bool = false`; the text becomes a user message in the
conversation, the opposite plane, so the verb is vendor-scoped and
deliberately outside the `instruct` corpus.

Payload: `{ "text": string [redacted] REQ }`, cap 4000 characters (the
steering family's bound); no `delivery` field, because OpenHands has
one append plane and no queue/steer distinction to expose. The bridge
sends `role: "user"` with one text part and **pins `run: false`
permanently**; `run: true` is rejected on three independent grounds:
from `idle` it starts work (the driving-operator shape every control
surface in this project refuses), from `waiting_for_confirmation` it
silently accepts the pending actions (an input that doubles as an
approval would bypass the answerable attention loop), and its ACP
supersede path fires an internal interrupt nobody commanded. There is
**no status guard**: the append lands in every status, and the vendor's
`200 Success` returns only after the append completes, so 200 means
*appended*, not *will try*. The vendor's side effects are observed
rather than promised: a live run consumes the input on a later step; an
idle or paused conversation queues it; an active goal loop is
superseded resumably; `FINISHED`/`STUCK` reset to `IDLE` (`ERROR` does
not), a flip that rides `state.delta` like any other. Outcome:
`x.openhands.input.sent {}` cause-linked to the command id at REST 2xx;
the appended message's own `MessageEvent` rides the socket through the
existing mapping; the `text` is never echoed in the outcome.
*Rejected:* naming it `instruct` (it would counterfeit the corpus a
future core-verb proposal must weigh); exposing `run` as a payload
field (the three grounds above); a waiting-for-confirmation refusal
guard (the `run: false` append neither answers nor bypasses the pending
approval; refusing would invent a restriction the vendor does not
have); role passthrough (offering roles that fail server-side is a
false schema claim); echoing text in outcomes.

### `x.openhands.control.interrupt`: the escalated pause

`POST /{id}/interrupt` cancels an in-flight LLM task instantly (a
cancellation token is set first so parallel tool executors skip pending
calls); the conversation lands **resumable `paused`** and emits
`InterruptEvent`; with no async task in flight the endpoint falls back
to `pause()`. `control.pause` waits out the current LLM call, and a
runaway call is exactly the moment an operator cannot wait, so the
instant variant maps as the vendor-scoped escalation, payload `{}`. It
is not cancel: resumable `paused` is never a terminal.

Forwarded only when the last-observed `execution_status` is `running`,
the same guard as `control.pause` with a sharper reason: the fallback
to `pause()` means an interrupt sent to an `idle` conversation would
mint the idle-pause the pause guard refuses, and one sent to
`paused`/`waiting_for_confirmation` is a silent no-op the ack would
misreport. Outcome: the vendor's own status flip to `paused` rides
`state.delta` cause-linked via a per-conversation `pendingInterrupt`
note (any status change clears it); the vendor's `InterruptEvent` keeps
riding as `x.openhands.interrupt.event` (debug), uncolored: one
outcome, one cause link. Resumption needs nothing new:
`control.resume` already honors `paused`, however it was reached. A
stated side effect: a service-side interrupt bumps the vendor's
interrupt generation, cancelling any vendor-side deferred run intent.
*Rejected:* mapping it onto `control.pause` with a force flag (a §5
core verb gains no vendor-specific payload; the extension rule exists
so escalations stay in the vendor namespace); forwarding from any
non-running status (the fallback-to-pause dishonesty above);
synthesizing a distinct interrupt outcome event (the status flip is the
fact); treating interrupt as scope-run cancel (resumable `paused` is
not a terminal).

### Ack discipline: REST-settled

Commands dedupe on (source, id); a recorded ack re-emits
byte-identically on redelivery; an in-flight guard drops duplicates
that arrive mid-decision (REST settlement is async: the one forthcoming
ack answers every delivery). The reply guard
`AEP_OPENHANDS_ACK_GUARD_MS` (default 8000, inside the declared 10 s
window) converts the REST result: 2xx → `control.accepted`; 4xx/409 →
`control.rejected` (`refused`, detail redaction-gated); server
unreachable → `busy`; guard expiry → `control.accepted` (will-try: the
write may still land, the outcome events remain the truth, and no
outcome is synthesized without a 2xx). Guard checks are evaluated
before the REST call from the bridge's own last-observed status, the
same state that drives run synthesis, so refusals are consistent with
what the stream shows.

### Out of scope, stated

- the goal-loop trio (`/goal`, `/goal/stop`, `/goal/resume`):
  initiating and steering work is operating
- `DELETE /{id}` (destruction, not control)
- webhook configuration (the deferred second channel)
- conversation creation/start

The events socket write path stays auth-frame-only unconditionally,
gated or not.
