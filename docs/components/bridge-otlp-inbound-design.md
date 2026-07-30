---
title: "OTel-inbound capture sidecar: design record"
sidebarTitle: "OTel-inbound sidecar"
description: "Design record for the OTel-inbound sidecar that captures agent OTLP log exports (Codex, the VS Code agent) as AEP events."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0003, AEP-0005]
---

<Info>

**Status: SHIPPED.** `impl/bridge-otlp-in/` in the reference
repository: `receiver.js` plus one pure mapper per vendor. The mapping
is pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/codex-otel.json` and smoke-verified
in CI: synthetic OTLP JSON `resourceLogs` fixtures (one per documented
`event.name`) are POSTed at the receiver, the mapped envelopes asserted
on a tokened relay in both modes, and `aep validate` run over what
flowed. No vendor account is needed.

</Info>

## What Codex emits

Codex's `[otel]` config exports LogRecords over OTLP (http/grpc);
`event.name` discriminates (vendor docs fetched 2026-07-11):

| `event.name` | Carries |
|---|---|
| `codex.conversation_starts` | session start: model, approval policy, sandbox policy |
| `codex.api_request` | API/model transport: status, duration, attempts, errors |
| `codex.sse_event` | streaming activity: event kind, success/failure, token counts |
| `codex.websocket_request` / `codex.websocket_event` | real-time transport activity |
| `codex.user_prompt` | prompt length; content `[REDACTED]` unless `otel.log_user_prompt` is enabled vendor-side |
| `codex.tool_decision` | approval decisions + whether the source was user, config, or automation |
| `codex.tool_result` | tool execution: duration, success, arguments, output |

Identity attributes: `conversation.id` (the session key), `model`,
`originator`, `app.version`, `user.email`; resource attributes:
`service.name` (`codex-app-server`), `service.version`, `host.name`.
The set is representative, not exhaustive: the vendor may add events
per version and surface.

## Design

- **Receiver**: single-endpoint, zero-dependency HTTP
  (`POST /v1/logs`, `application/json` OTLP), an ordinary emitter on
  the standard relay path; protobuf exports (the OTLP/HTTP default)
  transcode through an OTel Collector (`otlphttp` exporter,
  `encoding: json`). *Rejected:* native protobuf decoding, a dependency
  or hand-rolled wire decoder larger than the sidecar.
- **Identity**: `session` = `conversation.id`; `agent` = `codex`;
  `source` = `aep://{host.name}/agent/codex/session/{conversation.id}`;
  `originator` as metadata; no `run` is synthesized. *Rejected:* a run
  per `codex.user_prompt`: an OTel pipeline batches and retries, so
  cross-wire interleavings cannot pair a run boundary honestly.
- **Modes**: **companion** by default: everything lands in the vendor
  namespace, core types are never emitted, and a co-observing hook
  adapter stays the sole core-type authority. The explicit `--primary`
  flag enables core-type emission for deployments running no hook
  adapter. *Rejected:* runtime presence-detection (racy, wrong across
  restarts); semantic dedupe (AEP dedupe is by envelope `id`, AEP-0001
  §7.4; cross-emitter moment-identity would be new protocol surface);
  sharing the hook adapter's emitter identity (the forged-identity
  class of AEP-0003 §8.2).
- **Namespace**: `x.codex.otel.{snake_of_event_name}`, not the hook
  adapter's `x.codex.session.*`: the third segment names the channel,
  so the stream answers which pipeline carried a moment. *Rejected:*
  reusing `x.codex.session.*`, which interleaves two channels into one
  family.
- **Capture**: `prompt` content forwards only when vendor-side
  `otel.log_user_prompt` is enabled AND the ceiling is `redacted`+,
  through the shared `redactText`; `user.email` (PII) at `full` only;
  `host.name` at `redacted`; model ids, durations, statuses, token
  counts are metadata-grade. *Rejected:* trusting upstream redaction;
  capture honesty is the emitter's obligation (AEP-0001 §8.2).

## Mapping

In `--primary` mode: `codex.conversation_starts` → `session.started`;
`codex.tool_result` → `tool.completed`/`tool.failed` (by the success
flag; duration at metadata, arguments and output gated `full`);
`codex.tool_decision` with a deny from config or automation →
`tool.denied` (`data.by` from the decision source); a user deny is a
human decision, not a policy block, and maps to nothing.
`codex.user_prompt`, `codex.api_request`, `codex.sse_event`, and
`codex.websocket_*` stay in `x.codex.otel.*` in both modes: transport
and prompt internals fail the fleet-observer test. No `session.ended`
exists on this channel; sessions close by consumer recency policy (the
AEP-0002 §4.1 emitter-completeness posture).

## Vendor profiles

`--vendor codex` (default) and `--vendor vscode` (the VS Code agent's
opt-in OTel channel, the `copilot_chat.*` LogRecord family, verified in
the vendor source at the pinned tag). A profile is exactly three seams:
the agent identity; the session key (codex: the per-record
`conversation.id`; vscode: the resource-level `session.id`); the pure
mapper (`map-records.js` / `map-records-vscode.js`, same contract, own
`KNOWN` set, own `x.<vendor>.otel.*` namespace, own primary core
subset). One vendor per process: a two-vendor deployment runs two
instances on distinct ports. The vscode primary subset is deliberately
smaller (`session.started` + `tool.completed`/`tool.failed` only): the
vendor computes the allow/deny/ask tier after the hook span closes, so
`tool.denied` never reaches OTel, and session end does not exist on the
editor target. *Rejected:* a second sidecar component (identical
transport and process shape, zero delta); in-process multi-vendor
dispatch (one connection claiming two agent identities, the
forged-identity class of AEP-0003 §8).

## Non-goals

No new core types; no metrics/traces ingestion (per-event context lives
in the logs); no protobuf. Not a general OTLP→AEP bridge: mappings are
vendor-shaped and gated on `event.name`; foreign LogRecords fall to
`x.<vendor>.otel.unknown` rather than guessing. The outbound direction
([bridges](/components/bridges), `aep-bridge-otlp`) is this note's
mirror; the hook channel ([adapters](/components/adapters)) is what
companion mode defers to; [vendor surfaces](/vendor-surfaces) holds the
survey position this note settles.
