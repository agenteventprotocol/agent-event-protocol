#!/usr/bin/env node
// AEP 0.1 conformance runner (JS) — exercises impl/shared/* against the same
// fixtures as run.py. Two independent implementations agreeing on one corpus is
// the cross-check; envelope-schema validation itself is exercised via `aep validate`.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateFilter, attrMatch, canonicalJson, gateFormValues, downlevel, loadCaptureAnnotations } = require('../impl/shared/aep.js');
const { toCloudEvent, fromCloudEvent } = require('../impl/shared/ce-bridge.js');

// ---- args (--json <path|->: machine-readable report; `-` puts the report on
// stdout and moves the human lines to stderr) ---------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const JSON_OUT = opt('json', null);
if (argv.includes('--json') && JSON_OUT == null) {
  console.error('usage: node conformance/run.js [--json <path|->]');
  process.exit(2);
}
const JSON_STDOUT = JSON_OUT === '-';
const human = (line) => (JSON_STDOUT ? console.error(line) : console.log(line));
const startedAt = new Date().toISOString();

const FIX = path.join(__dirname, 'fixtures');
let failures = 0;
const results = [];
const check = (name, ok, detail = '') => {
  human(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  results.push({ name, ok, detail });
  if (!ok) failures++;
};

// ---- golden corpus through `aep validate` (envelope + payload + ordering) ----
const golden = fs.readFileSync(path.join(FIX, 'golden', 'golden.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const v = spawnSync('node', [path.join(__dirname, '..', 'impl', 'cli', 'aep.js'),
  'validate', path.join(FIX, 'golden', 'golden.jsonl')], { encoding: 'utf8' });
check('aep validate accepts golden corpus', v.status === 0, v.stderr?.slice(0, 300));

// ---- invalid corpus must fail (each case individually; a case may be a stream) --
const invalid = JSON.parse(fs.readFileSync(path.join(FIX, 'invalid', 'cases.json'), 'utf8'));
const os = require('os');
for (const c of invalid.cases) {
  const tmp = path.join(os.tmpdir(), `aep-inv-${process.pid}.jsonl`);
  const events = c.events ?? [c.event];
  fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e) + '\n').join(''));
  const r = spawnSync('node', [path.join(__dirname, '..', 'impl', 'cli', 'aep.js'), 'validate', tmp], { encoding: 'utf8' });
  check(`invalid rejected: ${c.name}`, r.status !== 0, `violates ${c.rule} but validated`);
  fs.rmSync(tmp, { force: true });
}

// ---- attr-match corpus ---------------------------------------------------------
const am = JSON.parse(fs.readFileSync(path.join(FIX, 'attr-match', 'cases.json'), 'utf8'));
for (const c of am.match) {
  const err = validateFilter(c.filter);
  check(`attr-match: ${c.name}`, err === null && attrMatch(c.filter, c.event) === c.match, err ?? 'wrong verdict');
}
for (const c of am.invalid) {
  check(`attr-match rejects: ${c.name}`, validateFilter(c.filter) !== null);
}

