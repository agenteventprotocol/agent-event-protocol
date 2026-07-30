---
title: "pi adapter: design record"
sidebarTitle: "pi adapter"
description: "Design record for the pi adapter: extension-bus observation mapped to AEP, plus an opt-in tool-call gate."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0004]
---

The adapter observes pi's in-process extension bus and maps it to AEP. It lives in the reference repository at `impl/adapter-pi/`: a notification-only extension shim (`pi-extension.js`), a daemon, and a pure `map-events.js`. The mapping is pinned in [AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings) via `conformance/fixtures/mappings/pi.json` (both runners). Verified against the published `@earendil-works/pi-coding-agent@0.80.6` type declarations (npm tarball pulled 2026-07-12; `dist/core/extensions/types.d.ts` is byte-identical at 0.80.7), the `@earendil-works/pi-agent-core@0.80.7` runtime, upstream `earendil-works/pi` tag `v0.80.6` (`2b3fda99`), and fork `can1357/oh-my-pi` tag `v16.4.6` (`20c0a2e4`, published in lockstep as `@oh-my-pi/pi-coding-agent@16.4.6`). Claims here are read from the type declarations, not the docs pages: the vendor's `docs/json.md` event list is stale against the published union.

## What pi exposes

pi (`pi.dev`) exposes three observation-shaped channels, all typed.

**1. The in-process extension bus.** Extensions are TypeScript/JavaScript modules loaded in-process (jiti); a module default-exports a factory `(pi: ExtensionAPI) => void | Promise<void>` and registers per-event handlers with `pi.on(<event>, handler)`. The union (`ExtensionEvent`, `dist/core/extensions/types.d.ts`) has 32 members at 0.80.6. The ones that matter here, with contract class:

| Event | Payload (from the declarations) | Class |
|---|---|---|
| `session_start` | `reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"`, `previousSessionFile?` | notification |
| `session_info_changed` | `name` | notification |
| `session_compact` | `compactionEntry`, `fromExtension`, `reason: "manual"\|"threshold"\|"overflow"`, `willRetry` | notification |
| `session_tree` | tree navigation fact | notification |
| `session_shutdown` | `reason: "quit"\|"reload"\|"new"\|"resume"\|"fork"`, `targetSessionFile?` | notification |
| `agent_start` / `agent_end` | `{}` / `messages: AgentMessage[]` | notification |
| `agent_settled` | `{}`: no automatic retry, compaction, or queued continuation will run | notification |
| `turn_start` / `turn_end` | `turnIndex: number`, `timestamp` / `turnIndex`, `message`, `toolResults[]` | notification |
| `message_start` / `message_update` / `message_end` | `message: AgentMessage` (user, assistant, or toolResult); update adds the streaming `assistantMessageEvent` | notification |
| `tool_execution_start` / `update` / `end` | `toolCallId`, `toolName`, `args` / + `partialResult` / + `result`, `isError: boolean` | notification |
| `model_select`, `thinking_level_select` | selection facts | notification |
| `tool_call` | blockable: return `{block?, reason?}`; `event.input` mutable in place | interception |
| `tool_result` | patchable: return `{content?, details?, isError?}` | interception |
| `context`, `input`, `before_agent_start`, `before_provider_*`, `user_bash`, `resources_discover`, `project_trust`, `session_before_*`, `message_end` (replacement) | transform/cancel surfaces | interception |

Identity is available in-process, read-only: `ctx.sessionManager.getSessionId(): string`, `getSessionFile(): string | undefined` (undefined for ephemeral sessions), `getCwd()`, `getSessionDir()`. Extensions load via the `extensions` array in settings.json, the repeatable `-e/--extension` flag, or the auto-discovery directories (`~/.pi/agent/extensions/*.ts`; project-local `.pi/extensions` behind project trust), in all four modes (interactive/rpc/json/print), with `ctx.hasUI` false in json/print.

**2. `pi --mode json`**: single-shot; the prompt rides argv, every `AgentSessionEvent` streams as JSON lines on stdout. The first stdout line is a session header `{"type":"session","version":3,"id":"<uuid>","timestamp":...,"cwd":...}`.

