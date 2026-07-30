# AEP-0003: Transport Bindings, Connection Lifecycle, and Subscriptions

| Field | Value |
|---|---|
| **AEP** | 0003 |
| **Title** | Transport Bindings, Connection Lifecycle, and Subscriptions |
| **Type** | Standards Track — Binding |
| **Status** | Draft |
| **Sponsor** | AEP maintainers |
| **Created** | 2026-07-03 |
| **Requires** | AEP-0001, AEP-0002 |
| **Supersedes / Superseded-by** | n/a |

> Provenance (non-normative): one wire unit in four framings (no JSON-RPC),
> per-binding lifecycle classes, the `hello` handshake, attr-match, and
> `(epoch, seq)` resume. Filter keys use native envelope spelling.

## Abstract

Defines the four AEP 0.1 transport bindings (JSONL (stdio/file), HTTP POST (emit),
SSE (consume), WebSocket (duplex)) and the connection lifecycle each requires: the
`hello` exchange and capability negotiation, producer identity and authentication,
the `attr-match` subscription filter dialect, resume via `(session, epoch, seq)`,
backpressure rules, and adapter conformance guidance including capture redaction.
The wire unit on every binding is the identical AEP-0001 envelope; no binding wraps
or rewrites Events.

## 1. Binding classes and lifecycle surface

Events are valid without any connection (AEP-0001 §4.2). Lifecycle obligations apply
only to live bindings, graduated by class:

| Binding | Class | Lifecycle surface |
|---|---|---|
| JSONL (stdio/file) | none | no handshake; the envelope alone carries version and identity |
| HTTP POST (emit) | stateless-lite | version in a request header; identity via auth; discovery via GET (§3.4); no negotiation round-trip |
| SSE (consume) | half | subscription expressed in the request; resume via `Last-Event-ID` |
| WebSocket (duplex) | full | `hello` exchange, capability negotiation, multiplexed subscriptions, control (AEP-0004) |

An implementation claims L2 conformance **per binding** it supports; no binding is
mandatory for emitters (the cheapest conformant emitter writes JSONL to stdout).
Consumers claiming L2 MUST implement `attr-match` (§6) and resume (§7) on the
consuming bindings they support.

## 2. Frames versus Events (WebSocket vocabulary)

On the WebSocket binding, each text frame carries one JSON object that is either an
**Event** (AEP-0001 envelope; its `type` always contains a dot) or a **frame**: a
connection-scoped message whose `type` contains no dot. Frame types in 0.1:
`hello`, `subscribe`, `subscribed`, `unsubscribe`, `unsubscribed`, `roster`,
`error`, `replay-exhausted`, `closing`, `ping`, `pong`. Unknown frame types MUST be
ignored (forward compatibility). Frames are never persisted, never carry `seq`, and
never appear on non-WS bindings.

## 3. Binding specifications

### 3.1 JSONL (stdio / file)

1. One Event per line, `\n`-delimited, UTF-8, no blank lines; writers MUST write each
   line atomically (single `write`) so concurrent tailing never observes a torn Event.
2. An append-only session log file is simultaneously a durable history format and a
   transport: `tail -f x.jsonl` is a conformant consume path. RECOMMENDED layout:
   `{root}/{agent}/{session}.jsonl`.
3. No handshake, no version negotiation: the `aep` attribute on each line is the
   version marker; a reader encountering an unsupported major version MUST skip the
   line and SHOULD report it once.
4. Trust model: filesystem and process trust (§8.1).

### 3.2 HTTP POST (emit)

1. `POST {base}/events` with either a single Event
   (`Content-Type: application/json`) or a batch, one Event per line
   (`Content-Type: application/x-ndjson`). Batch order within one request is
   preserved.
2. Request header `AEP-Version: 0.1` is REQUIRED. Servers MUST answer an unsupported
   major version with **426 Upgrade Required** and body
   `{ "versions": ["0.1"] }`.
3. Responses: `202` accepted (body optional); `400` with
   `{ "error": "invalid-event", "detail": ... }` when any Event fails envelope
   validation (batch: `207`-style per-line report MAY be used, or reject the batch
   whole with the first failing line index); `401`/`403` per §8; `413` oversize;
   `415` wrong content type.
