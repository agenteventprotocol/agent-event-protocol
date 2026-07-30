#!/usr/bin/env node
// gen-agents.js — generates the two agents matrix pages:
//
//   docs/agents/feature-matrix.md   (event coverage, several granularities)
//   docs/agents/control-matrix.md   (control loop, forms, steering boundary)
//
// Inputs, deliberately split so neither can go stale alone:
//   - conformance/fixtures/mappings/*.json — fixture-pinned event coverage
//     is DERIVED from the corpus, never restated by hand
//   - docs/data/agents.json — the reviewed capability record (channels,
//     ports, hello control declarations, vendor ceilings), every cell
//     traceable to a component doc, design record, or vendor-surfaces.md
//
// Usage:  node docs/gen-agents.js          (re)write both pages
//         node docs/gen-agents.js --check  fail if committed pages differ
//
// The generated pages carry a marker and are exempt from the prose lint
// checks (like the specification/community mirrors); mermaid and link
// checks still apply to them.
'use strict';
const fs = require('fs');
const path = require('path');

const DOCS = __dirname;
const MAPPINGS = path.join(DOCS, '..', 'conformance', 'fixtures', 'mappings');
const DATA = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'agents.json'), 'utf8'));

const REPO = 'https://github.com/agenteventprotocol/agent-event-protocol/blob/main';
const REF_REPO = 'https://github.com/agenteventprotocol/reference/tree/main/impl';

const CORE_FAMILIES = ['session', 'run', 'tool', 'attention', 'progress', 'delegation', 'state', 'error', 'agent'];
const TYPE_RE = /^(session|run|tool|attention|progress|delegation|state|error|agent|message|control|resource)\.[a-z0-9_.-]+$|^x\.[a-z0-9-]+\.[a-z0-9_.-]+$/;

// Collect every AEP event type pinned on the expected side of a fixture
// file. Expected slots across the corpus: `expected*` keys (hook/moment
// tables) and the OTel table's `companion`/`primary` slots.
function collectTypes(node, inExpected, out) {
  if (Array.isArray(node)) { for (const v of node) collectTypes(v, inExpected, out); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const now = inExpected || k.startsWith('expected') || k === 'companion' || k === 'primary';
      if (now && k === 'type' && typeof v === 'string' && TYPE_RE.test(v)) out.add(v);
      collectTypes(v, now, out);
    }
  }
}

// Tables that pin MECHANISMS, not feature span: `fallback`/`unknown` assert
// how a wholly novel vendor moment would map (with a synthetic name), so
// they never count toward a source's coverage.
const MECHANISM_TABLES = new Set(['$comment', 'identity', 'fallback', 'unknown']);

function fixtureTypes(file, scope) {
  const doc = JSON.parse(fs.readFileSync(path.join(MAPPINGS, file), 'utf8'));
  const out = new Set();
  for (const [key, tableValue] of Object.entries(doc)) {
    if (MECHANISM_TABLES.has(key)) continue;
    if (scope && scope.include && !scope.include.includes(key)) continue;
    if (scope && scope.exclude && scope.exclude.includes(key)) continue;
    collectTypes(tableValue, false, out);
  }
  return out;
}

// Per-source coverage: fixture-pinned (from the corpus, plus the data
// file's explicit override where a fixture file is not a full mapping
// table) and documented-only (shipped coverage the component doc states
// but no fixture pins — Claude Code's live-validated set).
function coverage(src) {
  const pinned = new Set(src.fixturePinned || []);
  if (!src.fixturePinned) for (const t of fixtureTypes(src.fixture, src.fixtureScope)) pinned.add(t);
  const documented = new Set();
  for (const t of src.documentedTypes || []) if (!pinned.has(t)) documented.add(t);
  return { pinned, documented };
}

const cov = new Map(DATA.sources.map((s) => [s.id, coverage(s)]));

function mark(src, type) {
  const c = cov.get(src.id);
  if (c.pinned.has(type)) return '●';
  if (c.documented.has(type)) return '○';
  return ' ';
}
function familyMark(src, family) {
  const c = cov.get(src.id);
  const inFam = (t) => t.split('.')[0] === family;
  if ([...c.pinned].some(inFam)) return '●';
  if ([...c.documented].some(inFam)) return '○';
  return ' ';
}
function extTypes(src) {
  const c = cov.get(src.id);
  return [...c.pinned].filter((t) => t.startsWith('x.')).sort();
}
function coreTypesInUse() {
  const all = new Set();
  for (const s of DATA.sources) {
    const c = cov.get(s.id);
    for (const t of [...c.pinned, ...c.documented]) if (!t.startsWith('x.')) all.add(t);
  }
  return all;
}

