---
title: "Vendor surfaces"
description: "What AEP captures, and what it deliberately does not yet."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0007]
---

Agent runtimes expose more than any protocol maps on day one. This page
states the coverage boundary publicly. Per vendor surface: what the runtime
exposes, what AEP captures today through the reference adapters, and the
recommendation for the remainder (an existing type, the vendor extension
namespace via the [registry path](https://github.com/agenteventprotocol/agent-event-protocol/blob/main/schemas/registry/README.md), a future
Standards-Track change, or deliberately out of scope). Knowing this boundary
is part of the protocol's claim to honesty; changing it is normative work
under the [SEP rule](/community/governance#2-requirements-for-accepted-the-sep-rule).

Vendor documentation is cited by URL and fetch date, as
[AEP-0007's AG-UI annex](/specification/draft/aep-0007-message-stream-subprofile#annex-normative-when-accepted-ag-ui-mapping)
does.

Sources:

- `code.claude.com/docs/en/hooks` (fetched 2026-07-10)
- `developers.openai.com/codex/hooks` (fetched 2026-07-10; the page
  308-redirects to `learn.chatgpt.com/docs/hooks`, which documents
  `additionalContext` on five moments, see the
  [steering design record](/components/control-steering-design))
- `geminicli.com/docs/hooks` (fetched 2026-07-10)
- `qwenlm.github.io/qwen-code-docs/en/users/features/hooks` (the Qwen
  Code hook reference, fetched 2026-07-15)
- `code.visualstudio.com/docs/agent-customization/hooks` (the VS Code
  agent hooks reference, fetched 2026-07-16; the contract is additionally
  pinned at source refs, see the ranked table below).

## Claude Code: 29 hook events

The vendor's hook reference carries 30 hook headings; the count here is 29
because `PreCompact` is the deliberately silent pre-moment of the
compaction pair.

**Captured today** (the adapter's
[mapping table](https://github.com/agenteventprotocol/reference) covers 19
hooks): session/run lifecycle, the tool trio plus `tool.denied`, permission
and structured-question attention loops, MCP elicitation as AEP-0006 forms,
subagent delegation, task planning (`progress.task.planned/completed`,
registered optional types), notifications (deduplicated against the
first-class permission/elicitation hooks), post-compaction with its
trigger, and teammate idleness (`agent.idle`).

**Exposed but not captured**, with positions:

| Surface | What it is | Position |
|---|---|---|
| `MessageDisplay` | live assistant text as CC renders it | The natural CC-native inbound source for the [AEP-0007](/specification/draft/aep-0007-message-stream-subprofile) message/stream prototype, named there as a candidate prototype source. Not mappable to 0.1 core types (deltas fail the fleet-observer test; AEP-0007 Rationale). |
| `TeammateIdle` + agent teams | peer multi-agent activity beyond parent/child subagents | **Watch and collect corpus.** `delegation.subagent.*` models delegation trees, not peer teams; whether peer-team vocabulary belongs in core is a question for the taxonomy freeze review, and it needs observed traffic first. `agent.idle` captures the idleness fact today. |
| `Setup`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate/Remove` | environment/config observability | **Wired, opt-in**, in the reference adapter (a second example settings block registers them): they land as `x.claude-code.session.*` ([AEP-0001 §6](/specification/draft/aep-0001-core-and-envelope#6-type-naming-and-categories)) with field-level capture fidelity: metadata-grade facts at the default ceiling, paths and labels at `redacted`+. Still vendor-namespace by design; the registry path remains the road to core if fleet-level value emerges from real corpus. |
| `UserPromptExpansion`, `PostToolBatch` | prompt preprocessing, batched tool bookkeeping | Vendor namespace on demand; low fleet value today. |

## Codex: 10 hook events, and a second channel

**Captured today**: all ten hooks land on core types
(fixture: [`codex.json`](https://github.com/agenteventprotocol/agent-event-protocol/blob/main/conformance/fixtures/mappings/codex.json);
Annex A status: live-validated). Managed
(`requirements.toml`) and plugin-bundled hooks are deployment paths, not new
events; the adapter README documents both.

**Exposed but not captured**: Codex's **native OTel log export** (`[otel]`,
otlp-http/grpc) emits "API requests, SSE/events, prompts, tool
approvals/results," a second, in places richer, event channel than hooks.

*Position: **shipped** (reference `impl/bridge-otlp-in/`, fixture-proven
in both modes; live validation pending)*. The
[OTel-inbound capture sidecar design note](/components/bridge-otlp-inbound-design)
settles four things: the shape (OTLP/HTTP `v1/logs`, JSON encoding), the
identity derivation (`conversation.id` → session; runs deliberately not
synthesized), the capture posture, and the fixture-first verification
strategy.

It also settles the deduplication question against the hook adapter, at the
configuration level. In companion mode, the default, the sidecar emits only
`x.codex.otel.*` and the hook adapter stays the sole core-type authority; an
explicit `--primary` flag serves hook-less deployments.

Its mapping table is pinned in Annex A
(`conformance/fixtures/mappings/codex-otel.json`, both runners).

## Gemini CLI: hooks now shipping

Fetched 2026-07-10: `SessionStart`, `SessionEnd`, `BeforeAgent`,
`AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`,
`BeforeTool`, `AfterTool`, `PreCompress`, `Notification`: command hooks
over stdin/stdout JSON, configured in `settings.json`, with blocking
decisions (exit 2, per-event Block Turn / Block Tool / Filter Tools).

*Position: **adapter shipped, fixture-proven***: the reference stack's
`impl/adapter-gemini-cli/` maps the lifecycle/tool events onto the core
vocabulary and keeps the model plane (`Before/AfterModel`,
`BeforeToolSelection`) in `x.gemini-cli.*`; Annex A carries the table at
documented + fixture-proven status with the machine-usable pin in
`conformance/fixtures/mappings/gemini-cli.json`. Notable honesty calls:
`Notification` is observability-only → `progress.status`, never a respond
affordance; `tool_response.error` → `tool.failed`; runs are synthesized (no
turn id). Live-session validation remains pending.

**Successor status:** the vendor executed the announced consumer-tier
cutover. **Antigravity CLI is GA**, and free/consumer-tier Gemini CLI auth
stopped serving June 18 (per the vendor's transition post,
`developers.googleblog.com`). Gemini CLI itself remains a live, shipping
product for paid and enterprise keys: the repo is active, and npm
`@google/gemini-cli` shipped 0.50.0 on 2026-07-08, per the registry's publish
timestamp. This adapter
therefore remains valid as shipped. The successor carries a **different
hook system**, ranked as its own candidate in the table below.

## Kimi Code CLI: 16 hook events

Pinned at `MoonshotAI/kimi-code` `c2d7beb` = the shipped
`@moonshot-ai/kimi-code` **0.28.1** (npm latest and the repo head
version verified equal, read 2026-07-21; beware the namespace: the
UNSCOPED npm `kimi-code` package is an unrelated third party). The
vendor ships weekly, so this pin is a standing re-verify surface.

**Captured today** (adapter shipped and **live-validated**, including
the permission pair and both opt-in controls; fixture:
[`kimi-code.json`](https://github.com/agenteventprotocol/agent-event-protocol/blob/main/conformance/fixtures/mappings/kimi-code.json)):
all sixteen external-hook events (shell `command` hooks, stdin
snake_case JSON to stdout JSON, registered only in the one global
`config.toml`) land on core types or degrade honestly.

Notable calls:

- a real failure twin (`PostToolUseFailure` → `tool.failed`,
  `StopFailure` → `run.failed`)
- the vendor names its own Esc moment (`Interrupt` → `run.cancelled`
  with `by: "user"`)
- the permission pair is observed via `oob` with no options claimed
  (the vendor owns the choice surface; a rejection also lands
  `tool.denied`)
- `Notification` is background-task status only → `progress.status`,
  never an attention loop (no idle hook exists)
- compaction lands at the post moment while the pre moment degrades to
  the fallback.

Opt-in legs: a held binary allow/deny `PreToolUse` gate (`AEP_KIMI_CONTROL=1`; the vendor's own
permission flow still runs downstream) and the steering verb
`x.kimi-code.control.instruct` (`AEP_INSTRUCT=1`). Detail, decisions,
and the TOML-ordering registration hazard: the
[design record](/components/adapter-kimi-code-design).

**Exposed but not captured**, with positions:

| Surface | What it is | Position |
|---|---|---|
| `kimi acp` | native ACP server: protocol v1, ndjson over stdio; editor-channel permission options approve-once / approve-always / reject | Observable **today** through the shipped ACP bridge with zero new code (the cross-cutting ACP note below); no separate build needed. |
| `kimi web` kap-server | a local control plane: REST approval and question routes, a WebSocket event stream, instance-registry discovery under the home directory, bearer-token auth | **Shipped** as `bridge-kimi-code-web`, the control twin of the OpenCode actuator shape (companion/primary modes, opt-in approval + cancel actuation; kap-hosted sessions only, since the terminal TUI has no server surface by vendor design); decisions in the [design record addendum](/components/adapter-kimi-code-design). |
| `wire.jsonl` | append-live per-session JSONL records: tailable, carrying a durable turn-cancel fact | Recorded headroom: a replay/audit source, not a live channel the hook adapter needs; revisit only if live sessions surface a fact the hooks cannot see. |

## Next adapters: candidates ranked by adaptation similarity

Candidates carry a popularity cross-check against OpenRouter's public
coding-apps leaderboard (`openrouter.ai/apps/category/coding`, fetched
2026-07-12; a routed-token signal only, cited for candidate discovery,
not for API claims). Everything fetch-dated; unverified claims say so.
The adapter template (shim or plugin → pure mapping → Annex A fixture →
CI smoke) is proven across the shipped adapters, so similarity ranks by
how directly a candidate's surface fits it.

| Rank | Agent | Surface (as fetched) |
|---|---|---|
| **1** | **Qwen Code**: *adapter shipped, fixture-proven (see [adapters.md](/components/adapters))* | A Claude-Code-shaped hook system: 16 events over the same common stdin fields, `tool_use_id` for exact pairing, four hook types, command **and native http**, so the daemon needs no shim; the hold-open `PermissionRequest` control loop applies. Verified from the published 0.19.10 tarball. See [adapters.md](/components/adapters). |
| **2** | **OpenCode**: *adapter shipped, fixture-proven (see [adapters.md](/components/adapters) and the [design record](/components/adapter-opencode-design))* | A JS **plugin** system plus an event-stream SDK, a non-hook-shaped surface. Built exactly to the design record: the plugin is the shim (Bun-clean, fail-open), the daemon stays outside, and the hold-open `permission.ask` loop carries control as a control-capable adapter. Verified against the published plugin/SDK v1 types. |
| **3** | **Kilo Code**: *adapter shipped, fixture-proven (see [adapters.md](/components/adapters) and the [design record](/components/adapter-kilocode-design))* | The CLI core is an **OpenCode fork** (`packages/opencode` + a root `.opencode-version` in `Kilo-Org/kilocode`), so both shipped OpenCode shapes apply nearly verbatim: a TypeScript **plugin** (`event`, `tool.execute.before/after`, `permission.ask`) and a headless `kilo serve` HTTP+SSE API. A native OTLP export sits behind `OTEL_EXPORTER_OTLP_ENDPOINT`. Caveat: an `event-v2-bridge.ts` migration is in flight; pin versions, re-verify the union at build. See the [design record](/components/adapter-kilocode-design). |
| **4** | **Cline**: *adapter shipped, fixture-proven (see [adapters.md](/components/adapters) and the [design record](/components/adapter-cline-design))* | Rebuilt on an SDK monorepo exposing **typed subprocess hook events** (zod schemas shipped in `@cline/shared@0.0.59`, clean fixture provenance; `agent_id`/`parent_agent_id` for delegation) via `--hooks-dir`, so the command-shim template applies directly. Further channels: a publicly-documented hub daemon (adopted opt-in as the control channel) and the `@cline/sdk` event union; two hook generations coexist, and a mapping picks one. See the [design record](/components/adapter-cline-design). |
| **5** | **Hermes Agent** (Nous Research): *adapter shipped, fixture-proven with source provenance; opt-in operator-deny gate; opt-in steering verb `x.hermes.control.instruct` through the `pre_llm_call` context injection; the `clarify` form overlay OBSERVED (AEP-0006 kind `form`, `respond_via: [oob]`) (see [adapters.md](/components/adapters), the [design record](/components/adapter-hermes-design), and the [steering record](/components/control-steering-design))* | The most-used coding app on the OpenRouter leaderboard at fetch time. MIT; terminal TUI + messaging gateway + ACP server + OpenAI-compatible API. Its **shell hooks are Claude-Code-shaped end to end** and the output accepts the CC-style `{"decision": "block"}`, so the proven shim template applies. Richer TUI-gateway JSON-RPC + per-run SSE channels exist. No published typed schema package; fixtures are source-sourced. See the [design record](/components/adapter-hermes-design). |
| **6** | **Antigravity** (Google): *adapter shipped, fixture-proven (see [adapters.md](/components/adapters) and the [design record](/components/adapter-antigravity-design))* | The Gemini CLI successor, **GA** (1.1.1, 2026-07-10). **Five** command hooks over stdin/stdout JSON in `hooks.json` (camelCase): `PreToolUse`/`PostToolUse`, `Pre`/`PostInvocation`, `Stop`. Same idiom as Gemini CLI but a **different system**: Windsurf-lineage tool names, and the migration tool drops hook configs. Observe-only via the vendor's own empty decision string (min 1.0.16). No telemetry export surface found. See the [design record](/components/adapter-antigravity-design). |
| **7** | **pi / Oh-My-Pi**: *adapter shipped, fixture-proven (see [adapters.md](/components/adapters) and the [design record](/components/adapter-pi-design))* | `pi.dev` (`@earendil-works/pi-coding-agent@0.80.6` publishes the types) exposes THREE channels: an in-process TypeScript **extension bus** (`pi.on(...)`, 32 typed members; blockable/patchable hooks deliberately never registered), **`pi --mode json`** (single-shot), and **`pi --mode rpc`** (long-lived headless). Both stream modes are client-owned, so the adapter picks the extension shim. The `can1357/oh-my-pi` fork (v16.4.6) is expected-compatible, unanchored. See the [design record](/components/adapter-pi-design). |
| **8** | **OpenHands**: *the attach question is ANSWERED: attachable, vendor-blessed (see the protocol-sources table, row 3)* | The SDK's event framework (`OpenHands/software-agent-sdk`) is an immutable append-only **typed event log** (Pydantic, `kind`-discriminated), with read-only monitoring a stated design responsibility. The attach question is closed: the **Agent Server** (`openhands-agent-server`, PyPI 1.35.0) serves the log over documented HTTP/WebSocket. Protocol-shaped, so the ranked verdict lives in the protocol-sources table (row 3); no separate adapter. |
| **9** | **VS Code agent (Copilot)**: *adapter shipped, fixture-proven (see [adapters.md](/components/adapters))* | VS Code's **agent hooks (Preview)** adopt the Claude Code hook contract wholesale: **8 VSCode-target events** with CC-identical snake_case `command` payloads, plus **native read-only parsing of `.claude/settings.json`**. Limits: command-only (no http), `PostToolUse` success-only, no `SessionEnd`/failure event. The opt-in OTel LogRecord channel (`--vendor vscode`) and the held PreToolUse **ask** gate are adopted; **Preview** is a re-pin trigger. See [adapters.md](/components/adapters). |
| 10 | Cursor CLI: *partial, revisit* | Vendor staff confirm **six** events fire in the local CLI as of April 2026, but the docs list 21 hook events with **no published CLI support matrix**, the response/thought events are broken locally, and the built-in question tool fires zero hooks. `--output-format stream-json` is an alternative observation channel. The docs-versus-runtime divergence keeps this below the adapter bar; revisit. |
| 11 | Aider | No general hook surface documented (command-level lint/test hooks only). Not adapter-shaped today. |
| 12 | Codebuff: *below the bar today, in-process SDK host only* | `@codebuff/sdk` (docs fetched 2026-07-12): a cloud-API TypeScript client whose `handleEvent` callback streams six event types (`agent_start`/`agent_finish`, `tool_call`/`tool_result`, `text`, `error`) inside the CALLER's process (the host-class rule applies: an embedding application is the SDK guides' audience, not an adapter's), and no CLI hook surface is documented. Re-verify trigger: a subprocess/CLI hook surface appearing. |
| n/a | Named, not surveyed in depth (honestly) | **Zed** speaks ACP, so the shipped ACP tee observes any ACP editor↔agent pairing (see the protocol-sources table); no separate adapter needed. **goose** (MCP-based extensions) and **Crush** stay named candidates, deferred to post-v0.1, since the pre-v0.1 focus is consolidating the shipped mappings, not widening them. |

The six inbound sidecars
(OTel-in, OpenCode SSE, Kilo SSE, the AG-UI tee, the ACP tee, the
OpenHands attach) plus the outbound CE/OTLP bridges
cover the collector-pipeline class;
dashboard/backend recipes (Grafana and kin) need running backends to
verify honestly and stay deferred ecosystem work.

## The protocol-shaped sources, ranked for buildability

These sources are protocols, not agents, so "adapter"
is the wrong shape question: an adapter has an agent process to observe;
a protocol source wants a **bridge** (the OTel-in / OpenCode-SSE
precedent) or nothing yet. Verdicts at the agents-ranking bar:

| # | Source | Verdict |
|---|---|---|
| **1** | **AG-UI**: *bridge shipped, fixture-proven (see the [design record](/components/bridge-agui-design))* | The protocol IS an event stream: every AG-UI agent emits a typed run lifecycle (`RunStarted`/`RunFinished`/`RunError` mandatory, `Step*` optional), `TextMessage*`/`ToolCall*` streaming, and `StateSnapshot`/`StateDelta`, with published `@ag-ui/core` SDK types for fixtures. A `bridge-agui` attaches as a stream client and republishes, the SSE-bridge template nearly verbatim, token deltas gated, read-only (no control loop). SHIPPED. See the [design record](/components/bridge-agui-design). |
| **2** | **ACP** (the Agent Client Protocol, editor↔agent): *bridge shipped, fixture-proven (see the [design record](/components/bridge-acp-design))* | Verdict from the pinned schema (`schema/v1/schema.json`, 142 definitions, schema-v1.19.0). Observation-RICH and typed (`session/update` chunks, `tool_call`/`tool_call_update`, `plan`, `usage_update`, `session/request_permission`) but point-to-point NDJSON over stdio, so the attach shape is a **command-substitution tee**: one bridge observes every ACP pairing (see the cross-cutting note below). WATCH: `schema/v2` went **Active** 2026-07-02 (Permission-Request + Session-Resume RFDs, untagged) and would reshape the permission mapping when it tags. See the [design record](/components/bridge-acp-design). |
| **3** | **OpenHands Agent Server**: *bridge shipped, fixture-proven (see the [design record](/components/bridge-openhands-design))* | Verdict from the types: the **Agent Server** (`openhands-agent-server`, PyPI 1.35.0) runs the SDK behind a documented HTTP/WebSocket API. Three channels (a multi-observer WebSocket socket, REST search, config webhooks) over a Pydantic `kind`-discriminated event union with a wire-visible approval loop. Unsecured by default (`OH_SESSION_API_KEYS_*`). `bridge-openhands` is SHIPPED with a never-send default; an opt-in control channel adds `control.pause`/`resume`. See the [design record](/components/bridge-openhands-design). |
| 4 | OpenClaw Gateway: *bridge-shaped, defer* | A versioned (v4) WebSocket gateway (`connect` first-frame, `seq`/`stateVersion`) with a documented observe vocabulary (per-session `session.*` events, broadcast approval pairs, an `audit.activity.list` ledger). But its best-documented client role is a **driving operator**, and token/password auth restores all operator scopes with **no read-only credential**, so an observe-only bridge would hold an all-scopes credential it never uses. Deferred; ACP outranks it on attach friction. |
| 5 | A2A: *no observation point, deferred* | A client↔server RPC protocol (JSON-RPC/gRPC): task state lives in `TaskStatusUpdateEvent`/`TaskArtifactUpdateEvent` streams scoped to the CALLING client, so there is no bus to attach to. The honest shape is an instrumented A2A client (an SDK helper mirroring task-state into AEP, `INPUT_REQUIRED`/`AUTH_REQUIRED` → `attention.requested`), which only proves itself against real counterparts; deferred ecosystem work. |

**Cross-cutting note:** ACP keeps appearing as a server mode on the
agents surveyed above: Cline (`--acp`), Kilo Code (`kilo acp`), Hermes
(`hermes acp`), Kimi Code CLI (`kimi acp`), and Zed itself. Its ranked verdict is row 2 above: one
bridge could observe every ACP-speaking pairing.

## What this page is not

<Note>

Nothing here changes the wire format: this survey carries zero normative
weight, and the schema registry is untouched by it. When a position above
graduates into mapping work, it arrives as an Annex A change with fixtures
in the same commit, per [GOVERNANCE](/community/governance).

</Note>