4. Delivery is at-least-once from the emitter's perspective: emitters SHOULD retry
   on network failure and 5xx with the same Event `id`s (dedupe is the consumer's
   duty, AEP-0001 §7.4).
5. Structured body only; there is no header-mapped ("binary mode") encoding.

### 3.3 SSE (consume)

1. `GET {base}/stream` with `Accept: text/event-stream`. Subscription parameters:
   `filter` (URL-encoded attr-match JSON, §6), `capture` (ceiling, §6.4), `from`
   (URL-encoded JSON array of `{session, epoch, seq}` triples for multi-session
   exact resume, or the literal string `all` for replay-all, §5).
2. Each SSE message: `event:` = the AEP `type`; `data:` = the Event JSON on one
   line; `id:` = `{session}:{epoch}:{seq}` for session-scoped Events. Agent-scoped
   Events carry no `id:` field (they are not resumable positions).
3. **Resume:** the `Last-Event-ID` request header, when present, is the resume
   position for the session it names; servers MUST replay buffered Events after that
   position for that session before live delivery. For exact multi-session resume,
   consumers SHOULD use the `from` parameter (which takes precedence over
   `Last-Event-ID`). When a requested position predates the buffer, the server MUST
   emit an SSE comment line `: replay-exhausted {session} {earliest-epoch}:{earliest-seq}`
   before delivering what it holds.
4. Heartbeat: servers SHOULD send a comment line (`: ping`) at least every 30 s.

### 3.4 HTTP discovery document

`GET {base}/events` (the same URL emitters POST to) MUST return the discovery
document, `Content-Type: application/json`:

```json
{
  "aep": ["0.1"],
  "role": "collector",
  "endpoints": { "events": "/events", "stream": "/stream", "socket": "/socket" },
  "capabilities": {
    "filters": ["attr-match"],
    "replay": { "buffer": 10000, "all": true },
    "capture": ["none", "metadata", "redacted"],
    "control": { "accepts": [] },
    "roster": {},
    "experimental": {}
  }
}
```

`capabilities` reuses the `hello` capability shape (§4) so stateless emitters learn
the same facts a WS party would negotiate. Origin-root deployments SHOULD also serve
it at `/.well-known/aep`. Fields other than `aep` and `endpoints` are OPTIONAL;
unknown fields MUST be ignored.

### 3.5 WebSocket (duplex)

1. URL: `{base}/socket`. After the WS handshake, the **first frame in each direction
   MUST be `hello`** (§4). Any other first frame gets an `error` frame
   (`code: "hello-required"`) and close.
2. One Event or frame per text frame; binary frames are reserved and MUST be
   rejected in 0.1.
3. Emitters send Events after `hello` completes; consumers manage subscriptions with
   `subscribe`/`unsubscribe` frames (§6.5); control Events flow only on this binding
   (AEP-0004).
4. **Orderly close:** a party closing deliberately SHOULD first send a `closing`
   frame: `{ "type": "closing", "reason": string, "delivered": [{ "sub": id,
   "session": s, "epoch": e, "seq": n }...] }` carrying last-delivered positions per
   subscription, then perform the WS close handshake. Consumers MUST NOT depend on
   receiving it (abnormal loss happens); they track their own positions.
5. Liveness: `ping`/`pong` frames (`{ "type": "ping", "t": ... }` echoed as `pong`);
   RECOMMENDED interval 30 s, timeout 90 s.

## 4. The `hello` exchange (WS)

```json
{
  "type": "hello",
  "versions": ["0.1"],
  "role": "emitter",
  "identity": {
    "agent": "claude-code",
    "instance": "host-a/7c1f",
    "card": null
  },
  "capabilities": {
    "emits": ["session", "run", "tool", "attention", "error"],
    "capture": ["none", "metadata", "redacted"],
    "control": { "accepts": ["control.attention.respond"], "ack_window_ms": 10000 },
    "replay": { "buffer": 10000, "all": true },
    "filters": ["attr-match"],
    "experimental": {}
  }
}
```

Normative rules:

