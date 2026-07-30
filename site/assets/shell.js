// Injects the topbar and sidebar from the build-time nav bundle, and wires
// the page interactions: theme toggle, mobile drawer, copy buttons, TOC
// scroll spy, and the entrance/reveal motion.
(function () {
  "use strict";
  var NAV = window.AEP_NAV || [];
  var route = document.body.getAttribute("data-route") || "/";

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // which tab is active
  function tabForRoute(r) {
    for (var i = 0; i < NAV.length; i++) {
      var routes = NAV[i].routes || [];
      for (var j = 0; j < routes.length; j++) {
        if (routes[j] === r) return NAV[i];
      }
    }
    // fallback: longest home-prefix match (covers deep links to anchors etc.)
    var best = NAV[0];
    var bestLen = -1;
    for (var k = 0; k < NAV.length; k++) {
      var home = NAV[k].home || "/";
      var prefix = home.replace(/[^/]+\/$/, "");
      if (prefix !== "/" && r.indexOf(prefix) === 0 && prefix.length > bestLen) {
        best = NAV[k];
        bestLen = prefix.length;
      }
    }
    return best;
  }
  var activeTab = tabForRoute(route);

  // icons (inline SVG, stroke = currentColor)
  var SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17L21 21"/><path d="M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z"/></svg>';
  var BURGER = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5H21"/><path d="M3 12H21"/><path d="M3 19H21"/></svg>';
  var MOON = '<svg class="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3A7 7 0 0 0 21 12.79Z"/></svg>';
  var SUN = '<svg class="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.25"/><path d="M12 2.5V4.75"/><path d="M12 19.25V21.5"/><path d="M4.78 4.78L6.37 6.37"/><path d="M17.63 17.63L19.22 19.22"/><path d="M2.5 12H4.75"/><path d="M19.25 12H21.5"/><path d="M6.37 17.63L4.78 19.22"/><path d="M19.22 4.78L17.63 6.37"/></svg>';
  var CHEV_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M6 9l6 6 6-6"/></svg>';
  var GITHUB = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
  var REPO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7.35304L21 16.647C21 16.8649 20.8819 17.0656 20.6914 17.1715L12.2914 21.8381C12.1102 21.9388 11.8898 21.9388 11.7086 21.8381L3.30861 17.1715C3.11814 17.0656 3 16.8649 3 16.647L2.99998 7.35304C2.99998 7.13514 3.11812 6.93437 3.3086 6.82855L11.7086 2.16188C11.8898 2.06121 12.1102 2.06121 12.2914 2.16188L20.6914 6.82855C20.8818 6.93437 21 7.13514 21 7.35304Z"/><path d="M3.52844 7.29357L11.7086 11.8381C11.8898 11.9388 12.1102 11.9388 12.2914 11.8381L20.5 7.27777"/><path d="M12 21L12 12"/></svg>';

  // ⌘K is Mac-only; the shortcut accepts Ctrl everywhere.
  var IS_MAC = /mac|iphone|ipad|ipod/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ""
  );
  var SHORTCUT_LABEL = IS_MAC ? "⌘K" : "Ctrl K";

  var ORG_URL = "https://github.com/agenteventprotocol";
  var GITHUB_URL = ORG_URL + "/agent-event-protocol";
  // Org repositories for the split-button dropdown (spec repo first).
  var REPOS = ["agent-event-protocol", "reference", "mission-control", "typescript-sdk", "python-sdk"];

  // topbar
  function buildTopbar() {
    var bar = document.getElementById("topbar");
    if (!bar) return;
    // Tab bar renders only when there is more than one tab.
    var tabs = NAV.length > 1
      ? NAV.map(function (t) {
          var on = t.id === activeTab.id;
          return '<a class="tab-link' + (on ? " active" : "") + '"' +
            (on ? ' aria-current="page"' : "") +
            ' href="' + esc(t.home) + '">' + esc(t.label) + "</a>";
        }).join("")
      : "";

    var menuItems = REPOS.map(function (name, i) {
      return (
        '<a href="' + ORG_URL + "/" + name + '" target="_blank" rel="noopener" role="menuitem">' +
        REPO_ICON + name + "</a>" +
        (i === 0 ? '<div class="menu-sep"></div>' : "")
      );
    }).join("");

    bar.innerHTML =
      '<button class="icon-btn nav-burger" id="navToggle" aria-label="Open navigation" aria-expanded="false">' + BURGER + "</button>" +
      '<a class="brand" href="/" aria-label="Agent Event Protocol">' +
      '<img class="logo-light" src="/logo/light.svg" alt="Agent Event Protocol" />' +
      '<img class="logo-dark" src="/logo/dark.svg" alt="Agent Event Protocol" />' +
      "</a>" +
      (tabs ? '<nav class="topbar-center" aria-label="Documentation sections">' + tabs + "</nav>" : "") +
      '<div class="topbar-right">' +
      '<button class="icon-btn" id="themeToggle" title="Toggle theme" aria-label="Toggle theme"></button>' +
      '<button class="search" type="button" aria-label="Search documentation" aria-keyshortcuts="Meta+K Control+K">' +
      '<span class="ic">' + SEARCH_ICON + '</span><span class="placeholder">Search</span>' +
      '<span class="kbd" aria-hidden="true">' + SHORTCUT_LABEL + "</span></button>" +
      '<div class="repo-wrap" id="repoWrap">' +
      '<div class="repo-btn">' +
      '<a class="label" href="' + GITHUB_URL + '" target="_blank" rel="noopener">' + GITHUB + "<span>GitHub</span></a>" +
      '<button class="split" id="repoToggle" aria-haspopup="true" aria-expanded="false" aria-label="Open repositories menu">' + CHEV_DOWN + "</button>" +
      "</div>" +
      '<div class="repo-menu" role="menu">' + menuItems + "</div>" +
      "</div>" +
      "</div>";
  }

  function wireRepoDropdown() {
    var wrap = document.getElementById("repoWrap");
    var toggle = document.getElementById("repoToggle");
    if (!wrap || !toggle) return;
    function close() { wrap.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = wrap.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  // sidebar
  function linkHtml(item) {
    var on = item.route === route;
    return '<a class="nav-link' + (on ? " active" : "") + '"' +
      (on ? ' aria-current="page"' : "") +
      ' href="' + esc(item.route) + '">' + esc(item.label) + "</a>";
  }

  function buildSidebar() {
    var sb = document.getElementById("sidebar");
    if (!sb) return;

    // Mobile tab switcher dropdown (hidden on desktop via CSS).
    var switcher = "";
    if (NAV.length > 1) {
      var tabItems = NAV.map(function (t) {
        var activeCls = t.id === activeTab.id ? " mob-tab-item-active" : "";
        return '<a class="mob-tab-item' + activeCls + '" href="' + esc(t.home) + '">' + esc(t.label) + "</a>";
      }).join("");
      switcher =
        '<div class="mob-tab-switcher">' +
          '<button class="mob-tab-btn" id="mobTabBtn" aria-haspopup="true" aria-expanded="false">' +
            "<span>" + esc(activeTab.label) + "</span>" + CHEV_DOWN +
          "</button>" +
          '<div class="mob-tab-menu" id="mobTabMenu">' + tabItems + "</div>" +
        "</div>";
    }

    var html = (activeTab.groups || []).map(function (g) {
      var items = g.items.map(function (item) {
        if (item.children) {
          // Collapsible subgroup: `expanded: false` starts collapsed, but the
          // active page's subgroup always opens so the location stays visible.
          var kids = item.children.map(linkHtml).join("");
          var hasActive = item.children.some(function (c) { return c.route === route; });
          var open = hasActive || item.expanded !== false;
          var tag = item.tag ? '<span class="nav-tag">' + esc(item.tag) + "</span>" : "";
          return (
            '<div class="nav-subgroup' + (open ? "" : " collapsed") + '">' +
            '<button class="nav-subgroup-toggle" type="button" aria-expanded="' + open + '">' +
            '<span class="nav-subgroup-label">' + esc(item.label) + "</span>" + tag + CHEV_DOWN +
            "</button>" +
            '<div class="nav-children">' + kids + "</div></div>"
          );
        }
        return linkHtml(item);
      }).join("");
      // a single-page tab derives its group label from the tab name; don't repeat it
      var label = g.label === activeTab.label
        ? ""
        : '<div class="nav-group-label">' + esc(g.label) + "</div>";
      return '<div class="nav-group">' + label + items + "</div>";
    }).join("");
    sb.innerHTML = switcher + html;

    sb.querySelectorAll(".nav-subgroup-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var sub = btn.closest(".nav-subgroup");
        var collapsed = sub.classList.toggle("collapsed");
        btn.setAttribute("aria-expanded", String(!collapsed));
      });
    });
  }

  // Static site: every navigation rebuilds the sidebar. Restore the previous
  // scroll position, then make sure the active link is visible.
  function restoreSidebarScroll() {
    var sb = document.getElementById("sidebar");
    if (!sb) return;
    var key = "aep-sidebar-scroll:" + activeTab.id;
    var saved = null;
    try { saved = sessionStorage.getItem(key); } catch (e) { /* storage blocked */ }
    if (saved !== null) {
      var n = parseInt(saved, 10);
      if (!isNaN(n)) sb.scrollTop = n;
    }
    var active = sb.querySelector(".nav-link.active");
    if (active) {
      var sbRect = sb.getBoundingClientRect();
      var aRect = active.getBoundingClientRect();
      if (aRect.top < sbRect.top || aRect.bottom > sbRect.bottom) {
        sb.scrollTop += aRect.top - sbRect.top - sb.clientHeight / 2 + aRect.height / 2;
      }
    }
    window.addEventListener("pagehide", function () {
      try { sessionStorage.setItem(key, String(sb.scrollTop)); } catch (e) { /* storage blocked */ }
    });
  }

  // interactions
  function wireTheme() {
    var root = document.documentElement;
    var btn = document.getElementById("themeToggle");
    if (!btn) return;
    // Both icons render; CSS cross-fades to the one a click applies.
    btn.innerHTML = MOON + SUN;
    function relabel() {
      var text = root.getAttribute("data-theme") === "dark" ? "Switch to light theme" : "Switch to dark theme";
      btn.setAttribute("aria-label", text);
      btn.setAttribute("title", text);
    }
    relabel();
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("aep-theme", next); } catch (e) { /* storage blocked */ }
      relabel();
    });
  }

  // CodeGroup pill tabs: switch the visible pane.
  function wireCodeGroups() {
    document.querySelectorAll(".code-group").forEach(function (g) {
      g.querySelectorAll(".cg-tab").forEach(function (tab) {
        tab.addEventListener("click", function () {
          var i = tab.getAttribute("data-i");
          g.querySelectorAll(".cg-tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
          g.querySelectorAll(".cg-pane").forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-i") === i); });
        });
      });
    });
  }

  // Interactive <Tabs>: underline tab strip above stacked panes.
  function wireTabs() {
    document.querySelectorAll(".mdx-tabs").forEach(function (t) {
      var bar = t.querySelector(":scope > .tabs-bar");
      var panes = t.querySelector(":scope > .tabs-panes");
      if (!bar || !panes) return;
      bar.querySelectorAll(".tab-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var i = btn.getAttribute("data-i");
          bar.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b === btn); });
          panes.querySelectorAll(":scope > .mdx-tab").forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-i") === i); });
        });
      });
    });
  }

  // Large tables get a build-time toolbar (filter input + row count); wire
  // the client-side filtering here. Small tables carry no toolbar.
  function wireTableFilters() {
    document.querySelectorAll(".table-wrap").forEach(function (wrap) {
      var input = wrap.querySelector(".filter-input input");
      var table = wrap.querySelector("table");
      var count = wrap.querySelector(".row-count");
      if (!input || !table) return;
      var rows = Array.prototype.slice.call(table.querySelectorAll("tbody tr"));
      var noRes = null;
      function update() {
        var q = input.value.trim().toLowerCase();
        var shown = 0;
        rows.forEach(function (tr) {
          var hit = !q || tr.textContent.toLowerCase().indexOf(q) !== -1;
          tr.style.display = hit ? "" : "none";
          if (hit) shown++;
        });
        if (count) count.textContent = q ? shown + " of " + rows.length + " rows" : rows.length + " rows";
        if (!shown) {
          if (!noRes) {
            noRes = el('<div class="no-results">No rows match your filter.</div>');
            wrap.appendChild(noRes);
          }
          noRes.style.display = "";
          table.style.display = "none";
        } else {
          if (noRes) noRes.style.display = "none";
          table.style.display = "";
        }
      }
      input.addEventListener("input", update);
      update();
    });
  }

  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13L9 17L19 7"/></svg>';

  // navigator.clipboard is absent outside a secure context and rejects when denied.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy unavailable"));
    });
  }

  function flash(btn, html, cls, ms) {
    var orig = btn.getAttribute("data-orig") || btn.innerHTML;
    btn.setAttribute("data-orig", orig);
    btn.classList.add(cls);
    btn.innerHTML = html;
    setTimeout(function () {
      btn.classList.remove(cls);
      btn.innerHTML = orig;
    }, ms);
  }

  var CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6L18 18"/></svg>';
  function wireCopy() {
    document.querySelectorAll(".code-copy").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var block = btn.closest(".code-block");
        var pre = block && block.querySelector("code");
        if (!pre) return;
        copyText(pre.textContent).then(
          function () { flash(btn, CHECK, "copied", 1200); },
          function () { flash(btn, CROSS, "copy-failed", 1600); }
        );
      });
    });
  }

  function wireMobileNav() {
    var btn = document.getElementById("navToggle");
    var sb = document.getElementById("sidebar");
    if (!btn || !sb) return;
    var backdrop = el('<div class="nav-backdrop"></div>');
    document.body.appendChild(backdrop);
    function set(open) {
      document.body.classList.toggle("nav-open", open);
      btn.setAttribute("aria-expanded", String(open));
    }
    btn.addEventListener("click", function () { set(!document.body.classList.contains("nav-open")); });
    backdrop.addEventListener("click", function () { set(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") set(false); });
    sb.addEventListener("click", function (e) {
      if (e.target.closest("#mobTabBtn")) return;
      if (e.target.closest("a")) set(false);
    });

    var tabBtn = document.getElementById("mobTabBtn");
    var tabMenu = document.getElementById("mobTabMenu");
    if (tabBtn && tabMenu) {
      var setTabMenu = function (open) {
        tabMenu.classList.toggle("mob-tab-menu-open", open);
        tabBtn.setAttribute("aria-expanded", String(open));
        tabBtn.classList.toggle("open", open);
      };
      tabBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        setTabMenu(!tabMenu.classList.contains("mob-tab-menu-open"));
      });
      document.addEventListener("click", function (e) {
        if (!tabBtn.contains(e.target) && !tabMenu.contains(e.target)) setTabMenu(false);
      });
    }
  }

  // Page hand-offs
  var AI_TARGETS = {
    chatgpt: "https://chatgpt.com/?hint=search&q=",
    claude: "https://claude.ai/new?q=",
  };

  function wirePageActions() {
    var wrap = document.getElementById("pageActions");
    if (!wrap) return;
    var mdHref = wrap.getAttribute("data-md");
    var main = document.getElementById("copyPage");
    var toggle = document.getElementById("pageActionsToggle");

    var prompt = "Read " + new URL(mdHref, location.href).href +
      " so I can ask questions about this page.";
    Object.keys(AI_TARGETS).forEach(function (key) {
      var link = wrap.querySelector('[data-ai="' + key + '"]');
      if (link) link.setAttribute("href", AI_TARGETS[key] + encodeURIComponent(prompt));
    });

    function copy(btn) {
      var label = btn.querySelector("span");
      var orig = label ? label.textContent : "";
      function report(text, cls, ms) {
        btn.classList.add(cls);
        if (label) label.textContent = text;
        setTimeout(function () {
          btn.classList.remove(cls);
          if (label) label.textContent = orig;
        }, ms);
      }
      fetch(mdHref)
        .then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        })
        .then(function (text) { return copyText(text); })
        .then(
          function () { report("Copied", "copied", 1400); },
          function () { report("Copy failed", "copy-failed", 1600); }
        );
    }

    function close() {
      wrap.classList.remove("open");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    }

    if (main) main.addEventListener("click", function () { copy(main); });
    if (toggle) {
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = wrap.classList.toggle("open");
        toggle.setAttribute("aria-expanded", String(open));
      });
    }
    wrap.addEventListener("click", function (e) {
      var item = e.target.closest(".pa-item");
      if (!item) return;
      // the copy item reports on the always-visible primary half
      if (item.getAttribute("data-act") === "copy") copy(main || item);
      close();
    });
    document.addEventListener("click", function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  function wireSearchTrigger() {
    // The shortcut itself is handled by search.js; the pill opens the modal.
    var trigger = document.querySelector(".topbar .search");
    if (!trigger) return;
    trigger.addEventListener("click", function () {
      if (window.AEP_SEARCH) window.AEP_SEARCH.open();
    });
  }

  // Wide layout hides the summary, so a stale collapsed state must not persist.
  function wireTocLayout() {
    var toc = document.getElementById("toc");
    if (!toc) return;
    var wide = window.matchMedia("(min-width: 1280px)");
    function sync() { if (wide.matches) toc.open = true; }
    sync();
    if (wide.addEventListener) wide.addEventListener("change", sync);
    else if (wide.addListener) wide.addListener(sync);
  }

  function wireTocSpy() {
    var links = Array.prototype.slice.call(document.querySelectorAll(".toc-link"));
    if (!links.length) return;
    var headings = links
      .map(function (link) {
        var id = (link.getAttribute("href") || "").slice(1);
        var target = id && document.getElementById(id);
        return target ? { link: link, target: target } : null;
      })
      .filter(Boolean);
    if (!headings.length) return;

    var ticking = false;
    function update() {
      ticking = false;
      var threshold = window.scrollY + 120;
      var current = headings[0];
      for (var i = 0; i < headings.length; i++) {
        if (headings[i].target.offsetTop <= threshold) current = headings[i];
        else break;
      }
      headings.forEach(function (h) { h.link.classList.toggle("active", h === current); });
    }
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
    update();
  }

  // micro-interactions: staggered intro + scroll reveal
  function wireMotion() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.documentElement.classList.add("motion");
    var content = document.querySelector(".content");
    if (!content) return;

    // Entrance animation only on the first load of a session.
    var fresh = false;
    try {
      fresh = !sessionStorage.getItem("aep-visited");
      sessionStorage.setItem("aep-visited", "1");
    } catch (e) { /* storage blocked: treat as a repeat visit */ }

    var fold = window.innerHeight || 800;
    var below = [];
    var delay = 0;
    Array.prototype.forEach.call(content.children, function (node) {
      if (node.offsetTop >= fold) {
        below.push(node);
      } else if (fresh) {
        node.classList.add("intro");
        node.style.animationDelay = delay + "ms";
        delay = Math.min(delay + 55, 440);
      }
    });

    if (fresh) {
      var toc = document.querySelector(".toc");
      if (toc) toc.classList.add("intro-fade");
      var sb = document.getElementById("sidebar");
      if (sb) sb.classList.add("intro-fade");
    }

    // Deep links land mid-page: render that content immediately.
    if (location.hash || !below.length || !("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    below.forEach(function (node) {
      node.classList.add("reveal");
      io.observe(node);
    });
  }

  // Smooth-scroll in-page anchors without animating initial deep links.
  function wireSmoothAnchors() {
    if (!document.documentElement.classList.contains("motion")) return;
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var target = document.getElementById(a.getAttribute("href").slice(1));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth" });
      history.pushState(null, "", a.getAttribute("href"));
    });
  }

  function wireTopbarShadow() {
    var bar = document.getElementById("topbar");
    if (!bar) return;
    var ticking = false;
    function update() {
      ticking = false;
      bar.classList.toggle("scrolled", window.scrollY > 8);
    }
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
    update();
  }

  buildTopbar();
  buildSidebar();
  restoreSidebarScroll();
  wireMotion();
  wireSmoothAnchors();
  wireTopbarShadow();
  wireTheme();
  wireRepoDropdown();
  wireMobileNav();
  wireCodeGroups();
  wireTabs();
  wireTableFilters();
  wireCopy();
  wirePageActions();
  wireSearchTrigger();
  wireTocLayout();
  wireTocSpy();
})();