// ---- CE bridge vs pins + round-trip identity ------------------------------------
const pins = fs.readFileSync(path.join(FIX, 'ce-roundtrip', 'ce-expected.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
check('CE pins cover golden corpus', pins.length === golden.length);
golden.forEach((ev, i) => {
  const fwd = toCloudEvent(ev);
  check(`CE forward[${i}] matches pin (${ev.type})`, canonicalJson(fwd) === canonicalJson(pins[i]));
  check(`CE round-trip identity[${i}]`, canonicalJson(fromCloudEvent(fwd)) === canonicalJson(ev));
});
check('foreign CE event out of bridge scope',
  fromCloudEvent({ specversion: '1.0', id: 'F1', source: 's', type: 'com.example.thing', time: 'now' }) === null);

// Inbound preserve-path (AEP-0005 §2 rule 2): hand-authored inbound CE objects
// fed to the inverse directly — the golden-derived pins above only exercise
// round-trips of attributes the golden corpus already carries.
const inbound = JSON.parse(fs.readFileSync(path.join(FIX, 'ce-roundtrip', 'inbound-cases.json'), 'utf8'));
for (const c of inbound.cases) {
  check(`CE inbound: ${c.name}`,
    canonicalJson(fromCloudEvent(c.ce)) === canonicalJson(c.expected),
    `${c.rule}: got ${(JSON.stringify(fromCloudEvent(c.ce)) ?? 'null').slice(0, 160)}`);
}

// ---- redaction pipeline adversarial corpus (AEP-0003 §9.4) ----------------------
const { redactText, redactValue } = require('../impl/shared/redact.js');
const red = JSON.parse(fs.readFileSync(path.join(FIX, 'redaction', 'cases.json'), 'utf8'));
const redOk = (out, c) =>
  (c.must_not_contain ?? []).every((s) => !out.includes(s)) &&
  (c.must_contain ?? []).every((s) => out.includes(s));
for (const c of red.text_cases) {
  const out = redactText(c.input, { home: '/nonexistent-home', ...(c.opts ?? {}) });
  check(`redact text: ${c.name}`, redOk(out, c), JSON.stringify(out).slice(0, 120));
}
for (const c of red.value_cases) {
  const out = JSON.stringify(redactValue(c.input, { home: '/nonexistent-home', ...(c.opts ?? {}) }));
  check(`redact value: ${c.name}`, redOk(out, c), out.slice(0, 120));
}

// ---- capture-gating corpus (AEP-0006 values asymmetry; run.py holds its own) ----
const cg = JSON.parse(fs.readFileSync(path.join(FIX, 'capture-gating', 'cases.json'), 'utf8'));
for (const c of cg.cases) {
  const out = gateFormValues(c.fields, c.values, c.ceiling, (s) => redactText(s, { home: '/nonexistent-home' }));
  check(`capture-gating: ${c.name}`, canonicalJson(out) === canonicalJson(c.expect),
    JSON.stringify(out).slice(0, 160));
}

// ---- downlevel corpus (AEP-0001 §8.2 at a fan-out hop; run.js-only like the ------
// redaction corpus — exercises the shared implementation the relay uses) ----------
const ANNOTATIONS = loadCaptureAnnotations(path.join(__dirname, '..', 'schemas', 'types'));
const dl = JSON.parse(fs.readFileSync(path.join(FIX, 'downlevel', 'cases.json'), 'utf8'));
for (const c of dl.cases) {
  const out = downlevel(c.event, c.ceiling, ANNOTATIONS);
  const dataOk = c.expect_data === null
    ? out.data === undefined
    : canonicalJson(out.data) === canonicalJson(c.expect_data);
  check(`downlevel: ${c.name}`, out.capture === c.expect_capture && dataOk,
    JSON.stringify({ capture: out.capture, data: out.data }).slice(0, 200));
}

// ---- Annex-A mapping pins: AskUserQuestion -> kind:"form" (AEP-0006) -------------
// Pins the adapter's own pure mapping module against the fixture; run.py holds
// the spec-side check (schema validity + wire facts) since it has no adapter impl.
const { mapAskUserQuestion } = require('../impl/adapter-claude-code/map-ask-user-question.js');
const maps = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'claude-code.json'), 'utf8'));
const auq = maps.ask_user_question;
for (const [pinKey, contentOk] of [['expected_data', true], ['expected_data_metadata', false]]) {
  const mapped = mapAskUserQuestion(auq.input.questions, { agent: 'claude-code', contentOk });
  const data = { kind: 'form', ...mapped, respond_via: ['control'] }; // adapter assembly
  check(`mapping AskUserQuestion -> form matches pin (${pinKey})`,
    canonicalJson(data) === canonicalJson(auq[pinKey]), JSON.stringify(data).slice(0, 200));
}

// ---- Annex-A mapping pins: MCP elicitation -> kind:"form" (AEP-0006) --------------
const { mapElicitation } = require('../impl/adapter-claude-code/map-elicitation.js');
const eli = maps.elicitation;
for (const [pinKey, contentOk] of [['expected_data', true], ['expected_data_metadata', false]]) {
  const mapped = mapElicitation(eli.input.message, eli.input.requestedSchema, { agent: 'claude-code', contentOk });
  const data = { kind: 'form', ...mapped, respond_via: ['control'] }; // adapter assembly
  check(`mapping Elicitation -> form matches pin (${pinKey})`,
    canonicalJson(data) === canonicalJson(eli[pinKey]), JSON.stringify(data).slice(0, 200));
}

