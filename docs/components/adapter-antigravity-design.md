---
title: "Antigravity CLI adapter: design record"
sidebarTitle: "Antigravity CLI adapter"
description: "Design and implementation record for the Antigravity CLI adapter mapping hook events to AEP."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0004]
---

<Info>

**Status: SHIPPED.** The adapter lives in the reference repository
(`impl/adapter-antigravity/`: the argv-discriminated
`antigravity-hook.js` shim, the daemon with the
(`conversationId`, `stepIdx`) join and the run synthesis, and the pure
`map-hooks.js`). The mapping is pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/antigravity.json` (both runners).
One schema fact worth naming: `session.started`'s `client` field is an
OBJECT (`{name}`), not a bare string; the host marker rides as
`client.name`.

The `agy` binary is closed source, so the design is pinned against the
official hook documentation plus the vendor's public changelog
(`github.com/google-antigravity/antigravity-cli`): docs provenance.
The payloads carry **no schema-version sentinel** (unlike Hermes);
drift detection relies on the docs page and the changelog watch,
stated in Annex A.

Verified against `antigravity.google/docs/hooks` (fetched 2026-07-12;
CLI 1.1.1, desktop 2.2.1; the payload tables carry complete worked
examples per hook); minimum CLI 1.0.16.

</Info>

## What Antigravity exposes

One hook system, **host-shared** between Antigravity 2.0 (desktop,
2.2.1) and the Antigravity CLI (1.1.1, released 2026-07-10):
shell-command hooks declared in `hooks.json`, workspace
`<workspace>/.agents/hooks.json` or global
`~/.gemini/config/hooks.json`. Only the app data directory differs
between hosts (`~/.gemini/antigravity` vs
`~/.gemini/antigravity-cli`), visible in `transcriptPath`.

**Five events**, JSON over stdin/stdout, camelCase, handler
`{type: "command", command, timeout}` (default 30 s); a regex
`matcher` on tool names applies to the tool pair only. A 20-tool
catalog is documented with argument names. Every payload carries
`conversationId` (a real UUID), `workspacePaths[]`, `transcriptPath`
(the per-conversation `transcript.jsonl` under
`<app_data_dir>/brain/<conversationId>/.system_generated/logs/`), and
`artifactDirectoryPath`. Per event, inputs and the reply contract:

- `PreToolUse`: in: `toolCall.name`, `toolCall.args`, `stepIdx`
  (0-based trajectory index). Out: **`decision` REQUIRED**
  (`allow` / `deny` / `ask` / `force_ask`), `reason`,
  `permissionOverrides[]`.
- `PostToolUse`: in: `stepIdx`, `error` (empty on success). **THIN: no
  tool name, no args, no result.** Out: `{}`.
- `PreInvocation`: in: `invocationNum` (0-based model-call counter),
  `initialNumSteps`. Out: `injectSteps[]` (agent-mutating).
- `PostInvocation`: in: **documented as "Same as `PreInvocation`"**;
  the two payloads are indistinguishable on the wire. Out:
  `injectSteps[]` + `terminationBehavior`
  (`"force_continue"` / `"terminate"` / `""` = default).
- `Stop`: in: `executionNum`, `terminationReason` (`model_stop` /
  `max_steps_exceeded` / `error`), `error`, `fullyIdle` (required
  boolean). Out: `decision` REQUIRED: `"continue"` re-enters the
  execution loop; any other value allows the stop.

**No payload carries a hook-event-name discriminator.** Two facts
follow: the shim must learn which event it is serving from its own
registration, and the invocation pair cannot be told apart by payload
inspection.

One changelog entry is load-bearing: **1.0.16**, "safely handling
empty decision strings returned by pre-tool hooks". `{"decision": ""}`
is the vendor's own safely-handled no-opinion reply, the same
`""`-means-default idiom the docs state for `terminationBehavior`. It
is what makes an observe-only `PreToolUse` hook possible, and it is
the adapter's **minimum CLI version**.

Adjacent surfaces, out of scope: the Python SDK
(`google-antigravity/antigravity-sdk-python` v0.1.6) types an
in-process "Hooks v2" system for agents built ON the SDK, a different
host with zero occurrences of the CLI wire field names; sidecars are a
process manager, not an event channel; plugins can bundle a
`hooks.json`, a packaging option for this adapter's registration and
nothing more.

## Surface: the five-hook `hooks.json` system

The adapter is the command-shim template shared with the Claude Code,
Codex, and Qwen adapters, over all five hooks, matcher `"*"` on the
tool pair; each `hooks.json` entry passes the event name to the shim
as an argument (`antigravity-hook.js PreToolUse`, ...): registration is
the discriminator.

*Rejected:* tailing `transcript.jsonl` (the only place tool names
could be recovered without the pre/post join, but it lives under
`.system_generated/` and its format is documented nowhere; an adapter
built on undocumented internals breaks silently; deferred until Google
documents the format); the SDK in-process hooks (a different host);
sidecars as a channel (not an event source).

## Observe-only: the vendor's own empty decision string

Every named `PreToolUse` decision moves the user's permission gate:
`allow` removes it, `deny` blocks, the ask pair forces prompts. An
observer may return none of them. The neutral reply is
**`{"decision": ""}`**, the value the vendor's permission manager
safely handles since 1.0.16. The shim answers: `PreToolUse` →
`{"decision": ""}`, never a named decision, never
`permissionOverrides`; `Stop` → `{"decision": ""}`, never
`"continue"`; `PreInvocation`/`PostInvocation` → `{}` (`injectSteps`
and `terminationBehavior` deliberately unused); `PostToolUse` → `{}`.
Fail-open: on any internal error the shim prints the same neutral
output and exits 0. The adapter never grants, never blocks, never
prompts, never injects, never prolongs a stop.

*Rejected:* `"allow"` (silently removes the user's gate, a safety
mutation an observer must never make); `"ask"`/`"force_ask"` (forces
prompts that would not otherwise fire); skipping `PreToolUse` entirely
(it is the only source of tool names and arguments).

## The thin `PostToolUse`: the (`conversationId`, `stepIdx`) join

`tool.completed` and `tool.failed` REQUIRE `tool` (the name), and
`PostToolUse` carries only `stepIdx` + `error`. So the daemon keeps a
join table keyed (`conversationId`, `stepIdx`):

- `PreToolUse` → `tool.requested` (name; args digest at metadata,
  whole args redacted+) plus the join entry.
- Joined `PostToolUse` → empty `error` → `tool.completed`; non-empty →
  `tool.failed` (redacted+ with a digest at metadata). `stepIdx` rides
  as vendor metadata on all three: it is the join key, said so.
- Unpaired `PostToolUse` (daemon restart, a narrowed matcher on one
  side, mid-conversation attach) → `x.antigravity.step.completed` with
  the step index and the error fact only; a tool name is never
  invented.
- Dangling `PreToolUse` → **no synthesized terminal**: a denied tool,
  a rejected prompt, and a still-running tool are indistinguishable,
  and whether a denial even fires `PostToolUse` is undocumented (left
  to live validation).
- Entries clear on join and at `Stop` (bounded memory).

**No `tool.denied` and no `attention.*` claims**: the user's approval
outcomes are not hook-visible (no hook carries the allow/deny choice,
unlike Hermes); the gap is stated in the Annex A row rather than
papered over. `ask_question` and `ask_permission` are observed as what
the vendor says they are: tools.

*Rejected:* recovering names from the transcript (above); a
placeholder name on `tool.completed` (the registry's required field
exists precisely to forbid that).

## Identity: `conversationId` verbatim; runs synthesized

`conversationId` → the AEP `session` id, VERBATIM. There is no
session-start/end hook: `session.started` is synthesized at first
sight of a new `conversationId`, and no `session.ended` is ever
emitted, stated honestly.

**No run id rides the wire** (`executionNum` appears only at `Stop`),
so run ids are synthesized per conversation. `run.started` opens at
the first `PreInvocation` of an execution (`invocationNum` 0, or first
observation on mid-run attach). `Stop` closes on the typed
`terminationReason`: `model_stop` → `run.finished`;
`max_steps_exceeded` → `run.finished` with the reason as metadata (a
bounded termination is a completion); `error` → `run.failed`
(`reason: "error"`; message digest at metadata, content redacted+).
`executionNum` and `fullyIdle` ride as metadata on the terminal
(`fullyIdle: false` records still-running background tasks: a fact,
not a different terminal). `invoke_subagent` is observed as a tool
call only; **no `delegation.subagent.*` claims** (no child
conversation ids ride any payload, and inventing them from tool
arguments would fabricate identity).

## Invocations are run steps

`PreInvocation` → **`run.step.started`**, `PostInvocation` →
**`run.step.finished`**: `invocationNum` sets the envelope `step`,
`initialNumSteps` rides as metadata. The semantic fit is the
registry's own summary ("sub-run phase began; sets envelope step"):
one model invocation plus its tool executions IS a sub-run phase,
vendor-declared, zero synthesis. The docs are ambiguous on
`PostInvocation`'s firing moment ("after tool calls finish" vs "after
the invocation completes"); the mapping claims only the boundary fact
either way, and the argv discriminator is what makes it honest at all.

Path fields (`transcriptPath`, `artifactDirectoryPath`,
`workspacePaths`) are machine paths: redacted+, digest-free. **No
compaction hook → no invented moment** (the SDK's `OnCompactionHook`
belongs to the other host and proves nothing about this wire). Vendor
namespace: `x.antigravity.*`, two-segment
(`x.antigravity.step.completed`; an unknown future event name falls
back to `x.antigravity.hook.<name>`).

*Rejected:* `x.antigravity.invocation.*` instead of `run.step.*` (the
family exists, is optional, and fits; hiding a fitting core mapping in
vendor space would be neutrality theater in the other direction);
richer core families for `generate_image`/`search_web` (they are
tools; the tool trio already carries them).

## Provenance and drift

The fixture's `$comment` records the docs URL + fetch date
(2026-07-12), the worked examples used as payload bases, CLI 1.1.1
current / **1.0.16 minimum**, desktop 2.2.1, and the host-shared
caveat (fixtures pin the CLI host's `transcriptPath` shape). There is
no payload sentinel; the re-verify triggers are the hooks docs page
changing, any hook-related CLI changelog entry, the transcript format
becoming documented, and the binary going open source (which would
upgrade this record's provenance class from docs to source).

## Home

`impl/adapter-antigravity/`: one shim (`antigravity-hook.js`, event
name via argv, neutral outputs byte-exact, fail-open, exit 0 always),
the daemon (default `127.0.0.1:8395`, join table + run synthesis, no
control loop), a pure `map-hooks.js`, and a CI smoke driving the real
shim per event exactly as `hooks.json` would. Port band 19060-19064.