1. `versions` is ordered preference, newest first. The responder's `hello` selects
   **exactly one** version from the intersection (its `versions` array has length 1);
   no intersection gets an `error` frame (`code: "version-unsupported"`, `versions`
   listing supported ones) and close. One version governs the whole connection.
2. `role` is `emitter`, `consumer`, or `both`.
3. `identity.agent` is REQUIRED for emitters (matches the envelope `agent` of the
   Events it will send); `instance` disambiguates processes; `card` optionally
   carries the JWS identity document (§8.3).
4. **Unknown capability keys MUST be ignored**: capabilities are a discovery
   surface, never a validation gate.
5. Capabilities are declarations, not promises of exclusivity: an emitter MAY emit
   categories it did not declare (declarations are routing hints), but a party MUST
   NOT depend on a feature the peer did not declare. **Exception (control):**
   `control.accepts` is authoritative; commands outside it MUST be nacked
   (`unsupported`), per AEP-0004.
6. `capabilities.experimental` is the graduation namespace: features live there
   before standardization.

### 4.1 The `roster` frame (WS)

Declarations exist per connection (§4), but a consumer watching a fleet through a
relay could not see any *other* party's declarations: it learned a target's
`control.accepts` only by sending a command and reading the nack. The `roster`
frame closes that gap: a consumer asks the endpoint it is connected to for a
snapshot of the live emitter claims that endpoint terminates, and the declared
capability facts attached to each claim.

```json
{ "type": "roster", "id": "r-1" }
```

The endpoint replies with the complete snapshot:

```json
{ "type": "roster", "id": "r-1",
  "entries": [
    { "session": "s_8f2c", "agent": "claude-code", "instance": "host-a/7c1f",
      "control": { "accepts": ["control.attention.respond"], "ack_window_ms": 10000 },
      "emits": ["session", "run", "tool", "attention"] }
  ] }
```

Normative rules:

1. **Advertisement.** Endpoints implementing this frame declare `"roster": {}` in
   their capabilities (`hello` §4, and the discovery document §3.4). A consumer
   MUST NOT expect an answer from an endpoint that did not declare it: unknown
   frame types are ignored (§2), so an undeclared request would wait on silence.
2. **Request/reply.** The request carries `id` (REQUIRED); the reply echoes it.
   The frame is watch-class: requests are honored on `consumer`/`both`
   connections under the same §8 authentication posture as `subscribe`, never
   looser. An `emitter`-role request is refused in-band with the §6.5 pattern:
   an `error` frame (`code: "unauthorized"`, same `id`), and the connection
   survives.
3. **Scope.** `entries` covers exactly the live (connection, claimed session)
   pairs the answering endpoint currently terminates, the same knowledge
   boundary AEP-0004 §4 states for relay-behalf refusals. Chained relays answer
   for themselves; no cross-relay aggregation is defined in this revision.
   Sessions with history but no live duplex claimant are absent: absence means
   *no live route* (the command would nack `no-route`), which is exactly the
   affordance fact a consumer needs.
4. **Entries relay declarations verbatim.** Per entry: `session` (REQUIRED, the
   claim as declared), `agent` and `instance` from the claiming connection's
   `hello` identity, `control` (that connection's declared
   `capabilities.control`, verbatim, absent when none was declared) and
   `emits` when declared. Endpoints MUST NOT synthesize, merge, or infer
   members it was never sent.
5. **Ambiguity is visible, never resolved.** One entry per live claim: a
   `session` value repeating across entries reports the multi-claimant state
   (AEP-0004 §4). Endpoints MUST NOT merge claims or elect one.
6. **A roster is a snapshot, never a promise.** Entries state declarations as of
   the reply. The authoritative gate for commands remains the target's declared
   `accepts` at command time (AEP-0004 §4); nack semantics are identical with
   or without this frame. Consumers MAY re-request at any time; this revision
   defines no change-push (live `session.*` Events already signal the moments
   worth re-asking about).
7. **Metadata only.** Entries carry identity fields and declared verb/category
   lists: no event content, and no interaction with capture ceilings (§6.4).

## 5. Replay buffers

An endpoint that fans out Events MAY keep a bounded per-session replay buffer
and, if it does, MUST advertise its depth in `hello` and the discovery document
(`replay.buffer`, count of Events per session or a global count; implementations
document which).

