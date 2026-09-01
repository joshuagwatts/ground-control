/** Local static + CORS proxy for Flags listing scrapes (browser preview). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const www = path.join(root, "www");
const PORT = Number(process.env.PORT) || 4174;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

async function proxy(req, res, target) {
  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    send(res, 200, buf, {
      "Content-Type": upstream.headers.get("content-type") || "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
  } catch (e) {
    send(res, 502, String(e?.message || e), { "Content-Type": "text/plain" });
  }
}

function staticFile(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || !rel) rel = "/index.html";
  const file = path.normalize(path.join(www, rel));
  if (!file.startsWith(www)) {
    send(res, 403, "forbidden");
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, "not found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (u.pathname === "/proxy") {
    const target = u.searchParams.get("url") || "";
    if (!/^https?:\/\//i.test(target)) {
      send(res, 400, "bad url");
      return;
    }
    void proxy(req, res, target);
    return;
  }
  staticFile(u.pathname, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Ground Control + Flags proxy → http://127.0.0.1:${PORT}/`);
  console.log(`Proxy: http://127.0.0.1:${PORT}/proxy?url=…`);
});
