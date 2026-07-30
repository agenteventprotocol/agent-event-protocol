// Cmd/Ctrl-K search modal over the build-time section index
// (assets/search-index.json), fetched lazily on first open.
(function () {
  "use strict";
  var NAV = window.AEP_NAV || [];

  var DOC_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21.4V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4Z"/><path d="M8 10L16 10"/><path d="M8 18L16 18"/><path d="M8 14L12 14"/><path d="M16 2V5.4C16 5.73137 16.2686 6 16.6 6H20"/></svg>';

  var index = null;
  var loadPromise = null;
  var isOpen = false;
  var sel = 0;
  var rows = [];
  var overlay, dialog, input, listEl;
  var lastFocused = null;

  // Parses trusted template strings only; never pass untrusted input.
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function loadIndex() {
    if (!loadPromise) {
      loadPromise = fetch("/assets/search-index.json")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          index = d;
          // The user may have typed while the index was in flight.
          if (isOpen && input && input.value.trim()) render();
          return d;
        })
        .catch(function (e) {
          console.warn("Failed to load search index", e);
          loadPromise = null;
        });
    }
    return loadPromise;
  }

  // Escape-safe highlighter: scans the raw text, escapes each piece, wraps
  // matches in <mark> so query tokens can never corrupt HTML entities.
  function highlight(text, re) {
    if (!re) return esc(text);
    var out = "";
    var last = 0;
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      out += esc(text.slice(last, m.index)) + "<mark>" + esc(m[0]) + "</mark>";
      last = m.index + m[0].length;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return out + esc(text.slice(last));
  }

  function snippet(text, re) {
    re.lastIndex = 0;
    var m = re.exec(text);
    if (!m) return "";
    var start = Math.max(0, m.index - 40);
    if (start > 0) {
      var sp = text.indexOf(" ", start);
      if (sp !== -1 && sp < m.index) start = sp + 1;
    }
    var end = Math.min(text.length, m.index + 130);
    return (start > 0 ? "…" : "") + highlight(text.slice(start, end), re) + (end < text.length ? "…" : "");
  }

  function search(q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length || !index) return [];
    var phrase = q.trim().toLowerCase();
    var scored = [];
    for (var i = 0; i < index.length; i++) {
      var r = index[i];
      var title = (r.heading || r.title).toLowerCase();
      var page = r.title.toLowerCase();
      var text = r.text.toLowerCase();
      var crumb = (r.crumb || "").toLowerCase();
      var score = 0;
      var ok = true;
      for (var j = 0; j < tokens.length; j++) {
        var tk = tokens[j];
        var inTitle = title.indexOf(tk) !== -1;
        var inPage = page.indexOf(tk) !== -1;
        var inText = text.indexOf(tk) !== -1;
        var inCrumb = crumb.indexOf(tk) !== -1;
        if (!inTitle && !inPage && !inText && !inCrumb) { ok = false; break; }
        if (inTitle) score += 24;
        if (inPage) score += 10;
        if (inCrumb) score += 4;
        if (inText) score += 2;
      }
      if (!ok) continue;
      if (title === phrase) score += 60;
      else if (title.indexOf(phrase) === 0) score += 30;
      else if (title.indexOf(phrase) !== -1) score += 20;
      if (text.indexOf(phrase) !== -1) score += 8;
      if (!r.anchor) score += 2;
      scored.push({ r: r, score: score });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 30).map(function (s) { return s.r; });
  }

  function itemHtml(href, titleHtml, crumbHtml, snippetHtml) {
    return (
      '<a class="sm-item" href="' + esc(href) + '">' +
      '<span class="sm-ic">' + DOC_ICON + "</span>" +
      '<span class="sm-item-main">' +
      '<span class="sm-item-title">' + titleHtml + "</span>" +
      (crumbHtml ? '<span class="sm-item-crumb">' + crumbHtml + "</span>" : "") +
      (snippetHtml ? '<span class="sm-item-snippet">' + snippetHtml + "</span>" : "") +
      "</span></a>"
    );
  }

  // Empty-query view: every page grouped by top tab, in nav order.
  function defaultHtml() {
    return NAV.map(function (t) {
      var pages = [];
      (t.groups || []).forEach(function (g) {
        g.items.forEach(function (it) {
          if (it.children) it.children.forEach(function (c) { pages.push(c); });
          else if (it.route) pages.push(it);
        });
      });
      var items = pages.map(function (p) {
        return itemHtml(p.route, esc(p.label), "", "");
      }).join("");
      return '<div class="sm-group"><div class="sm-group-label">' + esc(t.label) + "</div>" + items + "</div>";
    }).join("");
  }

  function resultsHtml(results, q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    var re = new RegExp("(" + tokens.map(escRe).join("|") + ")", "gi");
    var groups = [];
    var byTab = {};
    results.forEach(function (r) {
      if (!byTab[r.tab]) {
        byTab[r.tab] = [];
        groups.push(r.tab);
      }
      byTab[r.tab].push(r);
    });
    return groups.map(function (tab) {
      var items = byTab[tab].map(function (r) {
        var href = r.route + (r.anchor ? "#" + r.anchor : "");
        var crumbLine = r.heading
          ? [r.crumb, r.title].filter(Boolean).join(" › ")
          : r.crumb;
        return itemHtml(href, highlight(r.heading || r.title, re), esc(crumbLine || ""), snippet(r.text, re));
      }).join("");
      return '<div class="sm-group"><div class="sm-group-label">' + esc(tab) + "</div>" + items + "</div>";
    }).join("");
  }

  // ARIA listbox owned by the input: options are not tab stops; the active one
  // is reported via aria-activedescendant so focus stays in the field.
  function decorateOptions() {
    var opts = listEl.querySelectorAll(".sm-item");
    for (var i = 0; i < opts.length; i++) {
      opts[i].setAttribute("role", "option");
      opts[i].setAttribute("id", "sm-opt-" + i);
      opts[i].setAttribute("tabindex", "-1");
    }
    var groups = listEl.querySelectorAll(".sm-group");
    for (var g = 0; g < groups.length; g++) {
      var label = groups[g].querySelector(".sm-group-label");
      if (!label) continue;
      label.id = "sm-grp-" + g;
      groups[g].setAttribute("role", "group");
      groups[g].setAttribute("aria-labelledby", label.id);
    }
  }

  function setSel(i, scroll) {
    rows = listEl.querySelectorAll(".sm-item");
    if (!rows.length) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    sel = Math.max(0, Math.min(i, rows.length - 1));
    for (var k = 0; k < rows.length; k++) {
      var on = k === sel;
      rows[k].classList.toggle("active", on);
      rows[k].setAttribute("aria-selected", String(on));
    }
    input.setAttribute("aria-activedescendant", rows[sel].id);
    if (scroll && rows[sel].scrollIntoView) rows[sel].scrollIntoView({ block: "nearest" });
  }

  function render() {
    var q = input.value.trim();
    if (!q) {
      listEl.innerHTML = defaultHtml();
    } else if (!index) {
      listEl.innerHTML = '<div class="sm-empty">Loading index…</div>';
    } else {
      var results = search(q);
      listEl.innerHTML = results.length
        ? resultsHtml(results, q)
        : '<div class="sm-empty">No results for &ldquo;' + esc(q) + "&rdquo;</div>";
    }
    listEl.scrollTop = 0;
    decorateOptions();
    setSel(0, false);
    wireHover();
  }

  function wireHover() {
    listEl.querySelectorAll(".sm-item").forEach(function (item, i) {
      item.addEventListener("mouseenter", function () { setSel(i, false); });
      item.addEventListener("click", function () { close(); });
    });
  }

  function onKey(e) {
    // The input is the dialog's only tab stop; swallow Tab so focus cannot escape.
    if (e.key === "Tab") { e.preventDefault(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(sel + 1, true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(sel - 1, true); }
    else if (e.key === "Enter") {
      e.preventDefault();
      rows = listEl.querySelectorAll(".sm-item");
      if (rows[sel]) {
        var href = rows[sel].getAttribute("href");
        close();
        window.location.href = href;
      }
    }
  }

  function build() {
    if (overlay) return;
    overlay = el('<div class="sm-overlay" hidden></div>');
    dialog = el(
      '<div class="sm-dialog" role="dialog" aria-modal="true" aria-label="Search documentation">' +
      '<div class="sm-input-row"><input class="sm-input" type="text" placeholder="Search documentation..." ' +
      'role="combobox" aria-expanded="true" aria-controls="sm-list" aria-autocomplete="list" ' +
      'aria-label="Search documentation" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" /></div>' +
      '<div class="sm-list" id="sm-list" role="listbox" aria-label="Search results"></div>' +
      '<div class="sm-footer">' +
      '<span class="sm-foot-brand">AGENT EVENT PROTOCOL</span>' +
      '<div class="sm-hints">' +
      '<span class="sm-hint">Navigate <kbd class="sm-kbd">&uarr;</kbd><kbd class="sm-kbd">&darr;</kbd></span>' +
      '<span class="sm-hint">Open <kbd class="sm-kbd">&crarr;</kbd></span>' +
      '<span class="sm-hint">Close <kbd class="sm-kbd">esc</kbd></span>' +
      "</div></div></div>"
    );
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input = dialog.querySelector(".sm-input");
    listEl = dialog.querySelector(".sm-list");
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    input.addEventListener("input", render);
    input.addEventListener("keydown", onKey);
  }

  function open() {
    build();
    lastFocused = document.activeElement;
    isOpen = true;
    overlay.hidden = false;
    document.body.classList.add("sm-open");
    input.value = "";
    render();
    input.focus();
    loadIndex();
  }

  function close() {
    if (!overlay) return;
    isOpen = false;
    overlay.hidden = true;
    document.body.classList.remove("sm-open");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function toggle() { isOpen ? close() : open(); }

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "k") {
      e.preventDefault();
      toggle();
    } else if (e.key === "Escape" && isOpen) {
      close();
    }
  });

  window.AEP_SEARCH = { open: open, close: close, toggle: toggle };
})();