Requested resume positions that predate the buffer MUST produce
`replay-exhausted` (WS frame: `{ "type": "replay-exhausted", "sub": id,
"session": s, "earliest": { "epoch": e, "seq": n } }`; SSE comment, §3.3.3),
followed by delivery from the earliest held position. The consumer then knows to
consult a history store.

**Replay-all.** In place of the position array, `from` MAY carry the literal
string `all`: replay every session buffer the endpoint currently holds, each
from its earliest held position (filter and capture ceiling applied as for any
replay), then live delivery; `live=0` composes unchanged. Endpoints
implementing it advertise `"all": true` inside `replay` (`hello` §4 and the
discovery document §3.4).

Three honesty rules:

1. Replay-all is bounded by what the endpoint *holds*. It is never a
   completeness claim, and sessions wholly evicted are absent.
2. No `replay-exhausted` fires for it: the request names no position that could
   predate a buffer, and "earliest held" is the ask itself.
3. A consumer that needs evicted history consults a history store, exactly as
   for any exhausted resume.

An endpoint that does not implement the value refuses it deterministically
through the closed refusal classes that already govern malformed `from`
(SSE §3.3, WS §6.5); advertisement therefore serves *planning*, not
determinism, and a consumer MAY equally try first and fall back to enumerated
positions on the refusal.

A buffering fan-out endpoint is not a terminal consumer: buffer **admission**
dedupes on `(source, id)` (AEP-0001 §7.4), but live fan-out forwards Events as
received: at-least-once redelivery MUST be able to traverse the hop, or
recovery built on redelivery (AEP-0004 §3's re-acknowledgement of a retried
command) breaks at it. Dedupe is the terminal consumer's duty.

## 6. The `attr-match` filter dialect

`attr-match` is the REQUIRED filter dialect; richer dialects (e.g. `cesql`) are
optional, declared via `capabilities.filters`. Design bound: implementable in an
afternoon in any language.

### 6.1 Grammar

A **filter** is a JSON object. Each member is a predicate on **one envelope context
attribute** (native spelling) or extension attribute. A filter
matches an Event iff **every** member matches (conjunction). An empty filter `{}`
matches every Event.

```
Filter        = { (AttrName : Predicate)* }
Predicate     = Scalar                          ; equality
              | [ Scalar+ ]                     ; inclusion: any-of
              | TypePattern | [ TypePattern+ ]  ; only on "type"
              | SeverityCmp                     ; only on "severity"
Scalar        = JSON string / integer / boolean
TypePattern   = exact type
              | prefix ".*"                     ; e.g. "attention.*", "x.acme.*"
SeverityCmp   = { "gte": Level }
              | { "lte": Level }
              | { "gte": Level, "lte": Level }
Level         = "debug"|"info"|"notice"|"warning"|"error"|"critical"
```

### 6.2 Matching rules

1. **Allowed keys:** `id`, `type`, `subject`, `source`, `agent`, `session`, `run`,
   `step`, `epoch`, `cause`, `severity`, `capture`, and extension attribute names
   (§AEP-0001 5.4). `time`, `seq`, `aep`, `traceparent`, and `data` are NOT
   filterable: routing never parses payloads; positions are the resume mechanism,
   not filters; trace context is pass-through join metadata; and a core attribute
   name is never a legal extension key (AEP-0001 §5.4).

   A filter key that is neither a filterable core attribute nor a syntactically
   legal extension-attribute name (AEP-0001 §5.4) MUST be rejected
   (`invalid-filter`): fail closed, never match-all. Legal extension-attribute
   keys are always accepted; whether any event carries them is a matching
   question, not a validity question.
2. **Equality/inclusion** compares JSON values exactly (no coercion). An inclusion
   array matches if any element matches.
3. **Type patterns:** `p.*` matches any `type` strictly beginning with `p` followed
   by a dot (`attention.*` matches `attention.requested`, not `attention`);
   patterns compose with inclusion arrays; `*` alone is NOT a pattern (use `{}` or
   omit the key). Patterns apply to vendor types too (`x.acme.*`).
