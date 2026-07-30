---
title: "OpenCode adapter: design record"
sidebarTitle: "OpenCode adapter"
description: "Design of the OpenCode adapter and SSE bridge: plugin shim, external daemon, the AEP event mapping, and the bridge's opt-in control gate."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0004]
---

<Info>

The adapter lives in the reference repository (`impl/adapter-opencode/`): the Bun-side plugin shim `opencode-plugin.js`, the daemon, and the pure mapping module `map-hooks.js`. The mapping is pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/opencode.json` (both runners), and the reference CI smoke drives the real plugin file end to end. A sibling SSE bridge (`impl/bridge-opencode-sse/`) observes the same bus over the server surface: read-only by default, with an opt-in gate covering exactly two REST writes.

Verified against the published `@opencode-ai/plugin` and `@opencode-ai/sdk` 1.18.1 types and tarballs, server source at `anomalyco/opencode` v1.18.1 (commit `99f638d`; the repository moved to the anomalyco org from sst, and the redirect resolves), and the `@kilocode/plugin` and `@kilocode/sdk` 7.4.7 tarballs for fork parity. Where vendor docs and published types disagree, the types win.

</Info>

## What OpenCode exposes

Two integration surfaces, both first-class in the vendor docs (fetched 2026-07-11).

**A JS plugin system.** A plugin is an async function that runs *inside* OpenCode's Bun runtime, receiving `{ project, client, $, directory, worktree }` and returning a hooks object. Relevant hooks:

| Hook | Contract |
|---|---|
| `event` | receives every bus event (catalog below) |
| `tool.execute.before` / `tool.execute.after` | interception around each tool call; `output` is mutable, a thrown error blocks the call |
| `permission.ask` | may settle a pending permission by setting `output.status` to `allow`/`deny`; untouched output falls through to OpenCode's own prompt |
| `shell.env` | environment injection for shell executions |
| `experimental.session.compacting` | pre-compaction context injection (explicitly experimental) |

The bus catalog spans the `session.*`, `message.*`, `permission.*`, `file.*`, `lsp.*`, `tool.execute.*`, `tui.*` groups plus `todo.updated`, `command.executed`, `installation.updated`, `shell.env`, and `server.connected`; every member the mapping touches is named below. One naming discrepancy matters: the docs call the ask moment `permission.asked`, but the published types name that bus member `permission.updated`. The mapping uses the wire type.

**A server + SDK.** `opencode` serves a REST API with a server-sent-events stream (`GET /event`, first event `server.connected`, then bus events; `GET /global/event` for the global scope), wrapped by the typed `@opencode-ai/sdk` client (`event.subscribe()`). Two writes matter to this design:

- The permission reply, `POST /session/{id}/permissions/{permissionID}` with body `response: "once" | "always" | "reject"`. The vendor docs describe a `remember` field; none exists at 1.18.1, and the `once`/`always` enum carries that semantics. 200 answers `true`; an unknown id is a typed 404 (`PermissionNotFoundError`). A settled reply is broadcast as `permission.replied` (properties `sessionID`, `permissionID`, `response`) on the same bus the SSE stream serves.
- `POST /session/{id}/abort`, which cancels background jobs and interrupts the running prompt; the interrupt finalizer marks the in-flight assistant message `aborted: true` (a `message.updated` broadcast) and teardown sets the session status idle. Every idle flip publishes both `session.status` and `session.idle`. Aborting an already-idle session is a 200 no-op that re-broadcasts idle.

The session route table carries no pause or resume write, so `control.pause`/`control.resume` are not adoptable on this surface. Auth is optional single-credential HTTP basic auth (`OPENCODE_SERVER_PASSWORD`; unset, the default, is an open local server). No read-only scope exists: a credential that can read `/event` can already write every route.

## Architecture: the plugin is the shim; the daemon stays outside

Where the Claude Code, Codex, Gemini CLI, and Qwen Code adapters use a stdin/stdout command shim, OpenCode's shim is a **plugin file**: `opencode-plugin.js` is a thin fail-open forwarder that POSTs bus events and hook moments to the external adapter daemon over local HTTP and never throws on delivery failure. It stays Bun-clean: ESM export, `fetch`, no Node built-ins. The daemon (Node, one file, default port 8390) owns mapping, identity, capture gating, the JSONL log, the relay WS binding, `GET /healthz`, and the boot-race-safe reconnect.

*Rejected:* embedding the full emitter (relay WS client, seq/epoch state, capture logic) inside the plugin. It couples the relay-client lifecycle to the agent's own process: a wedged socket or a mapping bug lives *inside* OpenCode with no fail-open boundary, it cannot be supervised via `/healthz`, and it forks the mapping logic away from the pure module the fixtures pin.

## Identity: bus `sessionID` is the session; runs synthesized on idle boundaries

Bus event properties carry the session identifier; that string rides as the AEP `session` unchanged. OpenCode documents no turn identifier, so the adapter synthesizes runs on OpenCode's own boundaries: a run opens at the first user-authored `message.updated` after `session.created` or `session.idle`, and `session.idle` closes it.

*Rejected:* keying runs off `session.status` transitions; `status` is a display surface with no documented state vocabulary to pin.

## Event mapping: core lifecycle, namespaced machinery

Core mappings, each pinned in the Annex A fixture:

- `session.created` → `session.started`
- `session.deleted` → `session.ended`
- `session.compacted` → `session.compacted` (OpenCode announces compaction after the fact)
- `session.status` → `progress.status`
- `todo.updated` → `progress.task.planned` / `progress.task.completed`: the core registry has no `progress.task.updated`, so the pure `diffTodos` diffs consecutive snapshots into transitions, pinned in the fixture
- `permission.updated` (the ask moment's wire type) → `attention.requested` (kind `permission`)
- `permission.replied` → `attention.resolved` (resolution `answered`; when the reply came through the adapter's own control loop, an `attention.answered` event precedes it)
- `tool.execute.before` → `tool.requested`
- `tool.execute.after` → `tool.completed`, splitting to `tool.failed` exactly when the typed payload carries the documented error surface; the split is pinned at fixture time, not guessed.

The machinery rides the vendor namespace at `debug` severity: `message.*` (model/stream plane), `file.*`, `lsp.*`, `command.executed`, `installation.updated`, `session.diff`, `session.updated`, `tui.*`, `shell.env`, `server.connected` → `x.opencode.*`; unknown bus types → `x.opencode.unknown`, never guessed. `session.error` stays `x.opencode.session.error` at `error` severity: OpenCode does not say whether it terminates the turn, and claiming `run.failed` would assert exactly that.

*Rejected:* promoting `file.edited` to a core type: the taxonomy has no artifact/file family in v0.1, and inventing one for an adapter inverts the SEP direction (taxonomy moves first, adapters follow).

## Control: the hold-open `permission.ask` hook

`permission.ask` can settle a permission from inside the plugin, so the adapter runs the same hold-open loop the Claude Code, Codex, and Qwen Code adapters prove: the daemon emits `attention.requested`, the plugin holds the hook open awaiting the daemon's decision over the same local HTTP exchange, `control.attention.respond` (AEP-0004, authenticated binding only) settles it as `output.status`, and a timeout leaves `output` untouched, fail-open to OpenCode's own prompt. This works in the default TUI with no server mode.

*Rejected as primary:* the REST actuator (`POST /session/{id}/permissions/{permissionID}`). It requires the server surface plus out-of-band session discovery, and it answers *around* the agent rather than through the moment the agent is already holding. It is the right actuator for the SSE bridge, where there is no hook to hold and the stream itself carries the session.

## Fixtures

The Annex A fixture (`opencode.json`, both runners) is built against the published TypeScript types of `@opencode-ai/plugin` and `@opencode-ai/sdk`: the vendor's own contract, strictly stronger than doc prose. The mapping is documented and fixture-proven; live validation against a real OpenCode session is tracked separately and does not gate the adapter. *Rejected:* blocking the adapter on a live session.

## The SSE bridge

`GET /event` offers a zero-install observation channel: attach to a running server, no plugin required. It exists only when the server surface is up, and the stream itself cannot carry the hold-open control loop. `impl/bridge-opencode-sse/` therefore runs in one of two config-level modes, never guessed at runtime, pinned in the fixture's `sse_modes` block and implemented by the pure `mode-policy.js`:

- **companion** (the default): the plugin adapter may observe the same agent and stays the sole core-type authority; the bridge contributes channel visibility only.
- **`--primary`**: an SSE-only deployment; the full mapping applies, and `attention.requested` advertises no answer path by default, because a read-only channel cannot honor one.

Read-only is the default posture. The gate below inverts it for exactly two REST writes; the answers travel on the REST channel the server serves beside the stream. The SSE stream itself is read-only in every mode: `GET /event` stays the only stream operation, gate on or off.

### The control gate: primary mode only, two writes

`AEP_OPENCODE_SSE_CONTROL=1` inverts read-only for exactly two writes: the permission reply and `POST /session/{id}/abort`, nothing else. The gate is honored in `--primary` mode only. Gated on, the hello declares `control.accepts` of `control.attention.respond` and `control.cancel` with a 10 000 ms ack window; gated off, and in companion mode regardless of the environment, the hello declares read-only (`accepts: []`), so a gating relay refuses sender-side (AEP-0004 §4.2). Both verbs come from the AEP-0004 §5 core registry; no vendor verb is minted. The gate also mints no permission vendor-side: the server has no read-only scope (above), so the gate changes only what this bridge is willing to write.

*Rejected:* honoring the gate in companion mode. Companion exists exactly when a plugin adapter may own the same agent: two live claimants of one session string is AEP-0004 §4.5's mandatory ambiguous refusal, and the adapter is the control home there, answering through the moment the agent holds rather than around it. Companion also emits no `attention.requested` and owns no synthesized runs, so there is nothing a command could honestly address. *Rejected:* per-write env vars: the bridge ships one posture gate; two flags would imply a policy surface AEP-0004 reserves for the authenticated relay binding.

### respond: answerable attention in the vendor's own vocabulary

Gated-on primary decorates `attention.requested` (kind `permission`) with the vendor's own reply vocabulary as options: `once` ("Allow once"), `always` ("Always allow"), `reject` ("Reject"), plus `respond_via: ["control"]`. The decoration is receiver-side runtime state; the pure `mode-policy.js` and the pinned fixture posture (no options, no `respond_via`) do not change.

`control.attention.respond` (`subject` = the `attention.requested` event id) maps `answer.option` verbatim onto the REST body's `response`; the reply rides `POST /session/{id}/permissions/{permissionID}` with the vendor id the receiver paired to the emitted request. Text-only and `values` answers are refused `invalid`: nothing on this surface carries free text. A stale or unknown `subject` is refused; a raced duplicate is answered by the in-flight dedupe with the one forthcoming ack.

The outcome has one source: the vendor's `permission.replied` broadcast. The receiver marks the pending entry settling with the command id; the observed reply then rides `attention.answered` (`via: "control"`, `cause` = the command id) and chains `attention.resolved` (`cause` = the answered event's id), AEP-0004 §5's expected outcome pair. Without a command, the plain fixture-pinned `attention.resolved` path stands. A reply that settled vendor-side first (the TUI answered) clears the pending entry through the same observed broadcast; a command arriving after is refused stale.

*Rejected:* relabeling the options `allow`/`deny` to match the adapter's hold-open vocabulary: the surfaces genuinely differ (the REST reply carries the remember semantics as `always`; the hook output cannot). *Rejected:* treating the bridge's own REST 200 as the outcome: two outcome sources for one moment is a double report; the 200 is the ack's evidence, the broadcast is the outcome.

### cancel: scope `run`, the vendor's own boundary as the outcome

`control.cancel` with `scope: "run"` forwards to `POST /session/{id}/abort` only when a synthesized run is open for the addressed session and the command's `run`, when present, matches it; anything else is refused, because aborting an idle session is a vendor no-op that would ack a fiction. `scope: "session"` is refused: the only session-terminal write is `DELETE /session/{id}`, a permanent destructive deletion, and an observer turned controller must not carry destruction under `control.cancel`.

The outcome is AEP-0004 §5's expected `run.cancelled`: an accepted abort sets a per-session pendingCancel note (command id + run id), and the next `session.idle` (the same vendor boundary that closes every synthesized run) closes the run as `run.cancelled` cause-linked to the command id instead of `run.finished`. Any run close clears the note.

The race, stated honestly: a natural finish arriving inside the note's window is labeled cancelled. The vendor broadcasts no dedicated cancelled terminal, and the aborted-message marker is absent when the abort lands between steps, so the note-window rule is the honest simple discipline; a heuristic would mislabel in the other direction.

*Rejected:* emitting `run.cancelled` on the REST 200: the outcome must be the vendor's own boundary fact, cause-linked (the AEP-0004 §7 obligation), not an echo of the bridge's write. *Rejected:* `DELETE /session/{id}` as scope-session cancel (above). *Rejected:* mapping abort onto `control.pause`: after an abort nothing is resumable in place (the next prompt starts new work), and the vendor has no pause plane to claim.

### Ack discipline

Commands dedupe on (source, id) via the shared `cmdKey()` helper (one NUL escape); the recorded ack is re-sent byte-identically on redelivery, and an in-flight guard covers the async REST settlement. The reply guard `AEP_OPENCODE_SSE_ACK_GUARD_MS` (default 8 000 ms, inside the 10 000 ms declared window) settles the ack: REST 2xx → `control.accepted`; 4xx → refused (detail gated by capture redaction); network unreachable → busy; guard expiry → accepted (will-try: the write may still land, and the settling mark and pendingCancel note stay armed for the eventual broadcast). `GET /healthz` reports `control`, true exactly when the gate is honored (gated on and primary).

*Rejected:* holding the respond ack until `permission.replied` arrives. The ack answers "did the target act on the command", not "did the moment resolve"; conflating them starves the sender's ack window on a healthy target.

### Fork portability

The control path is fork-portable: the pending, settling, and note structures and both REST paths ride profile constants, with no OpenCode-specific control logic beyond the profile. At `@kilocode/*` 7.4.7 the abort route, the permission route, the `response` enum, the `Permission` type, and the legacy `Event` union are byte-identical to OpenCode 1.18.1's (tarball diff), and the Kilo SSE bridge (`impl/bridge-kilocode-sse/`) carries the same design under its own gate (`AEP_KILOCODE_SSE_CONTROL`).

*Rejected:* a vendor-switch branchy receiver: shared code belongs in shared modules, not in a fork-coupled branch.

### Out of scope

- Prompt, message, command, shell, and init POSTs: initiating or steering work is operating, not observing.
- Session create/fork/share/revert/delete.
- The TUI routes.
- Polling `GET /session/{id}/permissions`: the SSE stream is the discovery surface, so the bridge adds no poll loop.
- The v2 API family: at 1.18.1 the typed v2 question/permission surface is REST/v2-only, absent from the plugin `Hooks` contract and from the legacy `Event` union the stream serves. Adopting it is a re-verify decision for a later vendor version, not part of this design.
- Companion-mode control (see the gate).
- Any write on the SSE stream itself.
