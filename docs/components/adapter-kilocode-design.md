---
title: "Kilo Code adapter: design record"
sidebarTitle: "Kilo Code adapter"
description: "Design of the Kilo Code adapter: the OpenCode-fork surfaces, the version-split permission surface, and the AEP event mapping."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0004]
---

<Info>

The adapter lives in the reference repository (`impl/adapter-kilocode/`): the Bun-side plugin shim `kilocode-plugin.js` (the `{ server }` module shape), the daemon, and the pure mapping module `map-hooks.js`. The mapping is pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/kilocode.json` (both runners). The adapter carries both permission surfaces the vendor ships, version-gated by the vendor itself (below).

Verified against the published `@kilocode/plugin@7.4.5` + `@kilocode/sdk@7.4.5` types (`npm pack`), the shipped 7.4.11 CLI binary, and a headless 7.4.11 server; vendor docs fetched 2026-07-12. The published npm types lag the shipped runtime at 7.4.11, so the verification order throughout is: binaries outrank types outrank prose.

</Info>

## What Kilo Code exposes

Kilo Code's CLI core is an **OpenCode fork**. The vendor monorepo carries it as `packages/opencode` with a root `.opencode-version`, and the vendor docs link OpenCode's own configuration reference.

**A TypeScript plugin system** (`@kilocode/plugin`, published in lockstep with the CLI). A plugin module exports `{ server: Plugin }` where `Plugin = (input, options?) => Promise<Hooks>`: the module shape differs from OpenCode's direct export, the hook contract does not. The hooks relevant to observation:

| Hook | Contract (from the 7.4.5 declarations) |
|---|---|
| `event` | receives every bus event (`{ event: Event }`) |
| `tool.execute.before` / `tool.execute.after` | interception around each tool call; `{ tool, sessionID, callID }` input, mutable output (`args` before; `title/output/metadata` after) |
| `permission.ask` | `(input: Permission, output: { status: "ask" \| "deny" \| "allow" })`, may settle a pending permission; untouched output falls through to Kilo's own prompt |

The remaining hooks (`chat.message`, `chat.params`, `chat.headers`, `shell.env`, `command.execute.before`, `auth`, `provider`, `config`, `tool`, and the `experimental.*` family) mutate agent behavior and stay unused (below).

**The bus vocabulary** (`Event` union, 32 members at `@kilocode/sdk@7.4.5`) is byte-identical to `@opencode-ai/sdk@1.17.18`'s, verified by a member-by-member diff of the two published unions: the fork's bus delta at those pins is zero. Every family the OpenCode mapping routes onto core is here (`session.created/updated/deleted/idle/error/status/compacted`, `message.updated/removed`, `message.part.updated/removed`, `permission.updated/replied`, `file.edited`, `todo.updated`, `command.executed`, `server.connected`), and so are the machinery/UI members listed under the mapping below.

**Two further channels** are out of this adapter's scope: the headless `kilo serve` HTTP API with an SSE event stream, observed by the separate `impl/bridge-kilocode-sse/` (the OpenCode SSE bridge design under Kilo's own gate), and a native OTLP trace/log export behind `OTEL_EXPORTER_OTLP_ENDPOINT`.

## The permission surface split at 7.4.6

CLI releases through 7.4.5 fire the hold-open `permission.ask` hook and publish `permission.updated` on the bus. Releases from 7.4.6 on (verified against the 7.4.11 binary) remove both; asks ride new bus types instead: `permission.asked` (properties = the permission request), settled by `permission.replied`, plus a followup-question surface (`question.asked` / `question.replied`). Two verification facts frame this split. First, the published npm types lag the shipped runtime: `@kilocode/plugin@7.4.11` still declares the never-fired `permission.ask` hook, and `@kilocode/sdk@7.4.11` still carries `permission.updated` and none of the new members, so a published-union diff verifies the types, not the runtime. Second, upstream OpenCode (1.18.3) retains the hook: this is fork divergence, not an upstream change, and the OpenCode adapter is unaffected.

The adapter therefore carries both surfaces, version-gated by the vendor itself: at `<=7.4.5` only the hook fires; at `>=7.4.6` only the bus types do.

## Architecture: the plugin is the shim; the daemon stays outside

The OpenCode adapter shape, with one Kilo-specific delta: the plugin module exports `{ server: Plugin }` rather than a bare function. The plugin file runs inside Kilo's Bun runtime, forwards moments over local HTTP to the adapter daemon, and fails open: a dead daemon must never break the agent. The daemon owns mapping, capture gating, and relay delivery, reusing the shared receiver floor (healthz delivery-readiness, error-or-close reconnect, outbox).

*Rejected:* SSE-only observation: the permission surface is the whole reason an adapter beats a bridge here. *Rejected:* forking the OpenCode adapter in place behind a vendor switch: the two vendors' drift would be permanently coupled, and the fork relationship is the vendor's, not this project's; shared code belongs in `impl/shared/`, not in a branchy adapter.

## Observation hooks only

The adapter registers `event`, `tool.execute.before`, `tool.execute.after`, and `permission.ask`, nothing else. The `chat.params`/`chat.headers`/`shell.env`/`experimental.*` hooks mutate agent behavior (model parameters, environment, compaction prompts); an observer that changes what it observes has broken the capture-honesty contract before emitting a single event. The `tool.execute.before/after` outputs are left untouched for the same reason.

*Rejected:* registering `experimental.session.compacting` to enrich `session.compacted`: it is output-mutating by design (context/prompt injection) and the vendor marks the whole family unstable.

## Identity

`sessionID` rides as the AEP `session` unchanged. No turn id exists on this surface, so runs are adapter-synthesized on the user-message/idle boundaries exactly as the OpenCode mapping pins them; `callID` pairs the tool trio. The envelope `agent` is `kilocode` (the vendor's own one-word identifier: `kilo.ai`, `@kilocode`, `Kilo-Org/kilocode`). Vendor extensions live in `x.kilocode.*`.

## Event mapping: the OpenCode table transfers whole

The shared families map exactly as the OpenCode fixture pins them: lifecycle, the tool interception pair, `permission.*` (on the hook surface the bus `permission.updated` is suppressed against the held `permission.ask`), `todo.updated` snapshot-diffed into `progress.task.*` transitions, `session.compacted` at the vendor's post moment, and no `tool.failed` (the typed hooks expose no error field; failures ride session-scoped in `x.kilocode.session.error`).

The machinery/UI members (`lsp.*`, `pty.*`, `tui.*`, `vcs.branch.updated`, `installation.*`, `file.watcher.updated`, `session.diff`, `server.instance.disposed`) land in `x.kilocode.*` via the mechanical fallback, channel-visible at `debug`, never core. A mapping decision that only makes sense for one vendor is not a core event, and none of these are agent activity moments a fleet observer needs.

*Rejected:* mapping `vcs.branch.updated` or `session.diff` onto core progress types: no other mapped vendor exposes either moment, and neither is an activity fact (they are workspace state).

## Control

**The hook surface (`<=7.4.5`): hold-open.** The contract the OpenCode adapter proves: hold the hook open, emit `attention.requested` (kind `permission`) with options and `respond_via`, settle from the control loop (`output.status = "allow" | "deny"`), fall through untouched on timeout so Kilo's own prompt takes over. Fail-open: the agent is never wedged by an absent operator. Same-id dedupe and the bus `permission.updated` suppression apply.

**The bus surface (`>=7.4.6`): notification plus REST reply.** The ask is a notification: Kilo's own prompt runs in parallel and nothing vendor-side is held. The card's options mirror the reply enum verbatim (`once` / `always` / `reject`, confirmed empirically against a headless 7.4.11 server). A control answer delivers over the server reply routes: `POST /session/{id}/permissions/{permissionID}` `{response, message?}`, where unmatched free text reaches the vendor as the reject message (the hook surface's output carries status only), and `POST /question/{requestID}/reply` `{answers: string[][]}`, with choice ids resolved back to the original vendor labels so redaction never rewrites what the vendor receives. The daemon learns the server address from `PluginInput.serverUrl`, forwarded on every plugin POST. A vendor-side settle (bus `*.replied`) stands the pending card down; timeout touches nothing vendor-side: the vendor prompt is the fallback, and its eventual decision arrives as the bus settle. Questions map to `attention.requested` (kind `form`) on the Claude Code adapter's `AskUserQuestion` shape: index ids stay structural at any capture ceiling, labels are gated, and the vendor `custom` option maps to `fields[].other`.

The fixture pins both surfaces. The SSE channel's primary mode sheds answer affordances from any mapped ask: a read-only channel cannot honor an answer path.

## Fixtures and drift

`conformance/fixtures/mappings/kilocode.json`, pinned in both runners, is generated against `@kilocode/plugin@7.4.5` + `@kilocode/sdk@7.4.5`. Two drift risks, stated: an event-model migration is in flight (the fork repo carries an `event-v2-bridge.ts`, and both published SDKs, Kilo's and upstream OpenCode's, ship a `dist/v2/` surface), so any version advance re-diffs the `Event` union first; and the fork tracks upstream OpenCode, so an upstream change can arrive on the vendor's schedule. Both are re-verify triggers, not surprises. Live validation against a real Kilo Code session is tracked separately and does not gate the adapter.