// ---- Annex-A mapping pins: the Codex table (hook -> event, pure) ------------------
// Pins the Codex adapter's own pure mapping module against the fixture at the
// adapter's default capture posture (metadata; attention.* redacted); run.py
// holds the spec-side check (schema validity + wire facts). Identity and
// causal wiring are runtime state, exercised by the adapter smoke in ci.sh.
const { mapHook } = require('../impl/adapter-codex/map-hooks.js');
const codex = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'codex.json'), 'utf8'));
for (const [name, c] of [...Object.entries(codex.hooks), ['fallback', codex.fallback]]) {
  const mapped = mapHook(c.input);
  const got = mapped === null ? null : {
    type: mapped.type, data: mapped.data,
    ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
  };
  const want = c.expected === null ? null : {
    type: c.expected.type, data: c.expected.data,
    ...(c.expected.subject !== undefined ? { subject: c.expected.subject } : {}),
  };
  check(`codex mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(want),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Annex-A mapping pins: the Gemini CLI table (hook -> event, pure) -------------
// Same discipline as the Codex block: the adapter's pure mapping module vs the
// fixture at the default posture; run.py holds the spec-side schema/wire-fact
// checks. Runs are adapter-synthesized (no turn id) — runtime state, smoke-pinned.
const { mapHook: mapGeminiHook } = require('../impl/adapter-gemini-cli/map-hooks.js');
const gemini = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'gemini-cli.json'), 'utf8'));
for (const [name, c] of [...Object.entries(gemini.hooks), ['fallback', gemini.fallback]]) {
  const mapped = mapGeminiHook(c.input);
  const got = mapped === null ? null : {
    type: mapped.type, data: mapped.data,
    ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
  };
  const want = c.expected === null ? null : {
    type: c.expected.type, data: c.expected.data,
    ...(c.expected.subject !== undefined ? { subject: c.expected.subject } : {}),
  };
  check(`gemini-cli mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(want),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Annex-A mapping pins: the Qwen Code table (hook -> event, pure) ---------------
const { mapHook: mapQwenHook } = require('../impl/adapter-qwen-code/map-hooks.js');
const qwen = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'qwen-code.json'), 'utf8'));
for (const [name, c] of [...Object.entries(qwen.hooks), ['fallback', qwen.fallback]]) {
  const mapped = mapQwenHook(c.input);
  const got = mapped === null ? null : {
    type: mapped.type, data: mapped.data,
    ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
  };
  const want = c.expected === null ? null : {
    type: c.expected.type, data: c.expected.data,
    ...(c.expected.subject !== undefined ? { subject: c.expected.subject } : {}),
  };
  check(`qwen-code mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(want),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Annex-A mapping pins: the VS Code agent table (hook -> event, pure) -----------
// The 8 VSCode-target agent-hook events (Preview), verified against the
// pinned vendor source (microsoft/vscode release/1.128 = 5264f2156;
// 1.129.0 contract-identical). Envelope identity (optional session_id),
// run synthesis per prompt, tool_use_id causality, and the opt-in held
// PreToolUse permission gate are runtime state, smoke-pinned in the
// reference repository.
const { mapHook: mapVscodeHook } = require('../impl/adapter-vscode/map-hooks.js');
const vscode = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'vscode.json'), 'utf8'));
for (const [name, c] of [...Object.entries(vscode.hooks), ['fallback', vscode.fallback]]) {
  const mapped = mapVscodeHook(c.input);
  const got = mapped === null ? null : {
    type: mapped.type, data: mapped.data,
    ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
  };
  const want = c.expected === null ? null : {
    type: c.expected.type, data: c.expected.data,
    ...(c.expected.subject !== undefined ? { subject: c.expected.subject } : {}),
  };
  check(`vscode mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(want),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Annex-A mapping pins: the Kimi Code CLI table (hook -> event, pure) ----------
// The 16-event external-hooks surface, verified against the pinned vendor
// source (MoonshotAI/kimi-code c2d7beb = the shipped @moonshot-ai/kimi-code
// 0.28.1); the six lifecycle payload shapes are oracle-captured from the
// shipped binary. Envelope identity (optional session_id), run synthesis
// per prompt with the Interrupt-hook cancellation and the stale-run drain,
// the permission-pair companions (resolved + the rejected decision's
// tool.denied by:runtime), and the opt-in held PreToolUse gate
// (AEP_KIMI_CONTROL=1, binary allow/deny) are runtime state, smoke-pinned
// in the reference repository.
const { mapHook: mapKimiHook } = require('../impl/adapter-kimi-code/map-hooks.js');
const kimi = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'kimi-code.json'), 'utf8'));
for (const [name, c] of [...Object.entries(kimi.hooks), ['fallback', kimi.fallback]]) {
  const mapped = mapKimiHook(c.input);
  const got = mapped === null ? null : {
    type: mapped.type, data: mapped.data,
    ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
  };
  const want = c.expected === null ? null : {
    type: c.expected.type, data: c.expected.data,
    ...(c.expected.subject !== undefined ? { subject: c.expected.subject } : {}),
  };
  check(`kimi-code mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(want),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Channel pins: the Kimi web modes (kap wire frame -> event, pure) --------------
// The kap-server WS stream vs the ws_modes block, twice per wire frame
// (companion and primary — the OTel-inbound dedup discipline on the family's
// first WS channel). Inputs are self-contained WS envelopes. Run bookkeeping,
// the resolved-pair companion, the stateful tool-name pairing, and control
// decoration are receiver wiring, smoke-pinned in the reference repository.
const { applyMode: applyKimiWebMode } = require('../impl/bridge-kimi-code-web/mode-policy.js');
for (const [name, c] of Object.entries(kimi.ws_modes.modes)) {
  for (const mode of ['companion', 'primary']) {
    const mapped = applyKimiWebMode(c.input, mode);
    const got = mapped === null ? null : {
      type: mapped.type, data: mapped.data,
      ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
    };
    check(`kimi-web ${mode} ${name} matches pin`,
      canonicalJson(got) === canonicalJson(c[mode]),
      (JSON.stringify(got) ?? 'null').slice(0, 200));
  }
}

// ---- Channel pins: the Codex OTel-inbound mapping (record -> event, pure) ---------
// Same discipline as the hook-mapping blocks, twice per record (companion and
// primary modes — the design-note dedup rule). Envelope identity is receiver
// wiring, smoke-pinned in the reference repository.
const { mapRecord } = require('../impl/bridge-otlp-in/map-records.js');
const codexOtel = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'codex-otel.json'), 'utf8'));
for (const [name, c] of [...Object.entries(codexOtel.records), ['unknown', codexOtel.unknown]]) {
  for (const mode of ['companion', 'primary']) {
    const mapped = mapRecord(c.input, { mode });
    const got = mapped === null ? null : {
      type: mapped.type, data: mapped.data,
      ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
    };
    const want = c[mode] === null ? null : {
      type: c[mode].type, data: c[mode].data,
      ...(c[mode].subject !== undefined ? { subject: c[mode].subject } : {}),
    };
    check(`codex-otel ${mode} mapping ${name} matches pin`,
      canonicalJson(got) === canonicalJson(want),
      (JSON.stringify(got) ?? 'null').slice(0, 200));
  }
}

// ---- Channel pins: the VS Code agent OTel-inbound mapping (second vendor profile) --
// Same receiver, same discipline: the vscode profile's pure mapper replayed in
// both modes against the pinned table. Envelope identity (resource session.id)
// is receiver wiring, smoke-pinned in the reference repository.
const { mapRecord: mapVscodeRecord } = require('../impl/bridge-otlp-in/map-records-vscode.js');
const vscodeOtel = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'vscode-otel.json'), 'utf8'));
for (const [name, c] of [...Object.entries(vscodeOtel.records), ['unknown', vscodeOtel.unknown]]) {
  for (const mode of ['companion', 'primary']) {
    const mapped = mapVscodeRecord(c.input, { mode });
    const got = mapped === null ? null : {
      type: mapped.type, data: mapped.data,
      ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
    };
    const want = c[mode] === null ? null : {
      type: c[mode].type, data: c[mode].data,
      ...(c[mode].subject !== undefined ? { subject: c[mode].subject } : {}),
    };
    check(`vscode-otel ${mode} mapping ${name} matches pin`,
      canonicalJson(got) === canonicalJson(want),
      (JSON.stringify(got) ?? 'null').slice(0, 200));
  }
}


// ---- Annex-A mapping pins: the OpenCode table (moment -> event, pure) --------------
// Two moment shapes ride one mapper: bus events ({kind:'bus', event}) and the
// interception hooks. The snapshot-diffed todo transitions get their own pure
// pin (diffTodos) — the registry deliberately has no snapshot type. Envelope
// identity, run synthesis, and the permission dedupe are runtime state,
// smoke-pinned in the reference repository.
const { mapMoment: mapOpencodeMoment, diffTodos: diffOpencodeTodos } = require('../impl/adapter-opencode/map-hooks.js');
const opencode = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'opencode.json'), 'utf8'));
for (const [name, c] of [...Object.entries(opencode.moments), ['fallback', opencode.fallback]]) {
  const mapped = mapOpencodeMoment(c.input);
  const got = mapped === null ? null : {
    type: mapped.type, data: mapped.data,
    ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
  };
  const want = c.expected === null ? null : {
    type: c.expected.type, data: c.expected.data,
    ...(c.expected.subject !== undefined ? { subject: c.expected.subject } : {}),
  };
  check(`opencode mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(want),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}
check('opencode todo snapshot diff matches pin',
  canonicalJson(diffOpencodeTodos(opencode.todos.input.prev, opencode.todos.input.next))
    === canonicalJson(opencode.todos.expected));

// ---- Channel pins: the OpenCode SSE modes (bus event -> event, pure) ---------------
// The mode-policy module vs the sse_modes block, twice per bus moment
// (companion and primary — the OTel-inbound dedup discipline on a second
// vendor). Reconnect, run synthesis, and todo diffing are receiver wiring,
// smoke-pinned in the reference repository.
const { applyMode: applyOpencodeSseMode } = require('../impl/bridge-opencode-sse/mode-policy.js');
for (const [name, c] of Object.entries(opencode.sse_modes.modes)) {
  for (const mode of ['companion', 'primary']) {
    const mapped = applyOpencodeSseMode(opencode.moments[name].input.event, mode);
    const got = mapped === null ? null : {
      type: mapped.type, data: mapped.data,
      ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
    };
    check(`opencode-sse ${mode} ${name} matches pin`,
      canonicalJson(got) === canonicalJson(c[mode]),
      (JSON.stringify(got) ?? 'null').slice(0, 200));
  }
}

// ---- Channel pins: the Kilo Code SSE modes (bus event -> event, pure) --------------
// The fork's own mode-policy vs the kilocode sse_modes block — the published
// bus union is byte-identical to OpenCode's at the pinned versions, so the
// same two-mode discipline rides Kilo's own mapper and x.kilocode.* namespace.
const { applyMode: applyKilocodeSseMode } = require('../impl/bridge-kilocode-sse/mode-policy.js');
const kilocodeFix = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'kilocode.json'), 'utf8'));
for (const [name, c] of Object.entries(kilocodeFix.sse_modes.modes)) {
  for (const mode of ['companion', 'primary']) {
    const mapped = applyKilocodeSseMode(kilocodeFix.moments[name].input.event, mode);
    const got = mapped === null ? null : {
      type: mapped.type, data: mapped.data,
      ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
    };
    check(`kilocode-sse ${mode} ${name} matches pin`,
      canonicalJson(got) === canonicalJson(c[mode]),
      (JSON.stringify(got) ?? 'null').slice(0, 200));
  }
}

