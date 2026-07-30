#!/usr/bin/env node
// AEP 0.1 live endpoint checker — self-certification against a running
// collector/relay. Zero dependencies (Node >= 22; the WebSocket client is the
// global one). Every check cites the normative text it verifies; the envelope
// check is derived from AEP-0001 §5.1/§5.2 directly (this repository ships no
// implementation code, by design — GOVERNANCE §6).
//
// Usage:
//   node conformance/live.js <base-url> [--token T] [--checks a,b,c] [--timeout MS]
//     [--json <path|->] [--evict] [--evict-max N]
//     [--control-session S [--control-accepts TYPE] [--control-undeclared TYPE]
//      [--control-cancel RUN] [--ack-window MS]]
//
// Checks: discovery · version-gate · reject-invalid · ingest-fanout · resume ·
// capture-downlevel · hello-ws (skipped when the endpoint advertises no socket)
// · subscribe-limits (same skip: WS subscribe rejection is in-band from the
// closed §6.5 code set and per-request — the connection survives)
// · ignore-unknown (same skip: unknown frame types, §2, and unknown capability
// keys, §4 rule 4, are ignored — forward compatibility is normative)
// · roster (skipped unless the endpoint advertises capabilities.roster —
// AEP-0003 §4.1 rule 1; the frame is opt-in surface, and probing an
// undeclared endpoint proves only the §2 silence)
// · replay-all (skipped unless the endpoint advertises replay.all — §5;
// unlike the roster the refusal is deterministic, so advertisement is a
// planning fact and an advertising endpoint that refuses is the failure)
// · evict-replay-exhausted / evict-byte-identity (OPT-IN under --evict, and
// both skip unless the endpoint advertises a positive
// capabilities.replay.buffer no larger than --evict-max, default 512): ONE
// shared flood pushes a fresh session past the advertised buffer, then
// replays from a predating position over BOTH bindings. The exhausted check
// (§5/§3.3.3) wants the replay-exhausted marker — the SSE comment line, the
// WS frame echoing the subscribe id — before any replayed event, the two
// earliest positions agreeing and exceeding the request, and delivery
// running the marked earliest through the last posted seq, strictly
// ascending (the eviction depth itself is implementation-defined, so the
// assertion is coherence with the marker, never a particular number). The
// byte-identity check (§10; floor AEP-0001 §4.2) grades the delivered
// payloads: strict when every raw string matches the posted line
// byte-for-byte, the §4.2 floor when a re-serialization keeps the core
// envelope and data intact; wrapped payloads, mutated core attributes, and
// bindings disagreeing on the same (source, id) fail. The flood is
// destructive pressure on a shared buffer — point --evict at a cooperating
// deployment (a dev instance with a small configured buffer), never at
// production.
// · control-behalf-refusal (skipped unless capabilities.control is advertised
// AND the run is authenticated — the §4 routing surface is opt-in, and §4.1
// refuses control before routing on an unauthenticated binding): a command to
// a session with history but no live claimant draws the deterministic
// cause-correlated `no-route` frame (AEP-0004 §4.5), and the addressed
// session's replay stays untouched — no command, no refusal Event (§4.2; §8's
// decided audit boundary)
// · control-auth-gate (probeable only on an UNAUTHENTICATED run: control must
// not flow on an unauthenticated duplex — AEP-0004 §4.1 / AEP-0003 §8.1; the
// check SKIPs when --token was supplied, because that binding is authenticated).
//
// Control-capable target checks (AEP-0004 §7) are OPT-IN: they run only when
// `--control-session` names a session whose owner is a connected
// control-capable target reachable through this endpoint — the checker sends
// real commands. `control-ack` / `control-dedupe` probe with a declared
// command type (default `control.attention.respond` with an unknown subject:
// a compliant target acknowledges without side effects); `control-nack-
// unsupported` probes with an undeclared type (default `control.pause`).
// `control-cancel` actually cancels the run named by `--control-cancel` — it
// is DESTRUCTIVE and never runs unless that flag names a run. The control
// profile is `experimental`; checking against it is exactly the evidence
// GOVERNANCE §5's graduation bar asks for.
//
// `--json <path|->` emits the machine-readable conformance report (format
// aep-conformance-report, formatVersion 1): every check as pass|fail|skip
// with its detail, the summary counts, and the overall verdict. A path
// writes the report to that file and leaves the human output alone; `-`
// makes the report the ONLY stdout and moves every human line — the header,
// the PASS/FAIL/SKIP lines, the footer — to stderr. Exit codes are
// unchanged in both modes.
// Exit 0 iff every selected, non-skipped check passes.
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const BASE = argv.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
if (!BASE) {
  console.error('usage: node conformance/live.js <base-url> [--token T] [--checks LIST] [--timeout MS] [--json PATH|-] [--evict] [--evict-max N]');
  process.exit(2);
}
const TOKEN = opt('token', null);
const TIMEOUT = Number(opt('timeout', 8000));
const ONLY = opt('checks', null)?.split(',').map((s) => s.trim());
// Control-target options (AEP-0004; see header — opt-in, destructive gated).
const CONTROL_SESSION = opt('control-session', null);
const CONTROL_ACCEPTS = opt('control-accepts', 'control.attention.respond');
const CONTROL_UNDECLARED = opt('control-undeclared', 'control.pause');
const CONTROL_CANCEL_RUN = opt('control-cancel', null);
// Sender-side ack window (AEP-0004 §3 default 10 000 ms). Exactly-one
// assertions must observe the WHOLE window, so smaller values make the
// control checks faster where the deployment allows it.
const ACK_WINDOW = Number(opt('ack-window', 10_000));
// Machine-readable report destination (--json <path|->; see the header).
const JSON_OUT = opt('json', null);
if (argv.includes('--json') && JSON_OUT == null) {
  console.error('usage: node conformance/live.js <base-url> [--token T] [--checks LIST] [--timeout MS] [--json PATH|-] [--evict] [--evict-max N]');
  process.exit(2);
}
// The eviction flood is opt-in (--evict) and refuses to run past an
// advertised buffer larger than --evict-max — flooding a replay buffer is
// pressure only a cooperating deployment should absorb.
const EVICT = argv.includes('--evict');
const EVICT_MAX = Number(opt('evict-max', 512));
// Every human line routes through here: with --json - the report owns
// stdout, so the header, the check lines, and the footer move to stderr.
const human = (line) => (JSON_OUT === '-' ? console.error(line) : console.log(line));

// ---- tiny ULID (id uniqueness; ULID is RECOMMENDED, not required — AEP-0001 §5.1) --
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(t = Date.now()) {
  let s = '';
  for (let i = 9; i >= 0; i--) s += B32[Math.floor(t / 32 ** i) % 32];
  for (let i = 0; i < 16; i++) s += B32[crypto.randomInt(32)];
  return s;
}

// ---- HTTP helpers -----------------------------------------------------------
function request(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const req = mod.request(u, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT, () => req.destroy(new Error('request timeout')));
    if (body !== null) req.write(body);
    req.end();
  });
}

// Collect SSE messages from `url` until `done(events, comments)` is true or the
// stream ends / times out. Returns { events, comments, ids, ended }.
function sseCollect(url, done, timeoutMs = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { accept: 'text/event-stream' };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const out = { events: [], comments: [], ids: [], ended: false };
    let buf = '';
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(tm); req.destroy(); resolve(out); } };
    const req = mod.get(u, { headers }, (res) => {
      if (res.statusCode !== 200) { settled = true; clearTimeout(tm); reject(new Error(`SSE HTTP ${res.statusCode}`)); return; }
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const msg = buf.slice(0, i); buf = buf.slice(i + 2);
          let dataLine = null, idLine = null;
          for (const line of msg.split('\n')) {
            if (line.startsWith(':')) out.comments.push(line.slice(1).trim());
            else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
            else if (line.startsWith('id:')) idLine = line.slice(3).trim();
          }
          if (dataLine) {
            try { out.events.push(JSON.parse(dataLine)); } catch { /* non-JSON data is a failure surfaced by the caller's assertions */ }
            out.ids.push(idLine);
          }
        }
        if (done(out.events, out.comments)) finish();
      });
      res.on('end', () => { out.ended = true; finish(); });
    });
    req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(tm); reject(e); } });
    const tm = setTimeout(finish, timeoutMs);
  });
}

