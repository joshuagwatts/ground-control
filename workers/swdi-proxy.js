/** Team SWDI CORS proxy — deploy with `npx wrangler deploy` or the SWDI Proxy workflow. */
const UA = "GroundControl-SWDI-Proxy/1.0";

function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  const host = (u.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") throw new Error("blocked host");
  return u.toString();
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    const u = new URL(request.url);
    const target = u.searchParams.get("url");
    if (!target) {
      return new Response(JSON.stringify({ error: "missing url param", result: [] }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    try {
      const upstream = assertPublic(target);
      const res = await fetch(upstream, {
        headers: { "User-Agent": UA, Accept: "application/json,text/html,*/*" },
        redirect: "follow",
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("content-type") || "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e), result: [] }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};