// ---- Annex-A mapping pins: the Kilo Code table (moment -> event, pure) -------------
// Kilo Code's CLI core is an OpenCode fork with a byte-identical published
// bus union at the pinned versions (design record) — the same two moment
// shapes ride the fork's own mapper and namespace. Envelope identity, run
// synthesis, and the permission dedupe are runtime state, smoke-pinned in
// the reference repository.
const { mapMoment: mapKilocodeMoment, diffTodos: diffKilocodeTodos } = require('../impl/adapter-kilocode/map-hooks.js');
const kilocode = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'kilocode.json'), 'utf8'));
for (const [name, c] of [...Object.entries(kilocode.moments), ['fallback', kilocode.fallback]]) {
  const mapped = mapKilocodeMoment(c.input);
  const got = mapped === null ? null : {
    type: mapped.type, data: mapped.data,
    ...(mapped.subject !== undefined ? { subject: mapped.subject } : {}),
  };
  const want = c.expected === null ? null : {
    type: c.expected.type, data: c.expected.data,
    ...(c.expected.subject !== undefined ? { subject: c.expected.subject } : {}),
  };
  check(`kilocode mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(want),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}
check('kilocode todo snapshot diff matches pin',
  canonicalJson(diffKilocodeTodos(kilocode.todos.input.prev, kilocode.todos.input.next))
    === canonicalJson(kilocode.todos.expected));

// ---- Annex-A mapping pins: the Cline table (hook -> events, pure) ------------------
// The subprocess hook generation, typed in the published @cline/shared
// package. mapHook returns an ARRAY (agent terminals with a typed parent id
// also close the delegation pair), so each pin compares the whole array.
// Envelope identity, run bookkeeping, and tool-pair causality are runtime
// state, smoke-pinned in the reference repository.
const { mapHook: mapClineHook } = require('../impl/adapter-cline/map-hooks.js');
const cline = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'cline.json'), 'utf8'));
for (const [name, c] of [...Object.entries(cline.hooks), ['fallback', cline.fallback]]) {
  const got = mapClineHook(c.input).map((m) => ({
    type: m.type, data: m.data,
    ...(m.subject !== undefined ? { subject: m.subject } : {}),
    ...(m.step !== undefined ? { step: m.step } : {}),
  }));
  check(`cline mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(c.expected),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Annex-A mapping pins: the Hermes table (envelope -> events, pure) -------------
// The shell-hook generation, pinned against SOURCE at tag v2026.7.7.2 (no
// typed package exists — the design record carries the file:line citations;
// the payloads' telemetry_schema_version string is the drift sentinel).
// mapHook returns an ARRAY; run identity (the REAL per-turn turn_id) and
// the approval pre/post pairing are runtime state, smoke-pinned in the
// reference repository.
const { mapHook: mapHermesHook } = require('../impl/adapter-hermes/map-hooks.js');
const hermes = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'hermes.json'), 'utf8'));
for (const [name, c] of [...Object.entries(hermes.hooks), ['fallback', hermes.fallback]]) {
  const got = mapHermesHook(c.input).map((m) => ({
    type: m.type, data: m.data,
    ...(m.subject !== undefined ? { subject: m.subject } : {}),
  }));
  check(`hermes mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(c.expected),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Annex-A mapping pins: the Antigravity table ((hook, payload) -> events) -------
// The five-hook hooks.json system, docs-pinned (the binary is closed). No
// payload names its own event, so each pin carries the `hook` the
// registration argv supplies; PostToolUse pins carry the daemon's `join`
// result where one exists — the (conversationId, stepIdx) join, session
// first-sight, and run synthesis are runtime state, smoke-pinned in the
// reference repository.
const { mapHook: mapAntigravityHook } = require('../impl/adapter-antigravity/map-hooks.js');
const antigravity = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'antigravity.json'), 'utf8'));
for (const [name, c] of [...Object.entries(antigravity.hooks), ['fallback', antigravity.fallback]]) {
  const got = mapAntigravityHook(c.hook, c.input, { join: c.join ?? null }).map((m) => ({
    type: m.type, data: m.data,
    ...(m.subject !== undefined ? { subject: m.subject } : {}),
    ...(m.step !== undefined ? { step: m.step } : {}),
  }));
  check(`antigravity mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(c.expected),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
}

// ---- Annex-A mapping pins: the pi table (extension-bus event -> event, pure) -------
// The in-process extension bus, verified against the published types in
// @earendil-works/pi-coding-agent@0.80.6. Each pin checks mapEvent at the
// adapter default posture; entries whose behavior forks under the
// AEP_PI_DELTAS opt-in carry deltas_expected. Identity (ctx.sessionManager
// -> session), run synthesis per agent loop, and toolCallId causality are
// runtime state, smoke-pinned in this repository.
const { mapEvent: mapPiEvent } = require('../impl/adapter-pi/map-events.js');
const piFix = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'pi.json'), 'utf8'));
for (const [name, c] of [...Object.entries(piFix.moments), ['fallback', piFix.fallback]]) {
  const shape = (r) => r === null ? null : {
    type: r.type, data: r.data,
    ...(r.subject !== undefined ? { subject: r.subject } : {}),
    ...(r.step !== undefined ? { step: r.step } : {}),
  };
  check(`pi mapping ${name} matches pin`,
    canonicalJson(shape(mapPiEvent(c.input))) === canonicalJson(c.expected),
    (JSON.stringify(shape(mapPiEvent(c.input))) ?? 'null').slice(0, 200));
  if (c.deltas_expected !== undefined) {
    check(`pi mapping ${name} (deltas opt-in) matches pin`,
      canonicalJson(shape(mapPiEvent(c.input, { deltas: true }))) === canonicalJson(c.deltas_expected));
  }
}

