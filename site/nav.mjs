// Navigation index for the docs site, parsed from ../docs/docs.json
// (Mintlify schema). Tabs come from navigation.tabs[]; each tab lists page
// groups either directly (tab.pages) or per version (tab.versions[].pages).
// A group is { group, pages } where pages entries are page ids (strings) or
// nested groups. Page ids map to files under ../docs (.md first, then .mdx);
// sidebar labels come from each page's front-matter title.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DOCS = join(__dirname, "..", "docs");

// Page id -> site route. "index" is the landing page; "x/index" collapses to
// "/x/"; everything else gets a trailing slash so each page is a directory.
export function routeFor(id) {
  if (id === "index") return "/";
  return "/" + id.replace(/\/index$/, "") + "/";
}

export function fileFor(id) {
  for (const ext of [".md", ".mdx"]) {
    const p = join(DOCS, id + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

function idFromLabel(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Unquotes a scalar front-matter value, undoing YAML escapes inside "..."
export function fmScalar(rawValue) {
  const s = rawValue.trim();
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\/])/g, "$1");
  }
  if (s.length > 1 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

export function fmField(block, key) {
  const m = block.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return m ? fmScalar(m[1]) : null;
}

// Minimal front-matter reader: the sidebar label is the page's title
function titleOf(file, fallback) {
  try {
    const raw = readFileSync(file, "utf8");
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) return fmField(fm[1], "sidebarTitle") || fmField(fm[1], "title") || fallback;
  } catch {
    /* unreadable file: fall through to the fallback label */
  }
  return fallback;
}

function humanize(id) {
  const base = id.split("/").pop();
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/-/g, " ");
}

// Normalize a tab's page list into [{ label, entries }] groups. Bare page ids
// at the top level (e.g. a version's flat page list) are wrapped into one
// group labeled with the version name.
function badShape(where, entry) {
  throw new Error(
    `docs.json: unrecognized navigation entry in ${where}: ` +
    JSON.stringify(entry).slice(0, 160) +
    " (expected a page id string or a { group, pages } object)"
  );
}

function groupsOf(pages, fallbackLabel) {
  const groups = [];
  let loose = null;
  for (const entry of pages) {
    if (typeof entry === "string") {
      if (!loose) {
        loose = { label: fallbackLabel || "Pages", entries: [] };
        groups.push(loose);
      }
      loose.entries.push(entry);
    } else if (entry && Array.isArray(entry.pages)) {
      groups.push({ label: entry.group || fallbackLabel || "Pages", entries: entry.pages });
    } else {
      badShape("a tab's page list", entry);
    }
  }
  return groups;
}

// Flatten arbitrarily nested group entries into leaf page ids (used below the
// first nesting level, where the sidebar has no deeper visual container).
function leavesOf(entries, where) {
  const out = [];
  for (const e of entries) {
    if (typeof e === "string") out.push(e);
    else if (e && Array.isArray(e.pages)) out.push(...leavesOf(e.pages, where));
    else badShape(where, e);
  }
  return out;
}

// Build the full nav model:
//   tabs:    [{ id, label, home, routes, groups: [{ label, items }] }]
//            items: { label, route }
//                 | { label, tag, expanded, children: [{ label, route }] }
//            (a nested group renders as a collapsible sidebar sub-section;
//             `expanded: false` starts it collapsed, `tag` renders a badge)
//   index:   page id -> { id, label, route, tabId, tabLabel, breadcrumb, file }
//   pages:   ordered page ids (docs.json order, deduplicated)
//   missing: nav entries whose file does not exist
export function buildNav() {
  const docsJson = JSON.parse(readFileSync(join(DOCS, "docs.json"), "utf8"));
  const tabs = [];
  const index = {};
  const pages = [];
  const missing = [];

  const leaf = (id, tab, groupLabel, subLabel) => {
    const file = fileFor(id);
    const label = file ? titleOf(file, humanize(id)) : humanize(id);
    if (!file) missing.push(`${tab.label} > ${groupLabel}${subLabel ? " > " + subLabel : ""} > ${id}`);
    if (!index[id]) {
      index[id] = {
        id,
        label,
        route: routeFor(id),
        tabId: tab.id,
        tabLabel: tab.label,
        breadcrumb: subLabel
          ? [tab.label, groupLabel, subLabel, label]
          : [tab.label, groupLabel, label],
        file,
      };
      pages.push(id);
    }
    return { label, route: routeFor(id) };
  };

  for (const rawTab of docsJson.navigation?.tabs ?? []) {
    const tab = { id: idFromLabel(rawTab.tab), label: rawTab.tab, home: null, routes: [], groups: [] };
    const sourceGroups = [];
    // A tab lists page groups directly; older schemas nest them per version.
    if (Array.isArray(rawTab.pages)) sourceGroups.push(...groupsOf(rawTab.pages, rawTab.tab));
    if (Array.isArray(rawTab.versions)) {
      for (const v of rawTab.versions) sourceGroups.push(...groupsOf(v.pages ?? [], v.version));
    }
    if (!sourceGroups.length) badShape("navigation.tabs", rawTab);

    for (const g of sourceGroups) {
      const group = { label: g.label, items: [] };
      for (const entry of g.entries) {
        if (typeof entry === "string") {
          group.items.push(leaf(entry, tab, g.label));
        } else if (entry && Array.isArray(entry.pages)) {
          // Nested group -> collapsible sidebar subgroup. `expanded: false`
          // starts it collapsed; `tag` renders as a badge next to the label.
          // Nesting deeper than this flattens into the subgroup (the sidebar
          // has no deeper container; no page is ever dropped).
          const subLabel = entry.group || "Pages";
          const children = leavesOf(entry.pages, `group "${g.label}" > "${subLabel}"`)
            .map((id) => leaf(id, tab, g.label, subLabel));
          group.items.push({
            label: subLabel,
            tag: entry.tag || null,
            expanded: entry.expanded !== false,
            children,
          });
        } else {
          badShape(`group "${g.label}"`, entry);
        }
      }
      tab.groups.push(group);
    }

    for (const id of pages) {
      if (index[id].tabId === tab.id) tab.routes.push(index[id].route);
    }
    tab.home = tab.routes[0] || "/";
    tabs.push(tab);
  }

  return { tabs, index, pages, missing };
}