**3. `pi --mode rpc`**: long-lived, headless; bare JSON lines both ways (not JSON-RPC framing), a ~30-command stdin vocabulary (`prompt`, `steer`, `follow_up`, `abort`, `get_state`, `compact`, `switch_session`, `fork`, `get_entries`, ...), every command answered by a typed `response`, the same event union streaming interleaved. No startup session header: the id is on demand via `get_state`.

Both stream modes are client-owned: whoever spawns pi owns stdin/stdout, and there is no attach point to someone else's running session on these channels.

**The fork.** Oh-My-Pi (`can1357/oh-my-pi`) publishes `@oh-my-pi/pi-coding-agent` in lockstep with its tags. Its extension union diverges from upstream's: it adds a typed `tool_approval_requested` / `tool_approval_resolved` pair (carrying `sessionId`, `toolCallId`, `toolName`, `approvalMode` / `approved`, `reason`) plus further events, and its mode enum adds `acp` and `rpc-ui`. Its legacy hook subsystem has naming drift against upstream (`session_before_branch` vs `session_before_fork`).

## Channel

The adapter is a shim plus daemon: a small extension module runs inside pi and forwards notification moments over local HTTP to the daemon, failing open (a dead daemon must never break the agent). The shim channel is the only one that attaches to the user's real sessions: it loads by the vendor's own registration paths in all four modes, and it alone has in-process identity plus the typed notification-only tool trio.

The other channels, dispositioned: `--mode rpc`/`--mode json` as an adapter channel is rejected, because owning those streams means being the process that spawned pi, the session's driver rather than its observer. An operator-piped ingest path (`pi --mode json ... | aep pi-ingest`) is wire-honest but deliberately not built: it is a second delivery path for the same vocabulary, and the mapping is written against the shared union so such a path could reuse it verbatim. The fork's `--mode acp` needs no pi-specific work: any ACP pairing is observable by the ACP bridge tee.

## Pinning

The fixture anchors `@earendil-works/pi-coding-agent@0.80.6`, the vendor's own published package. The envelope `agent` is `pi`; vendor extensions live in `x.pi.*`. The fork is stated, not anchored: the factory shape (`pi.on`) is the same, so the shim is expected to load under Oh-My-Pi, but the fork's union diverges and its versioning is its own (16.x vs 0.80.x); fork extras are out of fixture scope. Re-verify triggers: an upstream minor touching `ExtensionEvent`; the fork's approval pair reaching upstream. At fork 16.5.2, `ToolCallEventResult` is byte-equivalent to upstream's and the approval pair remains fork-only.