function sourceLink(s) {
  return s.designRecord ? `[${s.name}](${s.designRecord})` : `[${s.name}](/components/${s.kind === 'agent' ? 'adapters' : 'bridges'})`;
}
function fixtureLink(s) {
  return `[\`${s.fixture}\`](${REPO}/conformance/fixtures/mappings/${s.fixture})`;
}
function implLink(s) {
  return `[\`impl/${s.impl}\`](${REF_REPO}/${s.impl})`;
}
function kindLabel(s) { return s.kind === 'agent' ? 'Agent adapter' : 'Inbound bridge'; }
function validationLabel(s) { return s.validation === 'live' ? 'live-validated' : 'fixture-proven'; }

function controlCell(s) {
  const c = s.control;
  if (c.answerable && c.answerable.length) return `answers \`${c.answerable.join('`, `')}\``;
  if (c.observedAttention && c.observedAttention.length) return `observes \`${c.observedAttention.join('`, `')}\``;
  return 'n/a';
}

function table(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

const LEGEND = 'Legend: `●` fixture-pinned (the mapping table in `conformance/fixtures/mappings/` asserts it) · `○` shipped and documented at the component doc, not fixture-pinned · blank = not emitted by this source.';

// ---------------------------------------------------------------- page 1
function featureMatrixPage() {
  const out = [];
  out.push('---');
  out.push('title: "Agent feature matrix"');
  out.push('sidebarTitle: "Feature matrix"');
  out.push('description: "What every adopted source emits, at several granularities; derived from the conformance fixture corpus plus the reviewed capability record, regenerated by docs/gen-agents.js."');
  out.push('---');
  out.push('');
  out.push('{/* GENERATED by docs/gen-agents.js from conformance/fixtures/mappings/*.json + docs/data/agents.json; do not edit. Edit the inputs and re-run `node docs/gen-agents.js` */}');
  out.push('');
  out.push('Coverage below is **derived**, not asserted: the per-type grids come from');
  out.push('the [conformance mapping fixtures](' + REPO + '/conformance/fixtures/mappings)');
  out.push('that CI runs on every commit, and the capability columns come from the');
  out.push('reviewed record behind this page ([`docs/data/agents.json`](' + REPO + '/docs/data/agents.json)).');
  out.push('How each cell earned its place is the [vendor surfaces](/vendor-surfaces) page\'s job;');
  out.push('the control side has its own [control matrix](/agents/control-matrix).');
  out.push('');
  out.push(LEGEND);
  out.push('');
  out.push('One reading note: the grids assert what each source\'s **mapping tables**');
  out.push('pin: vendor moments landing on AEP types. The fixture `fallback` tables');
  out.push('(how a wholly novel vendor moment would map) pin a mechanism, not feature');
  out.push('span, so they are excluded. A blank family cell is itself feature-span');
  out.push('information: it means the vendor surface exposes no moment of that family');
  out.push('for the mapping to ride.');
  out.push('');
  out.push('## Coverage at a glance');
  out.push('');
  out.push(table(
    ['Source', 'Class', 'Channel', 'Control loop', 'Forms', 'Validation', 'Mapping fixture'],
    DATA.sources.map((s) => [
      sourceLink(s),
      kindLabel(s),
      s.channel,
      controlCell(s),
      s.forms ? '`form` (AEP-0006)' : 'n/a',
      validationLabel(s),
      fixtureLink(s),
    ])
  ));
  out.push('');
  out.push('## Event coverage');
  out.push('');
  out.push('<Tabs>');
  out.push('<Tab title="By family">');
  out.push('');
  out.push(table(
    ['Source', ...CORE_FAMILIES.map((f) => `\`${f}\``), 'vendor `x.*`'],
    DATA.sources.map((s) => [
      s.name,
      ...CORE_FAMILIES.map((f) => familyMark(s, f)),
      String(extTypes(s).length || ' '),
    ])
  ));
  out.push('');
  out.push('</Tab>');

  const groups = [
    ['Session and run', ['session.started', 'session.ended', 'session.compacted', 'run.started', 'run.finished', 'run.failed', 'run.cancelled', 'run.step.started', 'run.step.finished']],
    ['Tools and attention', ['tool.requested', 'tool.completed', 'tool.failed', 'tool.denied', 'attention.requested', 'attention.answered', 'attention.resolved', 'attention.timeout']],
    ['Progress, delegation, state', ['progress.status', 'progress.task.planned', 'progress.task.completed', 'delegation.subagent.started', 'delegation.subagent.stopped', 'state.snapshot', 'state.delta', 'error.raised', 'agent.idle']],
  ];
  const known = new Set(groups.flatMap(([, ts]) => ts));
  for (const t of coreTypesInUse()) {
    if (!known.has(t)) throw new Error(`gen-agents: core type ${t} in the corpus is not placed in any granularity group — add it`);
  }
  for (const [title, types] of groups) {
    out.push(`<Tab title="${title}">`);
    out.push('');
    out.push(table(
      ['Source', ...types.map((t) => `\`${t}\``)],
      DATA.sources.map((s) => [s.name, ...types.map((t) => mark(s, t))])
    ));
    out.push('');
    out.push('</Tab>');
  }
  out.push('</Tabs>');
  out.push('');
  out.push('## Vendor extension types, per source');
  out.push('');
  out.push('Everything a source exposes beyond the core taxonomy rides its vendor');
  out.push('namespace unchanged; the count is a feature-span signal, not noise.');
  out.push('');
  out.push('<AccordionGroup>');
  for (const s of DATA.sources) {
    const ext = extTypes(s);
    out.push(`<Accordion title="${s.name}: ${ext.length} fixture-pinned extension type${ext.length === 1 ? '' : 's'}">`);
    out.push('');
    if (ext.length) for (const t of ext) out.push(`- \`${t}\``);
    else out.push(`No vendor extension types are fixture-pinned for this source${s.fixtureNote ? ` (${s.fixtureNote})` : ''}.`);
    out.push('');
    if (s.fixtureNote && ext.length) out.push(`Note: ${s.fixtureNote}.`);
    if (s.fixtureNote && ext.length) out.push('');
    out.push('</Accordion>');
  }
  out.push('</AccordionGroup>');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------- page 2
function controlMatrixPage() {
  const out = [];
  out.push('---');
  out.push('title: "Control and interaction matrix"');
  out.push('sidebarTitle: "Control matrix"');
  out.push('description: "Which sources answer, which only observe, and where each vendor\'s ceiling sits: the control loop, the form loop, and the steering boundary, regenerated by docs/gen-agents.js."');
  out.push('---');
  out.push('');
  out.push('{/* GENERATED by docs/gen-agents.js from conformance/fixtures/mappings/*.json + docs/data/agents.json; do not edit. Edit the inputs and re-run `node docs/gen-agents.js` */}');
  out.push('');
  out.push('Control in AEP is declarative and opt-in: a target says what it accepts in');
  out.push('its `hello` `control.accepts` list, consumers send only that, and every');
  out.push('command is acknowledged and answered by `cause`-linked outcome Events');
  out.push('([AEP-0004](/specification/draft/aep-0004-control-profile)). A source that');
  out.push('declares nothing is not broken; observe-only is a per-vendor honesty');
  out.push('decision, recorded with its reason in the tables below.');
  out.push('');
  out.push('## The control loop');
  out.push('');
  out.push('```mermaid');
  out.push('sequenceDiagram');
  out.push('    participant V as Vendor agent');
  out.push('    participant A as Adapter');
  out.push('    participant R as Relay');
  out.push('    participant C as Consumer');
  out.push('    V->>A: permission moment<br/>(hook held open)');
  out.push('    A->>R: attention.requested<br/>(kind permission)');
  out.push('    R->>C: attention.requested');
  out.push('    C->>R: control.attention.respond<br/>(cause = request id)');
  out.push('    R->>A: command, delivered<br/>to one target');
  out.push('    A->>R: ack (control.accepted)');
  out.push('    A->>V: decision (allow or deny)');
  out.push('    A->>R: attention.answered,<br/>attention.resolved');
  out.push('```');
  out.push('');
  out.push('## Command support');
  out.push('');
  out.push(table(
    ['Source', '`hello` `control.accepts`', 'Answerable kinds', 'Ack window', 'Observed-only attention', 'Vendor-side cancel', '`tool.denied` facts'],
    DATA.sources.map((s) => {
      const c = s.control;
      return [
        sourceLink(s),
        (c.accepts.length ? '`' + c.accepts.join('`, `') + '`' : (c.ackWindowMs === null ? 'n/a (no `control` block)' : '`[]` (declared read-only)'))
          + (c.optInAccepts ? ' + opt-in: ' + c.optInAccepts.join(', ') : ''),
        c.answerable.length ? '`' + c.answerable.join('`, `') + '`' : 'n/a',
        c.accepts.length && c.ackWindowMs ? `${c.ackWindowMs} ms` : 'n/a',
        c.observedAttention.length ? '`' + c.observedAttention.join('`, `') + '`' : 'n/a',
        c.vendorCancel || 'n/a',
        c.toolDenied || 'n/a',
      ];
    })
  ));
  out.push('');
  out.push('Two targets accept `control.cancel` today, both opt-in: Cline through its');
  out.push("hub control channel, where the vendor's abort verb returns as its own hook");
  out.push('fact cause-linked to the command, and the OpenCode SSE bridge in primary');
  out.push("mode, where the server's `session.abort` ends the in-flight work and the");
  out.push("vendor's own idle boundary closes the synthesized run as `run.cancelled`.");
  out.push('Every other cancellation fact in the table is a **vendor-side** moment');
  out.push('each mapping reports honestly. The demo synthetic agent remains the');
  out.push('reference implementation of a cancel-capable target, and consumers surface');
  out.push('a nack from any non-accepting target as the correct, sovereign answer.');
  out.push('');
  out.push('`control.pause`/`control.resume` have their first real target: the');
  out.push('OpenHands bridge, opt-in, the one source whose vendor documents lifecycle');
  out.push("pause/run calls. The paused state returns as the vendor's own status");
  out.push('fact riding `state.delta`, cause-linked to the command, and the refusals');
  out.push('are load-bearing: a resume is refused where it would start new work or');
  out.push('silently accept a pending confirmation.');
  out.push('');
  out.push('## The form loop');
  out.push('');
  const formSources = DATA.sources.filter((s) => s.forms);
  out.push('```mermaid');
  out.push('sequenceDiagram');
  out.push('    participant V as Vendor agent');
  out.push('    participant A as Adapter');
  out.push('    participant C as Consumer');
  out.push('    V->>A: structured question<br/>(multi-field)');
  out.push('    A->>C: attention.requested<br/>(kind form, field_spec)');
  out.push('    C->>A: control.attention.respond<br/>(values)');
  out.push('    A->>V: validated values');
  out.push('    A->>C: attention.answered,<br/>attention.resolved');
  out.push('```');
  out.push('');
  out.push('Structured input requests ([AEP-0006](/specification/draft/aep-0006-structured-input-requests))');
  out.push('carry a typed `field_spec` so a consumer can render real forms and answer');
  out.push('with validated `values`; invalid values earn `control.rejected` with the');
  out.push('request kept pending.');
  out.push('');
  out.push(table(
    ['Source', 'Form loop today'],
    DATA.sources.map((s) => [s.name, s.forms || 'n/a'])
  ));
  out.push('');
  if (formSources.length) {
    out.push(`Today ${formSources.map((s) => s.name).join(', ')} ${formSources.length === 1 ? 'is' : 'are'} the form-loop source${formSources.length === 1 ? '' : 's'}; the loop itself is generic: any source whose vendor exposes a structured question surface adopts it without new protocol work.`);
    out.push('');
    out.push('A form loop is ANSWERABLE exactly when the vendor consumes an injected');
    out.push('answer (eligibility is a consumption property); where the ask and its');
    out.push('answer are only observable, the card declares `respond_via: ["oob"]` and');
    out.push('the vendor-delivered answer still rides `attention.answered` via `oob`;');
    out.push('the diagram above shows the answerable shape, and the observed shape');
    out.push('replaces the two middle arrows with the vendor asking its own user.');
    out.push('');
  }
  out.push('## Where the steering boundary sits');
  out.push('');
  out.push('Most vendors expose surfaces that could *drive* the agent: context');
  out.push('injection, input rewriting, mid-run messages. The mappings deliberately');
  out.push('leave them unused: an observer that silently changes what it observes has');
  out.push('broken the capture-honesty contract. They are catalogued here because the');
  out.push('boundary is part of the protocol\'s claim to honesty; where one IS');
  out.push('exercised (the SHIPPED rows below), it arrives as an explicit, declared,');
  out.push('commanded, opt-in capability (the vendor-scoped verb path of');
  out.push('[AEP-0004 §5](/specification/draft/aep-0004-control-profile) and the');
  out.push('[steering design record](/components/control-steering-design)), never as');
  out.push('a side effect.');
  out.push('');
  out.push(table(
    ['Source', 'Vendor steering surface and its use', 'Ceiling and headroom'],
    DATA.sources.map((s) => [sourceLink(s), s.steering || 'n/a', s.headroom || 'n/a'])
  ));
  out.push('');
  out.push('Implementation homes: ' + DATA.sources.map((s) => implLink(s)).filter((v, i, a) => a.indexOf(v) === i).join(' · ') + '.');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------- main
const pages = {
  'agents/feature-matrix.md': featureMatrixPage(),
  'agents/control-matrix.md': controlMatrixPage(),
};

const check = process.argv.includes('--check');
let failed = false;
for (const [rel, content] of Object.entries(pages)) {
  const file = path.join(DOCS, rel);
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== content) { console.error(`gen-agents: STALE ${rel} — run \`node docs/gen-agents.js\``); failed = true; }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`gen-agents: wrote ${rel}`);
  }
}
if (check && failed) process.exit(1);
if (check) console.log('gen-agents: pages current (2)');
