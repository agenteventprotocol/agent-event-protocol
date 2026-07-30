// Markdown/MDX renderer for the docs corpus: marked for markdown, Shiki for
// dual-theme syntax highlighting, plus the full MDX component set (callouts,
// code groups, cards, steps, params, accordions, frames, tabs, updates,
// tooltips). Mermaid fences are emitted as raw <pre class="mermaid"> blocks
// and rendered client-side.
import { marked } from "marked";
import { createHighlighter } from "shiki";
import { fmField } from "./nav.mjs";

marked.setOptions({ gfm: true, breaks: false });

// Shiki syntax highlighting (dual theme: light and dark tokens)
const SHIKI_THEMES = { light: "github-light", dark: "github-dark" };
const SHIKI_LANGS = ["bash", "json", "python", "javascript", "typescript", "yaml"];
const LANG_ALIAS = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  js: "javascript", node: "javascript",
  ts: "typescript", py: "python", yml: "yaml",
  text: "text", txt: "text", plain: "text", plaintext: "text", "": "text",
};
let _hl = null;
export async function initHighlighter() {
  if (_hl) return _hl;
  _hl = await createHighlighter({ themes: Object.values(SHIKI_THEMES), langs: SHIKI_LANGS });
  return _hl;
}
function highlightCode(code, lang) {
  const norm = LANG_ALIAS[lang] ?? lang;
  const ready = _hl && norm !== "text" && _hl.getLoadedLanguages().includes(norm);
  if (!ready) {
    // no grammar: mirror Shiki's wrapper so the CSS theming still applies
    return `<pre class="shiki shiki-plain" tabindex="0"><code>${esc(code)}</code></pre>`;
  }
  return _hl.codeToHtml(code, { lang: norm, themes: SHIKI_THEMES });
}

// heading anchors
// Same slug rule the docs tree's own link checker uses (GitHub-style): drop
// punctuation, map every whitespace character to one dash, never collapse
// runs ("a — b" slugs to "a--b" once the dash drops). Duplicate headings
// dedupe with a numeric suffix. Module-level state: render pages sequentially.
let _headingIds = new Map();
export function resetHeadingIds() {
  _headingIds = new Map();
}
function slugify(text) {
  return String(text).trim().toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}
