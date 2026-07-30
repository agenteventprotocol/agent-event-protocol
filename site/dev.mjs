// Dev loop for the docs site: watch, rebuild the stages the change feeds,
// reload the browser. Sources reach past docs/, so the watcher does too.
// editing spec/*.md or CHANGELOG.md refreshes the open page:
//
//   spec/*.md, root governance + CHANGELOG   -> render-site.js
//   mappings/*.json, docs/data/agents.json   -> gen-agents.js
//   docs/**, site/assets/**, site/*.mjs -> build.mjs
//
// Stages run as child processes: a build is ~1.3s, and the fresh module graph
// means build.mjs / mdx.mjs / nav.mjs edits apply without a restart and a
// crashing build cannot take the watcher with it.
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve, relative, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const DOCS = join(REPO, "docs");
const SPEC = join(REPO, "spec");
const MAPPINGS = join(REPO, "conformance", "fixtures", "mappings");
const ASSETS = join(__dirname, "assets");

const RENDER = "render-site";
const AGENTS = "gen-agents";
const BUILD = "build";

const DEBOUNCE_MS = 120;

// Borrow render-site.js's own manifest so both lists below track it.
const require = createRequire(import.meta.url);
const { SPEC_PAGES, COMMUNITY_PAGES } = require(join(DOCS, "render-site.js"));

// Generator output. Ignored by the watcher: it only ever changes because a
// stage below just wrote it, so watching it would rebuild in a loop.
const GENERATED = new Set([
  ...SPEC_PAGES.map((p) => join(DOCS, p.out)),
  ...COMMUNITY_PAGES.map((p) => join(DOCS, p.out)),
  // gen-agents.js writes exactly these two (its PAGES table).
  join(DOCS, "agents", "feature-matrix.md"),
  join(DOCS, "agents", "control-matrix.md"),
]);

// render-site.js's root-level sources; its spec/ ones are covered by that tree.
const ROOT_SOURCES = new Set(COMMUNITY_PAGES.map((p) => join(REPO, p.src)));

const AGENTS_DATA = join(DOCS, "data", "agents.json");
const SITE_BUILD_FILES = new Set(["build.mjs", "mdx.mjs", "nav.mjs"]);
const DEV_OWN_FILES = new Set(["dev.mjs", "serve.mjs"]);

// Editor scratch: dotfiles, vim swap/backup and its `4913` probe, emacs locks.
const IGNORED_NAME = /^[.#]|[~#]$|\.(swp|swx|tmp)$|^\d+$/;

const within = (root, abs) => abs === root || abs.startsWith(root + "/");

// Stages a changed path feeds, or null if it cannot affect the site.
function stagesFor(abs) {
  if (IGNORED_NAME.test(basename(abs))) return null;
  if (GENERATED.has(abs)) return null;

  if (within(DOCS, abs)) {
    if (abs === AGENTS_DATA || abs === join(DOCS, "gen-agents.js")) return [AGENTS, BUILD];
    if (abs === join(DOCS, "render-site.js")) return [RENDER, BUILD];
    return [BUILD];
  }
  if (within(SPEC, abs)) return abs.endsWith(".md") ? [RENDER, BUILD] : null;
  if (within(MAPPINGS, abs)) return abs.endsWith(".json") ? [AGENTS, BUILD] : null;
  if (within(ASSETS, abs)) return [BUILD];
  if (ROOT_SOURCES.has(abs)) return [RENDER, BUILD];

  // site/ is watched non-recursively, recursing would watch dist/ and loop.
  if (dirname(abs) === __dirname) {
    if (SITE_BUILD_FILES.has(basename(abs))) return [BUILD];
    if (DEV_OWN_FILES.has(basename(abs))) {
      log(`${basename(abs)} changed — restart \`pnpm dev\` to pick it up`);
    }
  }
  return null;
}

const WATCH_ROOTS = [
  { dir: DOCS, recursive: true, shown: "docs/**" },
  { dir: SPEC, recursive: true, shown: "spec/**" },
  { dir: MAPPINGS, recursive: true, shown: "conformance/fixtures/mappings/**" },
  { dir: ASSETS, recursive: true, shown: "site/assets/**" },
  { dir: __dirname, recursive: false, shown: "site/{build,mdx,nav}.mjs" },
  { dir: REPO, recursive: false, shown: [...ROOT_SOURCES].map((p) => relative(REPO, p)).join(" ") },
];

const rel = (abs) => relative(REPO, abs) || ".";
const log = (msg) => console.log(`[dev] ${msg}`);

let server = null;
let child = null;

function run(label, script, { quiet }) {
  return new Promise((done) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      child = null;
      done(ok);
    };
    // Routine stdout is noise on every keystroke: buffer it, replay only on
    // failure. stderr (warnings, errors) always passes through.
    const proc = spawn(process.execPath, [script], {
      cwd: REPO,
      stdio: ["ignore", quiet ? "pipe" : "inherit", "inherit"],
    });
    child = proc;
    let out = "";
    proc.stdout?.on("data", (d) => {
      out += d;
    });
    proc.once("error", (e) => {
      console.error(`[dev] ✗ ${label}: ${e.message}`);
      finish(false);
    });
    proc.once("close", (code, signal) => {
      if (code === 0) return finish(true);
      if (signal) return finish(false); // killed on shutdown
      if (out) process.stdout.write(out);
      console.error(`[dev] ✗ ${label} failed (exit ${code}) — keeping the last good build`);
      finish(false);
    });
  });
}

