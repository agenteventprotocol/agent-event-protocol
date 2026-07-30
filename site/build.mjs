// Static build for the Agent Event Protocol docs: renders every page that
// ../docs/docs.json navigation references to dist/<route>/index.html, plus
// the client nav bundle, the search index, and the shared assets.
import "./env.mjs";
import { mkdir, writeFile, readFile, readdir, rm, cp, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage, initHighlighter } from "./mdx.mjs";
import { buildNav, routeFor, DOCS } from "./nav.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "dist");
const ASSETS = join(__dirname, "assets");

const SITE_NAME = "Agent Event Protocol";

const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");

const FONTS = `<link rel="preload" href="/assets/fonts/inter-400-latin.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/assets/fonts/inter-600-latin.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="/assets/fonts/fonts.css" />`;

// Runs before first paint so the stored (or OS-preferred) theme never flashes.
const THEME_SCRIPT = `<script>(function(){var s=localStorage.getItem("aep-theme");var t=s||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);})();</script>`;


const MERMAID_PRELOAD =
  '<link rel="modulepreload" href="/assets/mermaid/mermaid.esm.min.mjs" />';

// Per-page mermaid boot. Theme-aware and toggle-aware: the raw diagram
// source (each <pre class="mermaid">'s text content) is stashed before the
// first render, and a MutationObserver on data-theme re-initializes mermaid
// and re-renders every diagram from that stash when the theme flips. A
// diagram that fails a re-render keeps whatever it showed before.
//
// Each rendered figure gets a control bar (zoom out / % readout / zoom in /
// reset / fullscreen with an overlay fallback), drag-to-pan when zoomed,
// Ctrl/Cmd+wheel zoom, double-click reset, and Esc to leave fullscreen. The
// transform lives on an inner wrapper (.mmd-canvas), never on the SVG, so a
// theme re-render can rebuild the figure from the stashed source (controls
// state resets then, by design).
const MERMAID_SCRIPT = `<script type="module">
import mermaid from "/assets/mermaid/mermaid.esm.min.mjs";
const blocks = Array.from(document.querySelectorAll("pre.mermaid"));
const sources = blocks.map((el) => el.textContent);
// Diagram labels are mostly event types and function names, so they read as code.
const MMD_FONT = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const MMD_SIZE = 12.5;

// Map the site's --mmd-* design tokens onto mermaid's theme variables, read at
// render time so a theme flip repaints the diagrams from the new palette.
function themeConfig() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const nodeBg = v("--mmd-node-bg"), nodeBorder = v("--mmd-node-border");
  const text = v("--mmd-text"), line = v("--mmd-line");
  const groupBg = v("--mmd-group-bg"), groupBorder = v("--mmd-group-border");
  const altBg = v("--mmd-alt-bg"), accent = v("--mmd-accent");
  return {
    startOnLoad: false,
    theme: "base",
    fontFamily: MMD_FONT,
    flowchart: { curve: "basis", padding: 14, useMaxWidth: true },
    sequence: {
      useMaxWidth: true, mirrorActors: false,
      actorFontFamily: MMD_FONT, actorFontSize: MMD_SIZE,
      noteFontFamily: MMD_FONT, noteFontSize: MMD_SIZE,
      messageFontFamily: MMD_FONT, messageFontSize: MMD_SIZE,
    },
    state: { useMaxWidth: true },
    er: { useMaxWidth: true, fontSize: MMD_SIZE },
    themeVariables: {
      fontFamily: MMD_FONT,
      fontSize: MMD_SIZE + "px",
      background: altBg,
      primaryColor: nodeBg,
      primaryTextColor: text,
      primaryBorderColor: nodeBorder,
      secondaryColor: groupBg,
      secondaryTextColor: text,
      secondaryBorderColor: groupBorder,
      tertiaryColor: altBg,
      tertiaryTextColor: text,
      tertiaryBorderColor: groupBorder,
      mainBkg: nodeBg,
      nodeBorder: nodeBorder,
      nodeTextColor: text,
      lineColor: line,
      textColor: text,
      titleColor: text,
      edgeLabelBackground: altBg,
      clusterBkg: groupBg,
      clusterBorder: groupBorder,
      // sequence
      actorBkg: nodeBg,
      actorBorder: nodeBorder,
      actorTextColor: text,
      actorLineColor: line,
      signalColor: line,
      signalTextColor: text,
      labelBoxBkgColor: nodeBg,
      labelBoxBorderColor: nodeBorder,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: groupBg,
      noteBorderColor: groupBorder,
      noteTextColor: text,
      activationBkgColor: groupBg,
      activationBorderColor: nodeBorder,
      sequenceNumberColor: altBg,
      // state
      labelColor: text,
      altBackground: groupBg,
      transitionColor: line,
      transitionLabelColor: text,
      stateBkg: nodeBg,
      stateBorder: nodeBorder,
      compositeBackground: groupBg,
      compositeBorder: groupBorder,
      compositeTitleBackground: groupBg,
      innerEndBackground: accent,
      specialStateColor: accent,
      // er
      attributeBackgroundColorOdd: groupBg,
      attributeBackgroundColorEven: altBg,
    },
  };
}
const IC = {
  zin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 8V16"/><path d="M8 12H16"/></svg>',
  zout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 12H16"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.3019 3 18.1885 4.77814 19.7545 7.42909"/><path d="M20 3V7.5H15.5"/></svg>',
  fs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H3V9"/><path d="M15 3H21V9"/><path d="M9 21H3V15"/><path d="M15 21H21V15"/></svg>'
};
let gen = 0;

const DENSE_BELOW = 0.7;
const VIEWPORT_PAD = 32; // .mmd-viewport padding, both sides
function fitCanvas(el, viewport, canvas) {
  const svg = canvas.querySelector("svg");
  if (!svg) return;
  const vb = (svg.getAttribute("viewBox") || "").split(/[\\s,]+/).map(Number);
  const natW = vb[2];
  if (!natW) return;
  const boxW = viewport.clientWidth - VIEWPORT_PAD;
  if (boxW > 0 && boxW / natW < DENSE_BELOW) el.setAttribute("data-dense", "true");
  else el.removeAttribute("data-dense");
}
function mount(el, svg) {
  el.setAttribute("data-processed", "true");
  el.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "mmd-bar";
  bar.innerHTML =
    '<button class="mmd-btn" data-act="out" type="button" aria-label="Zoom out">' + IC.zout + "</button>" +
    '<span class="mmd-zoom">100%</span>' +
    '<button class="mmd-btn" data-act="in" type="button" aria-label="Zoom in">' + IC.zin + "</button>" +
    '<button class="mmd-btn" data-act="reset" type="button" aria-label="Reset view">' + IC.reset + "</button>" +
    '<button class="mmd-btn" data-act="fs" type="button" aria-label="Toggle fullscreen">' + IC.fs + "</button>";
  const viewport = document.createElement("div");
  viewport.className = "mmd-viewport";
  const canvas = document.createElement("div");
  canvas.className = "mmd-canvas";
  canvas.innerHTML = svg;
  viewport.appendChild(canvas);
  el.appendChild(bar);
  el.appendChild(viewport);
  fitCanvas(el, viewport, canvas);
  wire(el, bar, viewport, canvas);
}
function wire(el, bar, viewport, canvas) {
  let s = 1, tx = 0, ty = 0, drag = null;
  const zoomEl = bar.querySelector(".mmd-zoom");

  const overflows = () => {
    const svg = canvas.querySelector("svg");
    if (!svg) return false;
    const c = svg.getBoundingClientRect(), v = viewport.getBoundingClientRect();
    return c.width > v.width - VIEWPORT_PAD + 1 || c.height > v.height - VIEWPORT_PAD + 1;
  };
  const apply = () => {
    canvas.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")";
    zoomEl.textContent = Math.round(s * 100) + "%";
    viewport.style.cursor = overflows() ? "grab" : "";

    viewport.style.touchAction = overflows() ? "none" : "pan-y";
  };
  const zoom = (f) => { s = Math.min(8, Math.max(0.25, s * f)); apply(); };
  const reset = () => { s = 1; tx = 0; ty = 0; apply(); };
  const inFallback = () => el.classList.contains("mmd-fs");
  const exitFs = () => {
    if (document.fullscreenElement === el && document.exitFullscreen) document.exitFullscreen();
    el.classList.remove("mmd-fs");
    document.body.classList.remove("mmd-fs-open");
  };
  const enterFs = () => {
    const fallback = () => { el.classList.add("mmd-fs"); document.body.classList.add("mmd-fs-open"); };
    if (el.requestFullscreen) el.requestFullscreen().catch(fallback);
    else fallback();
  };
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".mmd-btn");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "in") zoom(1.25);
    else if (act === "out") zoom(1 / 1.25);
    else if (act === "reset") reset();
    else if (act === "fs") (document.fullscreenElement === el || inFallback()) ? exitFs() : enterFs();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && inFallback()) exitFs(); });
  viewport.addEventListener("pointerdown", (e) => {
    if (!overflows()) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = "grabbing";
    e.preventDefault();
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!drag) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    apply();
  });
  const endDrag = () => { drag = null; viewport.style.cursor = overflows() ? "grab" : ""; };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);
  viewport.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  viewport.addEventListener("dblclick", reset);
  apply();
}
async function renderAll() {
  const g = ++gen;
  mermaid.initialize(themeConfig());
  for (let i = 0; i < blocks.length; i++) {
    try {
      const { svg } = await mermaid.render("aep-mmd-" + g + "-" + i, sources[i]);
      if (g !== gen) return; // superseded by a newer theme flip
      mount(blocks[i], svg);
      blocks[i].setAttribute("data-processed", "true");
    } catch (e) {
      // reveal the source as the fallback, and drop any temp element the
      // failed render left behind
      if (!blocks[i].hasAttribute("data-processed")) blocks[i].setAttribute("data-failed", "true");
      const stray = document.getElementById("daep-mmd-" + g + "-" + i);
      if (stray) stray.remove();
    }
  }
}
renderAll();
new MutationObserver(() => renderAll())
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const b of blocks) {
      const vp = b.querySelector(".mmd-viewport"), cv = b.querySelector(".mmd-canvas");
      if (vp && cv) fitCanvas(b, vp, cv);
    }
  }, 150);
});
</script>`;

function htmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// One `git log` walk for the whole tree; newest-first, so a path's first
// appearance is its last change. A shallow clone would date every file the
// same, so dates are dropped rather than shown wrong (publish with fetch-depth: 0).
function gitDates() {
  const dates = new Map();
  let shallow = false;
  try {
    shallow =
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: DOCS,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true";
    if (shallow) return { dates, reason: "shallow clone" };

    const git = (args) =>
      execFileSync("git", args, {
        cwd: DOCS,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    const prefix = git(["rev-parse", "--show-prefix"]).trim();

    const out = git(["log", "--format=%cI", "--name-only", "--no-renames", "--", "."]);
    let current = null;
    for (const line of out.split("\n")) {
      if (!line) continue;
      if (/^\d{4}-\d{2}-\d{2}T/.test(line)) current = line;
      else if (current && line.startsWith(prefix)) {
        const key = line.slice(prefix.length);
        if (!dates.has(key)) dates.set(key, current);
      }
    }
    if (!dates.size) return { dates, reason: "git log matched no docs paths" };
  } catch (e) {
    return { dates, reason: "git unavailable" };
  }
  return { dates, reason: null };
}

const DATE_FMT = new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric" });

function lastUpdatedHtml(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return (
    `<p class="last-updated">Last updated ` +
    `<time datetime="${htmlEsc(iso)}">${htmlEsc(DATE_FMT.format(d))}</time></p>`
  );
}

// Any content table with more than this many body rows gets a filter toolbar
// (markup emitted here so it is part of the static page; shell.js wires the
// client-side filtering and live row count).
const FILTER_ROWS_MIN = 15;
const FILTER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17L21 21"/><path d="M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z"/></svg>';

function enhanceTables(bodyHtml) {
  return bodyHtml.replace(/<table>[\s\S]*?<\/table>/g, (table) => {
    const tbody = table.match(/<tbody>[\s\S]*?<\/tbody>/);
    const rows = tbody ? (tbody[0].match(/<tr>/g) || []).length : 0;
    if (rows <= FILTER_ROWS_MIN) return table;
    return (
      `<div class="table-wrap">` +
      `<div class="table-toolbar">` +
      `<label class="filter-input">${FILTER_ICON}` +
      `<input type="text" placeholder="Filter rows…" aria-label="Filter table rows" autocomplete="off" /></label>` +
      `<span class="row-count" role="status" aria-live="polite">${rows} rows</span>` +
      `</div>` +
      table +
      `</div>`
    );
  });
}

function htmlToText(html) {
  return html
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Right-column "On this page" TOC from the h2/h3 anchors in the body.
function tocHtml(bodyHtml) {
  const items = [];
  const headingRe = /<h([23]) id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let m;
  while ((m = headingRe.exec(bodyHtml)) !== null) {
    items.push({ depth: m[1], anchor: m[2], label: htmlToText(m[3]) });
  }
  if (!items.length) return "";
  const links = items
    .map((i) => `<a class="toc-link depth-${i.depth}" href="#${i.anchor}">${htmlEsc(i.label)}</a>`)
    .join("\n     ");
  return `   <details class="toc" id="toc">
    <summary class="toc-title" id="toc-title">On this page</summary>
    <nav class="toc-list" aria-labelledby="toc-title">
     ${links}
    </nav>
   </details>`;
}

function breadcrumbHtml(meta, tabHome) {
  const crumbs = meta.breadcrumb.filter((c, i, a) => i === 0 || c !== a[i - 1]);
  const parts = crumbs.map((c, i) => {
    const text = htmlEsc(c);
    const label =
      i === 0 && tabHome && tabHome !== meta.route
        ? `<a class="crumb-link" href="${htmlEsc(tabHome)}">${text}</a>`
        : text;
    return i ? `<span>&rsaquo;</span> ${label}` : label;
  });
  return `<nav class="breadcrumb" aria-label="Breadcrumb">${parts.join(" ")}</nav>`;
}

// Page actions
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 20H9.6C9.26863 20 9 19.7314 9 19.4V9.6C9 9.26863 9.26863 9 9.6 9H19.4C19.7314 9 20 9.26863 20 9.6V19.4C20 19.7314 19.7314 20 19.4 20Z"/><path d="M15 9V4.6C15 4.26863 14.7314 4 14.4 4H4.6C4.26863 4 4 4.26863 4 4.6V14.4C4 14.7314 4.26863 15 4.6 15H9"/></svg>';
const MD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21.4V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4Z"/><path d="M16 2V5.4C16 5.73137 16.2686 6 16.6 6H20"/></svg>';
const GH_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
const AI_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L13.9 8.1L19 10L13.9 11.9L12 17L10.1 11.9L5 10L10.1 8.1L12 3Z"/><path d="M18 16L18.7 17.8L20.5 18.5L18.7 19.2L18 21L17.3 19.2L15.5 18.5L17.3 17.8L18 16Z"/></svg>';
const EXT_ICON =
  '<svg class="pa-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M11 7H17V13"/></svg>';
const CHEV_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9L12 15L18 9"/></svg>';

const SOURCE_BASE = "https://github.com/agenteventprotocol/agent-event-protocol/blob/main/docs/";

function pageActionsHtml(route, srcRel) {
  const mdHref = route === "/" ? "/index.md" : `${route}index.md`;
  const link = (href, attrs, icon, label) =>
    `<a class="pa-item" role="menuitem" href="${htmlEsc(href)}" target="_blank" rel="noopener"${attrs}>` +
    `${icon}<span>${label}</span>${EXT_ICON}</a>`;
  return (
    `<div class="page-actions">` +
    `<div class="pa-wrap" id="pageActions" data-md="${htmlEsc(mdHref)}">` +
    `<div class="pa-split">` +
    `<button class="pa-btn pa-main" id="copyPage" type="button">${COPY_ICON}<span>Copy page</span></button>` +
    `<button class="pa-btn pa-toggle" id="pageActionsToggle" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="More page options">${CHEV_ICON}</button>` +
    `</div>` +
    `<div class="pa-menu" role="menu">` +
    `<button class="pa-item" type="button" role="menuitem" data-act="copy">` +
    `${COPY_ICON}<span>Copy page</span><em class="pa-hint">Markdown</em></button>` +
    link(mdHref, "", MD_ICON, "View as Markdown") +
    link(SOURCE_BASE + srcRel, "", GH_ICON, "View source on GitHub") +
    `<div class="menu-sep"></div>` +
    link("https://chatgpt.com/", ' data-ai="chatgpt"', AI_ICON, "Open in ChatGPT") +
    link("https://claude.ai/new", ' data-ai="claude"', AI_ICON, "Open in Claude") +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

function metaDescription(leadHtml) {
  const text = htmlToText(leadHtml || "");
  if (text.length <= 180) return text;
  const cut = text.slice(0, 180);
  const sp = cut.lastIndexOf(" ");
  return (sp > 120 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, "") + "…";
}

function socialMetaHtml(route, title, description) {
  const full = `${title} · ${SITE_NAME}`;
  const tags = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${htmlEsc(SITE_NAME)}" />`,
    `<meta property="og:title" content="${htmlEsc(full)}" />`,
    `<meta property="og:description" content="${htmlEsc(description)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${htmlEsc(full)}" />`,
    `<meta name="twitter:description" content="${htmlEsc(description)}" />`,
  ];
  if (SITE_URL) {
    const abs = SITE_URL + route;
    tags.push(`<meta property="og:url" content="${htmlEsc(abs)}" />`);
    tags.push(`<link rel="canonical" href="${htmlEsc(abs)}" />`);
  }
  return tags.join("\n");
}

const ARROW_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12H3M3 12L11.5 3.5M3 12L11.5 20.5"/></svg>';
const ARROW_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12H21M21 12L12.5 3.5M21 12L12.5 20.5"/></svg>';

function pageNavHtml(prev, next) {
  if (!prev && !next) return "";
  const side = (page, dir, icon) =>
    page
      ? `<a class="pn-link pn-${dir}" href="${htmlEsc(page.route)}" rel="${dir}">` +
        `${dir === "prev" ? icon : ""}` +
        `<span class="pn-text"><span class="pn-dir">${dir === "prev" ? "Previous" : "Next"}</span>` +
        `<span class="pn-title">${htmlEsc(page.label)}</span></span>` +
        `${dir === "next" ? icon : ""}</a>`
      : `<span class="pn-spacer"></span>`;
  return (
    `<nav class="page-nav" aria-label="Previous and next page">` +
    side(prev, "prev", ARROW_LEFT) +
    side(next, "next", ARROW_RIGHT) +
    `</nav>`
  );
}

function pageTemplate({ route, srcRel, title, crumb, leadHtml, bodyHtml, pageScript, pageHead, prev, next, updated }) {
  const description = metaDescription(leadHtml);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${htmlEsc(title)} · ${SITE_NAME}</title>
<meta name="description" content="${htmlEsc(description)}" />
${socialMetaHtml(route, title, description)}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#070707" media="(prefers-color-scheme: dark)" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/favicon.svg" />
${FONTS}
<link rel="stylesheet" href="/assets/styles.css" />
${pageHead || ""}
${THEME_SCRIPT}
</head>
<body data-route="${htmlEsc(route)}">
<a class="skip-link" href="#main-content">Skip to content</a>
<header class="topbar" id="topbar"></header>
<div class="layout">
  <nav class="sidebar" id="sidebar" aria-label="Documentation navigation"></nav>
  <main class="main-area" id="main-content" tabindex="-1">
   <div class="content">
    <div class="page-head">
${crumb || '<div class="breadcrumb"></div>'}
${pageActionsHtml(route, srcRel)}
    </div>
    <h1 class="page-title">${htmlEsc(title)}</h1>
${leadHtml}
${bodyHtml}
${lastUpdatedHtml(updated)}
${pageNavHtml(prev, next)}
   </div>
${tocHtml(bodyHtml)}
  </main>
</div>
<script src="/assets/nav.js"></script>
<script src="/assets/shell.js"></script>
<script src="/assets/search.js"></script>
${pageScript || ""}
</body>
</html>
`;
}

function notFoundHtml() {
  return pageTemplate({
    route: "/404",
    srcRel: "index.md",
    title: "Page not found",
    crumb: "",
    leadHtml:
      '    <p class="page-lead">That page does not exist. It may have been renamed, ' +
      "or the link that brought you here may be out of date.</p>",
    bodyHtml:
      '<div class="nf-actions">' +
      '<a class="mdx-card" href="/">' +
      '<div class="card-title">Documentation home</div>' +
      '<div class="card-body"><p>Start from the index and work down.</p></div></a>' +
      '<a class="mdx-card" href="/specification/draft/">' +
      '<div class="card-title">Specification</div>' +
      '<div class="card-body"><p>The normative AEP-0001..AEP-0009 suite.</p></div></a>' +
      "</div>" +
      '<p>Or press <kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + <kbd>K</kbd> to search every page.</p>',
    prev: null,
    next: null,
  });
}

function sitemapXml(routes) {
  const urls = routes
    .map((r) => `  <url>\n    <loc>${htmlEsc(SITE_URL + r)}</loc>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function robotsTxt() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

// One search record per page section (split on h2/h3 anchors) so search
// results can deep-link. Code blocks are dropped to keep the JSON lean.
const MAX_SECTION_TEXT = 1600;

function clampText(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return sp > max * 0.8 ? cut.slice(0, sp) : cut;
}

function searchRecordsFor(meta, title, description, bodyHtml) {
  const crumbs = meta.breadcrumb.filter((c, i, a) => i === 0 || c !== a[i - 1]);
  const crumb = crumbs.slice(1, -1).join(" › ");

  const sections = [];
  let last = { heading: null, anchor: null, start: 0 };
  const headingRe = /<h([23]) id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let m;
  while ((m = headingRe.exec(bodyHtml)) !== null) {
    sections.push({ ...last, end: m.index });
    last = { heading: htmlToText(m[3]), anchor: m[2], start: headingRe.lastIndex };
  }
  sections.push({ ...last, end: bodyHtml.length });

  const records = [];
  for (const s of sections) {
    const body = htmlToText(bodyHtml.slice(s.start, s.end));
    const isRoot = s.anchor === null;
    if (!body && !isRoot) continue;
    records.push({
      route: meta.route,
      tab: meta.tabLabel,
      crumb,
      title,
      heading: s.heading,
      anchor: s.anchor,
      text: clampText((isRoot ? `${description} ${body}` : body).trim(), MAX_SECTION_TEXT),
    });
  }
  return records;
}

async function walkContent(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkContent(p, out);
    else if (/\.(md|mdx)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function copyMermaid() {
  const src = join(__dirname, "node_modules", "mermaid", "dist");
  const entry = join(src, "mermaid.esm.min.mjs");
  if (!existsSync(entry)) {
    console.warn("warning: mermaid ESM bundle not found; diagrams will render as source");
    return;
  }
  const dest = join(DIST, "assets", "mermaid");
  await mkdir(dest, { recursive: true });
  await copyFile(entry, join(dest, "mermaid.esm.min.mjs"));
  // The ESM entry imports hashed chunks by relative path; keep the layout
  // (only the minified chunk set the entry actually references).
  const chunks = join(src, "chunks", "mermaid.esm.min");
  if (existsSync(chunks)) {
    await cp(chunks, join(dest, "chunks", "mermaid.esm.min"), {
      recursive: true,
      filter: (s) => !s.endsWith(".map"),
    });
  }
}

async function build() {
  await initHighlighter();
  const { tabs, index, pages, missing } = buildNav();
  const { dates: DATES, reason: noDates } = gitDates();

  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, "assets"), { recursive: true });

  let count = 0;
  let hiddenCount = 0;
  const searchIndex = [];
  const warnings = [];
  const routes = [];

  // Scoped per tab so the last page of one tab does not link into the next.
  const seqByTab = new Map();
  for (const id of pages) {
    const m = index[id];
    if (!m.file) continue;
    if (!seqByTab.has(m.tabId)) seqByTab.set(m.tabId, []);
    seqByTab.get(m.tabId).push({ route: m.route, label: m.label });
  }
  function neighbours(meta) {
    const seq = seqByTab.get(meta.tabId) || [];
    const i = seq.findIndex((p) => p.route === meta.route);
    if (i === -1) return { prev: null, next: null };
    return { prev: seq[i - 1] || null, next: seq[i + 1] || null };
  }

  async function renderOne(meta) {
    const raw = await readFile(meta.file, "utf8");
    const rendered = renderPage(raw);
    const title = rendered.title || meta.label || meta.id;
    const leadHtml = rendered.descriptionHtml ? `    <p class="page-lead">${rendered.descriptionHtml}</p>` : "";

    // Search records come from the raw body; the toolbar markup that
    // enhanceTables adds is chrome, not content.
    searchRecordsFor(meta, title, rendered.description, rendered.bodyHtml).forEach((r) =>
      searchIndex.push(r)
    );

    const { prev, next } = neighbours(meta);
    const srcRel = relative(DOCS, meta.file);
    const html = pageTemplate({
      route: meta.route,
      srcRel,
      updated: DATES.get(srcRel),
      title,
      crumb: meta.breadcrumb.length
        ? breadcrumbHtml(meta, (tabs.find((t) => t.id === meta.tabId) || {}).home)
        : "",
      leadHtml,
      bodyHtml: enhanceTables(rendered.bodyHtml),
      pageScript: rendered.hasMermaid ? MERMAID_SCRIPT : "",
      pageHead: rendered.hasMermaid ? MERMAID_PRELOAD : "",
      prev,
      next,
    });

    routes.push(meta.route);
    const outPath =
      meta.route === "/" ? join(DIST, "index.html") : join(DIST, meta.route.slice(1), "index.html");
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html);
    // Raw markdown alongside the page (front matter included) for the
    // "Copy page" / "View as Markdown" actions.
    await writeFile(join(dirname(outPath), "index.md"), raw);
  }

  for (const id of pages) {
    const meta = index[id];
    if (!meta.file) continue; // collected in `missing`
    await renderOne(meta);
    count++;
  }

  // Hidden pages: content files the navigation never references still render
  // at their slug route (the hosted platform serves such pages too) so links
  // into them resolve. They join the search index but add no sidebar entry.
  // Basenames starting with "_" are templates, not pages, and stay skipped.
  const navFiles = new Set(pages.map((id) => index[id].file).filter(Boolean));
  for (const f of await walkContent(DOCS)) {
    if (navFiles.has(f)) continue;
    const rel = relative(DOCS, f);
    if (rel.split("/").pop().startsWith("_")) {
      warnings.push(`no nav entry (skipped, template): ${rel}`);
      continue;
    }
    const id = rel.replace(/\.(md|mdx)$/, "");
    warnings.push(`no nav entry (rendered hidden): ${rel} -> ${routeFor(id)}`);
    await renderOne({
      id,
      label: id,
      route: routeFor(id),
      tabId: null,
      tabLabel: "Other",
      breadcrumb: [],
      file: f,
    });
    hiddenCount++;
  }

  if (noDates) warnings.push(`no "Last updated" dates (${noDates})`);

  await writeFile(join(DIST, "404.html"), notFoundHtml());

  if (SITE_URL) {
    await writeFile(join(DIST, "sitemap.xml"), sitemapXml(routes));
    await writeFile(join(DIST, "robots.txt"), robotsTxt());
    console.log(`Wrote sitemap.xml (${routes.length} URLs) and robots.txt for ${SITE_URL}`);
  } else {
    warnings.push("SITE_URL unset: skipped sitemap.xml and robots.txt (see .env.example)");
  }

  // Client nav bundle (display order as authored in docs.json).
  const navJs = `window.AEP_NAV = ${JSON.stringify(tabs)};\n`;
  await writeFile(join(DIST, "assets", "nav.js"), navJs);

  // Search index, lazily fetched by the search modal on first open.
  const searchJson = JSON.stringify(searchIndex);
  await writeFile(join(DIST, "assets", "search-index.json"), searchJson);
  console.log(`Search index: ${searchIndex.length} records, ${(searchJson.length / 1024).toFixed(0)} KB`);

  // Shared assets.
  for (const name of ["styles.css", "shell.js", "search.js"]) {
    await copyFile(join(ASSETS, name), join(DIST, "assets", name));
  }
  if (existsSync(join(ASSETS, "fonts"))) {
    await cp(join(ASSETS, "fonts"), join(DIST, "assets", "fonts"), { recursive: true });
  } else {
    warnings.push("assets/fonts missing; run `node vendor-fonts.mjs` (text will fall back to system fonts)");
  }
  await copyMermaid();

  // Branding assets from the docs tree, when present.
  if (existsSync(join(DOCS, "favicon.svg"))) {
    await copyFile(join(DOCS, "favicon.svg"), join(DIST, "favicon.svg"));
  }
  if (existsSync(join(DOCS, "logo"))) {
    await cp(join(DOCS, "logo"), join(DIST, "logo"), { recursive: true });
  }

  // Cross-check: nav entries with no file are fatal.
  for (const m of missing) warnings.push(`nav entry with no file: ${m}`);

  console.log(`Generated ${count} nav pages + ${hiddenCount} hidden pages.`);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (missing.length) {
    console.error(`Build failed: ${missing.length} nav entr${missing.length === 1 ? "y" : "ies"} without a file.`);
    process.exit(1);
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