// ---- Annex-A mapping pins: the ACP table (moment -> events, pure) ------------------
// The editor<->agent protocol observed through the command-substitution tee.
// The tee reduces the wire to moments (responses joined by JSON-RPC id —
// runtime state); mapMoment returns an ARRAY, and the chunk moments fork
// under the deltas opt-in (deltas_expected, the AG-UI shape). Identity,
// pairing, and byte-transparency are tee wiring, smoke-pinned in the
// reference repository.
const { mapMoment: mapAcpMoment } = require('../impl/bridge-acp/map-frames.js');
const acp = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'acp.json'), 'utf8'));
for (const [name, c] of [...Object.entries(acp.moments), ['fallback', acp.fallback]]) {
  const got = mapAcpMoment(c.input).map((m) => ({
    type: m.type, data: m.data,
    ...(m.subject !== undefined ? { subject: m.subject } : {}),
  }));
  check(`acp mapping ${name} matches pin`,
    canonicalJson(got) === canonicalJson(c.expected),
    (JSON.stringify(got) ?? 'null').slice(0, 200));
  if (c.deltas_expected) {
    const forked = mapAcpMoment(c.input, { deltas: true, ceiling: 'redacted' }).map((m) => ({
      type: m.type, data: m.data,
      ...(m.subject !== undefined ? { subject: m.subject } : {}),
    }));
    check(`acp mapping ${name} deltas fork matches pin`,
      canonicalJson(forked) === canonicalJson(c.deltas_expected),
      (JSON.stringify(forked) ?? 'null').slice(0, 200));
  }
}

