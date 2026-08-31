import { withLanBypass } from "./proton.js";

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

/** CapacitorHttp — core plugin (Bridge always registers it). Prefer request() then get/post. */
function nativeHttp() {
  const cap = window.Capacitor;
  const plugins = cap && (cap.Plugins || cap.plugins);
  return (plugins && plugins.CapacitorHttp) || null;
}

export function hasNativeHttp() {
  return Boolean(nativeHttp());
}

export function httpDiag() {
  const cap = window.Capacitor;
  const http = nativeHttp();
  return {
    platform: cap?.getPlatform?.() || (cap ? "native?" : "web"),
    nativeHttp: Boolean(http),
    methods: http ? Object.keys(http).filter((k) => typeof http[k] === "function").slice(0, 12) : [],
  };
}

function parseCookie(setCookie) {
  const parts = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const part of parts) {
    const raw = String(part || "");
    const hit = raw.match(/pip_gate=([^;,\s]+)/i);
    if (hit) return hit[1];
  }
  return "";
}

function assertPublic(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("bad url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("need http(s)");
  const host = (u.hostname || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "127.0.0.1" || host === "::1") {
    throw new Error("public web only");
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) {
    throw new Error("public web only");
  }
  return u.toString();
}

function assertLan(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("bad url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("need http(s)");
  const host = (u.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("use your PC LAN IP, not localhost");
  }
  return u.toString();
}

function bodyToObject(data) {
  if (data == null) return {};
  if (typeof data === "object") return data;
  if (typeof data === "string") {
    try {
      return JSON.parse(data || "{}");
    } catch {
      return { raw: data };
    }
  }
  return {};
}

function bodyToText(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

async function nativeRequest(method, url, headers, body, timeoutMs) {
  const http = nativeHttp();
  if (!http) return null;
  const req = {
    url,
    method: method.toUpperCase(),
    headers: { "User-Agent": UA, Accept: "application/json,text/html,*/*", ...headers },
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
    disableRedirects: false,
  };
  if (body !== undefined) {
    req.data = typeof body === "string" ? body : JSON.stringify(body);
    if (!req.headers["Content-Type"] && !req.headers["content-type"]) {
      req.headers["Content-Type"] = "application/json";
    }
  }
  let res;
  try {
    if (typeof http.request === "function") {
      res = await http.request(req);
    } else if (method === "POST" && typeof http.post === "function") {
      res = await http.post(req);
    } else if (method === "GET" && typeof http.get === "function") {
      res = await http.get(req);
    } else {
      return null;
    }
  } catch (e) {
    const err = new Error(String(e?.message || e || "native http failed"));
    err.status = 0;
    throw err;
  }
  return {
    status: Number(res?.status) || 0,
    data: res?.data,
    headers: res?.headers || {},
    url: res?.url || url,
  };
}

async function request(method, url, headers, body, timeoutMs, assertFn) {
  const target = assertFn(url);
  const publicCall = assertFn === assertPublic;

  const native = await nativeRequest(method, target, headers, body, timeoutMs);
  if (native) {
    const status = native.status;
    const data = bodyToObject(native.data);
    let cookie = "";
    for (const [k, v] of Object.entries(native.headers || {})) {
      if (/^set-cookie$/i.test(k)) {
        cookie = parseCookie(v);
        if (cookie) break;
      }
    }
    if (cookie) data._cookie = cookie;
    if (!status) {
      const err = new Error(
        publicCall
          ? "network failed — check mobile data/Wi‑Fi · Proton may be blocking this API"
          : "network failed — Proton: Allow LAN connections · or same Wi‑Fi · Open-Firewall.bat as Admin",
      );
      err.status = 0;
      throw err;
    }
    if (status >= 400) {
      const detail =
        (data && (data.detail || (typeof data.error === "string" ? data.error : data.error?.message))) ||
        `http ${status}`;
      const err = new Error(String(detail).slice(0, 180));
      err.status = status;
      throw err;
    }
    return data;
  }

  // Web / browser preview — CORS may block cloud APIs.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init = {
      method,
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "application/json,text/html,*/*", ...headers },
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(target, init);
    const data = await res.json().catch(() => ({}));
    const cookie = parseCookie(res.headers.get("set-cookie"));
    if (cookie) data._cookie = cookie;
    if (!res.ok) {
      const detail =
        (typeof data.error === "string" ? data.error : data.error?.message) || data.detail || `http ${res.status}`;
      const err = new Error(String(detail).slice(0, 180));
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.status != null) throw e;
    const msg = String(e?.message || e || "fetch failed");
    if (/abort/i.test(msg)) throw new Error("timeout");
    throw new Error(publicCall ? `fetch failed — ${msg.slice(0, 100)}` : msg);
  } finally {
    clearTimeout(t);
  }
}

export async function httpGet(url, timeoutMs = 14000, extraHeaders = {}) {
  const target = assertPublic(url);
  const headers = { "User-Agent": UA, Accept: "text/html,application/json,*/*", ...extraHeaders };

  const native = await nativeRequest("GET", target, headers, undefined, timeoutMs);
  if (native) {
    const status = native.status;
    if (!status) throw new Error("network failed — check data/Wi‑Fi · Proton may block this API");
    if (status >= 400) throw new Error(`fetch ${status}`);
    return { url: native.url || target, status, body: bodyToText(native.data) };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { signal: ctrl.signal, redirect: "follow", headers });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return { url: res.url, status: res.status, body: await res.text() };
  } catch (e) {
    const msg = String(e?.message || e || "fetch failed");
    if (/abort/i.test(msg)) throw new Error("timeout");
    // Browser CORS (GitHub Pages / Safari): retry via public CORS proxies.
    if (needsBrowserCorsProxy(target)) {
      try {
        return await httpGetViaCorsProxy(target, timeoutMs);
      } catch {
        /* fall through */
      }
    }
    if (/^fetch \d/.test(msg)) throw e;
    throw new Error(`fetch failed — ${msg.slice(0, 100)}`);
  } finally {
    clearTimeout(t);
  }
}

