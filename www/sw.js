/** Same-origin CORS proxy for NOAA SWDI + other blocked APIs on GitHub Pages. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 GroundControl-SW";

function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  const host = (u.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") throw new Error("blocked host");
  return u.toString();
}

async function proxyFetch(target) {
  const url = assertPublic(target);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json,text/html,*/*" },
    redirect: "follow",
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: {
      "Content-Type": res.headers.get("content-type") || "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "GC_SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (msg.type !== "GC_PROXY_GET" || !msg.url || !event.ports?.[0]) return;
  proxyFetch(msg.url)
    .then(async (res) => {
      event.ports[0].postMessage({ ok: res.ok, body: await res.text(), status: res.status });
    })
    .catch((e) => {
      event.ports[0].postMessage({ ok: false, err: String(e?.message || e) });
    });
});

self.addEventListener("fetch", (event) => {
  try {
    const u = new URL(event.request.url);
    if (!u.pathname.endsWith("/proxy")) return;
    const target = u.searchParams.get("url");
    if (!target) return;
    event.respondWith(
      proxyFetch(target).catch(
        () =>
          new Response(JSON.stringify({ error: "proxy failed", result: [] }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
  } catch {
    /* ignore non-proxy requests */
  }
});