4. **Severity comparison** uses the §AEP-0001 8.1 total order, inclusive bounds.
5. **Absent attributes:** a predicate on an attribute the Event omits does not match,
   except `severity`, `capture`, and `epoch`, where the AEP-0001 defaults
   (`info`, `metadata`, `0`) are applied before matching.

### 6.3 Examples (non-normative)

```json
{ "type": ["attention.*", "error.*"], "severity": { "gte": "notice" } }
{ "session": "s_8f2c" }
{ "agent": ["claude-code", "codex"], "type": "tool.denied" }
```

### 6.4 Capture ceiling at subscribe

A subscription MAY declare `capture` (a ceiling). Fan-out MUST down-level delivered
Events to the ceiling per AEP-0001 §8.2 / AEP-0002 §5.1 and MUST NOT up-level.
Absent ceiling means "as stored/received". A `redacted` ceiling delivers
`full`-source Events at `metadata` unless the fan-out party is a redacting
re-emitter (AEP-0001 §8.2(e)); mechanical fan-out never mints the `redacted`
provenance claim.

### 6.5 Subscription frames (WS)

```json
{ "type": "subscribe", "id": "sub-1",
  "filter": { "type": ["attention.*"], "severity": { "gte": "notice" } },
  "from": [ { "session": "s_8f2c", "epoch": 3, "seq": 187 } ],
  "capture": "metadata" }
```

Endpoint replies `{ "type": "subscribed", "id": "sub-1" }` or
`{ "type": "error", "id": "sub-1", "code": "invalid-filter" | "unknown-dialect" |
"unauthorized" | "limit-exceeded", "detail": ... }`. The code set is closed:

- `invalid-filter`: the subscribe request is syntactically invalid (a
  malformed `filter` or `from` member) or the filter names an illegal key
  (§6.2 rule 1). Fail closed: never a partial subscription, never match-all.
- `unknown-dialect`: the subscription requires a filter dialect the endpoint
  did not advertise (dialects are declared via `capabilities.filters`, §6).
  No member of the 0.1 `subscribe` frame names a dialect: richer dialects
  arrive with their own frame surface in a future revision; the code is
  forward vocabulary, defined so the set stays closed when they do.
- `unauthorized`: this connection may not subscribe (§8).
- `limit-exceeded`: honoring the subscription would exceed an endpoint
  resource limit (more `from` resume positions than the endpoint replays, more
  concurrent subscriptions than it fans out, and so on). Limits are the endpoint's
  own; `detail` SHOULD name the one that was hit.

Rejection is per-request and in-band: the endpoint answers the offending
`subscribe` with the error frame, and a refused subscription MUST NOT by
itself close the connection or disturb the other subscriptions on it.

Multiple concurrent subscriptions per connection are REQUIRED server-side
(multiplexed fan-out; disjunction is expressed as multiple subscriptions).
`unsubscribe` by `id` is acknowledged with `unsubscribed`. `from` is OPTIONAL;
when present, buffered replay precedes live delivery per §5: either an array
of resume positions or the literal string `"all"` (replay-all, §5; an endpoint
not implementing the value answers the closed-set `invalid-filter` refusal,
exactly as for any malformed `from` member).

## 7. Resume contract (all consuming bindings)

Resume tokens are `(session, epoch, seq)` triples (AEP-0001 §7). A resuming
consumer supplies the last position it durably processed; the endpoint delivers
strictly after that position.

Gaps are legal; duplicates are legal (dedupe on `(source, id)`, AEP-0001 §7.4);
a below-high-water position is redelivery or backfill, ordered by
`(epoch, seq)`. A new epoch is only ever declared by the emitter via the `epoch`
attribute (AEP-0001 §7.2).

Binding carriage: SSE `Last-Event-ID` / `from` query (§3.3), WS
`subscribe.from` (§6.5). JSONL resumes by file offset (the file is its own
buffer).

## 8. Identity, authentication, and backpressure

### 8.1 Trust per binding

| Binding | Requirement |
|---|---|
| JSONL/stdio | filesystem & process trust; no protocol surface |
| HTTP / SSE / WS on localhost | bearer token RECOMMENDED |
| any off-host binding | TLS REQUIRED + bearer token (or stronger) REQUIRED |
| control (any) | authentication REQUIRED unconditionally (AEP-0004) |