const wsUrl = (base, path) => {
  const u = new URL(path, base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // Browser-API WebSocket cannot set headers; the query-token fallback is the
  // sanctioned carrier for header-less clients (AEP-0003 §8.1).
  if (TOKEN) u.searchParams.set('access_token', TOKEN);
  return u.toString();
};

// One WS exchange: open, send `frames` in order, collect incoming JSON frames
// until `done(frames)` or close/timeout. Resolves { got, raw, closed } — raw
// holds each frame's text verbatim, index-aligned with got (the eviction
// checks audit delivered bytes, not parsed shapes).
function wsExchange(url, frames, done, timeoutMs = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got = [];
    const raw = [];
    let settled = false;
    const finish = (closed) => { if (!settled) { settled = true; clearTimeout(tm); try { ws.close(); } catch {} resolve({ got, raw, closed }); } };
    ws.onopen = () => { for (const f of frames) ws.send(JSON.stringify(f)); };
    ws.onmessage = (m) => {
      raw.push(String(m.data));
      try { got.push(JSON.parse(m.data)); } catch { got.push({ __nonjson: String(m.data).slice(0, 80) }); }
      if (done(got)) finish(false);
    };
    ws.onclose = () => finish(true);
    ws.onerror = () => { if (!settled && got.length === 0) { settled = true; clearTimeout(tm); reject(new Error('websocket error before any frame')); } else finish(true); };
    const tm = setTimeout(() => finish(false), timeoutMs);
  });
}

// ---- envelope check, derived from AEP-0001 §5.1/§5.2 -------------------------
const SEVERITIES = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
const CAPTURES = ['none', 'metadata', 'redacted', 'full'];
function envelopeErrors(ev) {
  const errs = [];
  const str = (k) => typeof ev[k] === 'string' && ev[k].length > 0;
  for (const k of ['aep', 'id', 'type', 'time', 'source', 'agent']) {
    if (!str(k)) errs.push(`required attribute ${k} missing or not a nonempty string (§5.1)`);
  }
  if (str('type') && !/^[a-z0-9_.-]+\.[a-z0-9_.-]+$/.test(ev.type)) errs.push(`type ${JSON.stringify(ev.type)} is not a dotted lowercase name (§6)`);
  if (str('time') && Number.isNaN(Date.parse(ev.time))) errs.push('time is not a parseable RFC 3339 timestamp (§5.1)');
  for (const [k, v] of Object.entries(ev)) if (v === null) errs.push(`attribute ${k} is null — absent optionals are omitted, never null (§5.1)`);
  if (ev.severity !== undefined && !SEVERITIES.includes(ev.severity)) errs.push('severity outside the six-level enum (§8.1)');
  if (ev.capture !== undefined && !CAPTURES.includes(ev.capture)) errs.push('capture outside the four-level enum (§8.2)');
  const cat = str('type') ? ev.type.split('.')[0] : '';
  // Only imperative COMMANDS omit seq (AEP-0004 §2.2); the resulting acks
  // (control.accepted / control.rejected) are ordinary sequenced session
  // Events emitted by the target — the golden corpus pins both shapes.
  const isCommand = str('type')
    && /^(control\.(attention\.respond|cancel|pause|resume)|x\.[a-z0-9_-]+\.control\..+)$/.test(ev.type);
  if (cat === 'agent') {
    for (const k of ['session', 'run', 'step', 'seq']) if (ev[k] !== undefined) errs.push(`agent-scoped event carries ${k} (§5.2)`);
  } else if (isCommand) {
    if (typeof ev.session !== 'string') errs.push('command missing session (§5.2, AEP-0004 §2.2)');
    if (ev.seq !== undefined) errs.push('command carries seq — the sender does not own the target session\'s order (AEP-0004 §2.2)');
  } else if (cat && cat !== 'x') {
    if (typeof ev.session !== 'string') errs.push('session-scoped event missing session (§5.2)');
    if (!Number.isInteger(ev.seq) || ev.seq < 0) errs.push('session-scoped event missing integer seq >= 0 (§5.2)');
  }
  if (ev.epoch !== undefined && (!Number.isInteger(ev.epoch) || ev.epoch < 0)) errs.push('epoch is not an integer >= 0 (§5.1)');
  return errs;
}
const pos = (ev) => (ev.epoch ?? 0) * 2 ** 40 + ev.seq;

// ---- synthetic events ---------------------------------------------------------
function mkEvent(type, session, seq, data, extra = {}) {
  return {
    aep: '0.1', id: ulid(), type, time: new Date().toISOString(),
    source: `aep://live-check/agent/aep-live-check/session/${session}`,
    agent: 'aep-live-check', session, seq, epoch: 0, ...extra,
    ...(data ? { data } : {}),
  };
}
const postHeaders = (ct) => ({ 'content-type': ct, 'aep-version': '0.1' });

// ---- control-check helpers (AEP-0004) -------------------------------------------
// A command is a session-scoped foreign-emitter event: it MUST omit seq (§2.2).
function mkCommand(type, session, data, extra = {}) {
  return {
    aep: '0.1', id: ulid(), type, time: new Date().toISOString(),
    source: 'aep://live-check/agent/aep-live-check',
    agent: 'aep-live-check', session, capture: 'metadata', ...extra,
    ...(data ? { data } : {}),
  };
}

async function socketPath() {
  if (!discovery) {
    try { discovery = JSON.parse((await request('GET', new URL('/events', BASE))).body); } catch { /* handled below */ }
  }
  return discovery?.endpoints?.socket ?? null;
}

// Commands flow only on authenticated duplex bindings (§4.1): a persistent
// sender socket that also collects error frames (the relay's on-behalf nack
// arrives here, §4.2) and answers pings. Every settle path is guarded (matching
// the readers above) so a late close after the hello never re-settles.
function openSenderOnce(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const errors = [];
    const tm = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error('sender hello timeout'));
    }, TIMEOUT);
    const failPreHello = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(tm);
      reject(new Error(msg));
    };
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'hello', versions: ['0.1'], role: 'consumer',
      identity: { agent: 'aep-live-check', instance: 'live-check' },
      capabilities: {},
    }));
    ws.onerror = () => failPreHello('sender socket error before hello');
    ws.onclose = () => failPreHello('sender socket closed before hello');
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'hello') {
        if (settled) return;
        settled = true;
        clearTimeout(tm);
        resolve({
          send: (obj) => ws.send(JSON.stringify(obj)),
          errors,
          close: () => { try { ws.close(); } catch { /* already closed */ } },
        });
        return;
      }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
      if (msg.type === 'error') errors.push(msg);
    };
  });
}

// Establishing the duplex is a PRECONDITION of the control checks, not a
// measured conformance property, so a transient pre-hello blip (a reset or a
// slow accept under load — never a conformance signal) is retried a bounded
// number of times rather than failing an otherwise-passing check. A genuine
// refusal simply exhausts the attempts fast and rejects, so no verdict is
// masked; it only removes the contention-only "sender socket error before
// hello" flake.
async function openSender(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try { return await openSenderOnce(url); }
    catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw lastErr;
}

// Subscribe to the target session's stream, run `act`, and collect everything
// that arrives for the WHOLE window — exactly-one assertions need the full
// window, not the first match.
async function observeWindow(session, act, windowMs = ACK_WINDOW + 1000) {
  const u = new URL('/stream', BASE);
  u.searchParams.set('filter', JSON.stringify({ session }));
  const collected = sseCollect(u, () => false, windowMs);
  await new Promise((r) => setTimeout(r, 150)); // subscriber attached first
  await act();
  return (await collected).events;
}

const acksFor = (events, cmdId) =>
  events.filter((e) => (e.type === 'control.accepted' || e.type === 'control.rejected') && e.cause === cmdId);
// One ack DECISION per deduplicated command (AEP-0004 §3): redelivery of the
// SAME ack Event (the byte-identical re-ack a retransmit elicits) is one
// decision; the same (source, id) carrying different content is a collision
// and counts as distinct — a fault either way.
const distinctAcks = (acks) => {
  const seen = new Map(); // `${source}\0${id}` -> { ev, canon }
  for (const a of acks) {
    const k = `${a.source}\0${a.id}`;
    const c = JSON.stringify(a);
    if (!seen.has(k)) seen.set(k, { ev: a, c });
    else if (seen.get(k).c !== c) seen.set(`${k}\0#${seen.size}`, { ev: a, c });
  }
  return [...seen.values()].map((v) => v.ev);
};
const ackSummary = (acks) =>
  acks.map((a) => `${a.type}${a.data?.reason ? `(${a.data.reason})` : ''}`).join(', ') || 'none';

// ---- the eviction scenario (AEP-0003 §5/§3.3.3/§10) --------------------------
// The two evict-* checks share ONE flood. It is expensive and stateful, so it
// runs lazily exactly once: the first evict check to execute performs it, the
// second reads the cache (a --checks selection naming only one still gets it).
// Raw strings are kept end to end — the posted line, the SSE data payload,
// the WS frame text — because §10 is a statement about bytes, not shapes.
let evictFlood = null;