// ---- Annex-A mapping pins: the AG-UI table (event -> event, pure) ------------------
// The first protocol-source mapping: pins at the default posture plus the
// deltas_expected fork where the AEP_AGUI_DELTAS opt-in changes behavior.
// Identity (real vendor ids, stream-scoped) and the runtime joins are
// receiver wiring, smoke-pinned in the reference repository.
const { mapEvent: mapAguiEvent } = require('../impl/bridge-agui/map-events.js');
const agui = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'agui.json'), 'utf8'));
for (const [name, c] of [...Object.entries(agui.events), ['fallback', agui.fallback]]) {
  const shape = (r) => r === null ? null : {
    type: r.type, data: r.data,
    ...(r.subject !== undefined ? { subject: r.subject } : {}),
    ...(r.step !== undefined ? { step: r.step } : {}),
  };
  check(`agui mapping ${name} matches pin`,
    canonicalJson(shape(mapAguiEvent(c.input))) === canonicalJson(c.expected),
    (JSON.stringify(shape(mapAguiEvent(c.input))) ?? 'null').slice(0, 200));
  if (c.deltas_expected !== undefined) {
    check(`agui mapping ${name} (deltas opt-in) matches pin`,
      canonicalJson(shape(mapAguiEvent(c.input, { deltas: true }))) === canonicalJson(c.deltas_expected));
  }
}

