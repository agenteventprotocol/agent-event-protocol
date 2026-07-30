---
title: "Kimi Code CLI adapter: design record"
sidebarTitle: "Kimi Code CLI adapter"
description: "Design of the Kimi Code CLI adapter mapping external-hook events to AEP, and the kimi web bridge that observes the kap-server control plane."
audience: builder
spec-refs: [AEP-0001, AEP-0002, AEP-0004, AEP-0008]
---

The adapter observes Kimi Code CLI through the vendor's external-hook
surface: the stdin-JSON `kimi-hook.js` command shim, a daemon
(`adapter.js`, default port 8398), and the pure mapping module
`map-hooks.js`, at `impl/adapter-kimi-code/` in the reference
repository. The mapping is pinned in
[AEP-0002 Annex A](/specification/draft/aep-0002-taxonomy-and-types#annex-a-normative-source-vocabulary-mappings)
via `conformance/fixtures/mappings/kimi-code.json` in both conformance
runners.

Verified against source MoonshotAI/kimi-code `c2d7beb` = the shipped
`@moonshot-ai/kimi-code` 0.28.1 (pulled 2026-07-21): the six lifecycle
payload shapes were captured from the shipped binary driven headless
against a mock provider, and the permission pair is derived from
`approval.ts` + `permissionGateService.ts` and confirmed in a live
session. Two hazards ride the pin: the vendor ships weekly, so the
16-event enum may grow (the fixture's fallback entry exists for this),
and only the scoped `@moonshot-ai/kimi-code` is the vendor; the
unscoped `kimi-code` npm package is an unrelated third party.

## What Kimi Code CLI exposes

Sixteen hook events (`externalHooks/types.ts`): `SessionStart`,
`SessionEnd`, `UserPromptSubmit`, `Stop`, `StopFailure`, `Interrupt`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`,
`PermissionResult`, `SubagentStart`, `SubagentStop`, `PreCompact`,
`PostCompact`, `Notification`. Shell `command` hooks only: the runner
spawns the command, writes one snake_case JSON payload to stdin, and
reads JSON from stdout. Registration lives in exactly one place, the
global `~/.kimi-code/config.toml` (`$KIMI_CODE_HOME` relocates it), as
`[[hooks]]` tables with a strict four-field schema
(`event` / `matcher` / `command` / `timeout`); there is no per-project
hook file. TOML ordering is load-bearing: a top-level key appended
below a `[[hooks]]` table parses as a member of that table, and the
vendor then drops the whole hooks section with only a warning.

Blocking is narrow and binary: only `PreToolUse`, `Stop`, and
`UserPromptSubmit` consult the hook's structured output, and only the
literal `permissionDecision` `"deny"` blocks; there is no ask tier, and
every failure path (timeout, 30 seconds default and 600 at most; spawn
error; non-zero exit) resolves allow by vendor design. A hook is a
policy veto, not a security boundary.

Out of scope here: the native ACP server (`kimi acp`, ndjson over
stdio, observable through the existing ACP bridge) and the append-live
`wire.jsonl` session records. The `kimi web` control plane is covered
below.

## Shape

`kimi-hook.js` forwards stdin JSON to the daemon over local HTTP and
relays the reply; daemon down or slow means exit 0 with no output, so a
dead observer never breaks the agent. The daemon owns mapping, capture
gating, and relay delivery; the four-field schema means the daemon URL
rides the command string, not an env block.

`aep-setup write kimi-code` writes a marker-fenced `[[hooks]]` block
appended at the end of the global `config.toml` (all sixteen events;
timestamped backup; idempotent re-run; a stale fence refreshed in
place). End-append guarantees no top-level key ever lands below a hooks
table. One vendor-side hazard: the web UI settings save re-serializes
`config.toml` and strips the fence comments, after which the writer
degrades to a `kimi-hook.js` presence check (no duplicates are
appended, but fence refresh stops until the fence is re-landed).

*Rejected:* per-project registration (none exists); in-place edits
outside a fence (un-ownable on re-run; one misplaced key silently
disables every hook).

## Coverage and identity

All sixteen events are registered; the default posture replies an empty
object everywhere, so observation never exercises the blocking channel.
*Rejected:* a subset (unknown hooks degrade, never drop); an ask tier
(the surface is binary by contract).

`session_id` → AEP `session` (`unknown` where absent; the subagent
hooks carry none). No turn id exists at the run boundary, so the
adapter synthesizes one run per `UserPromptSubmit`, closed by `Stop`,
`StopFailure`, or `Interrupt`; a run left open drains as
`run.cancelled` at the next boundary (next prompt or `SessionEnd`).
`tool_call_id` pairs the tool trio and the permission pair.
`PermissionRequest` and `Interrupt` carry a `turn_id`, but it never
becomes the run id: one id authority, the synthesized run. `cwd`
(workstation-local) never rides. The envelope `agent` is `kimi-code`;
vendor extensions live in `x.kimi-code.*`.

## The mapping

Shorthand: "redacted+" means the field rides at the redacted capture
tier and above; tool args and results always carry a digest, with the
full value only at the full tier.

| Hook | AEP type | Notes |
|---|---|---|
| `SessionStart` | `session.started` | `source` → `data.trigger` |
| `SessionEnd` | `session.ended` | the vendor's one reason "exit" normalizes to the schema's "normal"; stale-run drain and instruction-queue drop run first |
| `UserPromptSubmit` | `run.started` | the prompt is a content-part array, text parts joined at redacted+; `is_steer: true` → `x.kimi-code.run.steer_submitted` (a steer rides the running turn, never opens a run) |
| `Stop` | `run.finished` | `stop_hook_active` is loop plumbing, never forwarded |
| `StopFailure` | `run.failed` | `error_type` → `reason` and `error.type`; `error_message` at redacted+ |
| `Interrupt` | `run.cancelled` | `by: "user"`: it fires only for the user's own cancellation (reason `"cancelled"`) |
| `PreToolUse` | `tool.requested` | paired via `tool_call_id` |
| `PostToolUse` | `tool.completed` | `tool_output` is vendor-sliced to 2000 chars |
| `PostToolUseFailure` | `tool.failed` | `error.name` → `error.type`; message at redacted+ |
| `PermissionRequest` | `attention.requested` | kind `permission`, `respond_via` `["oob"]`, no options claimed (the vendor's TUI owns the choice surface); cause-linked to its `tool.requested` |
| `PermissionResult` | `attention.answered` | `decision` → `answer.option`; `feedback` → `answer.text` at redacted+; "rejected" also lands `tool.denied` `by: "runtime"`; "cancelled" → `attention.resolved` dismissed; "error" degrades to the fallback |
| `SubagentStart` / `SubagentStop` | `delegation.subagent.started` / `.stopped` | subject = `agent_name`; no `session_id` → `unknown` |
| `PreCompact` | `x.kimi-code.session.pre_compact` | the post moment is the truthful carrier; the pre moment degrades, never drops |
| `PostCompact` | `session.compacted` | `trigger` + `estimated_token_count` at metadata |
| `Notification` | `progress.status` | background-task status only, never an attention loop; subject = `notification_type` |
| any other hook | `x.kimi-code.session.{snake_case}` | the [AEP-0001 §6](/specification/draft/aep-0001-core-and-envelope#6-type-naming-and-categories) mechanical fallback; unknown degrades, never drops |

Coverage limits: no idle or needs-input hook exists, so this surface
has no `agent.idle` source, and headless runs (`kimi -p`) force
permission mode "auto", so the permission pair never fires there.
*Rejected:* `Notification` toward `attention.*` (task status is not a
question); forwarding `stop_hook_active` or `cwd` (loop plumbing and
workstation paths are not fleet facts).

## Control

**Default: the permission pair, observed.** The vendor's TUI prompt is
the answer surface; rendering buttons here would claim a channel that
does not exist.

**Opt-in `AEP_KIMI_CONTROL=1`: the held `PreToolUse` gate.** The one
blockable tool moment becomes an answerable `attention.requested` (kind
`permission`, options allow / deny), held up to
`AEP_ATTENTION_TIMEOUT_MS` (default 50 seconds; the setup writer raises
the registered `PreToolUse` `timeout` to 60 so the hold fits the
vendor's window). A deny replies `permissionDecision` `"deny"` with the
free-text reason (vendor-rendered) and lands `tool.denied`
`by: "policy"`. An allow is strictly "no hook objection": Kimi's own
permission flow still runs downstream, and the observed pair records
the human's answer. Timeout frees the hook with no decision
(`attention.timeout`, fail-open). `AEP_KIMI_GATE_TOOLS` scopes the gate
by tool name.

**Opt-in `AEP_INSTRUCT=1`: steering.** `x.kimi-code.control.instruct`
queues per session (caps: 20 commands, 4000 chars) and delivers on the
next `UserPromptSubmit` reply as `{message}`, the vendor's one
context-accepting reply surface. `SessionEnd` drops leftovers with
reason "session-ended". See the
[steering design record](/components/control-steering-design).

*Rejected:* holding `PermissionRequest` itself (its reply carries no
decision; a hold there would gate nothing); treating an allow as an
approval (it is only the absence of a veto); delivering instructions on
any other hook reply (only the `UserPromptSubmit` reply accepts
context).

## Fixture

The fixture covers the sixteen events, the steer variant, the four
`PermissionResult` decisions, and the fallback; the runners' coverage
check asserts the enum is covered exactly. Lifecycle entries are
oracle-captured from the shipped binary; the permission pair entries
are source-derived and labeled as such (headless capture cannot reach
them). Re-verify triggers: the weekly vendor cadence (re-pin, re-diff
the enum) and the npm namespace.

## The kimi web channel

`impl/bridge-kimi-code-web/` (receiver port 4323) observes the
`kimi web` control plane, verified against the same pinned source and
the shipped 0.28.1 binary (a scratch `kimi web` on an isolated
`KIMI_CODE_HOME`).

`kimi web` runs the kap-server (agent-core-v2): REST under `/api/v1` (a
`{code, msg, data}` envelope; bearer token at `<home>/server.token`;
loopback-bound by default) and a WebSocket stream at `/api/v1/ws` (the
`kimi-code.bearer.<token>` subprotocol; subscribe by `session_ids`); it
registers host, port, and pid under `<home>/server/instances/`, never
the token. The interactive TUI is a different engine (agent-core v1,
in-process, no server surface), so the channel's scope is kap-hosted
sessions only; the TUI is recorded unsupported, never worked around.
The `/web` slash command does not bridge the two: it shuts the TUI down
and the process becomes the server.

External hooks fire for kap-hosted sessions too, and the approval
object is one object: a REST decision
(`POST .../approvals/{approval_id}`) resolves the same parked promise
the permission gate awaits, so the hook surface fires
`PermissionResult` with that decision, and a REST abort fires the
vendor's own `Interrupt` hook (reason "cancelled"). Companion mode (the
default) therefore adds `x.kimi-code.web.*` visibility only, with the
hook adapter carrying the core story; primary mode serves stream-only
deployments with no hooks registered.

Design points:

- Volatile frames (status pulses; assistant/thinking/tool-call deltas)
  never emit: the vendor marks them do-not-persist.
- The internal `permission.approval.*` bus echoes are deduped in favor
  of their `event.approval.*` wire twins: one moment, one carrier.
- Real boundaries, no synthesis: `turn.started`/`turn.ended` carry the
  run pair (`completed` → `run.finished`; `cancelled` →
  `run.cancelled` with no `by` claim, since the channel does not know
  who; anything else → `run.failed` with the vendor word). No session
  lifecycle is fabricated: kap sessions outlive connections.
- The wire `tool.result` names no tool and the schema requires
  `tool.name`, so the pure policy pins `null` and the receiver
  re-attaches the name recorded at `tool.call.started`; an unpairable
  result degrades to channel visibility.
- Every ask sheds its answer affordances in the pure policy (the
  read-only-channel rule): the vendor web UI owns the answer surface by
  default. A decision-less `event.approval.resolved` maps to
  `attention.resolved` dismissed. The question loop maps on the
  AEP-0002 §5.2 `field_spec` shape (every item a `select`;
  `allow_other` → `other`; vendor option ids preserved).
- Opt-in control (`AEP_KIMI_WEB_CONTROL=1`, primary mode only; gated
  off, the hello declares `accepts: []` and the relay refuses
  sender-side) is exactly two REST writes. `control.attention.respond`
  posts the approval decision in the vendor's own vocabulary
  (`approved` / `rejected`; free text rides as `feedback`, rendered as
  the rejection reason); the outcome rides the vendor's
  `event.approval.resolved` broadcast. `control.cancel` scope `run`
  posts the session abort; the `turn.ended` reason "cancelled" boundary
  closes the run. Scope `session` is refused: a kimi session has no end
  to command (abort cancels active work; archive merely shelves).

*Rejected:* actuating question answers (deferred until the round-trip
can be proven live; the ask presents read-only, so nothing is claimed
that cannot be honored); prompt submit or steer as control verbs
(user-plane driving; the hook adapter's steering carries the instruct
queue); the WS `abort` frame (protocol-defined but not implemented
server-side at 0.28.1; abort stays on REST); TUI reachability via the
instance registry (nothing registers for the TUI).
