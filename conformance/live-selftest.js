#!/usr/bin/env node
// Self-test for conformance/live.js — runs in this repository's CI (./ci.sh).
//
// Boots a ~250-line stub collector implementing just enough of AEP-0003 to be
// checkable (discovery, version gate, envelope rejection, SSE fan-out with
// filter/capture/from, a minimal RFC 6455 socket for the hello rules, and a
// control-capable stub TARGET behind the socket — declared accepts, (source,
// id) dedupe with the recorded ack re-emitted byte-identically on a
// retransmit, cancel outcome per AEP-0004), then asserts BOTH directions:
//   1. live.js reports all-pass against the compliant stub — with the
//      control checks SKIPPED by default (they are opt-in) and green when a
//      target session + the destructive cancel flag are named;
//   2. live.js catches a deliberately broken resume (a replay gap §3.3.3
//      forbids), a double-acking target (§3: one ack decision), a silent
//      target (§3: window silence is a failure, not a pass), a target that
//      re-DECIDES a retried command instead of re-acking the recorded answer
//      (§3), and an endpoint that lets control flow over an unauthenticated
//      duplex (§4.1 — the control-auth-gate check; the compliant stub refuses
//      with an `unauthorized` error frame until a token authenticates the
//      binding).
//
// The opt-in eviction scenario (AEP-0003 §5/§3.3.3/§10) and the
// machine-readable report (--json <path|->) are covered the same two ways:
// a compliant small-buffer stub draws the replay-exhausted markers on both
// bindings and strict byte-identity; stubs that withhold the marker or
// rewrite a core context attribute in flight are caught; a value-preserving
// re-serialization grades as the AEP-0001 §4.2 floor, not a failure; and the
// --json report must carry the versioned shape with summary/exit parity
// (`-` moves every human line to stderr, a file path leaves stdout unchanged).
//
// The stub is test scaffolding, not a reference implementation: where a real
// endpoint derives capture gating from the schema annotations, the stub
// hard-codes the one field live.js probes with (`run.started.data.prompt`).
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ---- minimal envelope check (mirror of live.js's posting shapes) --------------
function badEnvelope(ev) {
  for (const k of ['aep', 'id', 'type', 'time', 'source', 'agent']) {
    if (typeof ev[k] !== 'string' || !ev[k]) return `missing ${k}`;
  }
  const cat = ev.type.split('.')[0];
  if (cat !== 'agent' && cat !== 'control' && cat !== 'x') {
    if (typeof ev.session !== 'string') return 'missing session';
    if (!Number.isInteger(ev.seq) || ev.seq < 0) return 'missing seq';
  }
  return null;
}
const pos = (ev) => (ev.epoch ?? 0) * 2 ** 40 + ev.seq;

// ---- the stub ------------------------------------------------------------------
// breakControl: null (compliant) | 'double-ack' | 'no-ack' | 'nack-retry' —
// the deliberate AEP-0004 §3 defects the control checks must catch — plus
// breakSubscribe, the AEP-0003 §6.5 defect (subscribe rejected OUT-OF-BAND by
// killing the socket instead of an in-band error frame)
// ('nack-retry' re-DECIDES a retransmitted command with a fresh
// rejected{invalid} instead of re-emitting the recorded ack).
// The eviction postures (AEP-0003 §5/§10): `evictBuffer` advertises
// capabilities.replay.buffer = N, holds the raw POSTED ndjson line strings
// per session and evicts from the front past N; a resume predating the
// earliest held position draws the replay-exhausted marker on both bindings
// (the SSE comment line; the WS frame with sub/session/earliest) before the
// held lines are delivered verbatim. `breakEvictMarker` evicts but withholds
// both markers; `breakEnvelope` rewrites a core context attribute in flight;
// `reserializeEnvelope` re-serializes held lines with key order changed and
// every value intact — the extension-tolerant floor AEP-0001 §4.2 keeps legal.
function startStub({ breakResume = false, breakControl = null, token = null, breakAuthGate = false, breakSubscribe = false, breakIgnoreUnknown = false, advertiseRoster = false, advertiseReplayAll = false, advertiseControl = false, behalfLiar = false, flakeUpgrades = 0, evictBuffer = 0, breakEvictMarker = false, breakEnvelope = false, reserializeEnvelope = false } = {}) {
  const sessions = new Map(); // session -> events[]
  const rawHeld = new Map();  // session -> [{ epoch, seq, line }] — raw POSTED lines, front-evicted past evictBuffer (AEP-0003 §5)
  const subs = new Set();     // { filter, capture, res }
  const seenCmds = new Map(); // command id -> recorded ack Event (AEP-0004 §2.3/§3)
  let stubIds = 0;

  // How an eviction posture serializes a held line for delivery: verbatim
  // (the AEP-0003 §10 byte-identity posture), with a core context attribute
  // rewritten in flight (the red posture), or re-serialized from the parsed
  // object with key order changed and every value intact — the shape the
  // AEP-0001 §4.2 extension tolerance keeps legal.
  const deliverLine = (line) => {
    if (breakEnvelope) {
      const ev = JSON.parse(line);
      ev.source = 'aep://stub/agent/rewritten-in-flight';
      return JSON.stringify(ev);
    }
    if (reserializeEnvelope) {
      const ev = JSON.parse(line);
      const out = {};
      for (const k of Object.keys(ev).reverse()) out[k] = ev[k];
      return JSON.stringify(out);
    }
    return line;
  };

  // The stub TARGET emits acks/outcomes as ordinary sequenced session events
  // (AEP-0004 §2.2), stored and fanned out like any ingested event.
  const emitAsTarget = (type, session, data, extra = {}) => {
    if (!sessions.has(session)) sessions.set(session, []);
    const list = sessions.get(session);
    const ev = {
      aep: '0.1', id: `STUBTGT${String(++stubIds).padStart(19, '0')}`, type,
      time: new Date().toISOString(), source: 'aep://stub/agent/stub-target',
      agent: 'stub-target', session, seq: list.length, epoch: 0, ...extra,
      ...(data ? { data } : {}),
    };
    list.push(ev);
    for (const s of subs) if (matches(s.filter, ev)) sseWrite(s.res, ev, s.capture);
    return ev;
  };
  // Redelivery of an already-emitted Event (the §3 re-ack): live fan-out only,
  // never a second buffer copy — the AEP-0003 §5 admission/fan-out split.
  const redeliver = (ev) => {
    for (const s of subs) if (matches(s.filter, ev)) sseWrite(s.res, ev, s.capture);
  };

  const gate = (ev, ceiling) => {
    if (!ceiling || ceiling === 'full' || ceiling === (ev.capture ?? 'metadata')) return ev;
    const out = JSON.parse(JSON.stringify(ev));
    out.capture = ceiling;
    if (out.data) {
      if (ceiling === 'none') delete out.data;
      else if (ceiling === 'metadata') delete out.data.prompt; // stub knowledge, see header
    }
    return out;
  };
  const matches = (filter, ev) => !filter.session || filter.session === ev.session;
  const sseWrite = (res, ev, capture) => {
    const out = gate(ev, capture);
    let msg = `event: ${out.type}\ndata: ${JSON.stringify(out)}\n`;
    if (out.session !== undefined && out.seq !== undefined) msg += `id: ${out.session}:${out.epoch ?? 0}:${out.seq}\n`;
    res.write(msg + '\n');
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (token && req.headers.authorization !== `Bearer ${token}`
      && url.searchParams.get('access_token') !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/events' || url.pathname === '/.well-known/aep')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        aep: ['0.1'], role: 'collector',
        endpoints: { events: '/events', stream: '/stream', socket: '/socket' },
        capabilities: { filters: ['attr-match'],
          // eviction postures advertise their real buffer; the replay-all-liar
          // posture: advertise §5's from=all, refuse it
          replay: { buffer: evictBuffer || 1000, ...(advertiseReplayAll ? { all: true } : {}) },
          capture: ['none', 'metadata', 'redacted'],
          // the roster-liar posture: advertise the §4.1 frame, never answer it
          ...(advertiseRoster ? { roster: {} } : {}),
          // the §4 routing surface (AEP-0004): advertised only for the
          // behalf-refusal postures — the plain stub is a target, not a router
          ...(advertiseControl ? { control: { accepts: [] } } : {}) },
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/events') {
      if (req.headers['aep-version'] !== '0.1') {
        res.writeHead(426, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ versions: ['0.1'] }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
        // Raw line strings ride along with the parsed events: the eviction
        // postures re-deliver the POSTED bytes verbatim (AEP-0003 §10).
        const lines = ct === 'application/x-ndjson'
          ? body.split('\n').filter((l) => l.trim())
          : [body.trim()];
        let events;
        try {
          events = lines.map((l) => JSON.parse(l));
        } catch { res.writeHead(400).end(JSON.stringify({ error: 'invalid-json' })); return; }
        for (const ev of events) {
          const err = badEnvelope(ev);
          if (err) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid-event', detail: err }));
            return;
          }
        }
        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          if (ev.session !== undefined && ev.seq !== undefined) {
            if (!sessions.has(ev.session)) sessions.set(ev.session, []);
            sessions.get(ev.session).push(ev);
            if (evictBuffer) {
              if (!rawHeld.has(ev.session)) rawHeld.set(ev.session, []);
              const held = rawHeld.get(ev.session);
              held.push({ epoch: ev.epoch ?? 0, seq: ev.seq, line: lines[i] });
              // evict from the front past the advertised buffer (§5)
              while (held.length > evictBuffer) held.shift();
            }
          }
          for (const s of subs) if (matches(s.filter, ev)) sseWrite(s.res, ev, s.capture);
        }
        res.writeHead(202).end();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/stream') {
      let filter = {}, from = [];
      try {
        filter = url.searchParams.get('filter') ? JSON.parse(url.searchParams.get('filter')) : {};
        from = url.searchParams.get('from') ? JSON.parse(url.searchParams.get('from')) : [];
      } catch { res.writeHead(400).end(); return; }
      const capture = url.searchParams.get('capture') || null;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const f of from) {
        // Eviction postures replay the raw held line strings (AEP-0003 §5):
        // a from predating the earliest held position draws the
        // replay-exhausted comment BEFORE the replayed data (unless the
        // marker-withholding defect is active), then the lines verbatim.
        if (evictBuffer && rawHeld.has(f.session)) {
          const held = rawHeld.get(f.session);
          const fromPos = (f.epoch ?? 0) * 2 ** 40 + f.seq;
          const tail = held.filter((h) => h.epoch * 2 ** 40 + h.seq > fromPos);
          if (!breakEvictMarker && tail.length && tail[0].epoch * 2 ** 40 + tail[0].seq > fromPos + 1) {
            res.write(`: replay-exhausted ${f.session} ${tail[0].epoch}:${tail[0].seq}\n\n`);
          }
          for (const h of tail) res.write(`data: ${deliverLine(h.line)}\n\n`);
          continue;
        }
        const tail = (sessions.get(f.session) ?? []).filter((e) => pos(e) > (f.epoch ?? 0) * 2 ** 40 + f.seq);
        if (breakResume) tail.shift(); // the deliberate defect: a replay gap
        for (const ev of tail) if (matches(filter, ev)) sseWrite(res, ev, capture);
      }
      // §5 single-pass replay: live=0 ends the stream after the replay
      // instead of holding a live subscription open.
      if (url.searchParams.get('live') === '0') { res.end(); return; }
      const sub = { filter, capture, res };
      subs.add(sub);
      req.on('close', () => subs.delete(sub));
      return;
    }

    res.writeHead(404).end();
  });

  // ---- minimal RFC 6455 server: enough for text frames under 64 KiB ------------
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://stub');
    if (url.pathname !== '/socket') { socket.destroy(); return; }
    // flakeUpgrades models a transient duplex blip: reset the first N /socket
    // upgrades before the 101 (a reachable relay under momentary load), so a
    // resilient sender must reconnect rather than fail an otherwise-passing
    // check. Reproduces the contention-only "sender socket error before hello".
    if (flakeUpgrades > 0) { flakeUpgrades -= 1; socket.destroy(); return; }
    const authed = !token || url.searchParams.get('access_token') === token;
    if (token && !authed) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    // sendRaw writes a text frame byte-for-byte — the eviction postures
    // deliver the POSTED line strings verbatim (AEP-0003 §10).
    const sendRaw = (text) => {
      const p = Buffer.from(text);
      const head = p.length < 126
        ? Buffer.from([0x81, p.length])
        : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(p.length); return b; })()]);
      socket.write(Buffer.concat([head, p]));
    };
    const send = (obj) => sendRaw(JSON.stringify(obj));
    const close = () => { try { socket.write(Buffer.from([0x88, 0])); } catch {} socket.end(); };

    let helloDone = false;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskOff = off, dataOff = masked ? off + 4 : off;
        if (buf.length < dataOff + len) return;
        let payload = buf.slice(dataOff, dataOff + len);
        if (masked) {
          const key = buf.slice(maskOff, maskOff + 4);
          payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
        }
        buf = buf.slice(dataOff + len);
        if (opcode === 8) { close(); return; }
        if (opcode !== 1) continue;
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch { send({ type: 'error', code: 'bad-json' }); continue; }
        const isEvent = typeof msg.type === 'string' && msg.type.includes('.');
        if (!helloDone) {
          if (isEvent || msg.type !== 'hello') { send({ type: 'error', code: 'hello-required' }); close(); return; }
          if (!(msg.versions ?? []).includes('0.1')) { send({ type: 'error', code: 'version-unsupported', versions: ['0.1'] }); close(); return; }
          helloDone = true;
          send({ type: 'hello', versions: ['0.1'], role: 'both', capabilities: { filters: ['attr-match'] } });
          continue;
        }
        // breakIgnoreUnknown models the §2 defect: a frame-rigid endpoint
        // that kills the socket on an unknown frame type instead of ignoring it
        if (breakIgnoreUnknown && !isEvent && msg.type !== 'subscribe') { socket.destroy(); return; }
        // ---- WS subscriptions (AEP-0003 §6.5): rejection is in-band from the
        // closed code set and per-request — the compliant posture live.js's
        // subscribe-limits check certifies; breakSubscribe models the defect
        // (out-of-band rejection: the socket dies instead of an error frame)
        if (msg.type === 'subscribe') {
          if (breakSubscribe) { socket.destroy(); return; }
          if (msg.from !== undefined && !Array.isArray(msg.from)) {
            send({ type: 'error', id: msg.id, code: 'invalid-filter', detail: 'from must be an array of resume positions' });
            continue;
          }
          if (Array.isArray(msg.from) && msg.from.length > 8) {
            send({ type: 'error', id: msg.id, code: 'limit-exceeded', detail: 'from exceeds 8 resume positions (stub limit)' });
            continue;
          }
          send({ type: 'subscribed', id: msg.id });
          // Eviction-posture replay over the duplex (AEP-0003 §5/§10): the
          // replay-exhausted frame — sub echoing the subscribe id — precedes
          // the held lines, delivered verbatim as text frames.
          if (evictBuffer && Array.isArray(msg.from)) {
            for (const f of msg.from) {
              const held = rawHeld.get(f.session);
              if (!held) continue;
              const fromPos = (f.epoch ?? 0) * 2 ** 40 + f.seq;
              const tail = held.filter((h) => h.epoch * 2 ** 40 + h.seq > fromPos);
              if (!breakEvictMarker && tail.length && tail[0].epoch * 2 ** 40 + tail[0].seq > fromPos + 1) {
                send({ type: 'replay-exhausted', sub: msg.id, session: f.session, earliest: { epoch: tail[0].epoch, seq: tail[0].seq } });
              }
              for (const h of tail) sendRaw(deliverLine(h.line));
            }
          }
          continue;
        }
        // ---- control-capable stub target (AEP-0004) ---------------------------
        if (!isEvent || !/^(control\.(attention\.respond|cancel|pause|resume)|x\.[a-z0-9_-]+\.control\..+)$/.test(msg.type)) continue;
        if (!token && !breakAuthGate) {
          // compliant posture: control never flows on an unauthenticated
          // binding (§4.1) — refuse toward the sender, touch no target
          send({ type: 'error', code: 'unauthorized', cause: msg.id,
            detail: 'control requires an authenticated binding (AEP-0004 §4.1)' });
          continue;
        }
        if (advertiseControl && msg.session !== 's_ctl') {
          // the §4 router posture: no live claimant owns this session — the
          // deterministic refusal is a cause-correlated no-route frame toward
          // the SENDER (§4.5), never an Event. behalfLiar models the §8
          // violation: it ALSO forges a refusal Event into the addressed
          // session's history under an identity that is not the session's
          // emitter — exactly what control-behalf-refusal must catch.
          if (behalfLiar) {
            if (!sessions.has(msg.session)) sessions.set(msg.session, []);
            const list = sessions.get(msg.session);
            const forged = {
              aep: '0.1', id: `STUBRLY${String(++stubIds).padStart(19, '0')}`,
              type: 'control.rejected', time: new Date().toISOString(),
              source: 'aep://stub/agent/stub-relay', agent: 'stub-relay',
              session: msg.session, seq: list.length, epoch: 0,
              cause: msg.id, data: { reason: 'no-route' },
            };
            list.push(forged);
            for (const s of subs) if (matches(s.filter, forged)) sseWrite(s.res, forged, s.capture);
          }
          send({ type: 'error', code: 'no-route', cause: msg.id,
            detail: `no connected emitter owns session ${msg.session}` });
          continue;
        }
        if (breakControl === 'no-ack') continue; // deliberately silent (§3 violation)
        if (msg.id && seenCmds.has(msg.id)) {
          // a retransmit is the SAME command (§2.3): compliant posture
          // re-emits the recorded ack byte-identically (§3); 'nack-retry'
          // models the defect of re-DECIDING it instead
          if (breakControl === 'nack-retry') {
            emitAsTarget('control.rejected', msg.session, { reason: 'invalid' }, { cause: msg.id });
          } else {
            const rec = seenCmds.get(msg.id);
            if (rec) redeliver(rec);
          }
          continue;
        }
        const keep = (ev) => { if (msg.id && !seenCmds.get(msg.id)) seenCmds.set(msg.id, ev); };
        const acks = breakControl === 'double-ack' ? 2 : 1; // §3 violation when 2
        if (msg.type === 'control.cancel') {
          for (let i = 0; i < acks; i++) keep(emitAsTarget('control.accepted', msg.session, null, { cause: msg.id }));
          emitAsTarget('run.cancelled', msg.session, { by: 'control' },
            { run: msg.run, cause: msg.id, severity: 'notice' });
        } else if (msg.type === 'control.attention.respond') {
          // no open gate to answer: acknowledge truthfully rather than stay silent
          for (let i = 0; i < acks; i++) keep(emitAsTarget('control.rejected', msg.session, { reason: 'invalid' }, { cause: msg.id }));
        } else {
          for (let i = 0; i < acks; i++) keep(emitAsTarget('control.rejected', msg.session, { reason: 'unsupported' }, { cause: msg.id }));
        }
      }
    });
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---- assertions ------------------------------------------------------------------
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
// Async spawn — the stub serves from this process's event loop, so a
// synchronous child wait would deadlock every request.
const runLive = (port, extra = []) => new Promise((resolve) => {
  const child = spawn('node',
    [path.join(__dirname, 'live.js'), `http://127.0.0.1:${port}`, '--timeout', '4000', ...extra],
    { timeout: 60_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

// Validate the machine-readable report (format v1) against its shape rules;
// returns the list of violations (empty = conformant). The shape is shared
// with the offline runners; here the tool under test is always `live`.
const reportProblems = (report, target) => {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['report is not a JSON object'];
  const bad = [];
  if (report.format !== 'aep-conformance-report') bad.push(`format ${JSON.stringify(report.format)}`);
  if (report.formatVersion !== 1) bad.push(`formatVersion ${JSON.stringify(report.formatVersion)}`);
  if (report.aep !== '0.1') bad.push(`aep ${JSON.stringify(report.aep)}`);
  if (report.tool !== 'live') bad.push(`tool ${JSON.stringify(report.tool)}`);
  if (report.target !== target) bad.push(`target ${JSON.stringify(report.target)} (want ${JSON.stringify(target)})`);
  for (const k of ['startedAt', 'finishedAt']) {
    if (typeof report[k] !== 'string' || Number.isNaN(Date.parse(report[k]))) bad.push(`${k} is not a parseable timestamp`);
  }
  if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) bad.push('finishedAt precedes startedAt');
  if (!Array.isArray(report.checks)) { bad.push('checks is not an array'); return bad; }
  const counted = { pass: 0, fail: 0, skip: 0 };
  for (const c of report.checks) {
    if (typeof c.name !== 'string' || !c.name) bad.push(`a check has no name: ${JSON.stringify(c).slice(0, 60)}`);
    if (c.status === 'pass' || c.status === 'fail' || c.status === 'skip') counted[c.status]++;
    else bad.push(`check ${c.name}: status ${JSON.stringify(c.status)} outside pass|fail|skip`);
    if ('detail' in c && (typeof c.detail !== 'string' || c.detail.length === 0)) bad.push(`check ${c.name}: empty detail present (an absent detail omits the key)`);
  }
  const s = report.summary;
  if (!s || s.pass !== counted.pass || s.fail !== counted.fail || s.skip !== counted.skip) {
    bad.push(`summary ${JSON.stringify(s)} disagrees with the recorded statuses ${JSON.stringify(counted)}`);
  }
  if (!s || s.total !== report.checks.length || s.total !== counted.pass + counted.fail + counted.skip) {
    bad.push(`summary.total ${s?.total} !== checks.length ${report.checks.length}`);
  }
  if (report.ok !== ((s?.fail ?? -1) === 0)) bad.push(`ok ${JSON.stringify(report.ok)} !== (fail === 0)`);
  return bad;
};

(async () => {
  // Short sender-side ack window: exactly-one assertions observe the whole
  // window, so the default 10 s would make this self-test needlessly slow.
  const CTL = ['--control-session', 's_ctl', '--control-cancel', 'r_ctl', '--ack-window', '1200'];
  // Control flows only on authenticated bindings (§4.1), so every run that
  // exercises the stub TARGET authenticates; the unauthenticated runs prove
  // the gate instead.
  const T = 'selftest-token';
  const AUTH = ['--token', T];
  // The eviction scenario is opt-in on both sides: the checker floods only
  // under --evict, and the targeted runs select just the two eviction ids.
  const EVICT = ['--evict', '--checks', 'evict-replay-exhausted,evict-byte-identity'];

  const good = await startStub();
  const g = await runLive(good.port);
  good.server.close();
  const gPass = (g.stdout.match(/^PASS /gm) ?? []).length;
  const gSkip = (g.stdout.match(/^SKIP {2}(control-(ack|nack|dedupe|cancel)|evict-(replay-exhausted|byte-identity))/gm) ?? []).length;
  check('live.js all-green against the compliant unauthenticated stub; auth gate holds, control checks skipped without a target, eviction checks skipped without --evict',
    g.status === 0 && gPass === 10 && gSkip === 6 && /0 failed/.test(g.stdout)
      && /PASS {2}control-auth-gate/.test(g.stdout)
      && /PASS {2}subscribe-limits/.test(g.stdout),
    `exit ${g.status}, ${gPass}/10 PASS, ${gSkip}/6 opt-in SKIP\n${(g.stdout + g.stderr).slice(0, 400)}`);

  const goodAuth = await startStub({ token: T });
  const g2 = await runLive(goodAuth.port, [...CTL, ...AUTH]);
  goodAuth.server.close();
  const g2Pass = (g2.stdout.match(/^PASS /gm) ?? []).length;
  const g2Skip = (g2.stdout.match(/^SKIP {2}(control-auth-gate|evict-(replay-exhausted|byte-identity))/gm) ?? []).length;
  check('live.js all-green with the control checks against the authenticated compliant stub target (incl. opted-in cancel; auth-gate probe and the opt-in eviction checks skipped)',
    g2.status === 0 && g2Pass === 13 && g2Skip === 3 && /0 failed/.test(g2.stdout)
      && /SKIP {2}control-auth-gate/.test(g2.stdout),
    `exit ${g2.status}, ${g2Pass}/13 PASS, ${g2Skip}/3 opt-in SKIP\n${(g2.stdout + g2.stderr).slice(0, 400)}`);

  // A transient duplex blip must not fail an otherwise-passing control check:
  // the sender socket is reset once before the hello handshake completes (the
  // contention-only "sender socket error before hello"), and the resilient
  // sender reconnects. Regression guard for the pre-hello race in openSender.
  const flaky = await startStub({ token: T, flakeUpgrades: 1 });
  const fk = await runLive(flaky.port, [...CTL, ...AUTH, '--checks', 'control-ack']);
  flaky.server.close();
  check('live.js recovers from a transient pre-hello sender-socket reset (control-ack still passes after one reconnect)',
    fk.status === 0 && /PASS {2}control-ack/.test(fk.stdout)
      && !/sender socket error before hello/.test(fk.stdout),
    `exit ${fk.status}\n${(fk.stdout + fk.stderr).slice(0, 400)}`);

  const broken = await startStub({ breakResume: true });
  const b = await runLive(broken.port);
  broken.server.close();
  const bFails = (b.stdout.match(/^FAIL /gm) ?? []).length;
  check('live.js catches the broken resume (gap in from-replay)',
    b.status === 1 && bFails === 1 && /FAIL {2}resume/.test(b.stdout),
    `exit ${b.status}, ${bFails} FAIL line(s)\n${(b.stdout + b.stderr).slice(0, 400)}`);

  const oob = await startStub({ breakSubscribe: true });
  const o = await runLive(oob.port, ['--checks', 'subscribe-limits']);
  oob.server.close();
  check('live.js catches out-of-band subscribe rejection (socket killed instead of a §6.5 error frame)',
    o.status === 1 && /FAIL {2}subscribe-limits/.test(o.stdout) && /connection dropped/.test(o.stdout),
    `exit ${o.status}\n${(o.stdout + o.stderr).slice(0, 400)}`);

  const rigid = await startStub({ breakIgnoreUnknown: true });
  const r = await runLive(rigid.port, ['--checks', 'ignore-unknown']);
  rigid.server.close();
  check('live.js catches a frame-rigid endpoint (unknown frame type kills the socket instead of being ignored, §2)',
    r.status === 1 && /FAIL {2}ignore-unknown/.test(r.stdout),
    `exit ${r.status}\n${(r.stdout + r.stderr).slice(0, 400)}`);

  const rosterLiar = await startStub({ advertiseRoster: true });
  const ro = await runLive(rosterLiar.port, ['--checks', 'roster']);
  rosterLiar.server.close();
  check('live.js catches an advertised-but-silent roster endpoint (capabilities.roster declared, the request unanswered — AEP-0003 §4.1 rules 1-2)',
    ro.status === 1 && /FAIL {2}roster/.test(ro.stdout) && /unanswered despite/.test(ro.stdout),
    `exit ${ro.status}\n${(ro.stdout + ro.stderr).slice(0, 400)}`);

  const raLiar = await startStub({ advertiseReplayAll: true });
  const ra = await runLive(raLiar.port, ['--checks', 'replay-all']);
  raLiar.server.close();
  check('live.js catches an endpoint advertising replay.all and then refusing from=all (AEP-0003 §5)',
    ra.status === 1 && /FAIL {2}replay-all/.test(ra.stdout) && /despite the endpoint advertising/.test(ra.stdout),
    `exit ${ra.status}\n${(ra.stdout + ra.stderr).slice(0, 400)}`);

  const behalfGood = await startStub({ advertiseControl: true, token: T });
  const bg = await runLive(behalfGood.port, [...AUTH, '--checks', 'control-behalf-refusal']);
  behalfGood.server.close();
  check('live.js certifies the behalf-refusal boundary (cause-correlated no-route frame toward the sender; the addressed session replay untouched — AEP-0004 §4.2/§4.5/§8)',
    bg.status === 0 && /PASS {2}control-behalf-refusal/.test(bg.stdout),
    `exit ${bg.status}\n${(bg.stdout + bg.stderr).slice(0, 400)}`);

  const behalfBad = await startStub({ advertiseControl: true, behalfLiar: true, token: T });
  const bl = await runLive(behalfBad.port, [...AUTH, '--checks', 'control-behalf-refusal']);
  behalfBad.server.close();
  check('live.js catches a relay that persists its behalf-refusal into the addressed session history (a forged Event under an identity that is not its own — AEP-0004 §8)',
    bl.status === 1 && /FAIL {2}control-behalf-refusal/.test(bl.stdout) && /histor/i.test(bl.stdout),
    `exit ${bl.status}\n${(bl.stdout + bl.stderr).slice(0, 400)}`);

  const dbl = await startStub({ breakControl: 'double-ack', token: T });
  const d = await runLive(dbl.port, [...CTL, ...AUTH, '--checks', 'control-ack,control-dedupe']);
  dbl.server.close();
  check('live.js catches a double-acking target (§3: exactly one ack per command)',
    d.status === 1 && /FAIL {2}control-ack/.test(d.stdout) && /FAIL {2}control-dedupe/.test(d.stdout),
    `exit ${d.status}\n${(d.stdout + d.stderr).slice(0, 400)}`);

  const silent = await startStub({ breakControl: 'no-ack', token: T });
  const s = await runLive(silent.port, [...CTL, ...AUTH, '--checks', 'control-ack']);
  silent.server.close();
  check('live.js catches a silent target (§3: window silence is a timeout, not a pass)',
    s.status === 1 && /FAIL {2}control-ack/.test(s.stdout),
    `exit ${s.status}\n${(s.stdout + s.stderr).slice(0, 400)}`);

  const nackRetry = await startStub({ breakControl: 'nack-retry', token: T });
  const nr = await runLive(nackRetry.port, [...CTL, ...AUTH, '--checks', 'control-dedupe']);
  nackRetry.server.close();
  check('live.js catches a target that re-DECIDES a retried command (fresh nack instead of the recorded ack, §3)',
    nr.status === 1 && /FAIL {2}control-dedupe/.test(nr.stdout),
    `exit ${nr.status}\n${(nr.stdout + nr.stderr).slice(0, 400)}`);

  const leaky = await startStub({ breakAuthGate: true });
  const l = await runLive(leaky.port, ['--checks', 'control-auth-gate']);
  leaky.server.close();
  check('live.js catches control flowing over an unauthenticated duplex (§4.1)',
    l.status === 1 && /FAIL {2}control-auth-gate/.test(l.stdout),
    `exit ${l.status}\n${(l.stdout + l.stderr).slice(0, 400)}`);

  // ---- eviction + byte-identity (AEP-0003 §5/§3.3.3/§10; AEP-0001 §4.2) -------

  const evictCapable = await startStub({ evictBuffer: 8 });
  const nf = await runLive(evictCapable.port);
  evictCapable.server.close();
  check('live.js skips both eviction checks without --evict (the flood is opt-in) and stays green against an evict-capable stub',
    nf.status === 0 && /0 failed/.test(nf.stdout)
      && /SKIP {2}evict-replay-exhausted/.test(nf.stdout)
      && /SKIP {2}evict-byte-identity/.test(nf.stdout)
      && /opt-in — pass --evict to flood a session past the advertised replay buffer/.test(nf.stdout),
    `exit ${nf.status}\n${(nf.stdout + nf.stderr).slice(0, 400)}`);

  const evictGood = await startStub({ evictBuffer: 8 });
  const eg = await runLive(evictGood.port, EVICT);
  evictGood.server.close();
  check('live.js certifies eviction: replay-exhausted markers on both bindings before delivery from the marked earliest, and strict byte-identity (AEP-0003 §5/§3.3.3/§10)',
    eg.status === 0 && /0 failed/.test(eg.stdout)
      && /PASS {2}evict-replay-exhausted/.test(eg.stdout)
      && /PASS {2}evict-byte-identity/.test(eg.stdout)
      && /byte-identical across POST body, SSE data, and WS frame/.test(eg.stdout),
    `exit ${eg.status}\n${(eg.stdout + eg.stderr).slice(0, 400)}`);

  const noMarker = await startStub({ evictBuffer: 8, breakEvictMarker: true });
  const nmk = await runLive(noMarker.port, EVICT);
  noMarker.server.close();
  check('live.js catches an evicting endpoint that replays from a predating position without the replay-exhausted marker (AEP-0003 §5/§3.3.3: the gap must be declared)',
    nmk.status === 1 && /FAIL {2}evict-replay-exhausted/.test(nmk.stdout),
    `exit ${nmk.status}\n${(nmk.stdout + nmk.stderr).slice(0, 400)}`);

  const rewritten = await startStub({ evictBuffer: 8, breakEnvelope: true });
  const rw = await runLive(rewritten.port, EVICT);
  rewritten.server.close();
  check('live.js catches a core context attribute rewritten in flight (AEP-0003 §10: the delivered envelope is the posted one), with the exhausted-marker check unaffected',
    rw.status === 1 && /FAIL {2}evict-byte-identity/.test(rw.stdout)
      && /PASS {2}evict-replay-exhausted/.test(rw.stdout),
    `exit ${rw.status}\n${(rw.stdout + rw.stderr).slice(0, 400)}`);

  const reserialized = await startStub({ evictBuffer: 8, reserializeEnvelope: true });
  const rs = await runLive(reserialized.port, EVICT);
  reserialized.server.close();
  check('live.js grades a value-preserving re-serialization as the AEP-0001 §4.2 floor, not a failure (core envelope intact, not byte-identical)',
    rs.status === 0 && /0 failed/.test(rs.stdout)
      && /PASS {2}evict-replay-exhausted/.test(rs.stdout)
      && /PASS {2}evict-byte-identity/.test(rs.stdout)
      && /core envelope intact; not byte-identical/.test(rs.stdout),
    `exit ${rs.status}\n${(rs.stdout + rs.stderr).slice(0, 400)}`);

  const hugeBuffer = await startStub({ evictBuffer: 100000 });
  const hb = await runLive(hugeBuffer.port, EVICT);
  hugeBuffer.server.close();
  check('live.js refuses to flood past a large advertised buffer (both eviction checks skip over --evict-max)',
    hb.status === 0 && /SKIP {2}evict-replay-exhausted/.test(hb.stdout)
      && /SKIP {2}evict-byte-identity/.test(hb.stdout)
      && /exceeds --evict-max/.test(hb.stdout),
    `exit ${hb.status}\n${(hb.stdout + hb.stderr).slice(0, 400)}`);

  // ---- the machine-readable report (--json <path|->) ---------------------------

  const jsonStub = await startStub();
  const js = await runLive(jsonStub.port, ['--json', '-']);
  jsonStub.server.close();
  let stdoutReport = null;
  try { stdoutReport = JSON.parse(js.stdout); } catch { /* asserted below */ }
  const jsProblems = reportProblems(stdoutReport, `http://127.0.0.1:${jsonStub.port}`);
  const names = stdoutReport?.checks?.map?.((c) => c.name) ?? [];
  const registryOk = names.length === 19
    && names.indexOf('evict-replay-exhausted') === names.indexOf('replay-all') + 1
    && names.indexOf('evict-byte-identity') === names.indexOf('replay-all') + 2;
  check('live.js --json - writes one pure JSON report to stdout (versioned shape, summary parity, both eviction checks registered after replay-all) and moves every human line to stderr',
    js.status === 0 && stdoutReport !== null && jsProblems.length === 0 && registryOk
      && stdoutReport.summary.pass === 10 && stdoutReport.summary.fail === 0
      && stdoutReport.summary.skip === 9 && stdoutReport.ok === true
      && js.stdout === JSON.stringify(stdoutReport, null, 2) + '\n'
      && !/^(PASS|FAIL|SKIP) {2}/m.test(js.stdout) && !/aep live check/.test(js.stdout)
      && /aep live check/.test(js.stderr) && /^PASS {2}discovery/m.test(js.stderr)
      && /0 failed/.test(js.stderr),
    `exit ${js.status}; shape problems: ${jsProblems.join(' | ') || 'none'}\n${(js.stdout + js.stderr).slice(0, 400)}`);

  const fileStub = await startStub();
  const reportPath = path.join(os.tmpdir(), `aep-live-report-${process.pid}-${Date.now()}.json`);
  const jf = await runLive(fileStub.port, ['--json', reportPath]);
  fileStub.server.close();
  let fileReport = null;
  try { fileReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* asserted below */ }
  try { fs.unlinkSync(reportPath); } catch { /* never written — asserted below */ }
  const jfProblems = reportProblems(fileReport, `http://127.0.0.1:${fileStub.port}`);
  check('live.js --json <path> writes the report to the file and leaves the human stdout unchanged (PASS lines and footer still there, no JSON on stdout)',
    jf.status === 0 && fileReport !== null && jfProblems.length === 0
      && fileReport.summary.fail === 0 && fileReport.ok === true
      && /^PASS {2}discovery/m.test(jf.stdout) && /0 failed/.test(jf.stdout)
      && /aep live check/.test(jf.stdout)
      && !/aep-conformance-report/.test(jf.stdout),
    `exit ${jf.status}; shape problems: ${jfProblems.join(' | ') || 'none'}\n${(jf.stdout + jf.stderr).slice(0, 400)}`);

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'}: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