// ---- Annex-A mapping pins: the OpenHands agent-server table (event -> event, pure) --
// The third protocol-source mapping: transport-shaped inputs (event_transport_dump
// — no parent_id, exclude_none) pinned at the default posture plus the
// deltas_expected forks, and the pure statusMoments transition table behind run
// synthesis and the attention legs. Socket wiring (conversation_id scoping,
// replay + dedupe, the never-send auth-frame-only posture) is receiver state,
// smoke-pinned in the reference repository.
const { mapEvent: mapOpenhandsEvent, statusMoments: openhandsStatusMoments } = require('../impl/bridge-openhands/map-events.js');
const openhands = JSON.parse(fs.readFileSync(path.join(FIX, 'mappings', 'openhands.json'), 'utf8'));
for (const [name, c] of [...Object.entries(openhands.events), ['fallback', openhands.fallback]]) {
  const shape = (r) => r === null ? null : {
    type: r.type, data: r.data,
    ...(r.subject !== undefined ? { subject: r.subject } : {}),
    ...(r.step !== undefined ? { step: r.step } : {}),
  };
  check(`openhands mapping ${name} matches pin`,
    canonicalJson(shape(mapOpenhandsEvent(c.input))) === canonicalJson(c.expected),
    (JSON.stringify(shape(mapOpenhandsEvent(c.input))) ?? 'null').slice(0, 200));
  if (c.deltas_expected !== undefined) {
    check(`openhands mapping ${name} (deltas opt-in) matches pin`,
      canonicalJson(shape(mapOpenhandsEvent(c.input, { deltas: true }))) === canonicalJson(c.deltas_expected));
  }
}
for (const [name, t] of Object.entries(openhands.status_transitions)) {
  check(`openhands status transition ${name} matches pin`,
    canonicalJson(openhandsStatusMoments(t.prev, t.next)) === canonicalJson(t.expected),
    JSON.stringify(openhandsStatusMoments(t.prev, t.next)).slice(0, 200));
}

// ---- OTLP projection vs pins (JS impl; run.py holds its independent one) --------
const { toOtlp } = require('../impl/shared/otlp.js');
const otlpPins = JSON.parse(fs.readFileSync(path.join(FIX, 'otlp', 'otlp-expected.json'), 'utf8'));
const OTLP_CASES = Object.keys(otlpPins).map(Number);
for (const i of OTLP_CASES) {
  check(`OTLP projection[${i}] matches pin (${golden[i].type})`,
    canonicalJson(toOtlp(golden[i])) === canonicalJson(otlpPins[String(i)]));
}

// ---- OCSF projection vs pins (inline JS impl — no runtime bridge exists;
// run.py holds its independent one; AEP-0005 §4) ----------------------------------
const ocsfClasses = JSON.parse(fs.readFileSync(path.join(FIX, 'ocsf', 'ocsf-classes.json'), 'utf8'));
const ocsfSeverity = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'schemas', 'registry', 'severity.json'), 'utf8')).ocsf;
// (class_uid, category_uid, activity_id, fixed status/disposition) per §4.2/§4.5
const OCSF_MAP = {
  'session.started':     [3002, 3, 1, { status_id: 1 }],
  'session.ended':       [3002, 3, 2, { status_id: 1 }],
  'tool.requested':      [1007, 1, 1, {}],
  'tool.completed':      [1007, 1, 2, { status_id: 1 }],
  'tool.failed':         [1007, 1, 2, { status_id: 2 }],
  'tool.denied':         [1007, 1, 1, { status_id: 2, disposition_id: 2 }],
  'attention.requested': [2004, 2, 1, { status_id: 1 }],
  'attention.answered':  [2004, 2, 2, { status_id: 2 }],
  'attention.resolved':  [2004, 2, 3, { status_id: 4 }],
  'attention.timeout':   [2004, 2, 3, { disposition_id: 16 }],
};
function toOcsf(ev, maxCapture = 'metadata') {
  const m = OCSF_MAP[ev.type];
  if (!m) return null;
  const [classUid, categoryUid, activityId, fixed] = m;
  const order = ['none', 'metadata', 'redacted', 'full'];
  let data = ev.data ?? {};
  if (order.indexOf(ev.capture ?? 'metadata') > order.indexOf(maxCapture)) data = {};
  const env = {};
  for (const [k, v] of Object.entries(ev)) if (k !== 'data') env[k] = v;
  const rec = {
    class_uid: classUid, category_uid: categoryUid,
    activity_id: activityId, type_uid: classUid * 100 + activityId,
    time: Date.parse(ev.time),
    severity_id: ocsfSeverity[ev.severity ?? 'info'],
    message: ev.type,
    metadata: { version: ocsfClasses.version, uid: ev.id, original_time: ev.time,
                product: { name: ev.agent } },
    unmapped: { aep: env },
    ...fixed,
  };
  if ('cause' in ev) rec.metadata.correlation_uid = ev.cause;
  if (classUid === 3002) {
    rec.user = { name: ev.agent };
    rec.session = { uid: ev.session };
  } else if (classUid === 1007) {
    rec.actor = { app_name: ev.agent };
    const host = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/.exec(ev.source);
    rec.device = host ? { type_id: 0, hostname: host[1] } : { type_id: 0, name: ev.source };
    rec.process = { name: ev.subject };
    if (data.tool?.call_id) rec.process.uid = data.tool.call_id;
  } else { // 2004 — finding_info.uid = the attention-request id (AEP-0002 §5)
    rec.finding_info = {
      uid: ev.type === 'attention.requested' ? ev.id : ev.subject,
      title: ev.type,
    };
    if (ev.type === 'attention.resolved' && data.resolution === 'dismissed') rec.disposition_id = 16;
  }
  if ('disposition_id' in rec) rec.metadata.profiles = ['security_control']; // the disposition rides the security_control profile
  if (Object.keys(data).length) rec.unmapped.data = data;
  return rec;
}
const ocsfPins = JSON.parse(fs.readFileSync(path.join(FIX, 'ocsf', 'ocsf-expected.json'), 'utf8'));
for (const i of Object.keys(ocsfPins).map(Number)) {
  const rec = toOcsf(golden[i]);
  check(`OCSF projection[${i}] matches pin (${golden[i].type})`,
    canonicalJson(rec) === canonicalJson(ocsfPins[String(i)]));
  const cls = ocsfClasses.classes[String(rec.class_uid)];
  const unknown = Object.keys(rec).filter((k) => !cls.attributes.includes(k));
  check(`OCSF projection[${i}] uses only class attributes`, unknown.length === 0, unknown.join(','));
  check(`OCSF projection[${i}] ids are enum-legal and type_uid is derived`,
    rec.category_uid === cls.category_uid
    && String(rec.activity_id) in cls.activity
    && String(rec.severity_id) in cls.severity
    && rec.type_uid === rec.class_uid * 100 + rec.activity_id
    && (!('status_id' in rec) || String(rec.status_id) in cls.status)
    && (!('disposition_id' in rec) || String(rec.disposition_id) in cls.disposition));
}
check('OCSF severity table complete',
  ['debug', 'info', 'notice', 'warning', 'error', 'critical'].every((l) => l in ocsfSeverity));