// Each evict check evaluates its own skip here: the flood is opt-in
// (--evict), needs an advertised positive capabilities.replay.buffer to size
// itself, and refuses buffers past --evict-max. Returns the buffer, or null
// after recording the SKIP.
async function evictPrecondition(name) {
  if (!EVICT) {
    record(name, null, 'skipped: opt-in — pass --evict to flood a session past the advertised replay buffer');
    return null;
  }
  if (!discovery) {
    try { discovery = JSON.parse((await request('GET', new URL('/events', BASE))).body); } catch { /* fall through */ }
  }
  const buffer = discovery?.capabilities?.replay?.buffer;
  if (typeof buffer !== 'number' || !Number.isFinite(buffer) || buffer <= 0) {
    record(name, null, 'skipped: no capabilities.replay.buffer advertised');
    return null;
  }
  if (buffer > EVICT_MAX) {
    record(name, null, `skipped: advertised replay buffer ${buffer} exceeds --evict-max ${EVICT_MAX} — run the target with a small replay buffer for this check`);
    return null;
  }
  return buffer;
}

async function runEvictFlood(buffer) {
  // 1. The flood: buffer + 8 minimal envelopes — progress.status, no data,
  //    no redactable fields, epoch 1 — each serialized ONCE checker-side;
  //    those exact line strings are the byte-identity baseline (§10).
  const session = `live-evict-${ulid().toLowerCase()}`;
  const total = buffer + 8;
  const posted = [];
  const lines = [];
  for (let seq = 0; seq < total; seq += 1) {
    const ev = mkEvent('progress.status', session, seq, null, { epoch: 1 });
    posted.push(ev);
    lines.push(JSON.stringify(ev));
  }
  for (let i = 0; i < lines.length; i += 500) {
    const r = await request('POST', new URL('/events', BASE),
      { headers: postHeaders('application/x-ndjson'), body: lines.slice(i, i + 500).join('\n') + '\n' });
    if (r.status !== 202 && r.status !== 200) throw new Error(`flood ingest failed: HTTP ${r.status}`);
  }
  const requested = { epoch: 1, seq: 0 };

  // 2. SSE single-pass replay (§5 live=0: the stream ends after the replay,
  //    so the whole body arrives in one read — no marker means no hang), raw
  //    data payloads and the replay-exhausted comment kept in arrival order.
  const u = new URL('/stream', BASE);
  u.searchParams.set('live', '0');
  u.searchParams.set('from', JSON.stringify([{ session, ...requested }]));
  const sseRes = await request('GET', u);
  if (sseRes.status !== 200) throw new Error(`replay stream answered HTTP ${sseRes.status}`);
  const sse = { data: [], marker: null, markerBeforeData: false };
  for (const line of sseRes.body.split('\n')) {
    if (line.startsWith(':')) {
      const m = /^:\s*replay-exhausted\s+(\S+)\s+(\d+):(\d+)/.exec(line);
      if (m && !sse.marker) {
        sse.marker = { session: m[1], epoch: Number(m[2]), seq: Number(m[3]) };
        sse.markerBeforeData = sse.data.length === 0;
      }
    } else if (line.startsWith('data:')) {
      const payload = line.slice(5);
      sse.data.push(payload.startsWith(' ') ? payload.slice(1) : payload);
    }
  }

  // 3. WS replay from the same position, raw frame text retained. Frames
  //    parsing to objects with an `aep` key are events; everything else
  //    (subscribed / replay-exhausted / ...) is a control frame. Collection
  //    ends when the last posted seq is observed — never on the marker,
  //    which a defective endpoint may withhold — or on the timeout.
  const sock = await socketPath();
  if (!sock) throw new Error('no socket endpoint advertised — the eviction comparison needs both bindings');
  const subId = `sub-evict-${ulid()}`;
  const { got, raw } = await wsExchange(wsUrl(BASE, sock), [
    { type: 'hello', versions: ['0.1'], role: 'consumer',
      identity: { agent: 'aep-live-check', instance: 'live-check' }, capabilities: {} },
    { type: 'subscribe', id: subId, filter: { session }, from: [{ session, ...requested }] },
  ], (g) => g.some((f) => f && typeof f === 'object' && 'aep' in f && f.session === session && f.seq === total - 1));
  const ws = { subId, events: [], marker: null, markerBeforeEvents: false, unparseable: [] };
  for (let i = 0; i < got.length; i += 1) {
    const f = got[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    if ('__nonjson' in f) { ws.unparseable.push(raw[i]); continue; }
    if ('aep' in f) { ws.events.push({ ev: f, raw: raw[i] }); continue; }
    if (f.type === 'replay-exhausted' && !ws.marker) {
      ws.marker = f;
      ws.markerBeforeEvents = ws.events.length === 0;
    }
  }
  return { session, total, requested, posted, lines, sse, ws };
}

// ---- the checks ---------------------------------------------------------------
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  human(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

let discovery = null;
let fanout = null; // { session, evs } shared from ingest-fanout to resume

const CHECKS = {
  // AEP-0003 §3.4 — discovery document at GET {base}/events.
  async discovery() {
    const r = await request('GET', new URL('/events', BASE));
    if (r.status !== 200) return record('discovery', false, `GET /events -> HTTP ${r.status}`);
    let doc;
    try { doc = JSON.parse(r.body); } catch { return record('discovery', false, 'discovery body is not JSON'); }
    discovery = doc;
    const versions = doc.aep;
    const ok = Array.isArray(versions) && versions.includes('0.1')
      && doc.endpoints && typeof doc.endpoints.events === 'string' && typeof doc.endpoints.stream === 'string';
    const wellKnown = await request('GET', new URL('/.well-known/aep', BASE)).catch(() => ({ status: 0 }));
    record('discovery', ok, ok
      ? `aep ${JSON.stringify(versions)}; endpoints events+stream${doc.endpoints.socket ? '+socket' : ''}; /.well-known/aep ${wellKnown.status === 200 ? 'served' : 'not served (SHOULD, origin-root only)'}`
      : 'requires aep array including "0.1" and endpoints.events/.stream (§3.4)');
  },

  // AEP-0003 §3.2.2 — unsupported major version answered with 426 + versions.
  async 'version-gate'() {
    const ev = mkEvent('session.started', `live-${ulid()}`, 0, { client: { name: 'aep-live-check' } });
    const r = await request('POST', new URL('/events', BASE),
      { headers: { 'content-type': 'application/json', 'aep-version': '9.9' }, body: JSON.stringify(ev) });
    let versions = null;
    try { versions = JSON.parse(r.body).versions; } catch { /* asserted below */ }
    const ok = r.status === 426 && Array.isArray(versions);
    record('version-gate', ok, ok ? `426 + versions ${JSON.stringify(versions)}` : `expected 426 with a versions array (§3.2.2), got HTTP ${r.status} body ${r.body.slice(0, 80)}`);
  },

  // AEP-0003 §3.2.3 — envelope-invalid events rejected with 400.
  async 'reject-invalid'() {
    const bad = { aep: '0.1', type: 'session.started', time: new Date().toISOString(), source: 'aep://x', agent: 'aep-live-check', session: 's', seq: 0 }; // no id
    const r = await request('POST', new URL('/events', BASE), { headers: postHeaders('application/json'), body: JSON.stringify(bad) });
    let hasError = false;
    try { hasError = typeof JSON.parse(r.body).error === 'string'; } catch { /* asserted below */ }
    const ok = r.status === 400 && hasError;
    record('reject-invalid', ok, ok ? '400 + error body for a missing id' : `expected 400 with an error body (§3.2.3), got HTTP ${r.status}`);
  },

  // AEP-0003 §3.2/§3.3 + AEP-0001 §5/§7 — ndjson batch ingest fans out to a
  // filtered SSE subscriber, envelopes intact, (epoch, seq) ascending.
  async 'ingest-fanout'() {
    const session = `live-${ulid()}`;
    const evs = [
      mkEvent('session.started', session, 0, { client: { name: 'aep-live-check' } }),
      mkEvent('tool.completed', session, 1, { tool: { name: 'demo' }, status: 'success' }),
      mkEvent('session.ended', session, 2, { reason: 'normal' }),
    ];
    evs[1].cause = evs[0].id;
    const streamUrl = new URL('/stream', BASE);
    streamUrl.searchParams.set('filter', JSON.stringify({ session }));
    const collected = sseCollect(streamUrl, (events) => events.length >= 3);
    await new Promise((r) => setTimeout(r, 150)); // subscriber attached before ingest
    const post = await request('POST', new URL('/events', BASE),
      { headers: postHeaders('application/x-ndjson'), body: evs.map((e) => JSON.stringify(e)).join('\n') + '\n' });
    const { events } = await collected;
    if (post.status !== 202 && post.status !== 200) return record('ingest-fanout', false, `batch POST -> HTTP ${post.status}, expected 202 (§3.2.3)`);
    if (events.length < 3) return record('ingest-fanout', false, `subscriber received ${events.length}/3 events before timeout`);
    const envErrs = events.flatMap((e) => envelopeErrors(e).map((x) => `${e.type}: ${x}`));
    if (envErrs.length) return record('ingest-fanout', false, `delivered envelope violates AEP-0001 — ${envErrs[0]}`);
    const ordered = events.every((e, i) => i === 0 || pos(events[i - 1]) < pos(e));
    const sameIds = JSON.stringify(events.map((e) => e.id)) === JSON.stringify(evs.map((e) => e.id));
    record('ingest-fanout', ordered && sameIds,
      ordered && sameIds ? `3/3 delivered in (epoch, seq) order, envelopes intact` : `order/id mismatch (§7): got ${events.map((e) => e.seq).join(',')}`);
    fanout = { session, evs };
  },

  // AEP-0003 §3.3.3/§7 — resume via `from` delivers strictly-after, no dupes.
  async resume() {
    if (!fanout) return record('resume', null, 'skipped: ingest-fanout did not run');
    const { session, evs } = fanout;
    const u = new URL('/stream', BASE);
    u.searchParams.set('filter', JSON.stringify({ session }));
    u.searchParams.set('from', JSON.stringify([{ session, epoch: 0, seq: 0 }]));
    // Expect exactly seq 1 and 2; wait a grace period after the second for dupes.
    // Replay is immediate on connect; a short window catches duplicate delivery.
    const { events } = await sseCollect(u, (got) => got.length > 2, 1500);
    const ids = events.map((e) => e.id);
    const expect = [evs[1].id, evs[2].id];
    const ok = JSON.stringify(ids) === JSON.stringify(expect);
    record('resume', ok, ok ? 'from(seq 0) replayed exactly seq 1..2, no duplicates'
      : `expected exactly the two events after seq 0 (§3.3.3, §7), got seqs [${events.map((e) => e.seq).join(',')}]`);
  },

  // AEP-0003 §6.4 + AEP-0001 §8.2 — the subscription capture ceiling is enforced:
  // a redacted-gated payload field must not reach a metadata-ceiling subscriber.
  async 'capture-downlevel'() {
    const session = `live-${ulid()}`;
    const ev = mkEvent('run.started', session, 0, { trigger: 'user', prompt: 'LIVE-CHECK-CANARY do not deliver at metadata' }, { capture: 'redacted', run: 'r1' });
    const u = new URL('/stream', BASE);
    u.searchParams.set('filter', JSON.stringify({ session }));
    u.searchParams.set('capture', 'metadata');
    const collected = sseCollect(u, (events) => events.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    await request('POST', new URL('/events', BASE), { headers: postHeaders('application/json'), body: JSON.stringify(ev) });
    const { events } = await collected;
    if (events.length < 1) return record('capture-downlevel', false, 'subscriber received nothing before timeout');
    const got = events[0];
    const leaked = JSON.stringify(got).includes('LIVE-CHECK-CANARY');
    const ok = !leaked && got.capture === 'metadata' && (got.data === undefined || got.data.prompt === undefined) && got.data?.trigger === 'user';
    record('capture-downlevel', ok, ok ? 'redacted-gated field dropped, capture rewritten to metadata, metadata field kept'
      : leaked ? 'FREE TEXT LEAKED past a metadata ceiling (§6.4 / AEP-0001 §8.2)' : `capture=${got.capture}, data=${JSON.stringify(got.data ?? {}).slice(0, 80)}`);
  },

  // AEP-0003 §3.5.1/§4.1 — hello is first, version intersection is honored.
  async 'hello-ws'() {
    const socketPath = discovery?.endpoints?.socket;
    if (!socketPath) return record('hello-ws', null, 'skipped: no socket endpoint advertised (§3.4 makes it optional)');
    const url = wsUrl(BASE, socketPath);
    const first = await wsExchange(url, [mkEvent('session.started', `live-${ulid()}`, 0, null)],
      (got) => got.some((f) => f.type === 'error'));
    const helloReq = first.got.find((f) => f.type === 'error');
    const a = Boolean(helloReq) && /hello/i.test(helloReq.code ?? '');
    const second = await wsExchange(url, [{ type: 'hello', versions: ['9.9'], role: 'consumer' }],
      (got) => got.some((f) => f.type === 'error'));
    const verErr = second.got.find((f) => f.type === 'error');
    const b = Boolean(verErr) && /version/i.test(verErr.code ?? '') && Array.isArray(verErr.versions);
    const third = await wsExchange(url, [{ type: 'hello', versions: ['0.1'], role: 'consumer' }],
      (got) => got.some((f) => f.type === 'hello'));
    const hello = third.got.find((f) => f.type === 'hello');
    const c = Boolean(hello) && Array.isArray(hello.versions) && hello.versions.length === 1 && hello.versions[0] === '0.1';
    record('hello-ws', a && b && c, a && b && c ? 'hello-required enforced; version intersection + single-version reply honored'
      : `hello-required ${a ? 'ok' : 'MISSING (§3.5.1)'}; version nack ${b ? 'ok' : 'MISSING (§4.1)'}; hello reply ${c ? 'ok' : 'not a single-version selection (§4.1)'}`);
  },

  // AEP-0003 §6.5 — the subscribe-error code set is CLOSED (invalid-filter |
  // unknown-dialect | unauthorized | limit-exceeded) and rejection is
  // per-request, in-band: the offending subscribe is answered with an error
  // frame and the connection survives. Limits themselves are the endpoint's
  // own (an endpoint with no from-count limit legally answers `subscribed`),
  // so the probe asserts the VOCABULARY and the survival posture, not a
  // particular limit: (a) an absurd `from` (1024 positions) must be answered
  // in-band from the closed set; (b) a malformed `from` (not an array) must
  // be rejected — fail closed, never guessed; after each, a plain follow-up
  // subscribe on the SAME connection must still be honored.
  async 'subscribe-limits'() {
    const sock = await socketPath();
    if (!sock) return record('subscribe-limits', null, 'skipped: no socket endpoint advertised (§3.4 makes it optional)');
    const url = wsUrl(BASE, sock);
    const CODES = ['invalid-filter', 'unknown-dialect', 'unauthorized', 'limit-exceeded'];
    const hello = {
      type: 'hello', versions: ['0.1'], role: 'consumer',
      identity: { agent: 'aep-live-check', instance: 'live-check' }, capabilities: {},
    };
    // frames are processed in receipt order on a duplex — pipelining after the
    // client hello is sound (the hello-ws exchanges batch the same way)
    const probe = async (label, fromValue) => {
      const subId = `sub-${label}`, followId = `sub-${label}-follow`;
      const { got, closed } = await wsExchange(url, [
        hello,
        { type: 'subscribe', id: subId, filter: { type: ['agent.*'] }, from: fromValue },
        { type: 'subscribe', id: followId, filter: { type: ['agent.*'] } },
      ], (g) => g.some((f) => (f.type === 'subscribed' || f.type === 'error') && f.id === followId));
      const reply = got.find((f) => (f.type === 'subscribed' || f.type === 'error') && f.id === subId);
      const follow = got.find((f) => f.type === 'subscribed' && f.id === followId);
      return { reply, follow, closed };
    };
    const big = Array.from({ length: 1024 }, (_, i) => ({ session: `live-sub-cap-${ulid()}-${i}`, epoch: 0, seq: 0 }));
    const cap = await probe('cap', big);
    const capOk = Boolean(cap.reply)
      && (cap.reply.type === 'subscribed' || CODES.includes(cap.reply.code))
      && Boolean(cap.follow);
    const mal = await probe('malformed', {});
    const malOk = Boolean(mal.reply) && mal.reply.type === 'error'
      && CODES.includes(mal.reply.code) && Boolean(mal.follow);
    const ok = capOk && malOk;
    const describe = (r) => !r.reply
      ? (r.closed ? 'NO in-band reply — connection dropped (§6.5: rejection is per-request)' : 'no reply within the window')
      : r.reply.type === 'subscribed' ? 'subscribed'
        : `error ${r.reply.code}${CODES.includes(r.reply.code) ? '' : ' (OUTSIDE the closed §6.5 set)'}`;
    record('subscribe-limits', ok, ok
      ? `1024-position from ${cap.reply.type === 'subscribed' ? 'accepted (no endpoint limit — legal)' : `refused in-band (${cap.reply.code})`}; malformed from rejected in-band (${mal.reply.code}); connection survived both`
      : !capOk ? `over-size from probe: ${describe(cap)}${cap.reply && !cap.follow ? '; follow-up subscribe unanswered (connection disturbed)' : ''}`
        : `malformed from probe: ${describe(mal)}${mal.reply && mal.reply.type === 'subscribed' ? ' — a malformed member was GUESSED past (§6.5: fail closed)' : ''}${mal.reply && !mal.follow ? '; follow-up subscribe unanswered' : ''}`);
  },

  // AEP-0003 §2 — unknown frame types MUST be ignored (forward compatibility),
  // and §4 rule 4 — unknown capability keys MUST be ignored (capabilities are
  // a discovery surface, never a validation gate). The probe pipelines a hello
  // whose capabilities carry an unknown key, then an unknown frame type, then
  // a plain subscribe: the hello must be answered normally and the subscribe
  // must be honored on the SAME connection — proof the unknowns neither closed
  // the socket nor poisoned the exchange.
  async 'ignore-unknown'() {
    const sock = await socketPath();
    if (!sock) return record('ignore-unknown', null, 'skipped: no socket endpoint advertised (§3.4 makes it optional)');
    const url = wsUrl(BASE, sock);
    const subId = `sub-ignore-${ulid()}`;
    const { got, closed } = await wsExchange(url, [
      { type: 'hello', versions: ['0.1'], role: 'consumer',
        identity: { agent: 'aep-live-check', instance: 'live-check' },
        capabilities: { futurecap: { enabled: true } } },
      { type: 'zigzag', note: 'unknown frame type — MUST be ignored (§2)' },
      { type: 'subscribe', id: subId, filter: { type: ['agent.*'] } },
    ], (g) => g.some((f) => (f.type === 'subscribed' || f.type === 'error') && f.id === subId));
    const hello = got.find((f) => f.type === 'hello');
    const sub = got.find((f) => f.type === 'subscribed' && f.id === subId);
    const ok = Boolean(hello) && Boolean(sub);
    record('ignore-unknown', ok, ok
      ? 'unknown capability key and unknown frame type both ignored; subscribe honored on the same connection'
      : !hello ? `hello carrying an unknown capability key ${closed ? 'closed the connection' : 'went unanswered'} (§4 rule 4: capabilities are never a validation gate)`
        : `subscribe after an unknown frame ${closed ? 'found the connection closed' : 'went unanswered'} (§2: unknown frame types MUST be ignored)`);
  },

  // AEP-0003 §5 — replay-all: `from=all` replays every held session from its
  // earliest held position, with NO replay-exhausted marker (the ask IS
  // earliest-held). Skipped unless the endpoint advertises replay.all —
  // unlike the roster frame the refusal is deterministic (the closed
  // malformed-from classes), so advertisement is a planning fact; an
  // endpoint that ADVERTISES the value and then refuses it is the failure.
  async 'replay-all'() {
    if (!discovery) {
      try { discovery = JSON.parse((await request('GET', new URL('/events', BASE))).body); } catch { /* fall through */ }
    }
    if (!discovery?.capabilities?.replay?.all) {
      return record('replay-all', null, 'skipped: endpoint does not advertise replay.all (§5 — optional surface; refusal of the value is deterministic regardless)');
    }
    const s1 = `live-ra1-${ulid().toLowerCase()}`;
    const s2 = `live-ra2-${ulid().toLowerCase()}`;
    const evs = [
      mkEvent('session.started', s1, 0, { client: { name: 'aep-live-check' } }),
      mkEvent('tool.completed', s1, 1, { tool: { name: 'demo' }, status: 'success' }),
      mkEvent('session.started', s2, 0, { client: { name: 'aep-live-check' } }),
    ];
    const post = await request('POST', new URL('/events', BASE),
      { headers: postHeaders('application/x-ndjson'), body: evs.map((e) => JSON.stringify(e)).join('\n') + '\n' });
    if (post.status !== 202 && post.status !== 200) {
      return record('replay-all', false, `ingest for the probe failed: HTTP ${post.status}`);
    }
    const u = new URL('/stream', BASE);
    u.searchParams.set('live', '0');
    u.searchParams.set('from', 'all');
    const r = await request('GET', u);
    if (r.status !== 200) {
      return record('replay-all', false, `from=all answered HTTP ${r.status} despite the endpoint advertising replay.all (§5)`);
    }
    const got = [...r.body.matchAll(/^data: (.+)$/gm)]
      .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter(Boolean);
    const seqs = (s) => got.filter((e) => e.session === s).map((e) => e.seq).join(',');
    const s1ok = seqs(s1) === '0,1';
    const s2ok = seqs(s2) === '0';
    const exhausted = /replay-exhausted/.test(r.body);
    const ok = s1ok && s2ok && !exhausted;
    record('replay-all', ok, ok
      ? 'every held probe session replayed from its earliest position under from=all, no replay-exhausted'
      : (!s1ok || !s2ok) ? `probe sessions incomplete under from=all (want ${s1}=0,1 and ${s2}=0; got ${seqs(s1) || 'none'} / ${seqs(s2) || 'none'})`
        : 'a replay-exhausted marker fired under from=all (§5: the ask is earliest-held — nothing was missed)');
  },

  // AEP-0003 §5/§3.3.3 — eviction declares its gap: a replay asked from a
  // position predating the earliest held event draws the replay-exhausted
  // marker on BOTH bindings (the SSE comment line; the WS frame echoing the
  // subscribe id) BEFORE any replayed event, the two earliest positions
  // agree and exceed the requested one, and delivery runs the marked
  // earliest through the last posted seq, strictly ascending. The eviction
  // depth is implementation-defined, so the assertion is coherence with the
  // marker, never a particular number. Opt-in — see --evict in the header.
  async 'evict-replay-exhausted'() {
    const buffer = await evictPrecondition('evict-replay-exhausted');
    if (buffer === null) return;
    if (!evictFlood) evictFlood = runEvictFlood(buffer);
    const s = await evictFlood;
    const p = (x) => x.epoch * 2 ** 40 + x.seq;
    const faults = [];
    if (!s.sse.marker) faults.push(`SSE replay from the predating position carried no replay-exhausted comment before its ${s.sse.data.length} delivered event(s)`);
    else if (s.sse.marker.session !== s.session) faults.push(`the SSE replay-exhausted comment names session ${s.sse.marker.session}, not the flooded one`);
    else if (!s.sse.markerBeforeData) faults.push('the SSE replay-exhausted comment arrived after replayed data (the marker precedes delivery)');
    if (!s.ws.marker) faults.push(`WS replay from the predating position carried no replay-exhausted frame before its ${s.ws.events.length} delivered event(s)`);
    else {
      if (!s.ws.markerBeforeEvents) faults.push('the WS replay-exhausted frame arrived after replayed events (the marker precedes delivery)');
      if (s.ws.marker.sub !== s.ws.subId) faults.push(`the WS replay-exhausted frame's sub ${JSON.stringify(s.ws.marker.sub)} does not echo the subscribe id`);
      if (s.ws.marker.session !== s.session) faults.push(`the WS replay-exhausted frame names session ${JSON.stringify(s.ws.marker.session)}, not the flooded one`);
      const e = s.ws.marker.earliest;
      if (!e || !Number.isInteger(e.epoch) || !Number.isInteger(e.seq)) faults.push('the WS replay-exhausted frame carries no earliest {epoch, seq}');
    }
    const sseE = s.sse.marker;
    const wsE = s.ws.marker?.earliest;
    if (faults.length === 0) {
      if (sseE.epoch !== wsE.epoch || sseE.seq !== wsE.seq) {
        faults.push(`the bindings disagree on earliest: SSE ${sseE.epoch}:${sseE.seq}, WS ${wsE.epoch}:${wsE.seq}`);
      } else if (p(sseE) <= p(s.requested)) {
        faults.push(`earliest ${sseE.epoch}:${sseE.seq} does not exceed the requested ${s.requested.epoch}:${s.requested.seq} — an exhausted replay starts past the ask`);
      }
    }
    const last = s.total - 1;
    const coherence = (evs, earliest, label) => {
      if (evs.some((e) => !e || typeof e !== 'object')) return `${label} delivered an unparseable payload — its positions cannot be audited`;
      if (evs.length === 0) return `${label} delivered nothing after the marker`;
      if ((evs[0].epoch ?? 0) !== earliest.epoch || evs[0].seq !== earliest.seq) return `${label} delivery starts at ${evs[0].epoch ?? 0}:${evs[0].seq}, not the marked earliest ${earliest.epoch}:${earliest.seq}`;
      for (let i = 1; i < evs.length; i += 1) {
        if (pos(evs[i]) <= pos(evs[i - 1])) return `${label} delivery is not strictly ascending at ${evs[i].epoch ?? 0}:${evs[i].seq}`;
      }
      const end = evs[evs.length - 1];
      if ((end.epoch ?? 0) !== 1 || end.seq !== last) return `${label} delivery ends at ${end.epoch ?? 0}:${end.seq}, not the last posted 1:${last}`;
      return null;
    };
    if (sseE) {
      const sseEvs = s.sse.data.map((d) => { try { return JSON.parse(d); } catch { return null; } });
      const f = coherence(sseEvs, sseE, 'SSE');
      if (f) faults.push(f);
    }
    if (wsE && Number.isInteger(wsE.epoch) && Number.isInteger(wsE.seq)) {
      const f = coherence(s.ws.events.map((x) => x.ev), wsE, 'WS');
      if (f) faults.push(f);
    }
    const ok = faults.length === 0;
    record('evict-replay-exhausted', ok, ok
      ? `replay-exhausted before delivery on both bindings, earliest ${sseE.epoch}:${sseE.seq} agreed and past the requested ${s.requested.epoch}:${s.requested.seq}; both replays ran the marked earliest through the last posted seq ${last}, strictly ascending`
      : `${faults[0]} (§5/§3.3.3)`);
  },

  // AEP-0003 §10 — the envelope over the wire is the envelope that was
  // posted: after the same flood, every payload replayed over SSE and WS is
  // audited against the line this checker serialized. Strict grade: the raw
  // strings match byte-for-byte. Floor grade (AEP-0001 §4.2): a
  // value-preserving re-serialization — re-ordered keys, added extension
  // attributes — keeps the core envelope and data intact and still passes.
  // A wrapped or unparseable payload, a mutated core attribute or data, or
  // the two bindings disagreeing on the same (source, id) is the failure.
  async 'evict-byte-identity'() {
    const buffer = await evictPrecondition('evict-byte-identity');
    if (buffer === null) return;
    if (!evictFlood) evictFlood = runEvictFlood(buffer);
    const s = await evictFlood;
    // key-order-insensitive canonical form — §4.2 tolerates re-serialization
    const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
      : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
        : JSON.stringify(v);
    const CORE = ['aep', 'id', 'type', 'time', 'source', 'agent', 'session', 'seq', 'epoch'];
    const bySeq = new Map(s.posted.map((ev, i) => [ev.seq, { ev, line: s.lines[i] }]));
    const seen = new Map(); // `${source} ${id}` -> { c, binding }
    const faults = [];
    let strict = true;
    let audited = 0;
    const audit = (rawStr, binding) => {
      let ev;
      try { ev = JSON.parse(rawStr); } catch {
        faults.push(`${binding} delivered an unparseable payload: ${rawStr.slice(0, 60)}`); return;
      }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev) || !('aep' in ev)) {
        faults.push(`${binding} delivered a wrapped payload (no top-level aep key): ${rawStr.slice(0, 60)}`); return;
      }
      const base = bySeq.get(ev.seq);
      if (!base) { faults.push(`${binding} delivered seq ${ev.seq}, which this checker never posted`); return; }
      for (const k of CORE) {
        if (canon(ev[k]) !== canon(base.ev[k])) {
          faults.push(`${binding} delivery at seq ${ev.seq}: core context attribute ${k} was ${JSON.stringify(ev[k])}, posted ${JSON.stringify(base.ev[k])}`); return;
        }
      }
      if (canon(ev.data) !== canon(base.ev.data)) {
        faults.push(`${binding} delivery at seq ${ev.seq}: data differs from the posted object`); return;
      }
      if (rawStr !== base.line) strict = false;
      audited += 1;
      const key = `${ev.source} ${ev.id}`;
      const c = canon(ev);
      const prior = seen.get(key);
      if (!prior) seen.set(key, { c, binding });
      else if (prior.c !== c) faults.push(`the same (source, id) at seq ${ev.seq} came back as different objects (${prior.binding} vs ${binding})`);
    };
    for (const d of s.sse.data) audit(d, 'SSE');
    for (const e of s.ws.events) audit(e.raw, 'WS');
    for (const r of s.ws.unparseable) audit(r, 'WS');
    if (audited === 0 && faults.length === 0) faults.push('no replayed payloads arrived to audit');
    const ok = faults.length === 0;
    record('evict-byte-identity', ok, ok
      ? strict
        ? `byte-identical across POST body, SSE data, and WS frame (${seen.size} events)`
        : 'core envelope intact; not byte-identical (re-serialized or extension attributes added in flight)'
      : `${faults[0]} (§10; floor AEP-0001 §4.2)`);
  },

  // AEP-0003 §4.1 — the roster frame: a consumer's snapshot of the live
  // emitter claims this endpoint terminates. Skipped unless the endpoint
  // ADVERTISES capabilities.roster (rule 1) — the frame is opt-in surface,
  // and an undeclared endpoint ignoring the request (§2) proves nothing.
  // The probe: an emitter claims a session with a declared control block;
  // a consumer's request must be answered with the id echoed (rule 2) and
  // an entry relaying that claim's declarations VERBATIM (rule 4); an
  // emitter-role request must be refused in-band (`unauthorized`, same id)
  // with the connection surviving (rule 2, the §6.5 pattern).
  async 'roster'() {
    const sock = await socketPath();
    if (!sock) return record('roster', null, 'skipped: no socket endpoint advertised (§3.4 makes it optional)');
    if (!discovery?.capabilities?.roster || typeof discovery.capabilities.roster !== 'object') {
      return record('roster', null, 'skipped: endpoint does not advertise capabilities.roster (§4.1 rule 1 — the frame is opt-in surface)');
    }
    const url = wsUrl(BASE, sock);
    const session = `live-roster-${ulid().toLowerCase()}`;
    // the claimant: a persistent emitter with a declared control block
    let claimant;
    try {
      claimant = await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.onopen = () => ws.send(JSON.stringify({
          type: 'hello', versions: ['0.1'], role: 'emitter',
          identity: { agent: 'aep-live-check-roster', instance: 'live-check' },
          capabilities: { emits: ['session'], control: { accepts: ['control.attention.respond'], ack_window_ms: 10_000 } },
        }));
        ws.onerror = () => reject(new Error('claimant socket refused'));
        ws.onclose = () => reject(new Error('claimant socket closed before hello'));
        ws.onmessage = (m) => {
          let msg;
          try { msg = JSON.parse(m.data); } catch { return; }
          if (msg.type === 'hello') {
            ws.send(JSON.stringify(mkEvent('session.started', session, 0, { client: { name: 'aep-live-check' } })));
            resolve({ ws, close: () => { try { ws.close(); } catch { /* gone */ } } });
            return;
          }
          if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        };
        setTimeout(() => reject(new Error('claimant hello timeout')), TIMEOUT);
      });
    } catch (e) {
      return record('roster', null, `skipped: could not hold an emitter claim open (${e.message})`);
    }
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the claim land
      const reqId = `roster-${ulid()}`;
      const { got, closed } = await wsExchange(url, [
        { type: 'hello', versions: ['0.1'], role: 'consumer',
          identity: { agent: 'aep-live-check', instance: 'live-check' }, capabilities: {} },
        { type: 'roster', id: reqId },
      ], (g) => g.some((f) => f.type === 'roster' && f.id === reqId));
      const reply = got.find((f) => f.type === 'roster' && f.id === reqId);
      const entry = reply?.entries?.find?.((e) => e.session === session);
      const replyOk = Boolean(reply) && Array.isArray(reply.entries);
      const entryOk = Boolean(entry)
        && entry.agent === 'aep-live-check-roster'
        && entry.control && Array.isArray(entry.control.accepts)
        && entry.control.accepts.includes('control.attention.respond')
        && entry.control.ack_window_ms === 10_000;
      const denyId = `roster-deny-${ulid()}`;
      const deny = await wsExchange(url, [
        { type: 'hello', versions: ['0.1'], role: 'emitter',
          identity: { agent: 'aep-live-check-roster-b', instance: 'live-check' }, capabilities: {} },
        { type: 'roster', id: denyId },
      ], (g) => g.some((f) => f.type === 'error' && f.id === denyId));
      const denyReply = deny.got.find((f) => f.type === 'error' && f.id === denyId);
      const denyOk = Boolean(denyReply) && denyReply.code === 'unauthorized' && !deny.closed;
      const ok = replyOk && entryOk && denyOk;
      record('roster', ok, ok
        ? `advertised, answered with the id echoed, the claim's declarations relayed verbatim (accepts + ack_window_ms), emitter-role request refused in-band`
        : !replyOk ? `roster request ${closed ? 'closed the connection' : 'went unanswered'} despite the endpoint advertising capabilities.roster (§4.1 rule 1)`
          : !entryOk ? `the live claim's entry is missing or altered (want agent + verbatim declared control block, §4.1 rule 4): ${JSON.stringify(entry ?? reply?.entries?.slice?.(0, 2) ?? null)}`
            : `emitter-role request ${deny.closed ? 'closed the connection (§6.5: rejection is per-request)' : denyReply ? `answered ${denyReply.code} (want unauthorized)` : 'went unanswered (want an in-band unauthorized error frame)'}`);
    } finally { claimant.close(); }
  },

  // AEP-0004 §4.1 / AEP-0003 §8.1 — control flows only on AUTHENTICATED duplex
  // bindings, unconditionally (localhost included). Probeable only when this
  // run was given no --token yet the endpoint admits its duplex: a command
  // sent over that unauthenticated duplex must not reach any target — neither
  // delivered to a connected control-capable emitter nor answered by one (a
  // cause-linked ack on the stream is proof it flowed). An explicit refusal
  // toward the sender is the friendlier posture (§4.3's nack idiom) and is
  // reported; the hard assertion is that control did not flow.
  async 'control-auth-gate'() {
    if (TOKEN) return record('control-auth-gate', null, 'skipped: authenticated run — probe the unauthenticated posture by running without --token against a dev endpoint');
    const sock = await socketPath();
    if (!sock) return record('control-auth-gate', null, 'skipped: no socket endpoint advertised (§3.4 makes it optional)');
    const url = wsUrl(BASE, sock);
    const session = `live-auth-${ulid().toLowerCase()}`;
    // a would-be target: if the endpoint (wrongly) routes, delivery lands here
    let target;
    try {
      target = await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const seen = [];
        ws.onopen = () => ws.send(JSON.stringify({
          type: 'hello', versions: ['0.1'], role: 'emitter',
          identity: { agent: 'aep-live-check-target', instance: 'live-check' },
          capabilities: { control: { accepts: ['control.attention.respond'], ack_window_ms: 10_000 } },
        }));
        ws.onerror = () => reject(new Error('refused'));
        ws.onclose = () => reject(new Error('refused'));
        ws.onmessage = (m) => {
          let msg;
          try { msg = JSON.parse(m.data); } catch { return; }
          if (msg.type === 'hello') {
            ws.send(JSON.stringify(mkEvent('session.started', session, 0, { client: { name: 'aep-live-check' } })));
            resolve({ seen, close: () => { try { ws.close(); } catch { /* gone */ } } });
            return;
          }
          if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
          if (typeof msg.type === 'string' && msg.type.startsWith('control.')) seen.push(msg);
        };
        setTimeout(() => reject(new Error('refused')), TIMEOUT);
      });
    } catch {
      return record('control-auth-gate', true, 'endpoint admits no unauthenticated duplex at all — the gate holds at the connection');
    }
    const sender = await openSender(url).catch(() => null);
    if (!sender) {
      target.close();
      return record('control-auth-gate', true, 'sender duplex refused unauthenticated — the gate holds at the connection');
    }
    const cmd = mkCommand('control.attention.respond', session,
      { answer: { option: 'live-check-probe' } }, { subject: ulid() });
    const events = await observeWindow(session, async () => sender.send(cmd),
      Math.min(ACK_WINDOW, 2500));
    const delivered = target.seen.filter((c) => c.id === cmd.id);
    const answered = acksFor(events, cmd.id);
    const refusal = sender.errors.find((e) => e.cause === cmd.id);
    sender.close();
    target.close();
    const ok = delivered.length === 0 && answered.length === 0;
    record('control-auth-gate', ok, ok
      ? refusal
        ? `command refused toward the sender (${refusal.code}) and never flowed`
        : 'command did not flow (no explicit refusal observed — a stated unauthorized nack toward the sender is the friendlier posture)'
      : `a control command FLOWED over an unauthenticated duplex (AEP-0004 §4.1 / AEP-0003 §8.1): ${delivered.length ? 'delivered to a connected target' : `answered on the stream (${ackSummary(answered)})`}`);
  },

  // AEP-0004 §4.2/§4.5 + §8 — the relay-behalf refusal boundary, decided: a
  // relay refusing a command on a target's behalf answers the SENDER's
  // connection with a cause-correlated error frame that never enters the
  // addressed session's history (a refusal Event there would be authored
  // under an identity that is not the relay's own — AEP-0001 §5.2). Skipped
  // unless the endpoint advertises capabilities.control (the §4 routing
  // surface is opt-in) and the run is authenticated (§4.1 refuses control
  // before routing otherwise — control-auth-gate owns that posture). The
  // no-claimant refusal is deterministic (§4.5), so silence is a failure —
  // the replay-all emphasis, not the roster one.
  async 'control-behalf-refusal'() {
    if (!TOKEN) return record('control-behalf-refusal', null, 'skipped: unauthenticated run — §4.1 refuses control before routing; run with --token to probe the behalf-refusal boundary');
    const sock = await socketPath();
    if (!sock) return record('control-behalf-refusal', null, 'skipped: no socket endpoint advertised (§4.1 needs a duplex binding)');
    if (!discovery?.capabilities?.control || typeof discovery.capabilities.control !== 'object') {
      return record('control-behalf-refusal', null, 'skipped: endpoint does not advertise capabilities.control (the §4 routing surface is opt-in)');
    }
    const session = `live-behalf-${ulid().toLowerCase()}`;
    // Seed real history over HTTP: the session exists, no live claimant —
    // the no-route posture by construction, and the non-empty replay is the
    // non-vacuity anchor for the boundary assertion.
    const seeded = [
      mkEvent('session.started', session, 0, { client: { name: 'aep-live-check' } }),
      mkEvent('run.started', session, 1, { trigger: 'user' }, { run: 'r-behalf' }),
    ];
    for (const ev of seeded) {
      const r = await request('POST', new URL('/events', BASE), { headers: postHeaders('application/json'), body: JSON.stringify(ev) });
      if (r.status !== 202) return record('control-behalf-refusal', false, `could not seed history over HTTP (POST /events → ${r.status})`);
    }
    const sender = await openSender(wsUrl(BASE, sock));
    const cmd = mkCommand('control.pause', session, { reason: 'aep-live-check behalf-refusal probe' });
    sender.send(cmd);
    const refusal = await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        const hit = sender.errors.find((e) => e.cause === cmd.id);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > TIMEOUT) return resolve(null);
        setTimeout(poll, 50);
      };
      poll();
    });
    sender.close();
    const u = new URL('/stream', BASE);
    u.searchParams.set('filter', JSON.stringify({ session }));
    u.searchParams.set('from', JSON.stringify([{ session, epoch: 0, seq: 0 }]));
    const { events } = await sseCollect(u, (got) => got.length > 1, 1500);
    const replayOk = events.some((e) => e.id === seeded[1].id);
    const extras = events.filter((e) => e.id !== seeded[1].id);
    const ok = Boolean(refusal) && refusal.code === 'no-route' && replayOk && extras.length === 0;
    record('control-behalf-refusal', ok, ok
      ? 'refused toward the sender with a cause-correlated no-route frame; the addressed session replay is untouched (no command, no refusal Event)'
      : !refusal ? 'the command went unanswered despite the endpoint advertising capabilities.control (§4.5: the no-claimant refusal is deterministic)'
        : refusal.code !== 'no-route' ? `refusal code ${refusal.code} (want no-route — §4.5: no connected emitter owns the addressed session)`
          : !replayOk ? 'replay did not return the seeded history (cannot certify the boundary against an empty read)'
            : `the behalf-refusal leaked into the addressed session history (§4.2/§8: the frame is connection-scoped and never an Event) — extra event(s): ${extras.slice(0, 2).map((e) => `${e.type} agent=${e.agent}${e.cause ? ` cause=${e.cause}` : ''}`).join('; ')}`);
  },

  // ---- control-capable target (AEP-0004 §7) — opt-in, see the header -----------

  // §3: one ack decision per command, cause = command id, within the ack
  // window; §4.2: a DECLARED type is never nacked `unsupported`.
  async 'control-ack'() {
    if (!CONTROL_SESSION) return record('control-ack', null, 'skipped: no --control-session target');
    const sock = await socketPath();
    if (!sock) return record('control-ack', null, 'skipped: no socket endpoint advertised (§4.1 needs a duplex binding)');
    const sender = await openSender(wsUrl(BASE, sock));
    const cmd = mkCommand(CONTROL_ACCEPTS, CONTROL_SESSION,
      CONTROL_ACCEPTS === 'control.attention.respond'
        ? { answer: { option: 'live-check-probe' } } : {},
      CONTROL_ACCEPTS === 'control.attention.respond' ? { subject: ulid() } : {});
    const events = await observeWindow(CONTROL_SESSION, async () => sender.send(cmd));
    sender.close();
    const acks = acksFor(events, cmd.id);
    const distinct = distinctAcks(acks);
    const envErrs = acks.flatMap((a) => envelopeErrors(a));
    const ok = acks.length >= 1 && distinct.length === 1
      && (distinct[0].type === 'control.accepted' || distinct[0].data?.reason !== 'unsupported')
      && envErrs.length === 0;
    record('control-ack', ok, ok
      ? `declared ${CONTROL_ACCEPTS}: one cause-linked ${ackSummary(distinct)} within the window`
      : acks.length === 0 ? `no acknowledgement within ${ACK_WINDOW} ms (§3: silence reads as timeout sender-side)`
        : distinct.length > 1 ? `${distinct.length} distinct acknowledgements for one command (§3: one decision): ${ackSummary(distinct)}`
          : envErrs.length ? `ack envelope violates AEP-0001 — ${envErrs[0]}`
            : `declared type nacked unsupported (§4.2: accepts is authoritative): ${ackSummary(distinct)}`);
  },

  // §4.2: an UNDECLARED type is nacked `unsupported` — by the target on the
  // stream, or by a relay that knows the declaration, on the target's behalf
  // (surfaced to the sender as an error frame). Either satisfies the rule.
  async 'control-nack-unsupported'() {
    if (!CONTROL_SESSION) return record('control-nack-unsupported', null, 'skipped: no --control-session target');
    const sock = await socketPath();
    if (!sock) return record('control-nack-unsupported', null, 'skipped: no socket endpoint advertised (§4.1 needs a duplex binding)');
    const sender = await openSender(wsUrl(BASE, sock));
    const cmd = mkCommand(CONTROL_UNDECLARED, CONTROL_SESSION, {});
    const events = await observeWindow(CONTROL_SESSION, async () => sender.send(cmd));
    const targetNacks = events.filter((e) => e.type === 'control.rejected' && e.cause === cmd.id);
    const relayNacks = sender.errors.filter((e) => e.cause === cmd.id && /unsupported/i.test(e.code ?? ''));
    sender.close();
    const wrongAccept = events.some((e) => e.type === 'control.accepted' && e.cause === cmd.id);
    const ok = !wrongAccept
      && (targetNacks.some((e) => e.data?.reason === 'unsupported') || relayNacks.length > 0);
    record('control-nack-unsupported', ok, ok
      ? targetNacks.length > 0
        ? `undeclared ${CONTROL_UNDECLARED} nacked unsupported by the target`
        : `undeclared ${CONTROL_UNDECLARED} refused on the target's behalf by the relay (§4.2)`
      : wrongAccept ? `undeclared type was ACCEPTED (§4.2: accepts is authoritative)`
        : `no unsupported nack observed within ${ACK_WINDOW} ms (target nacks: ${ackSummary(targetNacks)}; relay error frames: ${sender.errors.length})`);
  },

  // §2.3/§3: the envelope id is the idempotency key — a retransmit is the
  // SAME command: one ack DECISION, never a re-execution. A target that still
  // remembers the command re-acks byte-identically, so several deliveries of
  // ONE ack are conformant; a second DISTINCT ack is the violation.
  async 'control-dedupe'() {
    if (!CONTROL_SESSION) return record('control-dedupe', null, 'skipped: no --control-session target');
    const sock = await socketPath();
    if (!sock) return record('control-dedupe', null, 'skipped: no socket endpoint advertised (§4.1 needs a duplex binding)');
    const sender = await openSender(wsUrl(BASE, sock));
    const cmd = mkCommand(CONTROL_ACCEPTS, CONTROL_SESSION,
      CONTROL_ACCEPTS === 'control.attention.respond'
        ? { answer: { option: 'live-check-probe' } } : {},
      CONTROL_ACCEPTS === 'control.attention.respond' ? { subject: ulid() } : {});
    const events = await observeWindow(CONTROL_SESSION, async () => {
      sender.send(cmd);
      await new Promise((r) => setTimeout(r, 120));
      sender.send(cmd); // same id: the same command (§2.3)
    });
    sender.close();
    const acks = acksFor(events, cmd.id);
    const distinct = distinctAcks(acks);
    const ok = acks.length >= 1 && distinct.length === 1;
    record('control-dedupe', ok, ok
      ? acks.length > 1
        ? `retransmit re-acknowledged byte-identically (${acks.length} deliveries, one decision)`
        : 'retransmitted command id acknowledged once (redelivery may have been collapsed on the path)'
      : acks.length === 0 ? 'no acknowledgement within the window (§3)'
        : `expected one ack decision for the deduplicated id, got ${distinct.length} (${ackSummary(distinct)})`);
  },

  // §5/§6: the cancel outcome contract — ack, then a cause-linked
  // run.cancelled. DESTRUCTIVE: runs only when --control-cancel names a run.
  async 'control-cancel'() {
    if (!CONTROL_SESSION) return record('control-cancel', null, 'skipped: no --control-session target');
    if (!CONTROL_CANCEL_RUN) return record('control-cancel', null, 'skipped: destructive — pass --control-cancel <run> to opt in');
    const sock = await socketPath();
    if (!sock) return record('control-cancel', null, 'skipped: no socket endpoint advertised (§4.1 needs a duplex binding)');
    const sender = await openSender(wsUrl(BASE, sock));
    const cmd = mkCommand('control.cancel', CONTROL_SESSION,
      { scope: 'run', reason: 'aep-live-check control-class certification' },
      { run: CONTROL_CANCEL_RUN, capture: 'redacted' });
    const events = await observeWindow(CONTROL_SESSION, async () => sender.send(cmd));
    sender.close();
    const acks = acksFor(events, cmd.id);
    const accepted = acks.filter((a) => a.type === 'control.accepted');
    const outcomes = events.filter((e) => e.type === 'run.cancelled' && e.run === CONTROL_CANCEL_RUN);
    const causeOk = outcomes.length === 1
      && (outcomes[0].cause === cmd.id || (accepted[0] && outcomes[0].cause === accepted[0].id));
    const envErrs = outcomes.flatMap((o) => envelopeErrors(o));
    const ok = acks.length === 1 && accepted.length === 1 && causeOk && envErrs.length === 0;
    record('control-cancel', ok, ok
      ? 'accepted, then exactly one run.cancelled cause-linked to the command (§6)'
      : acks.length !== 1 ? `expected exactly one ack, got ${acks.length} (${ackSummary(acks)})`
        : accepted.length !== 1 ? `cancel was nacked: ${ackSummary(acks)}`
          : outcomes.length !== 1 ? `expected exactly one run.cancelled for ${CONTROL_CANCEL_RUN}, got ${outcomes.length}`
            : envErrs.length ? `outcome envelope violates AEP-0001 — ${envErrs[0]}`
              : `outcome cause ${outcomes[0].cause} links to neither the command nor its ack (§6)`);
  },
};

