---
title: "Troubleshoot the stack"
description: "Diagnose the environment first: address family, vantage, token, CORS, and daemon state explain most refusals."
audience: user
spec-refs: [AEP-0001, AEP-0003, AEP-0004]
---

When something in a running stack fails, the cause is usually the
environment, not the protocol. The relay is bound on one address family while
the URL names the other; a port forward lands on the wrong vantage; a token is
missing; a proxy strips the one header a browser needed to explain the
refusal.

This page is symptom-indexed. Find the symptom, run
the probe, apply the remedy. Commands run from a checkout of the
reference repository,
[`agenteventprotocol/reference`](https://github.com/agenteventprotocol/reference),
exactly as [Run the stack](/guides/run-the-stack) sets it up.

## Start with `aep doctor`

```bash
node impl/cli/aep.js doctor --relay http://127.0.0.1:8787
```

One read-only pass, findings with remedies attached, exit `0` when clean
and `1` when something needs attention. It checks:

- **Reachability, per address family.** The URL's port is probed on IPv4
  and IPv6 loopback separately, because from outside, a bind is only
  observable one family at a time.
- **Bind-vs-URL agreement**, derived from that pair of probes: the classic
  failure is a relay answering on the family the URL does not name.
- **Auth posture and token validity**: whether the relay enforces
  authentication, and whether the token you supplied is accepted.
- **CORS visibility**: whether the preflight and, separately, a refused
  request carry `access-control-allow-origin`.
- **Relay stats**: buffer depth, sessions, subscribers (informational).
- **The managed daemons**: every adapter daemon and inbound bridge the
  setup tool knows, with down / stale / wedged told apart.

<Warning>

Probes run from the machine `doctor` runs on. A clean report proves
nothing about a browser behind a port forward, a container, or a VM
boundary: that consumer sits on a different vantage. When a refusal only
happens "over there", re-run `doctor` on the refused machine against the
same `--relay` and compare the two reports.

</Warning>

The [CLI page](/components/cli#aep-doctor-the-environment-diagnostic)
documents each lane against the source.

## The relay answers on one machine and is refused on another

Port forwards and loopback mirrors land on one address family.
`http://127.0.0.1:8787` pins IPv4; a WSL or SSH loopback forward can
surface on IPv6 (`[::1]`) only, which leaves the IPv4 URL refused even
though the port is, in every other sense, forwarded. `doctor` names this
case directly: the URL's family refuses while the sibling family answers
`/healthz`.

Remedies, in preference order: forward the family the URL names; point
the URL at the family that answers; or restart the relay bound to the
family you need (the `AEP_HOST` environment variable, which
`aep-setup up relay` sets for you).

## Everything is up, but a browser consumer reports a network error

A browser can only explain a refusal it is allowed to read. A response
without `access-control-allow-origin` surfaces in the page as a generic
network error (status 0), whatever the real status was, so a bad token
and a dead relay become indistinguishable. The reference relay carries
the header on refusals too, precisely so a browser consumer can render
"401" instead of "failed to fetch"; `doctor`'s CORS lane verifies both
the preflight and a deliberately refused request.

If the relay sits behind a reverse proxy, check that the proxy forwards
that header on error responses as well: stripping headers from non-2xx
responses quietly reintroduces the opaque failure.

## Reachable, but every request answers 401

Authentication on the event and control bindings is unconditional,
localhost included; see
[AEP-0003 §8](/specification/draft/aep-0003-bindings-and-lifecycle#8-identity-authentication-and-backpressure)
for why. The reference stack never invents a token: the relay and every
CLI verb adopt one from `--token`, the `AEP_TOKEN` environment variable,
or the setup-managed token file, in that order. Two machines disagreeing
about the token value produce exactly this symptom; `doctor`'s auth lane
reports the posture the relay actually enforces.

## A control command is refused before the agent ever sees it

`aep respond` or `aep cancel` exiting `3` with a reason on stderr is a
sender-side refusal, not a transport failure. A target's
`hello.capabilities.control.accepts` declaration is authoritative, and a
relay that knows it refuses on the target's behalf; see
[AEP-0004 §4](/specification/draft/aep-0004-control-profile#4-gating-and-transport)
for the gate and the error frame it answers with. Reading the reason:

- `unsupported`: the target does not accept this command type. An
  adapter whose control gate is disabled declares no accepted commands,
  so every command nacks this way by design; enable the gate in that
  adapter's setup (each adapter README in the reference repository
  documents its switch) and the declaration changes on the next hello.
- `unauthorized`: the sending connection is unauthenticated, or a
  deployment policy refused the sender.
- `ambiguous`: more than one live connection claims the addressed
  session; the relay refuses rather than guess a claimant.
- `no-route`: no connected emitter owns the addressed session. The agent
  is down, or the session has ended.

## A managed daemon reads down, wedged, or stale

`doctor`'s daemon sweep reads ids, ports, and pid files from the setup
tool's catalogs (they are tool-managed; nothing else should assign
them), and it tells three states apart:

- **down** (info): not running. `node impl/setup/aep-setup.js up <id>`
  starts it.
- **stale pid** (warning): the pid file exists but the process is gone.
  `aep-setup down <id>` cleans it up.
- **wedged** (finding): the pid is alive but the port no longer answers
  `/healthz`. `aep-setup down <id>` then `up <id>`.

## Reproduce a problem without a live agent

Capture once, replay anywhere.
[`aep sink`](/components/cli#aep-sink-durable-capture) writes durable
per-session JSONL; `aep replay capture.jsonl` re-emits it onto any relay
as a new session, with fresh identity and command frames skipped so a
replay can never drive a live target (the
[CLI page](/components/cli#aep-replay-re-emit-a-capture-as-a-new-session)
covers why it is never a resume). `--dry-run` prints the plan without
emitting. This turns a "works on my machine" report into a file the
other side replays against their own consumer.

## When it is not the environment

Validate the traffic itself:
[`aep validate`](/components/cli#aep-validate-filejsonl-) runs the
conformance-grade envelope, payload, ordering, and capture checks over
any captured JSONL. If a line fails, the emitting adapter (or an
assumption in your consumer) is the bug, and the
[conformance fixtures](https://github.com/agenteventprotocol/agent-event-protocol/blob/main/conformance/README.md)
pin down which side is wrong. Open an issue with the `validate` output
and a replayable capture; anything security-sensitive goes through the
[security policy](/community/security) instead of the public tracker.