function needsBrowserCorsProxy(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h.endsWith("ncdc.noaa.gov") ||
      h.endsWith("noaa.gov") ||
      h.endsWith("weather.gov") ||
      h.endsWith("mesonet.org") ||
      h.endsWith("iowa.edu") ||
      h.includes("overpass") ||
      h.endsWith("openstreetmap.org") ||
      h.endsWith("zillow.com") ||
      h.endsWith("apartments.com") ||
      h.endsWith("realtor.com") ||
      h.endsWith("411.com") ||
      h.endsWith("whitepages.com") ||
      h.endsWith("anywho.com") ||
      h.endsWith("yellowpages.com") ||
      h.includes("chamber") ||
      h.includes("duckduckgo") ||
      h.includes("arcgis.com") ||
      h.includes("oklahomacounty") ||
      h.includes("assessor")
    );
  } catch {
    return false;
  }
}

async function httpGetViaCorsProxy(url, timeoutMs) {
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
  let last = "cors proxy failed";
  for (const proxy of proxies) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(proxy, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) {
        last = `fetch ${res.status}`;
        continue;
      }
      return { url, status: res.status, body: await res.text() };
    } catch (e) {
      last = String(e?.message || e || "proxy failed");
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(last);
}

export async function httpLanGet(url, timeoutMs = 10000, extraHeaders = {}) {
  return withLanBypass(() => request("GET", url, extraHeaders, undefined, timeoutMs, assertLan));
}

/** form-urlencoded POST — Overpass prefers this over huge GET query strings. */
export async function httpPostForm(url, formBody, timeoutMs = 18000) {
  const target = assertPublic(url);
  const headers = {
    "User-Agent": UA,
    Accept: "application/json,*/*",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body = String(formBody || "");
  const native = await nativeRequest("POST", target, headers, body, timeoutMs);
  if (native) {
    const status = native.status;
    if (!status) throw new Error("network failed — check data/Wi‑Fi · Proton may block this API");
    if (status >= 400) throw new Error(`fetch ${status}`);
    return { url: native.url || target, status, body: bodyToText(native.data) };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method: "POST", signal: ctrl.signal, headers, body });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return { url: res.url, status: res.status, body: await res.text() };
  } catch (e) {
    const msg = String(e?.message || e || "fetch failed");
    if (/abort/i.test(msg)) throw new Error("timeout");
    throw new Error(`fetch failed — ${msg.slice(0, 100)}`);
  } finally {
    clearTimeout(t);
  }
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

/** Run an Overpass QL query (POST first, GET fallback, each public interpreter). */
export async function overpassJson(query, timeoutMs = 18000) {
  const q = String(query || "").trim();
  if (!q) throw new Error("empty overpass query");
  const form = `data=${encodeURIComponent(q)}`;
  let last = "overpass failed";
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const { body } = await httpPostForm(endpoint, form, timeoutMs);
      const data = JSON.parse(body || "{}");
      if (Array.isArray(data.elements)) return data;
    } catch (e) {
      last = String(e?.message || e || "overpass post failed");
    }
    try {
      const { body } = await httpGet(`${endpoint}?${form}`, timeoutMs);
      const data = JSON.parse(body || "{}");
      if (Array.isArray(data.elements)) return data;
    } catch (e) {
      last = String(e?.message || e || "overpass get failed");
    }
  }
  throw new Error(last);
}

export async function httpPostJson(url, headers, payload, timeoutMs = 60000) {
  return request("POST", url, headers, payload, timeoutMs, assertPublic);
}

export async function httpLanPostJson(url, headers, payload, timeoutMs = 60000) {
  return withLanBypass(() => request("POST", url, headers, payload, timeoutMs, assertLan));
}

/** SSE stream from desktop Pip (CODE apply). Uses fetch ReadableStream — works in Capacitor WebView. */
export async function* httpLanSSE(url, headers, payload, timeoutMs = 300000) {
  const target = assertLan(url);
  // Hold Wi‑Fi bind for the whole stream so Proton doesn't steal the route mid-apply.
  let bound = false;
  try {
    const { vpnSystemActive, bindLanWifi, unbindLanNetwork } = await import("./proton.js");
    if (await vpnSystemActive()) bound = await bindLanWifi();
  } catch {
    /* browser preview */
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        detail = j.detail || JSON.stringify(j);
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const ev of parts) {
        if (!ev.startsWith("data: ")) continue;
        try {
          yield JSON.parse(ev.slice(6));
        } catch {
          /* skip bad chunk */
        }
      }
    }
  } finally {
    clearTimeout(t);
    if (bound) {
      try {
        const { unbindLanNetwork } = await import("./proton.js");
        await unbindLanNetwork();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function openUrl(url, opts = {}) {
  const cap = window.Capacitor;
  const system = Boolean(opts.system);
  if (system && cap && cap.Plugins && cap.Plugins.App && cap.Plugins.App.openUrl) {
    await cap.Plugins.App.openUrl({ url });
    return;
  }
  if (cap && cap.Plugins && cap.Plugins.Browser) {
    await cap.Plugins.Browser.open({ url });
    return;
  }
  window.open(url, "_blank");
}