Bearer tokens travel in `Authorization: Bearer <token>`. For browser `EventSource`
clients that cannot set headers, servers MAY accept `?access_token=<token>` and MUST NOT
log it.

### 8.2 Identity layers

Naming (envelope `agent` + `source` URI; connection-level `instance` at `hello`,
§4) is REQUIRED; binding authentication per §8.1; attestation is OPTIONAL (§8.3). Identity is *who is
speaking*; authorization (who may command whom) is deployment policy in 0.1.

### 8.3 Identity document (`experimental`)

A JWS-signed JSON document (A2A AgentCard shape): claims `agent`, `operator`,
`endpoints`, `accepts` (control types), `valid_until`; detached or compact JWS
signed by the operator key; carried in `hello.identity.card`. Verification is a
consumer policy, not a protocol gate. Normative schema deferred until a
multi-tenant relay exists (an open question for a future revision).

### 8.4 Backpressure

Endpoints MAY drop `debug` and `info` Events toward a slow consumer. They MUST NOT
silently drop `notice`-and-above: the choice is deliver, or disconnect (WS: `closing`
frame with positions, then close; SSE: terminate stream) so the consumer resumes
exactly. Emitter-side (adapter → collector) buffering guidance: bounded queue,
block-or-drop policy MUST prefer dropping `debug`/`info` first and MUST count drops
(`x.*` extension attribute or adapter log).

## 9. Adapter conformance guidance and capture redaction

Adapters translate a runtime's native hooks into Events (AEP-0002 Annex A). The
privacy promise of `capture` is enforced **at the adapter** for sources whose hooks
deliver full content:

1. **Configured ceiling.** Every adapter MUST expose a capture ceiling (default
   `metadata`), applied to every emitted Event: `capture` never exceeds it, and
   payload fields above it are dropped per the schema annotations (AEP-0002 §5.1).
   Per-category overrides SHOULD be supported (RECOMMENDED default:
   `attention.*: redacted` so prompts remain readable).
2. **Metadata synthesis.** At ceiling `metadata`, fields required for a usable Event
   but gated higher MUST be synthesized from structural metadata only (e.g.
   `attention.requested.prompt` becomes `"{agent} requests {kind}: {subject}"`).
   Adapters MUST NOT smuggle content through metadata-level fields.
3. **Digests before redaction.** `*_digest` fields are SHA-256 (hex, first 16 bytes)
   over the canonical JSON of the **original** content: correlation without
   content; computed before any redaction.
4. **Redaction pipeline** (for `redacted`-gated free text at ceiling `redacted`),
   normative minimum, applied in order:
   a. **Secrets/credentials**: replace with `[REDACTED:secret]`: PEM blocks;
      `AKIA[0-9A-Z]{16}`; `Bearer `-prefixed tokens; `(password|passwd|secret|
      api[_-]?key|token)\s*[=:]\s*\S+` values; JWT-shaped strings
      (`eyJ...`.`...`.`...`).
   b. **Configured names**: values of environment variables / config keys the
      operator lists as secret.
   c. **Home paths**: user home directory prefix replaced with `~`.
   d. **PII class** (emails, phone numbers): ON by default at `redacted`,
      operator-disableable; replace with `[REDACTED:pii]`.
   The pipeline is a floor, not a ceiling: adapters MAY redact more. Rule (a) and (b)
   failures discovered post-emission are security incidents, not conformance
   nits.
5. **No up-leveling downstream.** Adapters MUST set the Event's `capture` to the
   level actually honored, so every downstream hop can rely on it (AEP-0001 §8.2).
6. **Identifiers are untrusted downstream.** Adapters SHOULD keep `session`,
   `run`, and `step` values within `[A-Za-z0-9._-]`, starting alphanumeric:
   the interop-safe grammar every mapped vendor id observed to date fits. The
   envelope deliberately does not enforce a pattern: at least one adopted
   source's session ids are contractually arbitrary strings, so a schema
   constraint would reject conformant vendor ids at the wrong layer. Consumers
   treat these values (and `subject`) as producer-controlled input and encode
   or sanitize before using them as filesystem, URL, or query components
   (AEP-0001 §12).

## 10. Conformance surfaces owed by this document

