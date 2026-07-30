---
title: "AG-UI bridge: design record"
sidebarTitle: "AG-UI bridge"
description: "Design of the AG-UI bridge: a tee proxy that maps HTTP run-event streams to AEP."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0003]
---

<Info>

**Status: shipped.** The bridge lives in the reference repository
(`impl/bridge-agui/`: the tee-proxy `receiver.js` plus the pure
`map-events.js`). The mapping is pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/agui.json` and smoke-verified end to
end. Verified against the published `@ag-ui/core` 0.0.57 types.

</Info>

## What AG-UI exposes

An AG-UI agent is an HTTP service: a client POSTs a run input and
receives that run's event stream, typed in `@ag-ui/core` (pinned at
0.0.57; types outrank prose; the pre-1.0 package already deprecates
`THINKING_*` in favor of `REASONING_*`) as a 31-member union. Families:
lifecycle (`RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, optional
`STEP_STARTED`/`STEP_FINISHED`), tool calls
(`TOOL_CALL_START/ARGS/END/RESULT/CHUNK`), text and reasoning streaming
(`TEXT_MESSAGE_START/CONTENT/END/CHUNK`, `REASONING_*`,
`REASONING_ENCRYPTED_VALUE`), state (`STATE_SNAPSHOT`, `STATE_DELTA`
carrying JSON Patch, `MESSAGES_SNAPSHOT`, `ACTIVITY_SNAPSHOT/DELTA`),
and the escape hatches `RAW` and `CUSTOM` `{name, value}`. Every event
optionally carries `timestamp` and `rawEvent` (the source payload when
transformed).

## Attach shape: a tee proxy, because observation must not drive runs

`receiver.js` sits between the UI and the AG-UI agent
(`AEP_AGUI_UPSTREAM`): it forwards each run POST verbatim, streams the
agent's response back untouched, and tees every event onto the AEP
relay. Neither side is modified; deployments point the UI at the
bridge. One POST equals one run stream, which makes identity scoping
trivial. *Rejected:* client mode (`@ag-ui/client` initiates runs; an
observer must never drive the agent) and framework-side middleware (one
integration per framework is not vendor-neutral). The tee costs a hop,
the honest price of observation without participation.

## Read-only channel: no control claim

AG-UI's interactive patterns (human-in-the-loop via run input) belong
to the UI-to-agent conversation the bridge stays out of. It emits no
`attention.*` requests with a respond path and accepts no commands:
`control: { accepts: [] }`. *Rejected:* mapping human-in-the-loop
interrupts (`RUN_FINISHED.outcome`) to `attention.requested`; without a
respond path it would still be visibility-only, and the interrupt shape
is framework-specific pre-1.0. Revisit at AG-UI 1.0.

## Identity: real vendor ids, no synthesis

`threadId` maps to AEP `session`, `runId` to AEP `run`, and `STEP_*`
stamps the envelope `step`. The bridge synthesizes nothing:
`RUN_STARTED` opens, `RUN_FINISHED`/`RUN_ERROR` closes, and events on
the same tee stream scope to that stream's run. `parentRunId` is not
session lineage (runs are not sessions); it rides at metadata as
`data.parent_run`. `agent` = `agui` unless `AEP_AGENT_NAME` overrides
(a proxy cannot know the agent's own name). *Rejected:* per-event
`threadId` lookups (most stream events do not carry it; the stream is
the scope).

## Mapping: lifecycle, tools, steps, and state on core; streaming planes vendor

- `RUN_STARTED` → `run.started`
- `RUN_FINISHED` → `run.finished` (`result` rides as `summary`, gated redacted)
- `RUN_ERROR` → `run.failed` (`{reason: code ?? 'error'}`, message redacted)
- `STEP_STARTED/FINISHED` → `run.step.started/finished` (envelope `step` = `stepName`)
- `TOOL_CALL_START` → `tool.requested` (`tool.name`/`call_id`)
- `TOOL_CALL_RESULT` → `tool.completed` (`result_digest` at metadata,
  content as `result_redacted` at redacted; the receiver joins the tool
  name from `TOOL_CALL_START`, since the result event carries only the
  call id)
- `STATE_SNAPSHOT` → `state.snapshot` (payload redacted)
- `STATE_DELTA` → `state.delta` (patch redacted; op count `data.ops` at metadata)
- `TEXT_MESSAGE_END` (assistant role) → `x.agui.text_message.end`, with
  the streamed content assembled by the receiver at redacted+.
  `message.agent.replied` is **reserved** (the message/stream
  sub-profile has not graduated), so the reply terminal ships in the
  vendor namespace and moves to core when the sub-profile does.

Everything else rides at `debug` in the vendor namespace, named by
lowering the UPPER_SNAKE type and splitting family from leaf
(`TEXT_MESSAGE_CONTENT` → `x.agui.text_message.content`); `CUSTOM` →
`x.agui.custom.event` carries `data.name` at metadata with `value`
redacted, and `x.agui.raw.event` never rides its payload below `full`.
**Token deltas** (`TEXT_MESSAGE_CONTENT/CHUNK`,
`REASONING_MESSAGE_CONTENT/CHUNK`, `TOOL_CALL_ARGS/END/CHUNK`) **are
suppressed by default**; `AEP_AGUI_DELTAS=1` opts them in at `debug`. A
fleet console does not want every token twice. `REASONING_ENCRYPTED_VALUE` maps to nothing, ever (opaque
ciphertext is not observability). Unknown types fall mechanically into
the vendor namespace, never guessed. *Rejected:* mapping
`TEXT_MESSAGE_*` deltas to a core streaming type; the registry's
message types are terminal summaries by design, and the sub-profile
question stays with the taxonomy, not an adapter.

## Fixtures, home, and conventions

`conformance/fixtures/mappings/agui.json` is built against the
`@ag-ui/core@0.0.57` types and pinned in both conformance runners:
per-event-type expectations at the default posture plus the
delta-opt-in variants. Live validation against a real AG-UI framework
(LangGraph, CrewAI, Mastra) is deferred; the fixtures carry the
conformance claim. The implementation follows the receiver floor: pure
`map-events.js` (pinnable, no I/O), healthz `{ok, relay, source}`
(`source` = upstream reachability, probed lazily; a proxy has no
standing upstream connection), error-or-close reconnect on the relay
WebSocket, an outbox, and a JSONL log per session. The smoke drives a
stub AG-UI agent speaking real streamed framing, including a mid-run
client disconnect, and runs `aep validate` over everything that flowed.