function headingId(text) {
  const base = slugify(text) || "section";
  const n = _headingIds.get(base) ?? 0;
  _headingIds.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

// link rewriting
// Internal links are root-relative page paths (optionally with #anchor);
// static pages live at <path>/index.html, so append the trailing slash.
export function rewriteHref(href) {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return href;
  const hash = href.indexOf("#");
  const anchor = hash >= 0 ? href.slice(hash) : "";
  let path = hash >= 0 ? href.slice(0, hash) : href;
  if (path && !path.endsWith("/") && !/\.[a-z0-9]+$/i.test(path)) path += "/";
  return (path || "/") + anchor;
}

// Checklist glyphs
const CHECKLIST_TODO =
  '<svg class="checklist-box" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3.75" y="3.75" width="16.5" height="16.5"/></svg>';
const CHECKLIST_DONE =
  '<svg class="checklist-box" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="done"><rect x="3.75" y="3.75" width="16.5" height="16.5"/><path d="M7.5 12.25L10.75 15.5L16.5 9.5"/></svg>';

marked.use({
  renderer: {
    list(token) {
      if (token.ordered || !token.items.length || !token.items.every((i) => i.task)) return false;
      const items = token.items
        .map((item) => {
          const body = this.parser.parse(item.tokens, !!item.loose);
          return (
            `<li class="checklist-item${item.checked ? " is-done" : ""}">` +
            (item.checked ? CHECKLIST_DONE : CHECKLIST_TODO) +
            `<div class="checklist-text">${body}</div>` +
            `</li>`
          );
        })
        .join("");
      return `<ul class="checklist">${items}</ul>\n`;
    },
    checkbox({ checked }) {
      return checked ? CHECKLIST_DONE : CHECKLIST_TODO;
    },
    heading(token) {
      const html = this.parser.parseInline(token.tokens);
      const id = headingId(token.text);
      // The "#" comes from CSS: the TOC and search index strip tags from this
      // markup for their labels, so the anchor must hold no text.
      const label = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const permalink =
        token.depth >= 2 && token.depth <= 4
          ? `<a class="h-anchor" href="#${id}" aria-label="Permalink to &quot;${esc(label)}&quot;"></a>`
          : "";
      return `<h${token.depth} id="${id}">${html}${permalink}</h${token.depth}>\n`;
    },
    code(token) {
      // info string: "lang Optional Label theme={...}"
      const info = (token.lang || "").trim();
      const noTheme = info.replace(/theme=\{(?:[^{}]|\{[^{}]*\})*\}/g, "").trim();
      const parts = noTheme.split(/\s+/).filter(Boolean);
      const lang = parts.shift() || "text";
      const label = parts.join(" ") || lang;
      if (lang === "mermaid") {
        // Never highlighted: the bundled mermaid ESM renders these in-browser.
        return `<pre class="mermaid">${esc(token.text)}</pre>\n`;
      }
      return codeBlockHtml(lang, label, token.text);
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = rewriteHref(token.href || "");
      const title = token.title ? ` title="${esc(token.title)}"` : "";
      const external = /^https?:\/\//i.test(href);
      const rel = external ? ' target="_blank" rel="noopener"' : "";
      return `<a href="${esc(href)}"${title}${rel}>${text}</a>`;
    },
  },
});

// icons (inline SVG, stroke = currentColor
const ICONS = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11.5V16.5"/><path d="M12 7.51L12.01 7.49889"/><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18H15"/><path d="M10 21H14"/><path d="M9.00082 15C9.00098 13 8.50098 12.5 7.50082 11.5C6.50067 10.5 6.02422 9.48689 6.00082 8C5.95284 4.95029 8.00067 3 12.0008 3C16.001 3 18.0488 4.95029 18.0008 8C17.9774 9.48689 17.5007 10.5 16.5008 11.5C15.501 12.5 15.001 13 15.0008 15"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.0429 21H3.95705C2.41902 21 1.45658 19.3364 2.22324 18.0031L10.2662 4.01533C11.0352 2.67792 12.9648 2.67791 13.7338 4.01532L21.7768 18.0031C22.5434 19.3364 21.581 21 20.0429 21Z"/><path d="M12 9V13"/><path d="M12 17.01L12.01 16.9989"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21.4V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4Z"/><path d="M8 10L16 10"/><path d="M8 18L16 18"/><path d="M8 14L12 14"/><path d="M16 2V5.4C16 5.73137 16.2686 6 16.6 6H20"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 12.5L10 15.5L17 8.5"/><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 20H9.6C9.26863 20 9 19.7314 9 19.4V9.6C9 9.26863 9.26863 9 9.6 9H19.4C19.7314 9 20 9.26863 20 9.6V19.4C20 19.7314 19.7314 20 19.4 20Z"/><path d="M15 9V4.6C15 4.26863 14.7314 4 14.4 4H4.6C4.26863 4 4 4.26863 4 4.6V14.4C4 14.7314 4.26863 15 4.6 15H9"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12L21 12M21 12L12.5 3.5M21 12L12.5 20.5"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 12C9.26752 12 12 9.36306 12 3C12 9.36306 14.7134 12 21 12C14.7134 12 12 14.7134 12 21C12 14.7134 9.26752 12 3 12Z"/></svg>',
};