async function runPipeline(stages, { quiet = true } = {}) {
  const t0 = process.hrtime.bigint();
  if (stages.has(RENDER) && !(await run(RENDER, join(DOCS, "render-site.js"), { quiet })))
    return false;
  if (stages.has(AGENTS) && !(await run(AGENTS, join(DOCS, "gen-agents.js"), { quiet })))
    return false;
  if (!(await run(BUILD, join(__dirname, "build.mjs"), { quiet }))) return false;

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const tabs = server ? server.notifyReload() : 0;
  log(`rebuilt in ${ms.toFixed(0)}ms${tabs ? ` — reloaded ${tabs} tab${tabs > 1 ? "s" : ""}` : ""}`);
  return true;
}

let pending = new Set();
let timer = null;
let running = false;

async function drain() {
  timer = null;
  if (running || !pending.size) return;
  running = true;
  const stages = pending;
  pending = new Set();
  try {
    await runPipeline(stages);
  } finally {
    running = false;
    // Edits that landed mid-build get one coalesced follow-up.
    if (pending.size && !timer) timer = setTimeout(drain, DEBOUNCE_MS);
  }
}

function onChange(abs) {
  const stages = stagesFor(abs);
  if (!stages) return;
  if (!pending.size) log(`${rel(abs)} changed`);
  for (const s of stages) pending.add(s);
  clearTimeout(timer);
  timer = setTimeout(drain, DEBOUNCE_MS);
}

const watchers = [];

function watchAll() {
  for (const { dir, recursive } of WATCH_ROOTS) {
    try {
      const w = watch(dir, { recursive }, (_event, filename) => {
        if (filename) onChange(join(dir, filename));
      });
      w.on("error", (e) => console.error(`[dev] watch error on ${rel(dir)}: ${e.message}`));
      watchers.push(w);
    } catch (e) {
      console.error(`[dev] cannot watch ${rel(dir)}: ${e.message}`);
    }
  }
}

function shutdown() {
  for (const w of watchers) w.close();
  child?.kill();
  server?.close();
  process.exit(0);
}

log("initial build (generators + site)…");
const ok = await runPipeline(new Set([RENDER, AGENTS, BUILD]), { quiet: false });
if (!ok) log("serving whatever dist/ holds; fix the error above and save again");

server = startServer({ liveReload: true });
watchAll();
for (const r of WATCH_ROOTS) log(`watching ${r.shown}`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
