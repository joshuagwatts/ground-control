import { httpLanGet, httpLanPostJson } from "./net.js";
import { vpnSystemActive, openProtonVpn } from "./proton.js";

const PORT = 7420;
const FALLBACK_SUBNETS = ["192.168.1", "192.168.0", "10.0.0", "192.168.50", "192.168.2", "10.0.1"];

/** Always force port 7420 — http://IP alone was hitting port 80. */
export function normalizeUrl(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  let candidate = s;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = candidate.includes(":") ? `http://${candidate}` : `http://${candidate}:${PORT}`;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.port) u.port = String(PORT);
    return u.origin;
  } catch {
    return "";
  }
}

function baseUrl(settings) {
  return normalizeUrl(settings.desktop_url);
}

function token(settings) {
  return String(settings.desktop_token || "").trim();
}

export function desktopConfigured(settings) {
  const tok = token(settings);
  return Boolean(baseUrl(settings) && tok && tok !== "loopback");
}

function authHeaders(settings) {
  const tok = token(settings);
  if (!tok || tok === "loopback") return {};
  return {
    Cookie: `pip_gate=${tok}`,
    "X-Pip-Token": tok,
    Authorization: `Bearer ${tok}`,
  };
}

/** Host octets in DHCP-friendly order (covers .162 etc.). */
function hostOrder() {
  const mid = [];
  for (let i = 100; i <= 200; i++) mid.push(i);
  const low = [];
  for (let i = 2; i <= 99; i++) low.push(i);
  const high = [];
  for (let i = 201; i <= 254; i++) high.push(i);
  return [...mid, ...low, ...high, 1];
}

/** Guess phone Wi‑Fi subnet via WebRTC local candidates (works in Capacitor WebView). */
async function guessSubnets() {
  const out = [];
  const add = (subnet) => {
    if (subnet && !out.includes(subnet)) out.push(subnet);
  };
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("pip");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 700);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(t);
          resolve();
        }
      };
    });
    const sdp = String(pc.localDescription?.sdp || "");
    pc.close();
    for (const m of sdp.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) {
      const ip = m[1];
      if (/^127\.|^0\.|^255\./.test(ip)) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
        add(ip.split(".").slice(0, 3).join("."));
      }
    }
  } catch {
    /* ignore */
  }
  for (const s of FALLBACK_SUBNETS) add(s);
  return out;
}

async function pingReady(url, timeoutMs = 700) {
  const base = normalizeUrl(url);
  if (!base) return null;
  try {
    const ready = await httpLanGet(`${base}/api/ready`, timeoutMs);
    if (!ready || ready.ok === false) return null;
    return base;
  } catch {
    return null;
  }
}

async function probeDesktop(url, timeoutMs = 4000) {
  const base = normalizeUrl(url);
  if (!base) return null;
  let lastErr = "";
  try {
    const ready = await pingReady(base, Math.min(timeoutMs, 2500));
    if (!ready) {
      lastErr = `no response from ${base}`;
      const err = new Error(lastErr);
      err.hard = true;
      throw err;
    }
    let st = {};
    try {
      st = await httpLanGet(`${base}/api/auth/status`, timeoutMs);
    } catch (e) {
      lastErr = String(e.message || e);
    }
    const login = await httpLanPostJson(`${base}/api/auth/login`, {}, { password: "" }, timeoutMs);
    const tok = String(login.token || login._cookie || "").trim();
    if (!tok && !login.ok) {
      const detail = String(login.detail || lastErr || "login failed").trim();
      throw Object.assign(new Error(detail), { hard: true });
    }
    return {
      url: base,
      token: tok || "",
      listen: st.listen || "",
      phone_lan: Boolean(st.phone_lan || st.on),
      urls: (st.urls || []).map(normalizeUrl).filter(Boolean),
    };
  } catch (e) {
    // Surface auth/LAN problems; keep scanning on dead sockets.
    const msg = String(e.message || e || "");
    if (e && e.hard && /LAN|password|login|Wi-?Fi|firewall|VPN/i.test(msg)) throw e;
    return null;
  }
}

export async function desktopLogin(settings, password = "") {
  const url = baseUrl(settings);
  if (!url) throw new Error("set desktop URL first");
  const res = await httpLanPostJson(`${url}/api/auth/login`, {}, { password: password || "" }, 10000);
  const cookie = String(res.token || res._cookie || "").trim();
  if (!cookie) throw new Error(res.detail || "login failed — turn ON LAN on desktop DATA");
  return { token: cookie, loopback: Boolean(res.loopback), open_lan: Boolean(res.open_lan) };
}