Fixture classes (in `conformance/fixtures/`): the attr-match golden corpus
(filter, event, verdict) incl. fail-closed unknown keys; capture down-level at
fan-out; the redaction pipeline corpus.

Frame and connection behavior is not fixture-shaped (frames are not Events) and
lives in the live checker (`conformance/live.js`):

- `hello` version selection incl. rejection and hello-first ordering;
- subscribe rejection in-band from the closed §6.5 set with connection survival;
- ignore-unknown frame types and capability keys;
- capture ceiling at subscribe;
- resume over `from` (gap tolerance, duplicate delivery);
- control gating;
- the roster snapshot (§4.1: advertised capability, id echo, entry-per-claim
  with verbatim declared control blocks, emitter-role refusal in-band with
  connection survival);
- replay-all (§5: advertised via `replay.all`, every held session replayed from
  its earliest position, no spurious `replay-exhausted`, deterministic refusal
  where unimplemented).

Two classes need a live, cooperating endpoint rather than fixtures:
`replay-exhausted` under real buffer eviction (a black-box check cannot force
another endpoint's buffer to evict unaided) and envelope-over-binding
byte-identity round-trips (JSONL line, POST body, SSE `data:`, and WS frame).

The live checker's opt-in `--evict` mode covers both against any endpoint whose
operator runs the target with a small replay buffer for the occasion: the
checker floods a session past the advertised buffer, then asserts the exhaustion
markers and envelope identity black-box on both consuming bindings. The
reference stack self-certifies the same way in CI.

## 11. Security considerations

*This section is informative; every rule it mentions is defined where cited.*

- **The query-string token is the deliberate weak spot: treat its surroundings
  accordingly.** Bearer tokens belong in `Authorization` (§8.1); the
  `?access_token=<token>` fallback exists only because browser `EventSource` cannot set
  headers. Servers already may not log it (§8.1), but URLs also transit proxy access
  logs, browser history, and `Referer` chains: deployments using the fallback scrub
  query strings at every logging layer they control, scope such tokens narrowly, and
  rotate them more aggressively than header-borne ones.
- **Transport security is deployment-owned by design.** The trust table (§8.1) sets
  the floor: TLS plus a bearer token (or stronger) for anything off-host,
  authentication unconditionally for control (AEP-0004); and implementations
  typically terminate TLS at a reverse proxy in front of a plain-HTTP endpoint. The
  protocol adds no transport crypto of its own; whatever sits between the proxy and
  the endpoint is inside the trust boundary and needs the same care as the endpoint
  itself.
- **Backpressure doubles as the denial-of-service posture.** Bounded replay buffers
  (§5), the drop-`debug`/`info`-first rule, and deliver-or-disconnect for
  `notice`-and-above (§8.4) mean a slow, stalled, or hostile consumer costs bounded
  memory and can always be shed without losing the consumer's ability to resume
  exactly (§7). The same rules bound what a flood of low-severity Events can occupy.
- **Digests correlate; they do not conceal.** `*_digest` fields are computed over
  the original content before redaction (§9.3) so redacted streams stay joinable.
  A digest of low-entropy content (a short command line, a known filename) can be
  confirmed by brute force by anyone holding candidate plaintexts: digests are
  correlation aids, not encryption, and content that must not be inferable belongs
  behind `capture: none`, not behind a hash.
- **Redaction failures are incidents, not nits.** The pipeline (§9.4) is a normative
  floor with an explicit rule that secret/credential leaks discovered post-emission
  are security incidents. The ceiling mechanism only works end-to-end because every
  fan-out hop re-gates (§6.4, AEP-0001 §8.2) and a hop that cannot classify content
  degrades it structurally rather than passing it through.
- **Filters fail closed.** An unknown or illegal filter key is rejected
  (`invalid-filter`, §6.2) rather than silently matching everything: a subscription
  can narrow unexpectedly, but never silently widen its intake.

## References

- AEP-0001, AEP-0002, AEP-0004.
- RFC 6455 (WebSocket).
- WHATWG SSE (`text/event-stream`, `Last-Event-ID`).
- RFC 6750 (bearer tokens).
- NDJSON.
- RFC 7515 (JWS).
