---
title: "Cline adapter: design record"
sidebarTitle: "Cline adapter"
description: "Design record for the Cline adapter: subprocess hook observation mapped to AEP, plus an opt-in hub control tap."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0004]
---

The adapter observes Cline's subprocess hook events and maps them to AEP. It lives in the reference repository at `impl/adapter-cline/`: a stdin-JSON hook shim (`cline-hook.js`), a daemon, and a pure `map-hooks.js`. The mapping is pinned in [AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings) via `conformance/fixtures/mappings/cline.json` (both runners). Verified against the published `@cline/shared` 0.0.59/0.0.60 type declarations (`dist/hooks/events.d.ts`, `dist/hooks/contracts.d.ts`, `dist/hub.d.ts`; the hub contract is byte-identical across the two versions), the `@cline/core@0.0.60` hub implementation, and the vendor's hub-spoke architecture and permission-handling docs at docs.cline.bot.

## What Cline exposes

Four integration surfaces:

- **Subprocess hooks** (the adapter surface): ten zod-typed hook events (`HookEventNameSchema`): `agent_start`, `agent_resume`, `agent_abort`, `agent_end`, `agent_error`, `tool_call`, `tool_result`, `prompt_submit`, `pre_compact`, `session_shutdown`. Hook scripts are configured via `--hooks-dir` / `CLINE_HOOKS_DIR` / project `.cline/hooks/` and receive JSON on stdin. The base payload (`HookEventPayloadBase`) carries `clineVersion`, `timestamp`, `taskId`, `workspaceRoots`, structured `workspaceInfo` (git branch/commit), `userId`, and `agent_id`/`parent_agent_id`; run-scoped payloads add `conversationId` and an `iteration` counter; `tool_result` carries a full `ToolCallRecord` `{ id, name, input, output, error?, durationMs, startedAt, endedAt }`, whose `error?` lets this surface emit an honest `tool.failed`. The subprocess `agent_start` payload carries no typed prompt text, so `run.started` opens on the trigger fact alone. Hook output is `SubprocessHookControl` (`cancel`, `review`, `context`, `overrideInput`, `systemPrompt`, `appendMessages`); every field mutates agent behavior.
- **A hub daemon**: a local WebSocket, per-process token in an owner-only discovery file, broadcasting a 48-name typed event union (`HubEventName`, `dist/hub.d.ts`): session and run lifecycle, streaming deltas, tool lifecycle, and `approval.requested`/`approval.resolved`.
- **The `@cline/sdk` in-process streaming union** and an **ACP server mode**: host-integration surfaces, not observation channels for an external process.
- **The VS Code extension's protobuf hooks** (`apps/vscode/proto/cline/hooks.proto`): a different host with a different contract, out of scope.

## Design

A hook script is the shim: stdin JSON forwarded to the daemon over local HTTP, fail-open (a dead daemon never breaks the agent). The daemon owns mapping, identity, capture gating, the JSONL log, and the relay binding. Its hook responses carry none of the `SubprocessHookControl` fields: an observer that changes what it observes has broken the contract. No typed hook moment is answerable, so with the hub gates off the adapter is observe-only.