The payloads carry no schema-version sentinel (the json-mode header's `version: 3` versions the session file, not the bus); drift detection is the npm release feed plus a union member diff. The fixture's `$comment` records the npm pins and repo tags.

## Identity and lifecycle

- Session = `ctx.sessionManager.getSessionId()`, the same uuid the json-mode header carries. `session_start` → `session.started` (typed `reason` as metadata; `resume`/`fork` arrivals are facts, not new identities); `session_shutdown` → `session.ended` with its typed `reason`. `getSessionFile()` is a machine path: redacted+ only, digest-free.
- Run = one agent loop: `run.started` at `agent_start`; the terminal at `agent_end` is typed by the last assistant message's `stopReason`: `error` → `run.failed`; `aborted` → `run.cancelled`; `stop`/`length`/`toolUse` → `run.finished` (a bounded termination is a completion; the raw value rides as metadata). The extension-bus `agent_end` carries no `willRetry` and the `auto_retry_*` pair is not on the bus, so a retried loop is a new run in the same session; `agent_settled` → `x.pi.agent.settled` (debug), the "nothing further will run" fact that marks a final run.
- Turns are run steps: `turn_start` → `run.step.started`, `turn_end` → `run.step.finished`, with the envelope `step` set from the vendor's own `turnIndex` (declared on both boundaries; `step` is a string by schema, so the numeric index rides stringified). `turn_end.toolResults` are not re-emitted: the tool trio already carried them.

## Tools and messages

`tool_execution_start` → `tool.requested` (`toolCallId` joins the trio; `toolName` verbatim; args digest at metadata, whole args at redacted+). `tool_execution_end` → `tool.completed` on `isError: false`, `tool.failed` on `isError: true`: the split is the vendor's own typed fact, not an inference. `tool.failed` requires `error`: a generic class rides at metadata with the message redacted-gated. `tool_execution_update` (`partialResult`) is stream-shaped: `x.pi.tool.update`, emitted only behind the deltas gate.

The approval gap, stated: the upstream bus carries no approval events (`project_trust` is workspace trust; an extension-blocked tool surfaces as a thrown error). The fork's `tool_approval_requested`/`tool_approval_resolved` pair is the named trigger: if it reaches upstream, or a fork-specific build happens, it maps to `attention.requested` with `kind: "permission"`, the resolution riding the attention pair. The human attribution belongs on `attention.answered`, not on `tool.denied`: `tool.denied.by` is `enum(policy|user_setting|runtime)` (AEP-0002 §5.3) and has no `user` value.

Messages ship boundary facts only, vendor-scoped because the core types (`message.user.submitted`, `message.agent.replied`) are reserved for the message sub-profile: role `user` at `message_start` → `x.pi.message.submitted`; role `assistant` at `message_end` → `x.pi.message.replied` (content digest at metadata, whole content at redacted+; `stopReason` as metadata). toolResult messages are skipped; the tool trio owns them. `message_update` → `x.pi.message.delta` behind `AEP_PI_DELTAS` (default off): deltas are debug-severity, shed first under backpressure, never required for the durable story.

## Observe-only default: non-subscription is the neutrality

pi registers handlers per event, so by default the shim never registers any of the interception surfaces in the table: no `tool_call`, no `tool_result`, no transform/cancel surface, and no `message_end` replacement (it registers `message_end` and returns nothing; the handler is asserted void). `ctx.ui` is never touched. The registered set is exactly the notification list above, enumerated in the fixture's `$comment`. Forwarding errors are swallowed after a bounded retry queue; the agent never waits on the daemon.

Rejected: registering `tool_call` to observe pre-execution intent "neutrally" (a registered handler sits in the block chain: `emitToolCall` propagates handler errors as blocks, so an observer that can wedge a tool by crashing has broken fail-open); registering `input`/`context` with pass-through returns (an observer inside a transform chain is one bug from mutating what it observes). The control gate below inverts this deliberately, at the operator's explicit request; the default posture stands.

## Core vs `x.pi.*`

`session_compact` → `session.compacted` at the vendor's post moment, with typed `reason` (`manual`/`threshold`/`overflow`) and `willRetry` as metadata. Machinery facts stay vendor-scoped at debug severity, never core: `session_info_changed` → `x.pi.session.info`; `session_tree` → `x.pi.session.tree`; `model_select` → `x.pi.model.select`; `thinking_level_select` → `x.pi.thinking.select`. The vendor-type rule is two-segment `x.pi.<family>.<leaf>`; an unknown future member falls back to `x.pi.event.<type>`. `entry_appended` does not exist on the extension bus (stream-union-only); nothing is claimed from it.

## Home

`impl/adapter-pi/`: the extension shim (`pi-extension.js`, a plain-JS factory loaded by explicit path via the `extensions` settings array or `-e`; the auto-discovery directories scan `*.ts` only, so explicit-path registration is the documented route), the daemon (default `127.0.0.1:8396`), and the pure `map-events.js`. The CI smoke drives the real extension file the way pi's loader would and asserts the mapped envelopes with `aep validate` (port band 19070-19074; the control smoke `smoke-pi-control.js` uses 19075-19079).

## The opt-in control gate (`AEP_PI_CONTROL=1`)

Under `AEP_PI_CONTROL=1` the factory registers exactly one additional surface: the blockable `tool_call`, held open as an answerable `attention.requested` (allow/deny). Registration itself is the opt-in: the operator asks the adapter to sit in the block chain. Gated off (the default), the factory registers nothing new, so the registered set stays byte-identical to the notification set. The gated-off `hello` declares read-only (`accepts: []`); gated on, `accepts: ["control.attention.respond"]`, an AEP-0004 §5 core verb. The pure `map-events.js` and the pinned fixture are unaffected; the held loop is daemon state.

Rejected: registering `tool_call` unconditionally with an internal env check (a registered handler sits in the block chain even when passive; the neutrality line is drawn at registration, and only the operator's explicit gate may cross it).

### The vendor's block contract

Read from the published `@earendil-works/pi-agent-core@0.80.7` runtime:

- `ToolCallEventResult` is `{ block?: boolean, reason?: string }`; `emitToolCall` iterates extensions in order and the first `{block: true}` short-circuits.
- The runner has no try/catch: a throwing handler propagates and is re-thrown as "Extension failed, blocking execution". A crashing `tool_call` handler blocks the tool, so the opt-in handler must be fully try/caught and return `undefined` on any internal failure.
- The downstream shape is deterministic: `tool_execution_start` fires before the interception; a block returns an immediate error tool result carrying the reason ("Tool execution was blocked" when none), execution is skipped, and `tool_execution_end` with `isError: true` fires with the same `toolCallId`.
- The hold is unbounded vendor-side and abort-blind: the loop awaits the handler with no timeout, the run's abort signal is not passed in, and the aborted check runs only after the handler settles. The adapter's window is the only bound on the hold.

### The held gate

A gated `tool_call` (scoped by `AEP_PI_GATE_TOOLS`, a regex over `toolName`, default every tool) is forwarded to the daemon and held as `attention.requested` (kind `permission`, options `[{id:"allow",label:"Allow"},{id:"deny",label:"Deny"}]`, `respond_via: ["control"]`, `expires_at` = now + `AEP_ATTENTION_TIMEOUT_MS`, default 55 000; pi imposes no timeout of its own, so expiry is the adapter keeping its hold bounded, not a vendor budget).

Release semantics: allow → the handler returns `undefined` (later extensions and the vendor's own trust flow still decide; nothing is minted). Deny → `{ block: true, reason }` (the operator's reason, or the documented default). Expiry → `attention.timeout` plus `undefined` (fail-open: an absent answer must behave like an absent handler). Any internal error (daemon down, malformed reply) → `undefined` immediately; the crash-blocks fact makes this non-negotiable. A user abort during a held gate waits for the release (the abort-blind hold), so keep windows modest.

### The outcome story

`attention.answered { answer: {option, text?}, via: "control" }` (cause = the command id) plus chained `attention.resolved (answered)` at the release: the actuation is the handler's own return value, so settlement is synchronous. On a deny, the observed `tool_execution_end` with `isError: true` (same `toolCallId`, execution skipped) rides the pinned mapping unchanged: `tool.failed`, because the vendor's bus does not distinguish blocked from failed, and this note refuses to invent a distinction the vendor does not emit. The daemon adds only the envelope `cause` via the held call's `toolCallId`; consumers read the denial from the attention pair.

Rejected: receiver-side recast of `tool.failed` to `tool.denied` (no AEP-0004 §5 expected-outcome row demands it, and it would give one vendor fact two vocabularies); `tool.denied` with `by: "user"` (schema-illegal per the enum above); a vendor-scoped denial extension type (the attention pair already carries the attribution).

### Ack discipline and health

Dedupe on `(source, id)`, byte-identical re-acks, ack window 10 000, `invalid` for text-only or `values` answers, `refused` for stale or settled subjects, relay sender-side `unsupported` when gated off. `healthz` gains `control` (true only under the gate).

### Out of scope

- The client-owned `--mode rpc` channel, its `steer`/`follow_up`/`abort` vocabulary included: the channel rejection above stands.
- `tool_result` patching and every other interception surface (`context`, `input`, `before_*`, `user_bash`, `session_before_*`, `message_end` replacement).
- The fork-only approval pair (the named trigger above).
- `control.cancel` and `control.pause`/`resume`: no adopting surface exists on the extension bus; aborts belong to the client-owned modes.
- The operator-piped ingest path (see the channel dispositions).
