---
title: "ACP bridge: design record"
sidebarTitle: "ACP bridge"
description: "Design of the ACP bridge mapping the Agent Client Protocol to AEP."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0005]
---

The bridge observes editor↔agent traffic on the Agent Client Protocol
wire: the tee binary (`bridge-acp.js`: spawn the real agent from argv,
pipe and tee), the pure mapping module `map-frames.js`, and the daemon
side on the shared receiver floor (port band 19050-19054), at
`impl/bridge-acp/` in the reference repository. The mapping is pinned
in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/acp.json` in both conformance
runners. Verified against agentclientprotocol/agent-client-protocol
schema-v1.19.0 (`schema/v1/schema.json`, 142 definitions; `meta.json`
pins `protocolVersion` 1; npm `@agentclientprotocol/sdk` 1.2.1),
fetched 2026-07-12.

## What ACP exposes

ACP is an editor↔agent protocol: the client (editor) spawns the agent
as a subprocess and speaks newline-delimited JSON-RPC 2.0 over stdio
(no embedded newlines; stderr is reserved for logging; "streamable
HTTP" is a draft discussion). The observation-relevant surface:
`session/new` / `session/load` bind the `sessionId`; `session/prompt`
(client→agent) opens a turn whose response carries `stopReason ∈
end_turn | max_tokens | max_turn_requests | refusal | cancelled`;
`session/cancel` is the client-initiated interrupt; `session/update`
notifications (agent→client) stream the turn; `session/request_permission`
(agent→client) carries a `toolCall` and
`options[{optionId, name, kind}]`, answered `selected{optionId}` or
`cancelled`; `fs/*` and `terminal/*` are the editor-capability plane.

There is no spec-level observation point: no proxy mode, no session
recording, no event export. The one attach shape that exists in
practice follows from configuration alone: every ACP editor takes an
arbitrary agent command, so a bridge can be that command.

## Attach shape: the command-substitution tee

The bridge is configured as the editor's agent command. It spawns the
real agent as its own subprocess and pipes stdin→stdin and
stdout→stdout byte-transparently (newline framing makes the tee a line
pass-through; stderr passes through untouched; the real agent's exit
code is the bridge's exit code). Every teed line is parsed off-path for
mapping; a parse failure never blocks the pass-through. This attach
shape is not documented or blessed by the ACP spec: it is
wire-compatible in every ACP editor only because agent commands are
arbitrary, and the streamable-HTTP draft is a named re-verify trigger
if the transport story changes.

Transparency is the contract: the bridge never injects, reorders,
rewrites, or delays the pass-through on mapping work; a dead relay
never affects the editor↔agent session (fail-open); a dead real agent
surfaces to the editor exactly as it would without the bridge. One
consequence is deliberate: queued observations die with the process
when the agent exits. Transparency outranks delivery.

*Rejected:* an ACP client mode (an observer that drives sessions is not
an observer); waiting for a spec-level export (none exists); editor
debug views (interactive UIs, not exports).

## Id joins and identity

Requests flow both directions, so the tee tags each line's direction
and joins request↔response by JSON-RPC id per direction (the prompt,
permission, and session binds above). Notifications need no join;
unmatched responses ride the fallback plane.

`sessionId` → AEP `session`, verbatim. The run is the `session/prompt`
turn: the request opens it (`run.started`, trigger `user`; prompt
digest at metadata, redacted at redacted and above), the response
closes it by `stopReason`: `end_turn`, `max_tokens`, and
`max_turn_requests` → `run.finished` (the stop reason rides as
metadata: bounded terminations are completions, not failures);
`cancelled` → `run.cancelled` (`by: "user"`); `refusal` → `run.failed`
(reason `"refusal"`).

The run id is the prompt request's JSON-RPC id, scoped to the session
and qualified by the bridge's own epoch (restart generation): rpc
numbering resets per process, and a run terminal is exclusive across
the session's lifetime (AEP-0002 §2 convention 5), so two bridge
instances observing one session must never re-mint a run id. The rpc id
stays real wire identity, no synthesis. The envelope `agent` is `acp`
(the bridge observes a protocol, not a vendor); extensions live in
`x.acp.*`, where the envelope's vendor-extension pattern requires two
segments after the vendor token, so single-word names gain a mechanical
`.event` suffix.

## Core vs `x.acp.*`: the mapping

- `tool_call` (the first update for a `toolCallId`) → `tool.requested`
  (`kind` and `title` as metadata; `rawInput` digest/redacted).
- `tool_call_update` reaching `status: completed` → `tool.completed`
  (`rawOutput` digest/redacted); `status: failed` → `tool.failed`.
  Intermediate updates ride `x.acp.tool_call.update` at `debug`.
- `session/request_permission` → read-only `attention.requested` (kind
  `permission`). The bridge observes the editor's gate and cannot
  answer it: no `options` claim, no `respond_via` (the
  read-only-channel rule; the option list rides as metadata counts
  only). The outcome response → `attention.answered` (the selected
  `optionId` verbatim, via `oob`) + `attention.resolved`; a `cancelled`
  outcome → `attention.resolved` (resolution `dismissed`).
- `plan` → `x.acp.plan.updated` at `debug`, not `progress.task.*`: plan
  entries carry only `{content, priority, status}` and no id, so
  diffing snapshots into task transitions would key on content,
  inventing identity the wire does not carry. Entry counts by status
  ride as metadata; content is redacted-gated.
- Message, thought, and user chunks → suppressed by default behind an
  `AEP_ACP_DELTAS` opt-in at `debug` with redacted assembly (the
  `message.*` core types stay reserved).
- `usage_update` → `x.acp.usage.updated` at `debug` (token counts as
  metadata).
- `current_mode_update`, `available_commands_update`,
  `config_option_update`, `session_info_update`, `fs/*`, `terminal/*`
  → the machinery plane, mechanical fallback `x.acp.<name>` at `debug`.
- `session/new` / `session/load` responses → `session.started`;
  `session/close` / `session/delete` → `session.ended`. No compaction
  moment exists on this wire; none is invented.

## Fixture and verification surface

The fixture is generated from the pure mapping module against
schema-shaped frames at schema-v1.19.0 (the npm
`@agentclientprotocol/sdk` 1.2.1 types are the cross-check): the tool
status forks, the permission pair including the dismissed outcome, the
`stopReason` terminals, the plan call, and the deltas opt-in forks. The
CI smoke runs a stub editor and a stub agent with the real bridge
between them, asserting byte-transparency line for line and validating
the mapped events. The stubs are the scope
limit: the bridge has not been validated against a real editor↔agent
pairing. Drift triggers: a `schema/v2/` directory appearing in the
vendor repo (v1 is the documented protocol), and the streamable-HTTP
draft adding a second transport.
