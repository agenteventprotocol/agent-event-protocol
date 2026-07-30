// Zero-dependency static file server for dist/. Port 4173 by default,
// overridable with PORT. Directories serve their index.html; unknown paths
// get a plain 404.
//
// `node serve.mjs` serves dist/ exactly as published. dev.mjs passes
// liveReload, adding the /__dev/reload SSE endpoint and injecting the reload
// client into HTML responses, at serve time, never in the build, so dist/
// stays byte-identical to what CI publishes.
import "./env.mjs";
import { createServer } from "node:http";
import { stat, readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "dist");
const DEFAULT_PORT = Number(process.env.PORT) || 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

const RELOAD_PATH = "/__dev/reload";

// Injected before </body> in dev only. The stream holds one of the browser's
// six per-origin connections, so pagehide must close it: a page that keeps it
// after navigation starves the next page of sockets. bfcache restores
// (pageshow.persisted) reopen it.
const RELOAD_SCRIPT = `<script>
(function(){var e;function open(){try{e=new EventSource(${JSON.stringify(RELOAD_PATH)});e.onmessage=function(m){if(m.data==="reload")location.reload()}}catch(_){}}
addEventListener("pagehide",function(){if(e)e.close()});
addEventListener("pageshow",function(v){if(v.persisted)open()});
open();})();
</script>`;

// Serves the built 404.html so a miss looks locally as it will in production;
// falls back to plain text if the build has not produced one yet.
async function notFound(res) {
  try {
    const body = await readFile(join(ROOT, "404.html"));
    res.writeHead(404, { "Content-Type": MIME[".html"], "Content-Length": body.length });
    return res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}

function openReloadStream(req, res, clients) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 500\n\n");
  clients.add(res);
  const beat = setInterval(() => res.write(": keepalive\n\n"), 30_000);
  beat.unref();
  const drop = () => {
    clearInterval(beat);
    clients.delete(res);
  };
  req.on("close", drop);
  res.on("close", drop);
}

export function startServer({ port = DEFAULT_PORT, liveReload = false } = {}) {
  const clients = new Set();

  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

      if (liveReload && path === RELOAD_PATH) return openReloadStream(req, res, clients);

      // Resolve inside the dist root only.
      path = normalize(path).replace(/^(\.\.[/\\])+/, "");
      let file = join(ROOT, path);
      if (!file.startsWith(ROOT)) return notFound(res);

      let st = null;
      try {
        st = await stat(file);
      } catch {
        /* fall through to the directory/404 handling below */
      }

      if (st && st.isDirectory()) {
        if (!path.endsWith("/")) {
          res.writeHead(301, { Location: path + "/" });
          return res.end();
        }
        file = join(file, "index.html");
        try {
          st = await stat(file);
        } catch {
          st = null;
        }
      }

      if (!st || !st.isFile()) return notFound(res);

      const ext = extname(file).toLowerCase();
      let body = await readFile(file);

      if (liveReload && ext === ".html") {
        const html = body.toString("utf8");
        const at = html.lastIndexOf("</body>");
        body = Buffer.from(
          at === -1 ? html + RELOAD_SCRIPT : html.slice(0, at) + RELOAD_SCRIPT + html.slice(at),
          "utf8"
        );
      }

      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": body.length,
        // A rebuild rewrites every file; never serve a cached copy of one.
        ...(liveReload ? { "Cache-Control": "no-store" } : {}),
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("500 Internal Server Error");
    }
  });

  server.listen(port, () => {
    console.log(`Serving dist/ at http://localhost:${port}/`);
  });

  return {
    server,
    notifyReload() {
      for (const res of clients) res.write("data: reload\n\n");
      return clients.size;
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
      server.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