// ---- main ---------------------------------------------------------------------
(async () => {
  const startedAt = new Date().toISOString();
  human(`aep live check — ${BASE}\n`);
  for (const [name, fn] of Object.entries(CHECKS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    try { await fn(); } catch (e) { record(name, false, `check errored: ${e.message}`); }
  }
  const finishedAt = new Date().toISOString();
  const fails = results.filter((r) => r.ok === false).length;
  const skips = results.filter((r) => r.ok === null).length;
  human(`\n${fails === 0 ? 'OK' : 'FAILED'}: ${results.length - fails - skips} passed, ${fails} failed, ${skips} skipped`);
  if (JSON_OUT) {
    // The machine-readable report (format aep-conformance-report v1): one
    // object with a stable key order, statuses mapped from the recorded
    // verdicts (null = skip), the detail key omitted when there is none.
    const report = {
      format: 'aep-conformance-report',
      formatVersion: 1,
      aep: '0.1',
      tool: 'live',
      target: BASE,
      startedAt,
      finishedAt,
      checks: results.map(({ name, ok, detail }) => ({
        name,
        status: ok === null ? 'skip' : ok ? 'pass' : 'fail',
        ...(detail ? { detail } : {}),
      })),
      summary: { pass: results.length - fails - skips, fail: fails, skip: skips, total: results.length },
      ok: fails === 0,
    };
    const out = JSON.stringify(report, null, 2) + '\n';
    if (JSON_OUT === '-') process.stdout.write(out);
    else fs.writeFileSync(JSON_OUT, out);
  }
  process.exit(fails === 0 ? 0 : 1);
})();