export async function ensureDesktopSession(settings) {
  if (!baseUrl(settings)) throw new Error("set desktop URL first");
  const tok = token(settings);
  if (tok && tok !== "loopback") return tok;
  const out = await desktopLogin(settings, "");
  const next = String(out.token || "").trim();
  if (!next) throw new Error("desktop login returned no token");
  settings.desktop_token = next;
  settings.desktop_paired = true;
  return next;
}

export async function desktopReachable(settings, timeoutMs = 2500) {
  const url = baseUrl(settings);
  if (!url) return { ok: false, error: "no url" };
  try {
    const ready = await httpLanGet(`${url}/api/ready`, timeoutMs);
    if (!ready || ready.ok === false) return { ok: false, error: "not ready" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function desktopStatus(settings) {
  const url = baseUrl(settings);
  if (!url) return { ok: false, error: "no url" };
  try {
    const reach = await desktopReachable(settings, 2500);
    if (!reach.ok) return { ok: false, error: reach.error || "offline", offline: true };
    await ensureDesktopSession(settings).catch(() => {});
    const hdr = authHeaders(settings);
    const data = await httpLanGet(`${url}/api/auth/status`, 5000, hdr);
    let health = {};
    try {
      health = await httpLanGet(`${url}/api/health`, 8000, hdr);
    } catch {
      health = {};
    }
    return {
      ok: true,
      auth: Boolean(data.auth),
      phone_lan: Boolean(data.phone_lan),
      listen: data.listen || "",
      urls: data.urls || [],
      ollama: health.ollama || {},
      router: health.router || {},
      restart: Boolean(data.restart),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function postChat(settings, text, timeoutMs) {
  const url = baseUrl(settings);
  return httpLanPostJson(`${url}/api/chat`, authHeaders(settings), { text }, timeoutMs);
}

export async function desktopChat(settings, text, timeoutMs = 60000) {
  const url = baseUrl(settings);
  if (!url) throw new Error("desktop not paired");
  const reach = await desktopReachable(settings, 2500);
  if (!reach.ok) throw new Error(`desktop offline (${reach.error || "no route"})`);
  await ensureDesktopSession(settings);

  let raw;
  try {
    raw = await postChat(settings, text, timeoutMs);
  } catch (e) {
    const msg = String(e.message || e);
    const status = e.status || 0;
    if (status === 401 || /401|login required/i.test(msg)) {
      const out = await desktopLogin(settings, "");
      settings.desktop_token = String(out.token || "").trim();
      if (!settings.desktop_token) throw new Error("re-login failed — tap CONNECT again");
      raw = await postChat(settings, text, timeoutMs);
    } else {
      throw e;
    }
  }

  const reply = String(raw.reply || raw.content || "").trim();
  if (!reply) throw new Error("desktop empty reply");
  return {
    text: reply,
    provider: "desktop",
    model: String((raw.router && raw.router.model) || (raw.ollama && raw.ollama.using) || "ollama"),
    theme: raw.theme || null,
    theme_name: raw.theme_name || "",
  };
}

export async function desktopGpuPing(settings) {
  const out = await desktopChat(settings, "Reply with exactly: PIP GPU OK", 45000);
  return {
    ok: /pip\s*gpu\s*ok|gpu\s*ok/i.test(out.text),
    text: out.text,
    model: out.model,
  };
}

function stripDataUrl(url) {
  const s = String(url || "");
  const i = s.indexOf("base64,");
  return i >= 0 ? s.slice(i + 7) : s;
}

/** Control Room — GPU shingle / vision on the paired desktop (Ollama). Stays on LAN. */
export async function desktopLens(settings, { prompt, images, maxTokens = 1400, temperature = 0.2, mode = "shingle" } = {}) {
  const url = baseUrl(settings);
  if (!url) throw new Error("Control Room not paired — tap Connect in Settings");
  const reach = await desktopReachable(settings, 2500);
  if (!reach.ok) throw new Error(`Control Room offline (${reach.error || "same Wi‑Fi?"})`);
  await ensureDesktopSession(settings);
  const body = {
    prompt: String(prompt || ""),
    images: (images || []).map(stripDataUrl),
    mode: String(mode || "shingle"),
    max_tokens: Number(maxTokens) || 1400,
    temperature: Number(temperature) || 0.2,
  };
  const paths = ["/api/lens", "/api/vision"];
  let lastErr = "";
  for (const path of paths) {
    try {
      const raw = await httpLanPostJson(`${url}${path}`, authHeaders(settings), body, 120000);
      const text = String(raw.text || raw.reply || raw.content || "").trim();
      if (!text) throw new Error("empty Control Room reply");
      return {
        text,
        provider: "desktop",
        model: String(raw.model || raw.ollama?.using || "ollama"),
        leaked: false,
      };
    } catch (e) {
      lastErr = String(e.message || e);
      if (e?.status === 404) continue;
      if (path === paths[paths.length - 1]) throw e;
    }
  }
  throw new Error(lastErr || "Control Room vision not available on desktop");
}

export function disconnectDesktop(settings) {
  if (!settings) return;
  settings.desktop_token = "";
  settings.desktop_paired = false;
  settings.desktop_live = false;
}

let roomConnectLock = null;

/** Tap-less homebase pairing — scan LAN or refresh an existing session. */
export async function ensureControlRoom(settings, { onProgress, forceScan = false } = {}) {
  if (settings?.desktop_auto === false) {
    if (!desktopConfigured(settings)) return { ok: false, error: "auto off" };
  }
  if (roomConnectLock) return roomConnectLock;
  roomConnectLock = (async () => {
    if (desktopConfigured(settings) && !forceScan) {
      const reach = await desktopReachable(settings, 2200);
      if (reach.ok) return { ok: true, paired: true, url: baseUrl(settings) };
    }
    try {
      const hit = await connectDesktop(settings, onProgress || (() => {}));
      settings.desktop_model = hit.model || hit.ping?.model || settings.desktop_model || "";
      return { ok: true, paired: true, fresh: true, url: hit.url, model: settings.desktop_model };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  })();
  try {
    return await roomConnectLock;
  } finally {
    roomConnectLock = null;
  }
}

async function scanLan(onProgress) {
  if (onProgress) onProgress("FINDING YOUR Wi‑Fi…");
  const subnets = await guessSubnets();
  const hosts = hostOrder();
  const batch = 32;

  for (const subnet of subnets) {
    if (onProgress) onProgress(`SCAN ${subnet}.* …`);
    for (let i = 0; i < hosts.length; i += batch) {
      const chunk = hosts.slice(i, i + batch).map((h) => `http://${subnet}.${h}:${PORT}`);
      if (onProgress) {
        onProgress(`SCAN ${subnet}.${hosts[i]}–${subnet}.${hosts[Math.min(i + batch - 1, hosts.length - 1)]}…`);
      }
      const pings = await Promise.all(chunk.map((url) => pingReady(url, 650)));
      const alive = pings.filter(Boolean);
      for (const base of alive) {
        if (onProgress) onProgress(`FOUND ${base} — pairing…`);
        try {
          const hit = await probeDesktop(base, 6000);
          if (hit) return hit;
        } catch (e) {
          if (e && e.hard) throw e;
        }
      }
    }
  }
  return null;
}

async function protonBlockHint() {
  try {
    if (await vpnSystemActive()) {
      return (
        "Proton VPN is ON and blocking LAN. Proton → Settings → Features → Allow LAN connections (ON), " +
        "then CONNECT again. Same Wi‑Fi as the PC."
      );
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * One-shot connect: use typed URL if present, else scan full Wi‑Fi subnet.
 */
export async function connectDesktop(settings, onProgress) {
  const typed = normalizeUrl(settings.desktop_url);
  let hit = null;
  const protonHint = await protonBlockHint();

  if (typed) {
    if (onProgress) onProgress(`CONNECTING ${typed}…`);
    try {
      hit = await probeDesktop(typed, 8000);
    } catch (e) {
      const msg = String(e.message || e);
      if (protonHint) throw new Error(protonHint);
      throw new Error(
        `${msg} — OFF phone VPN or enable Proton Allow LAN · same Wi‑Fi · Open-Firewall.bat · Chrome: ${typed}/api/ready`,
      );
    }
    if (!hit) {
      if (protonHint) throw new Error(protonHint);
      throw new Error(`can't reach ${typed} — enable Proton Allow LAN, or turn VPN off briefly`);
    }
  } else {
    hit = await scanLan(onProgress);
    if (!hit) {
      if (protonHint) throw new Error(protonHint);
      throw new Error(
        "scan found nothing — desktop DATA → COPY URL → paste → CONNECT. Or Proton → Allow LAN connections.",
      );
    }
  }

  if (!hit.token) {
    settings.desktop_url = hit.url;
    const login = await desktopLogin(settings, "");
    hit.token = login.token;
  }

  settings.desktop_url = hit.url;
  settings.desktop_token = hit.token;
  settings.desktop_paired = true;
  settings.desktop_password = "";
  settings.desktop_live = true;

  if (onProgress) onProgress("TESTING GPU…");
  const ping = await desktopGpuPing(settings);
  return {
    url: hit.url,
    token: hit.token,
    ping,
    model: ping.model,
  };
}

/** @deprecated — use connectDesktop */
export async function findAndPair(settings, password, onProgress) {
  return connectDesktop(settings, onProgress);
}

export async function desktopDraft() {
  throw new Error("desktop draft proxy not wired yet");
}