check('OCSF honesty rule: answered resolution carries no disposition',
  !('disposition_id' in toOcsf(golden[9])));
check('OCSF unmapped families produce no record',
  toOcsf(golden[25]) === null && toOcsf(golden[5]) === null);

// ---- bridge daemons, offline mode, against the same pins -------------------------
const goldenPath = path.join(FIX, 'golden', 'golden.jsonl');
const ceDaemon = spawnSync('node',
  [path.join(__dirname, '..', 'impl', 'bridge-ce', 'bridge.js'), '--from-file', goldenPath],
  { encoding: 'utf8' });
const ceOut = (ceDaemon.stdout ?? '').split('\n').filter((l) => l.trim());
check('aep-bridge-ce --from-file emits one CE per golden event',
  ceDaemon.status === 0 && ceOut.length === golden.length, ceDaemon.stderr?.slice(0, 200));
ceOut.forEach((line, i) => {
  check(`aep-bridge-ce output[${i}] matches CE pin`,
    canonicalJson(JSON.parse(line)) === canonicalJson(pins[i]));
});
const otlpDaemon = spawnSync('node',
  [path.join(__dirname, '..', 'impl', 'bridge-otlp', 'bridge.js'), '--from-file', goldenPath],
  { encoding: 'utf8' });
const otlpOut = (otlpDaemon.stdout ?? '').split('\n').filter((l) => l.trim());
check('aep-bridge-otlp --from-file emits one record per golden event',
  otlpDaemon.status === 0 && otlpOut.length === golden.length, otlpDaemon.stderr?.slice(0, 200));
for (const i of OTLP_CASES) {
  check(`aep-bridge-otlp output[${i}] matches OTLP pin`,
    canonicalJson(JSON.parse(otlpOut[i])) === canonicalJson(otlpPins[String(i)]));
}

human(`\n${failures === 0 ? 'OK' : 'FAILED'}: ${failures} failure(s)`);
if (JSON_OUT !== null) {
  const checks = results.map((r) => {
    const c = { name: r.name, status: r.ok ? 'pass' : 'fail' };
    if (r.detail) c.detail = r.detail;
    return c;
  });
  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    skip: 0,
    total: checks.length,
  };
  const report = {
    format: 'aep-conformance-report',
    formatVersion: 1,
    aep: '0.1',
    tool: 'run-js',
    target: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    summary,
    ok: summary.fail === 0,
  };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (JSON_STDOUT) process.stdout.write(text);
  else fs.writeFileSync(JSON_OUT, text);
}
process.exit(failures === 0 ? 0 : 1);