Rejected: the extension protobuf generation (a different host; revisit only if the vendor unifies them); the in-process SDK subscribe (an observer does not live inside the agent process when a subprocess surface exists); hub-WS-first attach (a token-discovery dependency for basic observation); a separate hub bridge beside this adapter (AEP-0004 §4.5 obliges a relay to refuse, code `ambiguous`, a command whose `session` has two live claimants, and the hub session id and the hooks' `taskId` name the same task, so a second emitter would collide exactly when control matters); mapping the hub's full union (deltas, usage, and iteration lifecycle duplicate hook truth or belong to the reserved message-stream sub-profile: the hub tap contributes only what hooks cannot see).

## Identity and mapping

`taskId` → AEP `session`; the envelope `agent` is `cline`; vendor extensions live in `x.cline.*`. Runs are real, not synthesized. The typed `iteration` stamps the envelope `step` on run-scoped events as a plain string; no `run.step.*` synthesis, because the surface exposes no step boundaries, only a counter. Whether `conversationId` (run payloads) equals `taskId` on the wire is pinned by the smoke; live validation against a real Cline session remains open.

- `agent_start` → `run.started` (`trigger: "user"`); `agent_resume` → `run.started` (`trigger: "resume"`).
- `agent_end` → `run.finished`; `agent_abort` → `run.cancelled` (`reason` gated); `agent_error` → `run.failed` (`reason` from the typed `error.name`; `message` redacted-gated).
- `agent_start` with `parent_agent_id != null` also emits `delegation.subagent.started` (subject `agent_id`); the matching terminal emits `delegation.subagent.stopped`.
- `tool_call` → `tool.requested` (name and call id; `input` digest at metadata, content at redacted+).
- `tool_result` → `tool.completed` or `tool.failed` by `ToolCallRecord.error`; `durationMs` as metadata; output digested/redacted.
- `prompt_submit` → `x.cline.prompt.submitted` at `debug` (text redacted-gated); `message.user.submitted` is reserved pending the message/stream sub-profile.
- `pre_compact` → `session.compacted` at the vendor's only exposed (pre) moment, the deviation documented in Annex A; token counts and `compactionStrategy` as metadata; the `contextJsonPath`/`contextRawPath` paths are content-bearing, redacted+ only.
- `session_shutdown` → `session.ended` (`reason` when present).
- `workspaceInfo`: commit hash at metadata; branch names are user content, redacted-gated. `userId` is opaque, metadata. Unknown hook names → `x.cline.<name>`.

Rejected: `prompt_submit` as a run trigger (the run opened at `agent_start`; a mid-run prompt is steering, and a second run would double-count); `agent_abort` as `run.failed` (the vendor distinguishes abort from error; `run.cancelled` exists for exactly this).

## Fixtures and drift

The fixture is generated against the published `@cline/shared` zod schemas (they ship in the npm package, so no repo pinning is needed). The base payload carries legacy-shaped optional sub-objects (`preToolUse`, `taskStart`, ...) beside the typed payloads; the adapter maps the typed union and ignores the legacy mirrors. The package publishes a `nightly` channel, so freshness checks re-diff the hook enum first. The CI smoke drives the real shim path with stdin JSON exactly as the CLI would deliver it (port band 19030-19034); the hub tap is smoked against a stub hub speaking the pinned frames (`smoke-cline-hub.js`, band 19035-19039).

## The hub control tap (opt-in)

Under explicit gates the daemon opens one outbound WebSocket to Cline's hub and contributes two things to the session lane the hooks already own: the approval loop as `attention.*` Events, and command actuation. The commands are AEP-0004 §5 core verbs plus one `x.cline.control.*` extension. Hook observation never depends on the hub: connection failure or a protocol-version mismatch degrades to observe-only (1s reconnect), and the shim path is untouched.

Hub facts the tap builds on: auth is a per-hub bearer `authToken` in an owner-scoped discovery JSON, carried on the WebSocket upgrade as the subprotocol `cline-hub-auth.<token>`; the default endpoint is `ws://127.0.0.1:25463/hub`, and `cline hub ensure` starts the singleton. The approval loop genuinely gates: `requestToolApproval` holds an unresolved promise inside the hub until a client answers; `approval.respond` `{ "approvalId", "approved", "reason"? }` resolves the promise the runtime is awaiting (first answer wins; a later answer errors `approval_not_found`), and `approval.resolved` is broadcast to everyone. Non-interactive sessions auto-reject without publishing, and tool policies default to auto-approve, so the loop surfaces exactly the vendor's own ask-moments. `run.abort` aborts the session's active run, after which the subprocess hook generation fires `agent_abort`. `session.send_input` shares the hub's `run.start` handler; its `delivery` is `"immediate" | "queue" | "steer"`. The hub session id and the hook payloads' `taskId` describe the same task identity (the typed `ToolApprovalRequest.sessionId` doc comment). The `connectors/events.d.ts` surface is messaging integration, out of scope.

### Gates

- `AEP_CLINE_HUB=1` enables the tap: connect, subscribe, mirror the approval loop as attention Events (including out-of-band resolutions); `hello.capabilities.emits` gains `attention`.
- `AEP_CLINE_HUB_CONTROL=1` implies the tap; `hello` declares `control.accepts: ["control.attention.respond", "control.cancel", "x.cline.control.send_input"]` with `ack_window_ms: 10000`. Off, the verbs are absent from `hello`, so a compliant relay refuses commands sender-side (AEP-0004 §4.2); the daemon's own `unsupported` nack remains as defense-in-depth.
- Endpoint: `AEP_CLINE_HUB_URL` (plus `AEP_CLINE_HUB_TOKEN`), else `AEP_CLINE_HUB_DISCOVERY=<path>` reads the vendor's discovery JSON (`url` + `authToken`). The adapter does not auto-hunt discovery paths: the owner-scoped filename is keyed by a hash of the launching program, and a fail-open observer should not guess files under the vendor's data directory.
- The tap registers as `clientType: "aep-adapter-cline"` with no advertised capabilities: the hub routes capability requests only to clients that advertise them, so the tap can never be conscripted as a host-side executor.

Rejected: one env for both grants (observing the approval loop and answering it are different trust grants); default-on (observe-only is the default posture).

### The approval loop as `attention.*`

`approval.requested` → `attention.requested` on the session the hooks own: `kind: "permission"`, `prompt` synthesized from structural metadata (the tool name) per the AEP-0002 metadata-capture exception, `options` `approve`/`deny`, `respond_via: ["control", "oob"]` (the Cline UI answers the same hub loop), tool correlation at metadata, `inputJson` at redacted+ only. `control.attention.respond` (`subject` = the request Event's id; `answer.option` `"approve"` | `"deny"` REQ; `answer.text` rides as the vendor `reason`, redacted-gated) actuates as hub `approval.respond`; outcomes are `attention.answered { via: "control" }` then `attention.resolved { resolution: "answered", latency_ms }`, cause-linked (AEP-0002 §7.1). Out-of-band answers mirror as `attention.answered { via: "oob" }` plus the terminal; a hub-side bulk cancellation becomes `attention.resolved { resolution: "dismissed" }`; session end or hub disconnect with the request pending dismisses it (the AEP-0002 §7.2 terminal obligation). The vendor documents denial as advisory to the agent: a deny is a refused tool call, not a run stop. A respond that races an out-of-band resolution (`approval_not_found`) nacks `refused`.

Rejected: free-text-only answers (approve-or-deny is the loop's decision space; a respond without `answer.option` nacks `invalid`); widening to non-ask moments (the tap answers the vendor's questions and cannot invent gates).

### `control.cancel` → hub `run.abort`

Scope `run` only; a command naming a non-active run, or a session with no active run, nacks `refused` (the hub aborts the active run; the adapter never guesses). Scope `session` nacks `refused`: the hub has no session-stop verb (`session.delete` destroys records, `session.detach` abandons them; neither is cancel). Ack discipline, shared by all three verbs: forward to the hub and let the reply decide within a guard (`AEP_CLINE_HUB_ACK_GUARD_MS`, default 8000): reply ok → `control.accepted`; reply error → `control.rejected { "reason": "refused" }`; guard expiry → `control.accepted` (an ack is a will-try; the outcome settles on the stream); hub unreachable → `control.rejected { "reason": "busy" }`. Commands are deduped on `(source, id)` with byte-identical re-ack on redelivery.

The outcome Event is not synthesized from the hub's `run.aborted`: the abort lands back on the hook surface as `agent_abort`, and the hook mapping emits `run.cancelled` with `cause` = the command id (a per-session pending-cancel note). One truth source; emitting from the hub event too would double-emit the terminal.

### `x.cline.control.send_input`, deliberately not `instruct`

The instruct verb class in the [control steering design](/components/control-steering-design) is advisory context injection, never a conversation turn. `session.send_input` is the opposite plane: its text becomes the session's next user input, and `delivery: "steer"` names a pending-prompt queue-jump. The verb therefore mirrors the vendor's own command name: `x.cline.control.send_input`, payload `{ "text": string [redacted] REQ, "delivery"?: "queue" | "steer" [metadata] }` (default `queue`; text cap 4000 chars). Outcome: `x.cline.input.sent { "delivery" }`, cause-linked once the hub accepts; the vendor's `prompt_submit` hook may later surface the text's consumption, observed, never promised.

Rejected: naming it `instruct` (it would misrepresent the verb corpus a future core-verb SEP weighs); exposing `delivery: "immediate"` (on an idle session it starts the agent: operating, not controlling); echoing the text in outcomes (instruction text on the stream is redacted-gated).

### Out of scope

- `run.start`, `session.create`, `session.fork`: initiating or duplicating work is operating the agent, not controlling an observed run.
- `schedule.*`: a task scheduler, not run control.
- `capability.request/respond/progress` and `session.hook`: the hub's capability brokerage makes clients host-side executors; an observer that executes tools has left observation. The tap advertises no capabilities.
- `settings.*`, `ui.*`, `peer.*`, `connector.*`: deployment configuration and UI plumbing, not run control.