// Card icon="name" glyphs; unknown names fall back to spark.
const CARD_ICONS = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6H21"/><path d="M8 12H21"/><path d="M8 18H21"/><path d="M3.5 6L3.51 5.99889"/><path d="M3.5 12L3.51 11.9989"/><path d="M3.5 18L3.51 17.9989"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18L22 12L16 6"/><path d="M8 6L2 12L8 18"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17L10 11L4 5"/><path d="M12 19H20"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14H12L11 22L21 10H12L13 2Z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22C16 20 19.5 16.5 19.5 11.5V5.5L12 2.5L4.5 5.5V11.5C4.5 16.5 8 20 12 22Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"/><path d="M19.4 15C19.1277 15.6171 19.2583 16.3378 19.73 16.82L19.79 16.88C20.5705 17.6605 20.5705 18.9195 19.79 19.7C19.0095 20.4805 17.7505 20.4805 16.97 19.7L16.91 19.64C16.4278 19.1683 15.7071 19.0377 15.09 19.31C14.4855 19.5692 14.0918 20.1628 14.09 20.82V21C14.09 22.1046 13.1946 23 12.09 23C10.9854 23 10.09 22.1046 10.09 21V20.91C10.0742 20.2327 9.6462 19.6339 9.01 19.4C8.39294 19.1277 7.67223 19.2583 7.19 19.73L7.13 19.79C6.3495 20.5705 5.0905 20.5705 4.31 19.79C3.5295 19.0095 3.5295 17.7505 4.31 16.97L4.37 16.91C4.84173 16.4278 4.97231 15.7071 4.7 15.09C4.44081 14.4855 3.84723 14.0918 3.19 14.09H3C1.89543 14.09 1 13.1946 1 12.09C1 10.9854 1.89543 10.09 3 10.09H3.09C3.76733 10.0742 4.36613 9.6462 4.6 9.01C4.87231 8.39294 4.74173 7.67223 4.27 7.19L4.21 7.13C3.4295 6.3495 3.4295 5.0905 4.21 4.31C4.9905 3.5295 6.2495 3.5295 7.03 4.31L7.09 4.37C7.57223 4.84173 8.29294 4.97231 8.91 4.7H9C9.60447 4.44081 9.99818 3.84723 10 3.19V3C10 1.89543 10.8954 1 12 1C13.1046 1 14 1.89543 14 3V3.09C14.0018 3.74723 14.3955 4.34081 15 4.6C15.6171 4.87231 16.3378 4.74173 16.82 4.27L16.88 4.21C17.6605 3.4295 18.9195 3.4295 19.7 4.21C20.4805 4.9905 20.4805 6.2495 19.7 7.03L19.64 7.09C19.1683 7.57223 19.0377 8.29294 19.31 8.91V9C19.5692 9.60447 20.1628 9.99818 20.82 10H21C22.1046 10 23 10.8954 23 12C23 13.1046 22.1046 14 21 14H20.91C20.2528 14.0018 19.6592 14.3955 19.4 15Z"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2V7"/><path d="M15 2V7"/><path d="M6 7H18V12C18 15.3137 15.3137 18 12 18C8.68629 18 6 15.3137 6 12V7Z"/><path d="M12 18V22"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5C21 6.65685 16.9706 8 12 8C7.02944 8 3 6.65685 3 5C3 3.34315 7.02944 2 12 2C16.9706 2 21 3.34315 21 5Z"/><path d="M3 5V19C3 20.6569 7.02944 22 12 22C16.9706 22 21 20.6569 21 19V5"/><path d="M3 12C3 13.6569 7.02944 15 12 15C16.9706 15 21 13.6569 21 12"/></svg>',
  envelope: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.6C3 6.26863 3.26863 6 3.6 6H20.4C20.7314 6 21 6.26863 21 6.6V17.4C21 17.7314 20.7314 18 20.4 18H3.6C3.26863 18 3 17.7314 3 17.4V6.6Z"/><path d="M3 7L11.4 12.6C11.7643 12.8428 12.2357 12.8428 12.6 12.6L21 7"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V4.5C4 3.11929 5.11929 2 6.5 2H19.4C19.7314 2 20 2.26863 20 2.6V17"/><path d="M6.5 17H20V21.4C20 21.7314 19.7314 22 19.4 22H6.5C5.11929 22 4 20.8807 4 19.5C4 18.1193 5.11929 17 6.5 17Z"/></svg>',
  "diagram-project": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 3H8.4C8.73137 3 9 3.26863 9 3.6V8.4C9 8.73137 8.73137 9 8.4 9H3.6C3.26863 9 3 8.73137 3 8.4V3.6C3 3.26863 3.26863 3 3.6 3Z"/><path d="M15.6 15H20.4C20.7314 15 21 15.2686 21 15.6V20.4C21 20.7314 20.7314 21 20.4 21H15.6C15.2686 21 15 20.7314 15 20.4V15.6C15 15.2686 15.2686 15 15.6 15Z"/><path d="M6 9V14.4C6 14.7314 6.26863 15 6.6 15H15"/></svg>',
};

const CALLOUTS = {
  Note: { cls: "note", icon: ICONS.note },
  Info: { cls: "info", icon: ICONS.info },
  Tip: { cls: "tip", icon: ICONS.tip },
  Warning: { cls: "warning", icon: ICONS.warning },
  Check: { cls: "check", icon: ICONS.check },
};

// The full MDX component set this renderer supports. Anything else renders
// as literal text.
const KNOWN = new Set([
  "Note", "Info", "Tip", "Warning", "Check",
  "CodeGroup", "Card", "CardGroup", "Steps", "Step",
  "ParamField", "ResponseField", "Expandable", "Accordion", "AccordionGroup",
  "RequestExample", "ResponseExample", "Frame", "Tabs", "Tab", "Icon",
  "Update", "Tooltip", "Snippet",
]);

// Plain HTML elements allowed to pass through untouched.
const PASSTHROUGH = new Set(["img", "br", "hr", "video", "source"]);

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Parse `attr="x" cols={2} flag` into an object; bare flags become true.
function parseAttrs(str) {
  const attrs = {};
  if (!str) return attrs;
  const re = /([A-Za-z_:][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;
  const decode = (s) =>
    typeof s === "string"
      ? s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      : s;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (!m[1]) continue;
    const val = m[2] ?? m[3] ?? (m[4] !== undefined ? m[4].trim().replace(/^['"]|['"]$/g, "") : true);
    attrs[m[1]] = decode(val);
  }
  return attrs;
}

// Find the matching close tag for `name`, starting right after the open tag.
// Handles nested same-name tags; skips self-closing opens.
function findClose(text, name, from) {
  const open = new RegExp(`<${name}(?:\\s|>|/)`, "g");
  const close = new RegExp(`</${name}\\s*>`, "g");
  let depth = 1;
  let pos = from;
  while (pos < text.length) {
    open.lastIndex = pos;
    close.lastIndex = pos;
    const o = open.exec(text);
    const c = close.exec(text);
    if (!c) return -1;
    if (o && o.index < c.index) {
      const tagEnd = text.indexOf(">", o.index);
      if (tagEnd === -1) return -1;
      if (text[tagEnd - 1] !== "/") depth++;
      pos = tagEnd + 1;
    } else {
      depth--;
      if (depth === 0) return { inner: text.slice(from, c.index), end: close.lastIndex };
      pos = close.lastIndex;
    }
  }
  return -1;
}

function md(chunk) {
  const trimmed = chunk.trim();
  if (!trimmed) return "";
  return marked.parse(trimmed);
}

// Code block with a header: language label + copy button.
function codeBlockHtml(lang, label, code) {
  return (
    `<div class="code-block" data-lang="${esc(lang)}">` +
    `<div class="code-head"><span class="code-lang">${esc(label || lang)}</span>` +
    `<button class="code-copy" type="button" aria-label="Copy code">${ICONS.copy}</button></div>` +
    highlightCode(code, lang) +
    `</div>`
  );
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Extract fenced code blocks from a CodeGroup body: ```lang Label theme={...}
function parseCodeBlocks(body) {
  const blocks = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const info = m[1].trim();
    const code = m[2].replace(/\n$/, "");
    const noTheme = info.replace(/theme=\{(?:[^{}]|\{[^{}]*\})*\}/g, "").trim();
    const parts = noTheme.split(/\s+/).filter(Boolean);
    const lang = parts.shift() || "text";
    const label = parts.join(" ") || lang;
    blocks.push({ lang, label, code });
  }
  return blocks;
}

function renderCodeGroup(body) {
  const blocks = parseCodeBlocks(body);
  if (!blocks.length) return md(body);
  const id = "cg" + Math.abs(hash(body)).toString(36);
  const tabs = blocks
    .map((b, i) => `<button class="cg-tab${i === 0 ? " active" : ""}" data-i="${i}" type="button">${esc(b.label)}</button>`)
    .join("");
  const panes = blocks
    .map((b, i) => `<div class="cg-pane${i === 0 ? " active" : ""}" data-i="${i}">${codeBlockHtml(b.lang, b.label, b.code)}</div>`)
    .join("");
  return `<div class="code-group" id="${id}"><div class="cg-tabs">${tabs}</div><div class="cg-panes">${panes}</div></div>`;
}

// Collect the direct <Tab> children of a <Tabs> body for the interactive
// tab strip. The lookahead keeps "<Tabs" from matching as a "Tab" open tag.
function parseTabPanels(inner) {
  const panels = [];
  const re = /<Tab(?![A-Za-z0-9])((?:[^>"']|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const attrs = parseAttrs(m[1]);
    const title = attrs.title || attrs.label || `Tab ${panels.length + 1}`;
    if (m[2] === "/") {
      panels.push({ title, body: "" });
      continue;
    }
    const close = findClose(inner, "Tab", m.index + m[0].length);
    if (close === -1) break;
    panels.push({ title, body: close.inner });
    re.lastIndex = close.end;
  }
  return panels;
}

function paramName(attrs) {
  return attrs.body || attrs.header || attrs.path || attrs.query || attrs.name || attrs.title || "";
}

function renderComponent(name, attrs, inner) {
  // Components that re-process their body themselves (per pane / per code
  // block) must not pre-render it: heading ids register once per render, so
  // a double pass would shift every in-pane anchor to its deduped form.
  const reprocesses = name === "Tabs" || name === "CodeGroup" ||
    name === "RequestExample" || name === "ResponseExample";
  const children = !reprocesses && inner != null ? processMdx(inner) : "";

  if (CALLOUTS[name]) {
    const c = CALLOUTS[name];
    return `<div class="mdx-callout callout-${c.cls}"><span class="callout-ic">${c.icon}</span><div class="callout-body">${children}</div></div>`;
  }

  switch (name) {
    case "CodeGroup":
      return renderCodeGroup(inner || "");

    case "CardGroup": {
      const cols = attrs.cols || 2;
      return `<div class="card-group" style="--cols:${esc(String(cols))}">${children}</div>`;
    }
    case "Card": {
      const title = attrs.title || "";
      const href = attrs.href ? rewriteHref(attrs.href) : "";
      const tag = href ? "a" : "div";
      const hrefAttr = href ? ` href="${esc(href)}"` : "";
      const horiz = attrs.horizontal !== undefined ? " card-horizontal" : "";
      const icon = attrs.icon ? `<span class="card-icon">${CARD_ICONS[attrs.icon] || ICONS.spark}</span>` : "";
      return (
        `<${tag} class="mdx-card${horiz}"${hrefAttr}>` +
        icon +
        (title ? `<div class="card-title">${esc(title)}</div>` : "") +
        `<div class="card-body">${children}</div>` +
        `</${tag}>`
      );
    }

    case "Steps":
      return `<div class="mdx-steps">${children}</div>`;
    case "Step": {
      const title = attrs.title || "";
      return `<div class="mdx-step"><div class="step-dot"></div><div class="step-content">${title ? `<div class="step-title">${esc(title)}</div>` : ""}${children}</div></div>`;
    }

    case "ParamField":
    case "ResponseField": {
      const nm = paramName(attrs);
      const type = attrs.type || "";
      const required = attrs.required !== undefined;
      const def = attrs.default;
      return (
        `<div class="param">` +
        `<div class="param-head">` +
        (nm ? `<code class="param-name">${esc(nm)}</code>` : "") +
        (type ? `<span class="param-type">${esc(type)}</span>` : "") +
        (required ? `<span class="param-required">required</span>` : "") +
        (def ? `<span class="param-default">default: ${esc(String(def))}</span>` : "") +
        `</div>` +
        `<div class="param-body">${children}</div>` +
        `</div>`
      );
    }

    case "Expandable":
    case "Accordion": {
      const title = attrs.title || "Details";
      return `<details class="mdx-expandable"><summary>${esc(title)}</summary><div class="expandable-body">${children}</div></details>`;
    }
    case "AccordionGroup":
      return `<div class="accordion-group">${children}</div>`;

    case "RequestExample":
    case "ResponseExample": {
      const label = name === "RequestExample" ? "Request Example" : "Response Example";
      // Code blocks inside render as a tabbed CodeGroup for language switching.
      const tabbed = renderCodeGroup(inner || "");
      return `<div class="example-block"><div class="example-label">${label}</div>${tabbed}</div>`;
    }

    case "Frame": {
      const caption = attrs.caption || "";
      return `<figure class="mdx-frame">${children}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>`;
    }

    case "Tabs": {
      const panels = parseTabPanels(inner || "");
      if (!panels.length) return `<div class="mdx-tabs">${processMdx(inner || "")}</div>`;
      const id = "tabs" + Math.abs(hash(inner || "")).toString(36);
      const bar = panels
        .map((p, i) => `<button class="tab-btn${i === 0 ? " active" : ""}" data-i="${i}" type="button">${esc(p.title)}</button>`)
        .join("");
      const panes = panels
        .map((p, i) => `<div class="mdx-tab${i === 0 ? " active" : ""}" data-i="${i}">${processMdx(p.body)}</div>`)
        .join("");
      return `<div class="mdx-tabs" id="${id}"><div class="tabs-bar">${bar}</div><div class="tabs-panes">${panes}</div></div>`;
    }
    case "Tab": {
      // Reached only outside <Tabs>: render as a titled panel.
      const title = attrs.title || attrs.label || "";
      return `<div class="mdx-tab active">${title ? `<div class="tab-title">${esc(title)}</div>` : ""}${children}</div>`;
    }

    case "Icon":
      return `<span class="mdx-icon">${ICONS.spark}</span>`;

    case "Update": {
      const label = attrs.label || attrs.description || "";
      return `<div class="mdx-update">${label ? `<div class="update-label">${esc(label)}</div>` : ""}${children}</div>`;
    }

    case "Tooltip":
      return `<span class="mdx-tooltip" title="${esc(attrs.tip || "")}">${children}</span>`;

    case "Snippet":
      return children;

    default:
      return children;
  }
}

// Character ranges covered by fenced or inline code, so the tag scanner and
// the comment stripper never touch `<foo>` or `{/* */}` inside code.
function codeRanges(text) {
  const ranges = [];
  const patterns = [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /``[^`\n]*``/g, /`[^`\n]*`/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

// Strip MDX comments `{/* ... */}` outside code (generated pages carry them
// as provenance markers).
function stripMdxComments(text) {
  const ranges = codeRanges(text);
  const inCode = (idx) => ranges.some((r) => idx >= r[0] && idx < r[1]);
  let out = "";
  let i = 0;
  const re = /\{\/\*[\s\S]*?\*\/\}[ \t]*\n?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (inCode(m.index)) continue;
    out += text.slice(i, m.index);
    i = m.index + m[0].length;
  }
  return out + text.slice(i);
}

// Main recursive processor: split the text into MDX components and plain
// markdown chunks; the scanner is code-range aware.
export function processMdx(text) {
  let out = "";
  let i = 0;
  const ranges = codeRanges(text);
  const inCode = (idx) => ranges.some((r) => idx >= r[0] && idx < r[1]);
  const tagRe = /<([A-Za-z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;

  let scan = 0;
  while (scan < text.length) {
    tagRe.lastIndex = scan;
    const m = tagRe.exec(text);
    if (!m) {
      out += md(text.slice(i));
      i = text.length;
      break;
    }
    if (inCode(m.index)) {
      scan = m.index + 1;
      continue;
    }
    const name = m[1];
    const isKnown = KNOWN.has(name);
    const isPassthrough = PASSTHROUGH.has(name.toLowerCase());

    if (!isKnown && !isPassthrough) {
      // Not a component we render: treat '<' as literal text, advance one char.
      out += md(text.slice(i, m.index));
      out += esc(text.slice(m.index, m.index + 1));
      i = m.index + 1;
      scan = i;
      continue;
    }

    out += md(text.slice(i, m.index));
    const attrs = parseAttrs(m[2]);
    const selfClosed = m[3] === "/";

    if (isPassthrough) {
      out += m[0];
      i = m.index + m[0].length;
      scan = i;
      continue;
    }

    if (selfClosed) {
      out += renderComponent(name, attrs, null);
      i = m.index + m[0].length;
    } else {
      const close = findClose(text, name, m.index + m[0].length);
      if (close === -1) {
        out += renderComponent(name, attrs, "");
        i = m.index + m[0].length;
      } else {
        out += renderComponent(name, attrs, close.inner);
        i = close.end;
      }
    }
    scan = i;
  }
  return out;
}

// page entry point
// Front matter: title + description become the page h1 + lead; every other
// key (audience, spec-refs, verified-against, ...) is ignored.
export function renderPage(raw) {
  resetHeadingIds();
  let text = raw.replace(/\r\n/g, "\n");

  let title = "";
  let description = "";
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    title = fmField(fm[1], "title") || "";
    description = fmField(fm[1], "description") || "";
    text = text.slice(fm[0].length);
  }

  const bodyHtml = processMdx(stripMdxComments(text)).trim();
  const descriptionHtml = description ? marked.parseInline(description) : "";
  const hasMermaid = bodyHtml.includes('<pre class="mermaid">');
  return { title, description, descriptionHtml, bodyHtml, hasMermaid };
}
