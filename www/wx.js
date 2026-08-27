/** WX map + storm dossier — runs on phone standalone (public APIs) or via paired desktop. */
import { httpGet, httpLanGet, httpLanPostJson } from "./net.js";
import { desktopConfigured } from "./desktop.js";
import { locateDevice } from "./geo.js";

let map = null;
let pin = null;
let hailLayer = null;
let layers = {};
let activeLayer = "dark";

const WMO = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  75: "Heavy snow",
  82: "Violent rain",
  95: "Thunderstorm",
  96: "Thunder + hail",
  99: "Severe thunder + hail",
};

export const DEFAULT_FILTERS = { km: 25, hailIn: 0.75, windMph: 38, days: 365, year: "all", sort: "date" };
let wxFilters = { ...DEFAULT_FILTERS };
/** Current map pin — storm zones and graph are scoped to this point. */
let pinLat = null;
let pinLon = null;
let pinRadiusLayer = null;
let overlays = {};
/** Exclusive weather product on the map: precip | cloud | vis | wind | hail */
let activeWxProduct = "precip";
let activeOverlays = new Set(["precip"]);
let windLayer = null;
let windFieldLayer = null;
let lastHailRows = [];
let lastWindRows = [];
/** ISO date (YYYY-MM-DD) selected on storm graph — map heat shows that day only. */
let selectedStormDate = null;
/** HailScope: never auto-pick a storm date; zones wait for a tap. */
let hailScopeMode = false;
let hailSearchQ = "";

export function setHailScopeMode(on) {
  hailScopeMode = Boolean(on);
  if (!hailScopeMode) hailSearchQ = "";
}
let radarFrames = [];
let radarFrameIdx = 0;
let radarPlayRaf = null;
let radarPlaying = false;
let hourPlayTimer = null;
/** Dual-buffer radar tiles — crossfade instead of black flash between frames. */
let radarLayers = [null, null];
let radarActiveSlot = 0;
/** Map + timeline layer visibility. */
export const wxTimelineFilters = { precip: true, hail: true, wind: true, temp: true };
let wxSuppressMapTap = false;
let radarHost = "https://tilecache.rainviewer.com";
let radarColor = "2/1_1";
const WX_PRODUCTS = ["precip", "cloud", "vis", "wind", "hail"];

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function hailSizeIn(raw) {
  const n = parseInt(String(raw || "").trim(), 10);
  if (!n || n >= 8000) return "UNK";
  return (n / 100).toFixed(2);
}

function zillowUrl(address) {
  return `https://www.zillow.com/homes/${encodeURIComponent(String(address || "").trim())}_rb/`;
}

async function api(path, opts = {}) {
  const settings = opts.settings;
  if (desktopConfigured(settings)) {
    const tok = String(settings.desktop_token || "").trim();
    const base = String(settings.desktop_url || "").replace(/\/+$/, "");
    const headers = tok ? { Cookie: `pip_gate=${tok}` } : {};
    if (opts.method === "POST") {
      return httpLanPostJson(`${base}${path}`, headers, opts.body || {}, opts.timeout || 120000);
    }
    return httpLanGet(`${base}${path}`, opts.timeout || 20000, headers);
  }
  return null;
}

async function reverseNominatim(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=18`;
  try {
    const { body } = await httpGet(url, 9000, { "Accept-Language": "en" });
    const data = JSON.parse(body || "{}");
    const a = data.address || {};
    let house = "";
    if (a.house_number && a.road) house = `${a.house_number} ${a.road}`;
    else if (a.road) house = a.road;
    else if (data.name) house = data.name;
    const city = a.city || a.town || a.village || a.hamlet || "";
    const state = a.state || a.region || "";
    const zip = a.postcode || "";
    const parts = [house, city, state, zip].filter(Boolean);
    const line = parts.join(", ") || String(data.display_name || "").split(",").slice(0, 3).join(", ");
    if (!line.trim()) return { ok: false };
    return { ok: true, address: line, city: city || line.split(",")[0], lat, lon, source: "nominatim" };
  } catch {
    return { ok: false };
  }
}

async function reverseGeocode(lat, lon) {
  const nom = await reverseNominatim(lat, lon);
  if (nom.ok) return nom;
  try {
    const { body } = await httpGet(
      `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=en`,
    );
    const data = JSON.parse(body || "{}");
    const hit = (data.results || [])[0];
    if (!hit) return { ok: false, address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
    const address = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ");
    return { ok: true, address, city: hit.name || "", lat, lon, source: "open-meteo" };
  } catch {
    return { ok: false, address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
  }
}

async function historicalStorms(lat, lon, days = 540) {
  try {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - Math.min(days, 730));
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      daily: "weather_code,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max",
      timezone: "auto",
      wind_speed_unit: "mph",
      precipitation_unit: "mm",
    });
    const { body } = await httpGet(`https://archive-api.open-meteo.com/v1/archive?${params}`, 25000);
    const data = JSON.parse(body || "{}");
    const daily = data.daily || {};
    const times = daily.time || [];
    const out = [];
    for (let i = 0; i < times.length; i++) {
      const code = parseInt((daily.weather_code || [])[i] || 0, 10);
      const precip = parseFloat((daily.precipitation_sum || [])[i] || 0);
      const wind = parseFloat((daily.wind_speed_10m_max || [])[i] || 0);
      const gust = parseFloat((daily.wind_gusts_10m_max || [])[i] || 0);
      let score = 0;
      const reasons = [];
      if ([95, 96, 99, 82, 65, 75].includes(code)) {
        score += 3;
        reasons.push(WMO[code] || "storm");
      }
      if (Math.max(wind, gust) >= 38) {
        score += 2;
        reasons.push(`wind ${Math.max(wind, gust).toFixed(0)} mph`);
      }
      if (precip >= 25) {
        score += 2;
        reasons.push(`precip ${precip.toFixed(0)} mm`);
      }
      if (score >= 3) {
        out.push({
          date: times[i],
          score,
          label: WMO[code] || "Weather",
          reasons,
          wind_mph: Math.round(Math.max(wind, gust) * 10) / 10,
          precip_mm: Math.round(precip * 10) / 10,
          source: "open-meteo-archive",
        });
      }
    }
    return out.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, 80);
  } catch {
    return [];
  }
}

function parseSpcSection(text, reportDay, header, kind, measureKey) {
  const rows = [];
  let inSec = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(header)) {
      inSec = true;
      continue;
    }
    if (line.startsWith("Time,")) {
      inSec = false;
      continue;
    }
    if (!inSec || !line.trim()) continue;
    const parts = line.split(",", 8);
    if (parts.length < 7) continue;
    const rlat = parseFloat(parts[5]);
    const rlon = parseFloat(parts[6]);
    if (Number.isNaN(rlat) || Number.isNaN(rlon)) continue;
    const row = {
      kind,
      date: reportDay,
      time: parts[0].trim(),
      location: parts[2].trim(),
      county: parts[3].trim(),
      state: parts[4].trim(),
      lat: rlat,
      lon: rlon,
      comments: (parts[7] || "").trim(),
      source: "noaa-spc",
    };
    if (kind === "hail") {
      row.size_in = hailSizeIn(parts[1]);
    } else {
      const n = parseFloat(parts[1]);
      row[measureKey] = Number.isNaN(n) ? 0 : n;
    }
    rows.push(row);
  }
  return rows;
}

function parseSpcHailCsv(text, reportDay) {
  return parseSpcSection(text, reportDay, "Time,Size,", "hail", "size_in");
}

function bboxForKm(lat, lon, radiusKm) {
  const pad = Math.max(radiusKm * 1.15, 5);
  const dLat = pad / 111;
  const dLon = pad / (111 * Math.max(0.25, Math.cos((lat * Math.PI) / 180)));
  return `${(lon - dLon).toFixed(4)},${(lat - dLat).toFixed(4)},${(lon + dLon).toFixed(4)},${(lat + dLat).toFixed(4)}`;
}

function iemBboxQuery(lat, lon, radiusKm) {
  const pad = Math.max(radiusKm * 1.25, 8);
  const dLat = pad / 111;
  const dLon = pad / (111 * Math.max(0.25, Math.cos((lat * Math.PI) / 180)));
  return [
    `west=${(lon - dLon).toFixed(4)}`,
    `east=${(lon + dLon).toFixed(4)}`,
    `south=${(lat - dLat).toFixed(4)}`,
    `north=${(lat + dLat).toFixed(4)}`,
  ].join("&");
}

function isSpotterHail(p) {
  const src = String(p?.source || "");
  if (/swdi|radar/i.test(src)) return false;
  return /spc|lsr|spot|iem/i.test(src);
}

function parseSwdiShape(shape) {
  const s = String(shape || "");
  const pt = s.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (pt) {
    const lon = parseFloat(pt[1]);
    const lat = parseFloat(pt[2]);
    return Number.isNaN(lon) || Number.isNaN(lat) ? null : { type: "point", lon, lat };
  }
  const poly = s.match(/POLYGON\s*\(\(\s*([^)]+)\s*\)\)/i);
  if (poly) {
    const ring = [];
    for (const pair of poly[1].split(",")) {
      const bits = pair.trim().split(/\s+/);
      if (bits.length < 2) continue;
      const lon = parseFloat(bits[0]);
      const lat = parseFloat(bits[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) ring.push([lat, lon]);
    }
    if (ring.length >= 3) return { type: "polygon", ring };
  }
  return null;
}

async function fetchSwdiHail(lat, lon, radiusKm = 25, daysBack = 90) {
  const today = new Date();
  const days = Math.min(Math.max(daysBack, 7), 180);
  const km = Math.min(Math.max(radiusKm, 3), 50);
  const bbox = bboxForKm(lat, lon, km);
  const startLimit = new Date(today);
  startLimit.setDate(startLimit.getDate() - days);
  const chunks = [];
  let cursor = new Date(today);
  const maxChunks = days > 120 ? 14 : 10;
  while (cursor > startLimit && chunks.length < maxChunks) {
    const chunkEnd = new Date(cursor);
    const chunkStart = new Date(cursor);
    chunkStart.setDate(chunkStart.getDate() - 13);
    if (chunkStart < startLimit) chunkStart.setTime(startLimit.getTime());
    chunks.push({ start: chunkStart, end: chunkEnd });
    cursor = new Date(chunkStart);
    cursor.setDate(cursor.getDate() - 1);
  }
  const hits = new Map();
  const batch = 4;
  for (let i = 0; i < chunks.length; i += batch) {
    const part = await Promise.all(
      chunks.slice(i, i + batch).map(async ({ start, end }) => {
        const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
        const url = `https://www.ncdc.noaa.gov/swdiws/json/nx3hail/${fmt(start)}:${fmt(end)}?bbox=${bbox}`;
        try {
          const { body } = await httpGet(url, 22000);
          const data = JSON.parse(body || "{}");
          return data.result || [];
        } catch {
          return [];
        }
      }),
    );
    for (const rows of part) {
      for (const item of rows) {
        const pt = parseSwdiShape(item.SHAPE);
        if (!pt) continue;
        let hitLat;
        let hitLon;
        let swdiRing = null;
        if (pt.type === "polygon") {
          swdiRing = pt.ring;
          hitLat = pt.ring.reduce((a, c) => a + c[0], 0) / pt.ring.length;
          hitLon = pt.ring.reduce((a, c) => a + c[1], 0) / pt.ring.length;
        } else {
          hitLat = pt.lat;
          hitLon = pt.lon;
        }
        const dist = haversineKm(lat, lon, hitLat, hitLon);
        if (dist > km) continue;
        const ztime = String(item.ZTIME || "");
        const day = ztime.slice(0, 10) || "";
        if (!day) continue;
        const sz = parseFloat(item.MAXSIZE);
        const row = {
          kind: "hail",
          date: day,
          time: ztime.slice(11, 16) || "",
          lat: hitLat,
          lon: hitLon,
          size_in: Number.isNaN(sz) ? "UNK" : sz.toFixed(2),
          location: item.WSR_ID || "Radar hail",
          county: "",
          state: "",
          comments: `PROB ${item.PROB || "?"}`,
          source: "noaa-swdi-radar",
          distance_km: Math.round(dist * 10) / 10,
          score: !Number.isNaN(sz) && sz >= 1 ? 5 : 3,
          swdi_ring: swdiRing,
        };
        const key = `${day}|${hitLat.toFixed(3)}|${hitLon.toFixed(3)}|${row.size_in}`;
        const prev = hits.get(key);
        if (!prev || (parseFloat(row.size_in) || 0) > (parseFloat(prev.size_in) || 0)) hits.set(key, row);
      }
    }
  }
  return [...hits.values()];
}

/** Live Local Storm Reports (IEM) — CORS-friendly spotter hail near pin. */
function lsrValidStamp(valid) {
  const s = String(valid || "").trim();
  const iso = s.match(/(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (iso) return { day: iso[1], time: iso[2] || "" };
  const slash = s.match(/(\d{4})\/(\d{2})\/(\d{2})(?:\s+(\d{2}:\d{2}))?/);
  if (slash) return { day: `${slash[1]}-${slash[2]}-${slash[3]}`, time: slash[4] || "" };
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
  if (compact) {
    return {
      day: `${compact[1]}-${compact[2]}-${compact[3]}`,
      time: compact[4] && compact[5] ? `${compact[4]}:${compact[5]}` : "",
    };
  }
  return { day: new Date().toISOString().slice(0, 10), time: "" };
}

function lsrHailRow(lat, lon, km, { rlat, rlon, mag, valid, city, county, state, remark }) {
  if (!Number.isFinite(rlat) || !Number.isFinite(rlon)) return null;
  const dist = haversineKm(lat, lon, rlat, rlon);
  if (dist > km) return null;
  const when = lsrValidStamp(valid);
  const size = mag > 0 ? mag.toFixed(2) : "UNK";
  return {
    kind: "hail",
    date: when.day,
    time: when.time,
    lat: rlat,
    lon: rlon,
    size_in: size,
    location: city || county || "LSR hail",
    county: county || "",
    state: state || "",
    comments: String(remark || "IEM LSR").slice(0, 120),
    source: "iem-lsr",
    distance_km: Math.round(dist * 10) / 10,
    score: mag >= 1 ? 5 : 3,
  };
}

function parseIemLsrGeojson(body, lat, lon, km) {
  let data;
  try {
    data = JSON.parse(body || "{}");
  } catch {
    return [];
  }
  const out = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    const typ = String(p.type || p.typetext || p.typecode || "").toUpperCase();
    if (!(typ === "H" || /HAIL/.test(typ) || /HAIL/.test(String(p.typetext || "")))) continue;
    const coords = (f.geometry && f.geometry.coordinates) || [];
    const row = lsrHailRow(lat, lon, km, {
      rlon: Number(coords[0]),
      rlat: Number(coords[1]),
      mag: Number(p.magf != null ? p.magf : p.magnitude) || 0,
      valid: String(p.valid || p.utcvalid || p.wfo_valid || ""),
      city: p.city || "",
      county: p.county || "",
      state: p.state || "",
      remark: p.remark || p.source || "IEM LSR",
    });
    if (row) out.push(row);
  }
  return out;
}

function parseIemLsrCsv(body, lat, lon, km) {
  const text = String(body || "");
  const nl = text.indexOf("\n");
  if (nl < 0 || !/VALID|TYPETEXT|LAT/i.test(text.slice(0, nl))) return [];
  const split = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i += 1;
          continue;
        }
        q = !q;
        continue;
      }
      if (c === "," && !q) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split(text.slice(0, nl)).map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iLat = col("lat");
  const iLon = col("lon");
  const iType = col("typetext") >= 0 ? col("typetext") : col("typecode");
  const iMag = col("mag") >= 0 ? col("mag") : col("magnitude");
  const iValid = col("valid");
  if (iLat < 0 || iLon < 0) return [];
  const out = [];
  for (const line of text.slice(nl + 1).split("\n")) {
    if (!line.trim()) continue;
    const parts = split(line);
    const typ = String(parts[iType] || "").toUpperCase();
    if (!(typ === "H" || /HAIL/.test(typ))) continue;
    const row = lsrHailRow(lat, lon, km, {
      rlat: Number(parts[iLat]),
      rlon: Number(parts[iLon]),
      mag: Number(parts[iMag]) || 0,
      valid: String(parts[col("valid2")] || parts[iValid] || ""),
      city: parts[col("city")] || "",
      county: parts[col("county")] || "",
      state: parts[col("state")] || "",
      remark: parts[col("remark")] || parts[col("source")] || "IEM LSR",
    });
    if (row) out.push(row);
  }
  return out;
}

async function fetchIemLsrHail(lat, lon, radiusKm = 40, daysBack = 365) {
  const km = Math.min(Math.max(radiusKm, 5), 80);
  const days = Math.min(Math.max(Number(daysBack) || 365, 7), 730);
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  const sts = `${start.toISOString().slice(0, 19)}Z`;
  const ets = `${end.toISOString().slice(0, 19)}Z`;
  const box = iemBboxQuery(lat, lon, km);
  const range = `sts=${encodeURIComponent(sts)}&ets=${encodeURIComponent(ets)}`;
  const urls = [
    `https://mesonet.agron.iastate.edu/cgi-bin/request/gis/lsr.py?${range}&type=HAIL&fmt=csv&${box}`,
    `https://mesonet.agron.iastate.edu/geojson/lsr.py?${range}&${box}`,
    `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?${range}&${box}`,
  ];
  for (const url of urls) {
    try {
      const { body } = await httpGet(url, 20000);
      const rows = /"features"|FeatureCollection/i.test(body || "")
        ? parseIemLsrGeojson(body, lat, lon, km)
        : parseIemLsrCsv(body, lat, lon, km);
      if (rows.length) return rows;
    } catch {
      /* try next */
    }
  }
  return [];
}

function hailZoneColor(sizeIn) {
  const sz = parseFloat(sizeIn);
  if (Number.isNaN(sz)) return { stroke: "#7dff5a", fill: "#7dff5a", core: "#b8ff9a" };
  if (sz >= 2.5) return { stroke: "#f8bbd0", fill: "#ce93d8", core: "#ffffff" };
  if (sz >= 2) return { stroke: "#e040fb", fill: "#ab47bc", core: "#f8bbd0" };
  if (sz >= 1.5) return { stroke: "#ff1744", fill: "#e53935", core: "#ff8a80" };
  if (sz >= 1) return { stroke: "#ff6d00", fill: "#ef6c00", core: "#ffab40" };
  if (sz >= 0.75) return { stroke: "#ffb300", fill: "#f9a825", core: "#ffe082" };
  return { stroke: "#c0ca33", fill: "#d4e157", core: "#f0f4c3" };
}

function mergeHailRows(...groups) {
  const seen = new Set();
  const uniq = [];
  for (const h of groups.flat()) {
    if (!h) continue;
    const key = `${String(h.date || "").slice(0, 10)}|${Number(h.lat).toFixed(3)}|${Number(h.lon).toFixed(3)}|${h.size_in}|${isSpotterHail(h) ? "s" : "r"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(h);
  }
  uniq.sort((a, b) => {
    const ds = String(b.date || "").localeCompare(String(a.date || ""));
    if (ds) return ds;
    return (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0);
  });
  const spots = uniq.filter(isSpotterHail);
  const radar = uniq.filter((h) => !isSpotterHail(h));
  return [...spots, ...radar].slice(0, 400);
}

/**
 * HailTrace-style: one extremeness tag per calendar day near the pin.
 * Keeps the max size that day; folds radar/spotter hits into one zone.
 */
export function collapseHailByDate(rows) {
  const byDate = new Map();
  for (const h of rows || []) {
    const day = String(h.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const sz = parseFloat(h.size_in);
    const size = Number.isNaN(sz) ? 0 : sz;
    const dist = Number(h.distance_km);
    const distN = Number.isFinite(dist) ? dist : 999;
    const prev = byDate.get(day);
    const pt =
      Number.isFinite(h.lat) && Number.isFinite(h.lon)
        ? { lat: h.lat, lon: h.lon, size_in: size, source: h.source || "hail", swdi_ring: h.swdi_ring || null }
        : null;
    if (!prev) {
      byDate.set(day, {
        ...h,
        date: day,
        size_in: Number.isNaN(sz) ? "UNK" : size.toFixed(2),
        hits: 1,
        zone_pts: pt ? [pt] : [],
        sources: new Set([h.source || "hail"]),
        max_size: size,
        min_dist: distN,
      });
      continue;
    }
    prev.hits += 1;
    if (pt) prev.zone_pts.push({ lat: pt.lat, lon: pt.lon, size_in: size, source: h.source || "hail" });
    if (h.source) prev.sources.add(h.source);
    const better =
      size > prev.max_size ||
      (size === prev.max_size && distN < prev.min_dist) ||
      (Number.isNaN(parseFloat(prev.size_in)) && !Number.isNaN(sz));
    if (better) {
      prev.max_size = Math.max(prev.max_size, size);
      prev.min_dist = Math.min(prev.min_dist, distN);
      prev.size_in = Number.isNaN(sz) ? prev.size_in : size.toFixed(2);
      prev.lat = h.lat ?? prev.lat;
      prev.lon = h.lon ?? prev.lon;
      prev.time = h.time || prev.time;
      prev.location = h.location || prev.location;
      prev.state = h.state || prev.state;
      prev.distance_km = distN < 900 ? Math.round(distN * 10) / 10 : prev.distance_km;
      prev.score = Math.max(prev.score || 0, h.score || 0);
      prev.comments = h.comments || prev.comments;
    } else {
      prev.min_dist = Math.min(prev.min_dist, distN);
      if (distN < (Number(prev.distance_km) || 999)) prev.distance_km = Math.round(distN * 10) / 10;
    }
  }
  return [...byDate.values()].map((row) => {
    const srcs = [...(row.sources || [])];
    const hasRadar = srcs.some((s) => /radar|swdi/i.test(s));
    const hasSpot = srcs.some((s) => /spc|spot/i.test(s) || s === "hail");
    let source = "hail";
    if (hasRadar && hasSpot) source = "mixed";
    else if (hasRadar) source = "noaa-swdi-radar";
    else if (hasSpot) source = "noaa-spc";
    const pts = row.zone_pts || [];
    let zone_lat = row.lat;
    let zone_lon = row.lon;
    let zone_r_km = Math.max(1.2, Math.min(8, (parseFloat(row.size_in) || 0.5) * 2.2));
    if (pts.length) {
      zone_lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
      zone_lon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
      let maxSpread = 0;
      for (const p of pts) maxSpread = Math.max(maxSpread, haversineKm(zone_lat, zone_lon, p.lat, p.lon));
      zone_r_km = Math.max(zone_r_km, maxSpread + 0.6);
    }
    return {
      kind: "hail",
      date: row.date,
      time: row.time || "",
      lat: zone_lat,
      lon: zone_lon,
      size_in: row.size_in,
      location: row.location || "Hail zone",
      county: row.county || "",
      state: row.state || "",
      comments: row.comments || `${row.hits} signature${row.hits === 1 ? "" : "s"}`,
      source,
      distance_km: row.distance_km,
      score: row.score || (parseFloat(row.size_in) >= 1 ? 5 : 3),
      hits: row.hits,
      zone_pts: pts,
      zone_r_km: Math.round(zone_r_km * 10) / 10,
      severity: hailSeverityLabel(row.size_in),
      stars: hailStars(row.size_in),
    };
  });
}

function enrichStormDates(storms, hail, wind) {
  const byDate = new Map();
  for (const s of storms || []) {
    if (s.date) byDate.set(s.date, { ...s, reasons: [...(s.reasons || [])] });
  }
  // Already 1 hail tag/day when collapsed; still guard against duplicates.
  const hailDays = collapseHailByDate(hail);
  for (const h of hailDays) {
    if (!h.date) continue;
    const tag = `${h.severity || "HAIL"} ${h.size_in}"`;
    const cur = byDate.get(h.date);
    if (cur) {
      cur.reasons = (cur.reasons || []).filter((r) => !/hail|radar hail/i.test(r));
      cur.reasons.push(tag);
      cur.score = Math.max(cur.score || 0, h.score || 4);
      cur.hail_in = h.size_in;
      cur.severity = h.severity;
    } else {
      byDate.set(h.date, {
        date: h.date,
        score: h.score || 4,
        label: "Hail",
        reasons: [tag],
        wind_mph: 0,
        hail_in: h.size_in,
        severity: h.severity,
        source: h.source || "hail",
      });
    }
  }
  const windByDate = new Map();
  for (const w of wind || []) {
    if (!w.date) continue;
    const mph = Number(w.wind_mph) || 0;
    const prev = windByDate.get(w.date);
    if (!prev || mph > prev.mph) windByDate.set(w.date, { mph, row: w });
  }
  for (const [day, { mph }] of windByDate) {
    const tag = `wind ${mph.toFixed(0)} mph`;
    const cur = byDate.get(day);
    if (cur) {
      cur.reasons = (cur.reasons || []).filter((r) => !/^wind /i.test(r));
      cur.reasons.push(tag);
      cur.score = Math.max(cur.score || 0, mph >= 58 ? 4 : 3);
      cur.wind_mph = Math.max(cur.wind_mph || 0, mph);
    } else {
      byDate.set(day, {
        date: day,
        score: mph >= 58 ? 4 : 3,
        label: "Wind",
        reasons: [tag],
        wind_mph: mph,
        source: "noaa-spc",
      });
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100);
}

async function fetchSpcReports(lat, lon, radiusKm = 25, daysBack = 30) {
  const today = new Date();
  const days = Math.min(Math.max(daysBack, 7), 90);
  const km = Math.min(Math.max(radiusKm, 3), 50);
  const stamps = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(today);
    day.setDate(day.getDate() - d);
    stamps.push({
      stamp: day.toISOString().slice(0, 10).replace(/-/g, "").slice(2),
      iso: day.toISOString().slice(0, 10),
    });
  }
  const hailHits = [];
  const windHits = [];
  const batch = 12;
  for (let i = 0; i < stamps.length; i += batch) {
    const chunk = stamps.slice(i, i + batch);
    const parts = await Promise.all(
      chunk.map(async ({ stamp, iso }) => {
        try {
          const { body, status } = await httpGet(`https://www.spc.noaa.gov/climo/reports/${stamp}_rpts_filtered.csv`, 5500);
          if (status === 404) return { hail: [], wind: [] };
          return {
            hail: parseSpcHailCsv(body, iso),
            wind: parseSpcSection(body, iso, "Time,Speed,", "wind", "wind_mph"),
          };
        } catch {
          return { hail: [], wind: [] };
        }
      }),
    );
    for (const dayRows of parts) {
      for (const row of dayRows.hail) {
        const dist = haversineKm(lat, lon, row.lat, row.lon);
        if (dist <= km) {
          const sz = parseFloat(row.size_in);
          hailHits.push({ ...row, distance_km: Math.round(dist * 10) / 10, score: !Number.isNaN(sz) && sz >= 1 ? 5 : 3 });
        }
      }
      for (const row of dayRows.wind) {
        const dist = haversineKm(lat, lon, row.lat, row.lon);
        if (dist <= km) {
          windHits.push({ ...row, distance_km: Math.round(dist * 10) / 10, score: (row.wind_mph || 0) >= 58 ? 4 : 2 });
        }
      }
    }
  }
  hailHits.sort((a, b) => b.date.localeCompare(a.date));
  windHits.sort((a, b) => b.date.localeCompare(a.date));
  return { hail: hailHits.slice(0, 80), wind: windHits.slice(0, 80) };
}

async function fetchHailReports(lat, lon, radiusKm = 25, daysBack = 60) {
  const spc = await fetchSpcReports(lat, lon, radiusKm, daysBack);
  const swdi = await fetchSwdiHail(lat, lon, radiusKm, daysBack);
  return mergeHailRows(spc.hail, swdi);
}

let mapConfigCache = null;
const MAP_MAX_ZOOM = 18;
const RADAR_NATIVE_ZOOM = 7;
const RADAR_TILE_SIZE = 512;

function rainTileUrl(host, path, color = "2/1_1") {
  const base = String(host || "https://tilecache.rainviewer.com").replace(/\/+$/, "");
  return `${base}${path}/${RADAR_TILE_SIZE}/{z}/{x}/{y}/${color}.png`;
}

export function hailStars(sizeIn) {
  const sz = parseFloat(sizeIn);
  if (Number.isNaN(sz)) return "☆";
  if (sz >= 3) return "★★★★★";
  if (sz >= 2) return "★★★★";
  if (sz >= 1.75) return "★★★☆";
  if (sz >= 1.25) return "★★★";
  if (sz >= 1) return "★★";
  if (sz >= 0.75) return "★";
  return "☆";
}

export function hailSeverityLabel(sizeIn) {
  const sz = parseFloat(sizeIn);
  if (Number.isNaN(sz)) return "UNK";
  if (sz >= 2) return "EXTREME";
  if (sz >= 1.5) return "SEVERE";
  if (sz >= 1) return "STRONG";
  if (sz >= 0.75) return "MOD";
  return "LIGHT";
}

function ensureRadarLayer(url) {
  if (!map || !window.L) return null;
  if (!radarLayers[0]) {
    for (let i = 0; i < 2; i++) {
      radarLayers[i] = window.L.tileLayer(url, {
        attribution: "© RainViewer",
        opacity: i === 0 ? 0.72 : 0,
        maxZoom: MAP_MAX_ZOOM,
        maxNativeZoom: RADAR_NATIVE_ZOOM,
        tileSize: 256,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 4,
        zIndex: 450 + i,
      });
    }
    radarActiveSlot = 0;
    overlays.precip = radarLayers[0];
    overlays.radar = radarLayers[0];
  }
  return radarLayers[radarActiveSlot];
}

function setRadarTilePath(path, { crossfade = false } = {}) {
  if (!map || !window.L || !path) return;
  const url = rainTileUrl(radarHost, path, radarColor);
  const wantOn = wxTimelineFilters.precip && (activeWxProduct === "precip" || activeOverlays.has("precip") || activeOverlays.has("radar"));

  if (!crossfade) {
    const layer = ensureRadarLayer(url) || overlays.precip;
    if (layer) {
      if (layer._url !== url) layer.setUrl(url);
      overlays.precip = layer;
      overlays.radar = layer;
      if (wantOn && !map.hasLayer(layer)) layer.addTo(map);
    } else {
      overlays.precip = window.L.tileLayer(url, {
        attribution: "© RainViewer",
        opacity: 0.72,
        maxZoom: MAP_MAX_ZOOM,
        maxNativeZoom: RADAR_NATIVE_ZOOM,
        tileSize: 256,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 4,
      });
      overlays.radar = overlays.precip;
      if (wantOn) overlays.precip.addTo(map);
    }
    return;
  }

  ensureRadarLayer(url);
  const front = radarActiveSlot;
  const back = 1 - front;
  const frontLayer = radarLayers[front];
  const backLayer = radarLayers[back];
  if (!frontLayer || !backLayer) return;
  if (backLayer._url === url) return;

  backLayer.setUrl(url);
  if (wantOn && !map.hasLayer(backLayer)) backLayer.addTo(map);
  backLayer.setOpacity(0);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    backLayer.off("load", finish);
    backLayer.setOpacity(0.72);
    frontLayer.setOpacity(0);
    radarActiveSlot = back;
    overlays.precip = backLayer;
    overlays.radar = backLayer;
  };
  backLayer.on("load", finish);
  window.setTimeout(finish, 160);
}

export function applyWxTimelineFilters() {
  if (!map) return;
  const wantPrecip = wxTimelineFilters.precip;
  for (const layer of radarLayers) {
    if (!layer) continue;
    try {
      if (wantPrecip) {
        if (!map.hasLayer(layer)) layer.addTo(map);
      } else map.removeLayer(layer);
    } catch {
      /* ignore */
    }
  }
  if (wantPrecip && overlays.precip && !radarFrames.length) {
    try {
      if (!map.hasLayer(overlays.precip)) overlays.precip.addTo(map);
    } catch {
      /* ignore */
    }
  } else if (!wantPrecip && overlays.precip && !radarFrames.length) {
    try {
      map.removeLayer(overlays.precip);
    } catch {
      /* ignore */
    }
  }
  applyOverlays();
  syncHazardLayers();
  document.querySelectorAll("[data-wx-fl]").forEach((btn) => {
    const k = btn.dataset.wxFl;
    if (k === "all" || k === "none") return;
    btn.classList.toggle("on", Boolean(wxTimelineFilters[k]));
  });
  const hourly = document.getElementById("wx-hourly");
  const bundle = window.__pipWxBundle;
  const esc = window.__pipWxEsc || ((s) => String(s ?? ""));
  if (hourly && bundle?.hours?.length) {
    renderHourlyTimeline(hourly, bundle, esc, window.__pipWxHailDays || []);
  }
}

function wxFilterBarHtml() {
  const f = wxTimelineFilters;
  return `<div class="wx-tl-filters">
    <button type="button" data-wx-fl="all">ALL</button>
    <button type="button" data-wx-fl="none">NONE</button>
    <button type="button" data-wx-fl="precip" class="${f.precip ? "on" : ""}">PRECIP</button>
    <button type="button" data-wx-fl="hail" class="${f.hail ? "on" : ""}">HAIL</button>
    <button type="button" data-wx-fl="wind" class="${f.wind ? "on" : ""}">WIND</button>
    <button type="button" data-wx-fl="temp" class="${f.temp ? "on" : ""}">TEMP</button>
  </div>`;
}

export function bindWxTimelineFilters(root = document, onChange) {
  root.querySelectorAll("[data-wx-fl]").forEach((btn) => {
    btn.onclick = () => {
      const k = btn.dataset.wxFl;
      if (k === "all") {
        wxTimelineFilters.precip = true;
        wxTimelineFilters.hail = true;
        wxTimelineFilters.wind = true;
        wxTimelineFilters.temp = true;
      } else if (k === "none") {
        wxTimelineFilters.precip = false;
        wxTimelineFilters.hail = false;
        wxTimelineFilters.wind = false;
        wxTimelineFilters.temp = false;
      } else if (k in wxTimelineFilters) {
        wxTimelineFilters[k] = !wxTimelineFilters[k];
      }
      applyWxTimelineFilters();
      onChange?.();
    };
  });
}

export function setRadarFrame(idx, { crossfade = false } = {}) {
  if (!radarFrames.length) return;
  const i = Math.max(0, Math.min(radarFrames.length - 1, Number(idx) || 0));
  radarFrameIdx = i;
  const frame = radarFrames[i];
  if (frame?.path) setRadarTilePath(frame.path, { crossfade });
  const label = document.getElementById("wx-radar-label");
  if (label && frame?.time) {
    const d = new Date(frame.time * 1000);
    label.textContent = d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const range = document.getElementById("wx-radar-range");
  if (range && String(range.value) !== String(i)) range.value = String(i);
}

export function stopRadarPlay() {
  radarPlaying = false;
  if (radarPlayRaf) {
    clearTimeout(radarPlayRaf);
    radarPlayRaf = null;
  }
  const btn = document.getElementById("wx-radar-play");
  if (btn) {
    btn.textContent = "PLAY";
    btn.classList.remove("on");
  }
}

export function stopHourPlay() {
  if (hourPlayTimer) {
    clearInterval(hourPlayTimer);
    hourPlayTimer = null;
  }
}

function radarScrubberInnerHtml() {
  if (radarFrames.length < 2 || !wxTimelineFilters.precip) return "";
  const max = radarFrames.length - 1;
  return `<div class="wx-radar-scrub-row">
    <button type="button" id="wx-radar-play" class="wx-play-btn${radarPlaying ? " on" : ""}">${radarPlaying ? "PAUSE" : "PLAY"}</button>
    <span class="wx-radar-tag">LIVE PRECIP</span>
    <input type="range" id="wx-radar-range" min="0" max="${max}" value="${radarFrameIdx}" step="1" />
    <span id="wx-radar-label" class="wx-radar-label">…</span>
  </div>`;
}

/** Single live-control strip: filters + radar scrub (no duplicate bars elsewhere). */
export function wxLiveControlsHtml() {
  const radar = radarScrubberInnerHtml();
  const active = [];
  if (wxTimelineFilters.precip) active.push("precip");
  if (wxTimelineFilters.hail) active.push("hail");
  if (wxTimelineFilters.wind) active.push("wind");
  if (wxTimelineFilters.temp) active.push("temp");
  const hint =
    active.length > 1
      ? `<p class="wx-live-hint muted">Live ${active.join(" · ")} · hourly timeline below · tap hail bars for pin zones</p>`
      : active.length === 1 && active[0] !== "precip"
        ? `<p class="wx-live-hint muted">Live ${active[0]} · hourly timeline below</p>`
        : "";
  return `<div class="wx-live-controls" id="wx-live-controls">
    ${wxFilterBarHtml()}
    ${radar ? `<div class="wx-radar-scrub" id="wx-radar-scrub">${radar}</div>` : ""}
    ${hint}
  </div>`;
}

/** @deprecated use wxLiveControlsHtml */
export function radarScrubberHtml() {
  return wxLiveControlsHtml();
}

export function bindWxLiveControls(root = document) {
  bindRadarScrubber(root);
  bindWxTimelineFilters(root, () => {
    applyWxTimelineFilters();
    const host = root.querySelector?.("#wx-live-controls") || document.getElementById("wx-live-controls");
    if (host) {
      host.outerHTML = wxLiveControlsHtml();
      bindWxLiveControls(root);
    }
  });
}

export function bindRadarScrubber(root = document) {
  const range = root.querySelector?.("#wx-radar-range") || document.getElementById("wx-radar-range");
  const play = root.querySelector?.("#wx-radar-play") || document.getElementById("wx-radar-play");
  if (!range) return;
  setRadarFrame(radarFrameIdx);
  range.oninput = () => {
    stopRadarPlay();
    setRadarFrame(range.value);
  };
  if (play) {
    play.onclick = () => {
      if (radarPlaying) {
        stopRadarPlay();
        return;
      }
      if (radarFrames.length < 2) return;
      play.textContent = "PAUSE";
      play.classList.add("on");
      radarPlaying = true;
      const tick = () => {
        if (!radarPlaying) return;
        const next = (radarFrameIdx + 1) % radarFrames.length;
        setRadarFrame(next, { crossfade: true });
        radarPlayRaf = window.setTimeout(tick, 520);
      };
      tick();
    };
  }
}

const BASE_LAYERS = [
  { id: "osm", label: "Street", kind: "base", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OSM" },
  {
    id: "dark",
    label: "Night",
    kind: "base",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OSM",
    className: "hs-night-tiles",
  },
  { id: "sat", label: "Sat", kind: "base", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "© Esri" },
];

export async function resolveMapCenter(settings) {
  return locateDevice(settings, httpGet);
}

async function currentWeather(lat, lon) {
  const bundle = await fetchWeatherBundle(lat, lon);
  return bundle.current;
}

/** Current + hourly past/next for timeline scrub. */
export async function fetchWeatherBundle(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,relative_humidity_2m",
    hourly: "temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code,wind_gusts_10m_max",
    past_days: "1",
    forecast_days: "3",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
  });
  try {
    const { body } = await httpGet(`https://api.open-meteo.com/v1/forecast?${params}`, 10000);
    const data = JSON.parse(body || "{}");
    const cur = data.current || {};
    const code = parseInt(cur.weather_code || 0, 10);
    const current = {
      ok: true,
      temp_f: cur.temperature_2m,
      feels_f: cur.apparent_temperature,
      wind_mph: cur.wind_speed_10m,
      gust_mph: cur.wind_gusts_10m,
      precip_in: cur.precipitation,
      humidity: cur.relative_humidity_2m,
      code,
      label: WMO[code] || "Weather",
    };
    const h = data.hourly || {};
    const times = h.time || [];
    const now = Date.now();
    const hours = times.map((t, i) => {
      const ts = new Date(t).getTime();
      const c = parseInt((h.weather_code || [])[i] || 0, 10);
      const precipIn = Number((h.precipitation || [])[i]);
      return {
        time: t,
        ts,
        temp_f: (h.temperature_2m || [])[i],
        feels_f: (h.apparent_temperature || [])[i],
        precip_in: Number.isFinite(precipIn) ? precipIn : 0,
        precip_mm: Number.isFinite(precipIn) ? precipIn * 25.4 : 0,
        precip_prob: (h.precipitation_probability || [])[i],
        wind_mph: (h.wind_speed_10m || [])[i],
        gust_mph: (h.wind_gusts_10m || [])[i],
        humidity: (h.relative_humidity_2m || [])[i],
        code: c,
        label: WMO[c] || "Weather",
        offsetHr: Math.round((ts - now) / 3600000),
      };
    });
    const windowed = hours.filter((row) => row.offsetHr >= -12 && row.offsetHr <= 36);
    const nearestIdx = windowed.reduce((best, row, i) => {
      if (best < 0) return i;
      return Math.abs(row.offsetHr) < Math.abs(windowed[best].offsetHr) ? i : best;
    }, -1);
    const daily = data.daily || {};
    const days = (daily.time || []).map((t, i) => ({
      date: t,
      high_f: (daily.temperature_2m_max || [])[i],
      low_f: (daily.temperature_2m_min || [])[i],
      precip_in: (daily.precipitation_sum || [])[i],
      precip_prob: (daily.precipitation_probability_max || [])[i],
      gust_mph: (daily.wind_gusts_10m_max || [])[i],
      code: parseInt((daily.weather_code || [])[i] || 0, 10),
      label: WMO[parseInt((daily.weather_code || [])[i] || 0, 10)] || "Weather",
    }));
    return {
      current,
      hours: windowed.length ? windowed : hours.slice(0, 48),
      nowIdx: Math.max(0, nearestIdx),
      days,
    };
  } catch {
    return {
      current: { ok: false },
      hours: [],
      nowIdx: 0,
      days: [],
    };
  }
}

function hourMetric(row, mode) {
  if (!row) return 0;
  if (mode === "precip") return Math.max(Number(row.precip_prob) || 0, (Number(row.precip_in) || 0) * 100);
  if (mode === "wind") return Number(row.gust_mph || row.wind_mph) || 0;
  return Number(row.temp_f) || 0;
}

function renderHourBars(hours, mode, activeIdx, hailDates = null) {
  const vals = hours.map((h) => hourMetric(h, mode));
  const max = Math.max(...vals, mode === "temp" ? 1 : mode === "wind" ? 10 : 1);
  const min = mode === "temp" ? Math.min(...vals.filter((v) => v), max - 1) : 0;
  const span = Math.max(1, max - min);
  const w = Math.max(240, hours.length * 8);
  const h = 56;
  const gap = 1;
  const barW = Math.max(2, (w - gap * hours.length) / hours.length);
  const bars = hours
    .map((row, i) => {
      const v = vals[i];
      const norm = mode === "temp" ? (v - min) / span : v / max;
      const bh = Math.max(2, Math.round(norm * (h - 8)));
      const x = i * (barW + gap);
      const y = h - bh;
      const on = i === activeIdx;
      let fill = on ? "var(--phos)" : "rgba(125,255,90,0.35)";
      if (mode === "precip") fill = on ? "#4fc3f7" : "rgba(79,195,247,0.4)";
      if (mode === "wind") fill = on ? "#90caf9" : "rgba(144,202,249,0.35)";
      const day = String(row.time || "").slice(0, 10);
      const hailDay = hailDates && hailDates.has(day);
      if (hailDay && wxTimelineFilters.hail) fill = on ? "#ff7043" : "rgba(255,112,67,0.55)";
      else if (mode === "hail" || [95, 96, 99].includes(row.code)) {
        if ([96, 99].includes(row.code)) fill = on ? "#e040fb" : "rgba(224,64,251,0.55)";
        else if (row.code === 95) fill = on ? "#ff7043" : "rgba(255,112,67,0.45)";
      }
      return `<rect x="${x.toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${bh}" fill="${fill}" data-hi="${i}" />`;
    })
    .join("");
  const hailTicks =
    hailDates && wxTimelineFilters.hail
      ? hours
          .map((row, i) => {
            const day = String(row.time || "").slice(0, 10);
            if (!hailDates.has(day)) return "";
            const x = i * (barW + gap) + barW / 2;
            return `<line x1="${x.toFixed(1)}" y1="${h - 2}" x2="${x.toFixed(1)}" y2="${h}" stroke="#ff7043" stroke-width="2" />`;
          })
          .join("")
      : "";
  return `<svg class="wx-hour-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${bars}${hailTicks}</svg>`;
}

function renderPrecipStrip(hours, activeIdx, esc) {
  const slice = hours.slice(Math.max(0, activeIdx - 2), Math.min(hours.length, activeIdx + 7));
  if (!slice.length) return "";
  return `<div class="wx-precip-strip">${slice
    .map((row, j) => {
      const prob = row.precip_prob != null ? Math.round(row.precip_prob) : 0;
      const hi = j + Math.max(0, activeIdx - 2) === activeIdx;
      const hr =
        row.offsetHr === 0
          ? "NOW"
          : row.offsetHr < 0
            ? `${Math.abs(row.offsetHr)}h`
            : `+${row.offsetHr}h`;
      return `<span class="wx-precip-pill${hi ? " on" : ""}${prob >= 50 ? " wet" : ""}">
        <span class="wx-precip-hr">${esc(hr)}</span>
        <span class="wx-precip-pct">${prob}%</span>
      </span>`;
    })
    .join("")}</div>`;
}

/** HailTrace-style storm-date bars — tap a day to paint topo zones on the map. */
export function renderStormGraph(hailDays, esc, selectedDate = selectedStormDate) {
  const rows = [...(hailDays || [])]
    .filter((h) => parseFloat(h.size_in) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-24);
  if (!rows.length) {
    return `<div class="wx-storm-graph empty"><p class="muted">No hail days within ${wxFilters.km} km of this pin — widen NEAR / WINDOW or run DEEP RESEARCH.</p></div>`;
  }
  const maxSz = Math.max(...rows.map((h) => parseFloat(h.size_in) || 0), 1);
  const maxHits = Math.max(...rows.map((h) => Number(h.hits) || 1), 1);
  const w = Math.max(280, rows.length * 20);
  const h = 118;
  const pad = 18;
  const barArea = h - pad - 26;
  const slotW = (w - 8) / rows.length;
  const bars = rows
    .map((row, i) => {
      const sz = parseFloat(row.size_in) || 0;
      const hits = Number(row.hits) || 1;
      const bh = Math.max(4, Math.round((sz / maxSz) * barArea));
      const bw = Math.max(6, slotW * 0.72 * Math.min(1.8, 0.65 + (hits / maxHits) * 0.55));
      const x = 4 + i * slotW + (slotW - bw) / 2;
      const y = pad + (barArea - bh);
      const col = hailZoneColor(sz);
      const label = String(row.date || "").slice(5);
      const on = selectedDate && selectedDate === row.date;
      const dist = row.distance_km != null ? `${row.distance_km}km` : "";
      return `<g class="wx-sg-bar${on ? " on" : ""}" data-storm-date="${esc(row.date)}" role="button" tabindex="0">
        <rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" fill="${col.fill}" stroke="${on ? "var(--phos)" : col.stroke}" stroke-width="${on ? 1.8 : 0.6}" opacity="${on ? 1 : 0.88}" />
        <text x="${(x + bw / 2).toFixed(1)}" y="${Math.max(10, y - 3)}" text-anchor="middle" class="wx-sg-v">${esc(String(sz))}"</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${h - 16}" text-anchor="middle" class="wx-sg-x">${esc(label)}</text>
        ${dist ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle" class="wx-sg-dist muted">${esc(dist)}</text>` : ""}
      </g>`;
    })
    .join("");
  const biggest = [...rows].sort((a, b) => (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0))[0];
  const selLabel = selectedDate || biggest.date;
  return `<div class="wx-storm-graph">
    <div class="wx-storm-graph-head">
      <span>HAIL ZONES · THIS PIN</span>
      <span class="wx-storm-graph-peak">${esc(selLabel)} · ${rows.length} day(s) · ${wxFilters.km} km</span>
    </div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Hail size by storm date near pin">${bars}</svg>
    <div class="wx-storm-graph-legend muted">Tap a bar → storm zones on map · height = max inches · width = signatures · label = km from pin</div>
  </div>`;
}

export function bindStormGraph(root, onPick) {
  if (!root || typeof onPick !== "function") return;
  root.querySelectorAll("[data-storm-date]").forEach((el) => {
    const pick = () => onPick(el.getAttribute("data-storm-date"));
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      pick();
    };
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    };
  });
}

export function selectStormDate(date, { fit = false, requireDate } = {}) {
  selectedStormDate = date ? String(date).slice(0, 10) : null;
  const needDate = requireDate === true || (requireDate !== false && hailScopeMode);
  if (lastHailRows.length || lastWindRows.length) {
    drawHailMarkers(lastHailRows, lastWindRows, { fit, requireDate: needDate });
  }
  if (selectedStormDate && wxTimelineFilters.hail && activeWxProduct !== "hail" && activeWxProduct !== "precip") {
    setMapLayer("hail");
  }
  if (fit) {
    (document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell"))?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }
}

export function getSelectedStormDate() {
  return selectedStormDate;
}

export function renderDailyForecast(days, esc) {
  const rows = (days || []).slice(0, 4);
  if (!rows.length) return "";
  return `<div class="wx-daily">${rows
    .map((d, i) => {
      const label =
        i === 0 ? "TODAY" : new Date(d.date).toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
      const prob = d.precip_prob != null ? `${Math.round(d.precip_prob)}%` : "—";
      const amt = Number(d.precip_in) > 0 ? `${Number(d.precip_in).toFixed(2)}"` : "";
      const gust = d.gust_mph != null && d.gust_mph >= 30 ? `${Math.round(d.gust_mph)} gust` : "";
      return `<div class="wx-day-card">
        <span class="wx-day-lab">${esc(label)}</span>
        <span class="wx-day-hilo">${Math.round(d.high_f)}° <span class="wx-day-lo">${Math.round(d.low_f)}°</span></span>
        <span class="wx-day-precip">${esc(prob)}</span>
        ${amt ? `<span class="wx-day-amt">${esc(amt)} rain</span>` : ""}
        ${gust ? `<span class="wx-day-gust">${esc(gust)}</span>` : ""}
        <span class="wx-day-wx">${esc(d.label)}</span>
      </div>`;
    })
    .join("")}</div>`;
}

export function weatherSummaryHtml(bundle, hailDays, esc) {
  const cur = bundle?.current;
  if (!cur?.ok) return `<div class="wx-summary muted">Weather summary offline.</div>`;
  const hours = bundle.hours || [];
  const next12 = hours.filter((h) => h.offsetHr >= 0 && h.offsetHr <= 12);
  const maxProb = Math.max(0, ...next12.map((h) => Number(h.precip_prob) || 0));
  const maxGust = Math.max(0, ...next12.map((h) => Number(h.gust_mph || h.wind_mph) || 0), Number(cur.gust_mph) || 0);
  const stormHr = next12.find((h) => [95, 96, 99].includes(h.code));
  const recentHail = [...(hailDays || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const day0 = (bundle.days || [])[0];
  const nowPrecip = Number(cur.precip_in) || 0;
  const stats = [];
  if (cur.feels_f != null) stats.push({ k: "FEELS", v: `${Math.round(cur.feels_f)}°` });
  if (cur.humidity != null) stats.push({ k: "RH", v: `${Math.round(cur.humidity)}%` });
  if (cur.wind_mph != null) stats.push({ k: "WIND", v: `${Math.round(cur.wind_mph)} mph` });
  if (cur.gust_mph != null && cur.gust_mph > (cur.wind_mph || 0)) stats.push({ k: "GUST", v: `${Math.round(cur.gust_mph)}` });
  if (nowPrecip > 0) stats.push({ k: "NOW", v: `${nowPrecip.toFixed(2)}"` });
  if (maxProb >= 15) stats.push({ k: "12H RAIN", v: `${Math.round(maxProb)}%` });
  const outlook = [];
  if (day0) {
    outlook.push(`Today ${Math.round(day0.high_f)}°/${Math.round(day0.low_f)}°`);
    if (day0.precip_prob != null) outlook.push(`${Math.round(day0.precip_prob)}% precip chance`);
    if (Number(day0.precip_in) > 0) outlook.push(`${Number(day0.precip_in).toFixed(2)}" expected`);
  }
  if (maxGust >= 35) outlook.push(`Gusts to ${Math.round(maxGust)} mph`);
  if (stormHr) outlook.push(`Thunder ~${new Date(stormHr.ts).toLocaleTimeString(undefined, { hour: "numeric" })}`);
  if (recentHail) outlook.push(`Hail ${recentHail.date} · ${recentHail.size_in}"`);
  return `<div class="wx-summary wx-hero">
    <div class="wx-hero-main">
      <div class="wx-summary-hero">${Math.round(cur.temp_f)}°</div>
      <div class="wx-summary-label">${esc(cur.label)}</div>
    </div>
    <div class="wx-stat-grid">${stats
      .map((s) => `<div class="wx-stat"><span class="wx-stat-k">${esc(s.k)}</span><span class="wx-stat-v">${esc(s.v)}</span></div>`)
      .join("")}</div>
    ${outlook.length ? `<div class="wx-summary-outlook">${esc(outlook.join(" · "))}</div>` : ""}
  </div>`;
}

export function paintWxMapHud(bundle) {
  const hud = document.getElementById("wx-map-hud");
  if (!hud) return;
  const cur = bundle?.current;
  if (!cur?.ok || cur.temp_f == null) {
    hud.hidden = true;
    hud.innerHTML = "";
    return;
  }
  const wind = cur.wind_mph != null ? `${Math.round(cur.wind_mph)} mph` : "";
  hud.hidden = false;
  hud.innerHTML = `<strong>${Math.round(cur.temp_f)}°</strong><span>${String(cur.label || "Now").replace(/</g, "")}</span>${wind ? `<em>${wind}</em>` : ""}`;
}

/** Refresh hero + daily + hourly blocks inside a WX panel root. */
export function paintLiveWeather(root, bundle, hailDays, esc) {
  if (!root || !bundle) return;
  window.__pipWxBundle = bundle;
  window.__pipWxHailDays = hailDays || [];
  window.__pipWxEsc = esc;
  const hail = hailDays || [];
  const sum =
    root.querySelector("#wx-summary") ||
    root.querySelector(".wx-summary-host") ||
    root.querySelector(".wx-summary");
  if (sum) {
    const html = weatherSummaryHtml(bundle, hail, esc);
    if (sum.id === "wx-summary" || sum.classList.contains("wx-summary-host")) sum.innerHTML = html;
    else sum.outerHTML = html;
  }
  paintWxMapHud(bundle);
  const daily = root.querySelector("#wx-daily");
  if (daily) daily.innerHTML = renderDailyForecast(bundle.days, esc);
  const hourly = root.querySelector("#wx-hourly");
  if (hourly && bundle.hours?.length) renderHourlyTimeline(hourly, bundle, esc, hail);
}

export function renderHourlyTimeline(root, bundle, esc, hailDays = [], opts = {}) {
  if (!root) return;
  const hours = bundle?.hours || [];
  if (!hours.length) {
    root.innerHTML = `<p class="muted">Hourly timeline offline.</p>`;
    return;
  }
  const hailDates = new Set((hailDays || []).map((h) => String(h.date || "").slice(0, 10)).filter(Boolean));
  let mode = opts.mode || root.dataset.wxMode || "precip";
  if (mode === "temp" && !wxTimelineFilters.temp) mode = wxTimelineFilters.precip ? "precip" : "wind";
  const idx = Math.min(
    hours.length - 1,
    Math.max(0, Number(opts.idx ?? root.dataset.wxHour ?? bundle.nowIdx) || 0),
  );
  const paint = (i) => {
    const row = hours[i];
    if (!row) return;
    root.dataset.wxHour = String(i);
    const when =
      row.offsetHr === 0
        ? "NOW"
        : row.offsetHr < 0
          ? `${Math.abs(row.offsetHr)}h ago`
          : `+${row.offsetHr}h`;
    const tLabel = new Date(row.ts).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    let focus = "";
    if (mode === "precip") {
      focus = `${row.precip_prob != null ? `${Math.round(row.precip_prob)}% chance` : "precip"} · ${(Number(row.precip_in) || 0).toFixed(2)} in · ${esc(row.label)}`;
    } else if (mode === "wind") {
      focus = `${row.wind_mph != null ? `${Math.round(row.wind_mph)} mph` : "wind"}${row.gust_mph != null ? ` · gust ${Math.round(row.gust_mph)}` : ""} · ${esc(row.label)}`;
    } else {
      focus = `${Math.round(row.temp_f)}°F${row.feels_f != null ? ` (feels ${Math.round(row.feels_f)}°)` : ""} · ${esc(row.label)}`;
    }
    root.dataset.wxMode = mode;
    root.innerHTML = `
      <div class="wx-timeline">
        <div class="wx-timeline-modes">
          <button type="button" data-wx-mode="temp" class="${mode === "temp" && wxTimelineFilters.temp ? "on" : ""}${!wxTimelineFilters.temp ? " off" : ""}">TEMP</button>
          <button type="button" data-wx-mode="precip" class="${mode === "precip" && wxTimelineFilters.precip ? "on" : ""}${!wxTimelineFilters.precip ? " off" : ""}">PRECIP</button>
          <button type="button" data-wx-mode="wind" class="${mode === "wind" && wxTimelineFilters.wind ? "on" : ""}${!wxTimelineFilters.wind ? " off" : ""}">WIND</button>
        </div>
        <div class="wx-timeline-head">
          <span class="wx-timeline-when">${esc(when)}</span>
          <span class="wx-timeline-clock">${esc(tLabel)}</span>
        </div>
        <div class="wx-now">${focus}</div>
        <div class="wx-hour-chart-wrap">${renderHourBars(hours, mode, i, hailDates)}</div>
        ${mode === "precip" ? renderPrecipStrip(hours, i, esc) : ""}
        <div class="wx-timeline-meta muted">${esc(
          `${hours.length} hrs · −12h → +36h · tap bars · ${hailDates.size ? hailDates.size + " hail days marked" : "no hail on timeline"}`,
        )}</div>
      </div>`;
    root.querySelectorAll("[data-wx-mode]").forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.wxMode;
        paint(Number(root.dataset.wxHour || i));
      };
    });
    root.querySelectorAll(".wx-hour-chart rect").forEach((r) => {
      r.onclick = () => paint(Number(r.getAttribute("data-hi")));
    });
  };
  paint(idx);
}

export function renderWeatherBoot(root, geo, wx, hail, esc) {
  const addr = (geo && (geo.address || geo.city)) || "Your area";
  const hailRows = collapseHailByDate(hail || []);
  selectedStormDate = null;
  if (hailRows.length) {
    selectedStormDate = [...hailRows].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.date || null;
  }
  const bundleStub = {
    current: wx && wx.ok ? wx : { ok: false },
    hours: [],
    days: [],
  };
  const hourly = root.querySelector("#wx-hourly");
  root.innerHTML = `
    <div class="wx-boot">
      <div class="wx-addr">${esc(addr)}</div>
      <div id="wx-summary" class="wx-summary-host">${weatherSummaryHtml(bundleStub, hailRows, esc)}</div>
      <div id="wx-daily"></div>
      <div id="wx-hourly-slot" class="wx-hourly"></div>
      <p class="muted wx-boot-hint">Double-tap map to expand · roofing dossier below</p>
    </div>`;
  const slot = root.querySelector("#wx-hourly-slot");
  if (hourly && slot) {
    hourly.id = "wx-hourly";
    slot.replaceWith(hourly);
  }
  if (hail?.length) drawHailMarkers(hail, [], { fit: false });
}

export function renderRoofBoot(root, hail, esc) {
  if (!root) return;
  const hailRows = collapseHailByDate(hail || []);
  const n = hailRows.length;
  root.innerHTML = `
    <details class="wx-roof-fold">
      <summary class="wx-roof-sum">ROOFING · ${n ? `${n} hail day(s)` : "hail trace"}</summary>
      <div class="wx-roof-body">
        <p class="muted">${n ? `${n} hail day(s) near pin — tap to expand trace.` : "Pin an address — tap to expand hail trace."}</p>
      </div>
    </details>`;
}

async function searchNews(query, limit = 6) {
  try {
    const res = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `q=${encodeURIComponent(query)}`,
    });
    const html = await res.text();
    const hits = [];
    const re = /uddg=([^&"]+)[^>]*>([^<]{8,200})<\/a/g;
    let m;
    while ((m = re.exec(html)) && hits.length < limit) {
      hits.push({ title: m[2].replace(/\s+/g, " ").trim(), url: decodeURIComponent(m[1]), source: "duckduckgo" });
    }
    return hits;
  } catch {
    return [];
  }
}

function normalizeDossier(raw) {
  if (!raw || raw.ok === false) return null;
  const d = raw.dossier && typeof raw.dossier === "object" ? { ...raw.dossier, ...raw } : { ...raw };
  if (!d.address && !d.storms && !d.hail && !d.zillow_url) return null;
  if (!d.zillow_url && d.address) d.zillow_url = zillowUrl(d.address);
  d.storms = d.storms || d.recent_storms || [];
  d.hail = d.hail || [];
  d.wind = d.wind || [];
  d.news = d.news || [];
  return d;
}

function usableRemote(d) {
  const n = normalizeDossier(d);
  return n && (n.address || n.storms?.length || n.hail?.length || n.zillow_url);
}

async function localMapConfig(settings, center) {
  const c = center || (await resolveMapCenter(settings));
  const layerList = [...BASE_LAYERS];
  radarFrames = [];
  radarFrameIdx = 0;
  try {
    const { body } = await httpGet("https://api.rainviewer.com/public/weather-maps.json", 2500);
    const rv = JSON.parse(body || "{}");
    radarHost = rv.host || "https://tilecache.rainviewer.com";
    const past = ((rv.radar || {}).past || []).slice(-12);
    const nowcast = ((rv.radar || {}).nowcast || []).slice(0, 3);
    radarFrames = [...past, ...nowcast].filter((f) => f && f.path);
    radarFrameIdx = Math.max(0, past.length - 1);
    const frame = radarFrames[radarFrameIdx] || past.slice(-1)[0];
    const ir = ((rv.satellite || {}).infrared || []).slice(-1)[0];
    const vis = ((rv.satellite || {}).visible || []).slice(-1)[0];
    if (frame?.path) {
      layerList.push({
        id: "precip",
        label: "Precip",
        kind: "wx",
        url: rainTileUrl(radarHost, frame.path),
        attribution: "© RainViewer",
        opacity: 0.72,
        maxNativeZoom: RADAR_NATIVE_ZOOM,
      });
    }
    if (ir?.path) {
      layerList.push({
        id: "cloud",
        label: "Cloud",
        kind: "wx",
        url: rainTileUrl(radarHost, ir.path, "0/0_0"),
        attribution: "© RainViewer",
        opacity: 0.55,
        maxNativeZoom: RADAR_NATIVE_ZOOM,
      });
    }
    if (vis?.path) {
      layerList.push({
        id: "vis",
        label: "Vis",
        kind: "wx",
        url: rainTileUrl(radarHost, vis.path, "0/0_0"),
        attribution: "© RainViewer",
        opacity: 0.45,
        maxNativeZoom: RADAR_NATIVE_ZOOM,
      });
    }
    layerList.push({
      id: "wind",
      label: "Wind",
      kind: "wx",
      synthetic: true,
    });
    layerList.push({
      id: "hail",
      label: "Hail",
      kind: "wx",
      synthetic: true,
    });
  } catch {
    /* overlays optional */
  }
  if (!layerList.some((l) => l.id === "wind")) {
    layerList.push({ id: "wind", label: "Wind", kind: "wx", synthetic: true });
  }
  if (!layerList.some((l) => l.id === "hail")) {
    layerList.push({ id: "hail", label: "Hail", kind: "wx", synthetic: true });
  }
  return { center: { lat: c.lat, lon: c.lon, city: c.city || settings?.city || "" }, layers: layerList, radarFrames };
}

async function localResearch(lat, lon, address = "", { deep = true, filters = wxFilters, news = false } = {}) {
  const geoP = address ? Promise.resolve({ ok: true, address, city: address.split(",")[0] }) : reverseGeocode(lat, lon);
  const filterDays = Number(filters.days) || 180;
  const archiveDays = Math.min(filterDays, 730);
  const swdiDays = Math.min(filterDays, 180);
  const km = Number(filters.km) || 15;
  const spcDays = Math.min(filterDays, deep ? 90 : 30);
  const [geo, wxNow, archiveStorms, spc, swdi, lsr] = await Promise.all([
    geoP,
    currentWeather(lat, lon).catch(() => ({ ok: false })),
    historicalStorms(lat, lon, archiveDays),
    fetchSpcReports(lat, lon, km, spcDays),
    fetchSwdiHail(lat, lon, km, swdiDays),
    fetchIemLsrHail(lat, lon, km, filterDays).catch(() => []),
  ]);
  const addr = address || geo.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const city = geo.city || addr.split(",")[0];
  const hail = mergeHailRows(spc.hail || [], swdi || [], lsr || []);
  const wind = spc.wind || [];
  const storms = enrichStormDates(archiveStorms, hail, wind);
  const newsHits = [];
  if (news) {
    for (const q of [`hail damage "${city}"`, `hail storm "${city}"`, `severe weather "${addr}"`, `wind damage "${city}"`]) {
      for (const hit of await searchNews(q, 3)) {
        if (!newsHits.some((n) => n.url === hit.url)) newsHits.push(hit);
      }
    }
  }
  return {
    ok: true,
    address: addr,
    lat,
    lon,
    weather: wxNow,
    storms,
    hail,
    wind,
    news: newsHits,
    zillow_url: zillowUrl(addr),
    owner_name: "",
    owner_phone: "",
    owner_email: "",
    _meta: { fetchedDays: Math.max(archiveDays, swdiDays, spcDays, filterDays), fetchedKm: km, deep: Boolean(deep), lat, lon },
  };
}

export async function quickDossier(settings, lat, lon, { onPartial } = {}) {
  const geo = await reverseGeocode(lat, lon);
  const addr = geo.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const partial = {
    ok: true,
    address: addr,
    lat,
    lon,
    zillow_url: zillowUrl(addr),
    storms: [],
    hail: [],
    wind: [],
    news: [],
    owner_name: "",
    owner_phone: "",
    owner_email: "",
  };
  if (onPartial) onPartial(partial);
  const km = Number(wxFilters.km) || 25;
  const lsrDays = Number(wxFilters.days) || 365;
  const [wxNow, spc, swdi, lsr] = await Promise.all([
    currentWeather(lat, lon).catch(() => ({ ok: false })),
    fetchSpcReports(lat, lon, km, 30),
    fetchSwdiHail(lat, lon, km, 60),
    fetchIemLsrHail(lat, lon, km, lsrDays).catch(() => []),
  ]);
  const hail = mergeHailRows(spc.hail || [], swdi || [], lsr || []);
  const wind = spc.wind || [];
  return {
    ...partial,
    weather: wxNow,
    hail,
    wind,
    storms: enrichStormDates([], hail, wind),
    _meta: { fetchedDays: Math.max(60, lsrDays), fetchedKm: km, deep: false },
  };
}

export async function refetchDossier(settings, lat, lon, address, filters = wxFilters) {
  const f = { ...wxFilters, ...filters };
  return localResearch(lat, lon, address, { deep: true, filters: f });
}

function applyBaseLayers(config) {
  if (!config) return config;
  const layers = [...(config.layers || [])];
  for (const base of BASE_LAYERS) {
    const i = layers.findIndex((l) => l.id === base.id);
    if (i >= 0) layers[i] = { ...layers[i], ...base };
    else layers.unshift({ ...base });
  }
  config.layers = layers;
  return config;
}

export async function loadMapConfig(settings) {
  if (mapConfigCache) {
    const layers = mapConfigCache.layers || [];
    if (!layers.some((l) => l.id === "hail")) {
      layers.push({ id: "hail", label: "Hail", kind: "wx", synthetic: true });
    }
    if (!layers.some((l) => l.id === "wind")) {
      layers.push({ id: "wind", label: "Wind", kind: "wx", synthetic: true });
    }
    mapConfigCache.layers = layers;
    return applyBaseLayers(mapConfigCache);
  }
  const center = await resolveMapCenter(settings);
  const remote = await api("/api/storm/map", { settings, timeout: 8000 }).catch(() => null);
  mapConfigCache = remote ? { ...remote, center: { ...remote.center, ...center } } : await localMapConfig(settings, center);
  return applyBaseLayers(mapConfigCache);
}

export async function researchPin(settings, lat, lon, address = "", deep = true) {
  let remote = null;
  try {
    remote = await api("/api/storm/research", {
      settings,
      method: "POST",
      body: { lat, lon, address, deep },
      timeout: deep ? 180000 : 60000,
    });
  } catch {
    /* local fallback */
  }
  const local = await localResearch(lat, lon, address, { deep, filters: wxFilters, news: deep });
  if (usableRemote(remote)) {
    const norm = normalizeDossier(remote) || local;
    norm.lat = lat;
    norm.lon = lon;
    norm.hail = pinFilterHailRows(norm.hail || [], lat, lon, Number(wxFilters.km) || 25);
    if ((local.hail?.length || 0) > (norm.hail?.length || 0)) {
      norm.hail = local.hail;
      norm.wind = local.wind || [];
      norm.storms = local.storms || [];
    }
    norm._meta = local._meta || norm._meta;
    return norm;
  }
  return local;
}

export async function pinDossier(settings, lat, lon, { onPartial, deep = false } = {}) {
  if (!deep) {
    return normalizeDossier(await quickDossier(settings, lat, lon, { onPartial })) || null;
  }
  const geo = await reverseGeocode(lat, lon);
  const addr = geo.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const partial = {
    ok: true,
    address: addr,
    lat,
    lon,
    zillow_url: zillowUrl(addr),
    storms: [],
    hail: [],
    news: [],
    owner_name: "",
    owner_phone: "",
    owner_email: "",
  };
  if (onPartial) onPartial(partial);
  const full = await researchPin(settings, lat, lon, addr, true);
  return normalizeDossier(full) || partial;
}

export async function quickPin(settings, lat, lon) {
  const [remote, local] = await Promise.all([
    api("/api/storm/pin", {
      settings,
      method: "POST",
      body: { lat, lon },
      timeout: 20000,
    }).catch(() => null),
    quickDossier(settings, lat, lon).catch(() => null),
  ]);
  if (local) {
    const norm = normalizeDossier(local) || local;
    norm.lat = lat;
    norm.lon = lon;
    if (remote) {
      const r = normalizeDossier(remote) || {};
      norm.geo = r.geo || norm.geo;
      norm.weather = (r.weather && r.weather.ok !== false ? r.weather : null) || norm.weather;
      if ((local.hail?.length || 0) >= (r.hail?.length || 0)) {
        /* keep local pin-filtered hail */
      } else if (r.hail?.length) {
        norm.hail = pinFilterHailRows(r.hail, lat, lon, Number(wxFilters.km) || 25);
      }
    }
    return norm;
  }
  if (remote) {
    const norm = normalizeDossier(remote) || remote;
    norm.lat = lat;
    norm.lon = lon;
    norm.hail = pinFilterHailRows(norm.hail || [], lat, lon, Number(wxFilters.km) || 25);
    return norm;
  }
  const [geo, wx] = await Promise.all([
    reverseGeocode(lat, lon),
    currentWeather(lat, lon),
  ]);
  return { ok: true, geo, lat, lon, address: geo?.address || "", weather: wx, hail: [], recent_storms: [] };
}

function pinFilterHailRows(rows, lat, lon, km = 15) {
  const pinLat = Number(lat);
  const pinLon = Number(lon);
  const radius = Number(km) || 25;
  return (rows || [])
    .map((h) => {
      if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon) || !Number.isFinite(h.lat) || !Number.isFinite(h.lon)) {
        return h;
      }
      const dist = haversineKm(pinLat, pinLon, h.lat, h.lon);
      return { ...h, distance_km: Math.round(dist * 10) / 10 };
    })
    .filter((h) => {
      if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) return false;
      const dist = Number(h.distance_km);
      return !Number.isFinite(dist) || dist <= radius;
    });
}

function hailNearPin(rows, day = null) {
  if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon)) return rows || [];
  const km = Number(wxFilters.km) || 15;
  return (rows || []).filter((h) => {
    const d = String(h.date || "").slice(0, 10);
    if (day && d !== day) return false;
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) return false;
    const dist = Number.isFinite(h.distance_km) ? h.distance_km : haversineKm(pinLat, pinLon, h.lat, h.lon);
    return dist <= km;
  });
}

function windNearPin(rows, day = null) {
  if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon)) return rows || [];
  const km = Number(wxFilters.km) || 15;
  return (rows || []).filter((w) => {
    const d = String(w.date || "").slice(0, 10);
    if (day && d !== day) return false;
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) return false;
    const dist = Number.isFinite(w.distance_km) ? w.distance_km : haversineKm(pinLat, pinLon, w.lat, w.lon);
    return dist <= km;
  });
}

export function setWxPin(lat, lon) {
  pinLat = Number(lat);
  pinLon = Number(lon);
  drawPinRadius();
  if (lastHailRows.length || lastWindRows.length) {
    drawHailMarkers(lastHailRows, lastWindRows);
  }
}

function drawPinRadius() {
  if (!map || !window.L) return;
  if (pinRadiusLayer) {
    try {
      map.removeLayer(pinRadiusLayer);
    } catch {
      /* ignore */
    }
    pinRadiusLayer = null;
  }
  if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon)) return;
  const km = Number(wxFilters.km) || 15;
  pinRadiusLayer = window.L.circle([pinLat, pinLon], {
    radius: km * 1000,
    color: "#ffcc00",
    fillColor: "#ffcc00",
    fillOpacity: 0.05,
    weight: 1,
    dashArray: "6 8",
    interactive: false,
    className: "wx-pin-radius",
  }).addTo(map);
}

function ringPolygon(lat, lon, radiusM, sides = 6) {
  const ring = [];
  const cos = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < sides; i++) {
    const ang = (i / sides) * Math.PI * 2 - Math.PI / 2;
    const dLat = (radiusM * Math.sin(ang)) / 111320;
    const dLon = (radiusM * Math.cos(ang)) / (111320 * Math.max(0.2, cos));
    ring.push([lat + dLat, lon + dLon]);
  }
  return ring;
}

function convexHullLatLon(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 3) return null;
  const sorted = [...pts].sort((a, b) => (a.lat === b.lat ? a.lon - b.lon : a.lat - b.lat));
  const cross = (o, a, b) => (a.lat - o.lat) * (b.lon - o.lon) - (a.lon - o.lon) * (b.lat - o.lat);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return null;
  return hull.map((p) => [p.lat, p.lon]);
}

function padPolygon(ring, padM) {
  if (!ring || ring.length < 3 || !padM) return ring;
  let lat = 0;
  let lon = 0;
  for (const [a, b] of ring) {
    lat += a;
    lon += b;
  }
  lat /= ring.length;
  lon /= ring.length;
  const cos = Math.cos((lat * Math.PI) / 180);
  return ring.map(([a, b]) => {
    const dLat = a - lat;
    const dLon = (b - lon) * cos;
    const len = Math.hypot(dLat, dLon) || 1;
    const scale = padM / 111320 / len;
    return [a + dLat * scale, b + (dLon * scale) / cos];
  });
}

function clusterPoints(pts, splitKm = 5) {
  const clusters = [];
  for (const p of pts || []) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    let placed = false;
    for (const c of clusters) {
      if (haversineKm(c.center.lat, c.center.lon, p.lat, p.lon) <= splitKm) {
        c.pts.push(p);
        c.center.lat = c.pts.reduce((a, x) => a + x.lat, 0) / c.pts.length;
        c.center.lon = c.pts.reduce((a, x) => a + x.lon, 0) / c.pts.length;
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ pts: [p], center: { lat: p.lat, lon: p.lon } });
  }
  return clusters.map((c) => c.pts);
}

/** Roofer/industry-style footprint radius from hail size + source type. */
function hailFootprintM(sizeIn, source) {
  const sz = parseFloat(sizeIn);
  const s = Number.isNaN(sz) ? 0.75 : sz;
  const spot = /spc|lsr|spot|iem/i.test(String(source || ""));
  return Math.max(350, Math.min(8000, (spot ? 700 : 1100) + s * (spot ? 600 : 900)));
}

function buildDetailedZoneRings(zone, rawPts) {
  const day = zone.date;
  const hits = (rawPts || []).filter(
    (p) => String(p.date || "").slice(0, 10) === day && Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
  const fromZone = (zone.zone_pts || []).map((p) => ({
    lat: p.lat,
    lon: p.lon,
    size_in: p.size_in || zone.size_in,
    source: p.source || zone.source,
    swdi_ring: p.swdi_ring || null,
  }));
  const merged = hits.length ? hits : fromZone;
  if (!merged.length) {
    return [{ ring: topoZoneRing(zone, rawPts), maxSize: parseFloat(zone.size_in) || 0, hits: 1, confirmed: false }];
  }

  const rings = [];
  for (const p of merged) {
    if (p.swdi_ring && p.swdi_ring.length >= 3) {
      const maxSz = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0;
      rings.push({
        ring: padPolygon(p.swdi_ring, Math.max(120, maxSz * 80)),
        maxSize: maxSz,
        hits: 1,
        confirmed: false,
        source: "radar-poly",
      });
    }
  }

  const clusterInput = merged.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    size_in: p.size_in || zone.size_in,
    source: p.source || zone.source,
  }));
  const clusters = clusterPoints(clusterInput, 5);
  for (const cluster of clusters) {
    const samples = [];
    let confirmed = false;
    for (const p of cluster) {
      if (/spc|lsr|spot|iem/i.test(String(p.source || ""))) confirmed = true;
      const r = hailFootprintM(p.size_in, p.source);
      for (const [la, lo] of ringPolygon(p.lat, p.lon, r, 12)) samples.push({ lat: la, lon: lo });
    }
    const hull = convexHullLatLon(samples);
    if (!hull) continue;
    const maxSz = Math.max(...cluster.map((p) => parseFloat(p.size_in) || 0));
    rings.push({
      ring: padPolygon(hull, Math.max(180, maxSz * 100)),
      maxSize: maxSz,
      hits: cluster.length,
      confirmed,
      source: confirmed ? "spot+radar" : "radar-merge",
    });
  }

  if (!rings.length) {
    return [{ ring: topoZoneRing(zone, rawPts), maxSize: parseFloat(zone.size_in) || 0, hits: zone.hits || 1, confirmed: false }];
  }
  return rings;
}

function topoZoneRing(zone, rawPts) {
  const lat = zone.lat;
  const lon = zone.lon;
  const sz = parseFloat(zone.size_in);
  const baseM = Math.max(900, Math.min(11000, (zone.zone_r_km || 2) * 1000));
  const dayPts = (rawPts || []).filter((p) => String(p.date || "").slice(0, 10) === zone.date);
  const hull = convexHullLatLon(dayPts);
  if (hull) return padPolygon(hull, Math.max(400, baseM * 0.15));
  return ringPolygon(lat, lon, baseM, sz >= 1.5 ? 8 : 6);
}

function hailPopupHtml(h, day) {
  const stars = h.stars || hailStars(h.size_in);
  const sev = h.severity || hailSeverityLabel(h.size_in);
  const src =
    h.source === "mixed"
      ? "radar+spot"
      : h.source === "noaa-swdi-radar"
        ? "radar"
        : h.source === "iem-lsr"
          ? "LSR"
          : "spotter";
  return `<b>${stars} ${sev}</b><br>${h.date || day || ""}${h.time ? ` ${h.time}` : ""} · <b>${h.size_in}"</b> (${src})<br>${h.hits || 1} signature${(h.hits || 1) === 1 ? "" : "s"} · zone ~${h.zone_r_km || "?"} km<br>${h.location || ""}${h.state ? `, ${h.state}` : ""}${h.distance_km != null ? `<br>${h.distance_km} km from pin` : ""}`;
}

export function drawHailMarkers(hailRows, windRows, opts = {}) {
  if (!map || !window.L) return;
  lastHailRows = hailRows || [];
  lastWindRows = windRows || [];
  const requireDate = opts.requireDate === true || (opts.requireDate !== false && hailScopeMode);
  if (hailLayer) {
    try {
      hailLayer.remove();
    } catch {
      /* ignore */
    }
  }
  if (windLayer) {
    try {
      windLayer.remove();
    } catch {
      /* ignore */
    }
  }
  hailLayer = window.L.layerGroup();
  windLayer = window.L.layerGroup();
  if (!map.getPane("hailSpotters")) {
    map.createPane("hailSpotters");
    map.getPane("hailSpotters").style.zIndex = 650;
  }

  const day = selectedStormDate;
  const nearHail = hailNearPin(hailRows || [], null);
  const collapsed = collapseHailByDate(nearHail);
  const daySet = new Set(collapsed.map((h) => h.date));
  if (selectedStormDate && !daySet.has(selectedStormDate)) {
    selectedStormDate = null;
  }
  if (!selectedStormDate && collapsed.length && !requireDate) {
    selectedStormDate = [...collapsed].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.date || null;
  }
  const activeDay = selectedStormDate;
  if (requireDate && !activeDay) {
    syncHazardLayers();
    return;
  }
  const zones = collapsed
    .filter((h) => !activeDay || h.date === activeDay)
    .sort((a, b) => (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0))
    .slice(0, 36);

  const fitPts = [];
  for (const h of zones) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
    const dayHits = hailNearPin(hailRows || [], h.date);
    const subRings = buildDetailedZoneRings(h, dayHits.length ? dayHits : nearHail);
    for (const sub of subRings) {
      const sz = sub.maxSize || parseFloat(h.size_in);
      const col = hailZoneColor(sz);
      const isConfirm = sub.confirmed || sub.source === "spot+radar";
      fitPts.push(...sub.ring);
      window.L.polygon(sub.ring, {
        color: col.stroke,
        fillColor: col.fill,
        fillOpacity: isConfirm ? (sz >= 2 ? 0.26 : 0.18) : sz >= 2 ? 0.16 : sz >= 1 ? 0.11 : 0.07,
        weight: isConfirm ? (sz >= 2 ? 2.6 : 2) : sz >= 2 ? 2 : 1.2,
        opacity: 0.92,
        dashArray: isConfirm ? null : sz >= 1 ? "4 4" : "6 5",
        className: isConfirm ? "wx-hail-topo wx-hail-confirmed" : "wx-hail-topo",
      })
        .bindPopup(
          hailPopupHtml(
            { ...h, hits: sub.hits || h.hits, size_in: String(sub.maxSize || h.size_in) },
            activeDay,
          ),
        )
        .addTo(hailLayer);
      if (sz >= 0.75 && isConfirm) {
        const cLat = sub.ring.reduce((a, c) => a + c[0], 0) / sub.ring.length;
        const cLon = sub.ring.reduce((a, c) => a + c[1], 0) / sub.ring.length;
        const coreR = Math.max(280, hailFootprintM(sz, "noaa-spc") * 0.45);
        window.L.polygon(ringPolygon(cLat, cLon, coreR, 8), {
          color: col.core,
          fillColor: col.core,
          fillOpacity: 0.32,
          weight: 1.4,
          opacity: 0.9,
          dashArray: "3 4",
          className: "wx-hail-topo-core",
        }).addTo(hailLayer);
      }
    }
    const spots = dayHits.filter(isSpotterHail);
    const radar = dayHits.filter((p) => !isSpotterHail(p));
    const toDraw = [...radar.slice(0, 24), ...spots.slice(0, 48)];
    for (const p of toDraw) {
      const isSpot = isSpotterHail(p);
      window.L.circleMarker([p.lat, p.lon], {
        radius: isSpot ? 8 : 4,
        color: isSpot ? "#ffffff" : "#7dff5a",
        fillColor: isSpot ? "#ff2d2d" : "#3f8f32",
        fillOpacity: isSpot ? 0.95 : 0.85,
        weight: isSpot ? 2 : 1.2,
        pane: isSpot ? "hailSpotters" : "overlayPane",
        className: isSpot ? "wx-hail-spot" : "wx-hail-radar-pt",
      })
        .bindPopup(
          `<b>${isSpot ? "SPOTTER" : "RADAR"}</b> · ${p.date}${p.time ? ` ${p.time}` : ""}<br><b>${p.size_in}"</b> · ${p.location || ""}${p.distance_km != null ? `<br>${p.distance_km} km from pin` : ""}`,
        )
        .addTo(hailLayer);
    }
  }

  const nearWind = windNearPin(windRows || [], activeDay || null);
  const windDays = new Map();
  for (const w of nearWind) {
    const wday = String(w.date || "").slice(0, 10);
    if (!wday) continue;
    if (activeDay && wday !== activeDay) continue;
    const mph = Number(w.wind_mph) || 0;
    const prev = windDays.get(wday);
    if (!prev || mph > (Number(prev.wind_mph) || 0)) windDays.set(wday, w);
  }
  for (const w of [...windDays.values()].slice(0, 24)) {
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) continue;
    const mph = Number(w.wind_mph) || 0;
    window.L.polygon(ringPolygon(w.lat, w.lon, Math.max(1200, Math.min(9000, mph * 75)), 6), {
      color: "#4a9eff",
      fillColor: "#4a9eff",
      fillOpacity: 0.1,
      weight: 1.4,
      opacity: 0.65,
      dashArray: "5 6",
      className: "wx-wind-topo",
    })
      .bindPopup(`${w.date} · ${mph} mph wind<br>${w.location || ""}, ${w.state || ""}<br>${w.distance_km != null ? `${w.distance_km} km from pin` : ""}`)
      .addTo(windLayer);
  }
  syncHazardLayers();
  if (opts.fit && map) {
    const pts = [];
    if (Number.isFinite(pinLat) && Number.isFinite(pinLon)) pts.push([pinLat, pinLon]);
    for (const h of nearHail.filter((p) => !activeDay || String(p.date || "").slice(0, 10) === activeDay)) {
      if (Number.isFinite(h.lat) && Number.isFinite(h.lon)) pts.push([h.lat, h.lon]);
    }
    try {
      if (pts.length >= 1) {
        const bounds = window.L.latLngBounds(pts);
        if (bounds.isValid()) {
          map.fitBounds(bounds.pad(pts.length === 1 ? 0.08 : 0.35), { maxZoom: 14, animate: true });
          return;
        }
      }
      if (fitPts.length) {
        const bounds = window.L.latLngBounds(fitPts);
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.3), { maxZoom: 12, animate: true });
      }
    } catch {
      /* ignore */
    }
  }
}

function syncHazardLayers() {
  if (!map) return;
  const showHail = wxTimelineFilters.hail;
  const showWind = wxTimelineFilters.wind;
  try {
    if (hailLayer) {
      if (showHail) hailLayer.addTo(map);
      else map.removeLayer(hailLayer);
    }
    if (windLayer) {
      if (showWind) windLayer.addTo(map);
      else map.removeLayer(windLayer);
    }
  } catch {
    /* ignore */
  }
}

function applyOverlays() {
  if (!map) return;
  for (const id of Object.keys(overlays)) {
    if (id === "radar") continue;
    let on = activeWxProduct === id || (id === "precip" && activeWxProduct === "precip");
    if (id === "precip") on = on && wxTimelineFilters.precip;
    if (id === "cloud" || id === "vis") on = (activeWxProduct === id || activeWxProduct === "cloud" || activeWxProduct === "vis") && wxTimelineFilters.precip;
    if (id === "wind") on = activeWxProduct === "wind" && wxTimelineFilters.wind;
    try {
      if (on) overlays[id].addTo(map);
      else map.removeLayer(overlays[id]);
    } catch {
      /* ignore */
    }
  }
  if (activeWxProduct === "wind") refreshWindField();
  else if (windFieldLayer) {
    try {
      map.removeLayer(windFieldLayer);
    } catch {
      /* ignore */
    }
  }
  syncHazardLayers();
}

async function refreshWindField() {
  if (!map || !window.L || activeWxProduct !== "wind") return;
  const c = map.getCenter();
  if (!c) return;
  try {
    const params = new URLSearchParams({
      latitude: c.lat,
      longitude: c.lng,
      current: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      hourly: "wind_speed_10m,wind_direction_10m",
      forecast_days: "1",
      wind_speed_unit: "mph",
      timezone: "auto",
    });
    const { body } = await httpGet(`https://api.open-meteo.com/v1/forecast?${params}`, 8000);
    const data = JSON.parse(body || "{}");
    const cur = data.current || {};
    const spd = Number(cur.wind_speed_10m) || 0;
    const gust = Number(cur.wind_gusts_10m) || spd;
    const dir = Number(cur.wind_direction_10m) || 0;
    if (windFieldLayer) {
      try {
        map.removeLayer(windFieldLayer);
      } catch {
        /* ignore */
      }
    }
    windFieldLayer = window.L.layerGroup();
    const color = gust >= 50 ? "#ff3a3a" : gust >= 35 ? "#d4a84b" : "#4a9eff";
    window.L.circle([c.lat, c.lng], {
      radius: Math.max(2500, Math.min(18000, gust * 220)),
      color,
      fillColor: color,
      fillOpacity: 0.15,
      weight: 2,
    })
      .bindPopup(`Wind ${Math.round(spd)} mph · gust ${Math.round(gust)} · from ${Math.round(dir)}°`)
      .addTo(windFieldLayer);
    window.L.circleMarker([c.lat, c.lng], {
      radius: Math.min(18, 5 + spd / 4),
      color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 1,
    }).addTo(windFieldLayer);
    if (activeWxProduct === "wind") windFieldLayer.addTo(map);
  } catch {
    /* wind field optional */
  }
}

export function destroyMap() {
  stopRadarPlay();
  stopHourPlay();
  if (map) {
    try {
      map.off();
      map.remove();
    } catch {
      /* ignore */
    }
    map = null;
  }
  pin = null;
  pinRadiusLayer = null;
  pinLat = null;
  pinLon = null;
  hailLayer = null;
  windLayer = null;
  windFieldLayer = null;
  lastHailRows = [];
  lastWindRows = [];
  selectedStormDate = null;
  hailSearchQ = "";
  layers = {};
  overlays = {};
  radarLayers = [null, null];
  radarActiveSlot = 0;
  radarPlaying = false;
  activeOverlays = new Set(["precip"]);
  activeWxProduct = "precip";
}

export function mountMap(container, config, { onTap, center, product, base } = {}) {
  if (!window.L) throw new Error("Leaflet not loaded");
  destroyMap();
  const c = center || config.center || { lat: 0, lon: 0 };
  const zoom = Math.abs(c.lat) < 1 && Math.abs(c.lon) < 1 ? 3 : 12;
  map = window.L.map(container, {
    zoomControl: true,
    preferCanvas: true,
    scrollWheelZoom: true,
    touchZoom: true,
    doubleClickZoom: false,
    maxZoom: MAP_MAX_ZOOM,
  }).setView([c.lat, c.lon], zoom);
  const all = config.layers || [];
  for (const layer of all) {
    if (layer.synthetic || !layer.url) continue;
    const isWx = layer.kind === "wx" || layer.kind === "overlay";
    const tile = window.L.tileLayer(layer.url, {
      attribution: layer.attribution || "",
      opacity: layer.opacity ?? 1,
      className: layer.className || "",
      maxZoom: MAP_MAX_ZOOM,
      maxNativeZoom: isWx ? layer.maxNativeZoom ?? RADAR_NATIVE_ZOOM : 19,
      tileSize: 256,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    });
    if (isWx) {
      overlays[layer.id] = tile;
      if (layer.id === "precip") overlays.radar = tile;
    } else layers[layer.id] = tile;
  }
  const prefer = base || (product === "hail" ? "dark" : null);
  const startId =
    (prefer && layers[prefer] && prefer) ||
    (layers[activeLayer] && activeLayer) ||
    (layers.dark && "dark") ||
    (layers.osm && "osm") ||
    (layers.sat && "sat") ||
    Object.keys(layers)[0];
  layers[startId]?.addTo(map);
  if (startId) activeLayer = startId;
  if (product === "hail") {
    activeWxProduct = "hail";
    activeOverlays = new Set(["hail"]);
  } else {
    activeWxProduct = overlays.precip ? "precip" : WX_PRODUCTS.find((id) => overlays[id]) || "precip";
    activeOverlays = new Set([activeWxProduct]);
  }
  applyOverlays();
  map.on("click", (e) => {
    if (wxSuppressMapTap) return;
    const { lat, lng } = e.latlng;
    setWxPin(lat, lng);
    if (pin) pin.setLatLng(e.latlng);
    else pin = window.L.marker(e.latlng).addTo(map);
    if (onTap) onTap(lat, lng);
  });
  map.on("moveend", () => {
    if (activeWxProduct === "wind") refreshWindField();
  });
  setTimeout(() => {
    try {
      map?.invalidateSize?.(true);
    } catch {
      /* ignore */
    }
  }, 80);
  if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) setWxPin(c.lat, c.lon);
  return map;
}

export function setMapLayer(id) {
  if (!map) return;
  if (id === "radar") id = "precip";
  if (id === "clouds") id = "cloud";
  if (WX_PRODUCTS.includes(id) || overlays[id] || id === "hail") {
    activeWxProduct = id;
    activeOverlays = new Set([id]);
    applyOverlays();
    // Hail product focuses the map on zones; redraw if we already have rows.
    if (id === "hail" && (lastHailRows.length || lastWindRows.length)) {
      drawHailMarkers(lastHailRows, lastWindRows);
    }
    return;
  }
  if (!layers[id]) return;
  Object.values(layers).forEach((l) => map.removeLayer(l));
  layers[id].addTo(map);
  applyOverlays();
  activeLayer = id;
}

export function flyToPin(lat, lon, zoom = 13) {
  if (!map || !window.L || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  setWxPin(lat, lon);
  map.setView([lat, lon], zoom);
  if (pin) pin.setLatLng([lat, lon]);
  else pin = window.L.marker([lat, lon]).addTo(map);
}

/** Double-tap map shell to expand / collapse — keeps address pin zoom separate from hail fit. */
export function bindWxMapExpand(shell) {
  if (!shell || shell.dataset.expandBound) return;
  shell.dataset.expandBound = "1";
  let lastTap = 0;
  let suppressClick = false;
  shell.addEventListener(
    "click",
    (e) => {
      if (e.target.closest(".leaflet-control, .hs-search, .hs-styles, input, select, textarea, button, a")) return;
      const now = Date.now();
      if (now - lastTap < 360) {
        e.stopPropagation();
        e.preventDefault();
        suppressClick = true;
        wxSuppressMapTap = true;
        const on = shell.classList.toggle("expanded");
        document.body.classList.toggle("wx-map-expanded", on);
        const hint = shell.querySelector(".wx-map-hint, .hs-map-hint");
        if (hint) hint.textContent = on ? "Double-tap to close" : "Double-tap to expand";
        setTimeout(() => {
          try {
            map?.invalidateSize?.(true);
          } catch {
            /* ignore */
          }
        }, 280);
        lastTap = 0;
        setTimeout(() => {
          suppressClick = false;
          wxSuppressMapTap = false;
        }, 400);
        return;
      }
      lastTap = now;
    },
    true,
  );
}

/** Forward geocode an address/place for WX search. */
export async function geocodeAddress(query) {
  const q = String(query || "").trim();
  if (q.length < 3) throw new Error("type a longer address");
  const looksStreet = /\d/.test(q) || /,/.test(q);
  const fromNominatim = async () => {
    const { body: nb } = await httpGet(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`,
      9000,
      { "User-Agent": "GroundControl/1.0 (joshuagwatts)" },
    );
    const hits = JSON.parse(nb || "[]");
    return hits.map((h) => ({
      lat: Number(h.lat),
      lon: Number(h.lon),
      address: h.display_name || q,
      city: String((h.address && (h.address.city || h.address.town || h.address.village)) || "").trim() || String(h.display_name || "").split(",")[0],
      source: "nominatim",
    }));
  };
  const fromMeteo = async () => {
    const { body } = await httpGet(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`,
      9000,
    );
    const results = JSON.parse(body || "{}").results || [];
    return results.map((h) => ({
      lat: Number(h.latitude),
      lon: Number(h.longitude),
      address: [h.name, h.admin1, h.country].filter(Boolean).join(", "),
      city: h.name || q,
      source: "open-meteo",
    }));
  };
  let hits = [];
  try {
    hits = looksStreet ? await fromNominatim() : await fromMeteo();
  } catch {
    hits = [];
  }
  if (!hits.length) {
    try {
      hits = looksStreet ? await fromMeteo() : await fromNominatim();
    } catch {
      hits = [];
    }
  }
  hits = hits.filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
  if (!hits.length) throw new Error("address not found");
  return hits;
}

function cutoffDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 180));
  return d.toISOString().slice(0, 10);
}

export function filterHailRaw(data, filters = wxFilters) {
  const since = cutoffDate(filters.days);
  const km = Number(filters.km) || 15;
  const hailMin = Number(filters.hailIn) || 0;
  const year = String(filters.year || "all");
  const pinLat = Number(data.lat ?? data._meta?.lat);
  const pinLon = Number(data.lon ?? data._meta?.lon);
  return (data.hail || []).filter((h) => {
    if (year !== "all") {
      if (!h.date || !String(h.date).startsWith(year)) return false;
    } else if (h.date && h.date < since) {
      return false;
    }
    let dist = h.distance_km;
    if (Number.isFinite(pinLat) && Number.isFinite(pinLon) && Number.isFinite(h.lat) && Number.isFinite(h.lon)) {
      dist = haversineKm(pinLat, pinLon, h.lat, h.lon);
    }
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) return false;
    if (dist != null && dist > km) return false;
    const sz = parseFloat(h.size_in);
    return Number.isNaN(sz) || sz >= hailMin;
  });
}

export function filterDossier(data, filters = wxFilters) {
  const since = cutoffDate(filters.days);
  const km = Number(filters.km) || 15;
  const windMin = Number(filters.windMph) || 0;
  const year = String(filters.year || "all");
  const sort = String(filters.sort || "date");
  let hailRaw = filterHailRaw(data, filters);
  // One extremeness tag per date (HailTrace-style).
  let hail = collapseHailByDate(hailRaw);
  if (sort === "size") {
    hail = [...hail].sort(
      (a, b) => (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0) || String(b.date).localeCompare(String(a.date)),
    );
  } else {
    hail = [...hail].sort(
      (a, b) => String(b.date).localeCompare(String(a.date)) || (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0),
    );
  }
  const windRaw = (data.wind || []).filter((w) => {
    if (year !== "all") {
      if (!w.date || !String(w.date).startsWith(year)) return false;
    } else if (w.date && w.date < since) {
      return false;
    }
    if (w.distance_km != null && w.distance_km > km) return false;
    return (Number(w.wind_mph) || 0) >= windMin;
  });
  // One wind max per date.
  const windByDay = new Map();
  for (const w of windRaw) {
    const day = String(w.date || "").slice(0, 10);
    const prev = windByDay.get(day);
    if (!prev || (Number(w.wind_mph) || 0) > (Number(prev.wind_mph) || 0)) windByDay.set(day, { ...w, date: day });
  }
  const wind = [...windByDay.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const archiveStorms = (data.storms || []).filter(
    (s) =>
      (s.source || "").includes("open-meteo") ||
      (s.reasons || []).some((r) => /precip|thunder|storm|Weather/i.test(r)),
  );
  let storms = enrichStormDates(archiveStorms, hailRaw, windRaw);
  storms = storms.filter((s) => {
    if (year !== "all") {
      if (!s.date || !String(s.date).startsWith(year)) return false;
    } else if (s.date && s.date < since) {
      return false;
    }
    if ((Number(s.wind_mph) || 0) < windMin && !(s.reasons || []).some((r) => /hail|thunder|EXTREME|SEVERE|STRONG|MOD/i.test(r))) {
      return (Number(s.wind_mph) || 0) >= windMin || (Number(s.precip_mm) || 0) >= 25;
    }
    return true;
  });
  if (sort === "size") {
    storms = [...storms].sort((a, b) => {
      const as = parseFloat(a.hail_in) || Number(a.wind_mph) || a.score || 0;
      const bs = parseFloat(b.hail_in) || Number(b.wind_mph) || b.score || 0;
      return bs - as || String(b.date).localeCompare(String(a.date));
    });
  }
  return { hail, wind, storms };
}

export function renderWeatherPanel(root, data, esc) {
  if (!root) return;
  const addr = data.address || "";
  const alert =
    data.weather && data.weather.severity && data.weather.severity.line
      ? `<div class="wx-alert ${esc(data.weather.severity.level || "")}">${esc(data.weather.severity.line)}</div>`
      : "";
  root.innerHTML = `
    <div class="wx-weather-panel">
      <div class="wx-addr">${esc(addr)}</div>
      <div id="wx-summary" class="wx-summary-host"></div>
      <div id="wx-daily"></div>
      <div id="wx-hourly" class="wx-hourly"></div>
      ${alert}
    </div>`;
  const lat = Number(data.lat || data._meta?.lat);
  const lon = Number(data.lon || data._meta?.lon);
  const { hail } = filterDossier(data, wxFilters);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    fetchWeatherBundle(lat, lon)
      .then((bundle) => paintLiveWeather(root, bundle, hail, esc))
      .catch(() => {});
  }
}

function roofDossierHtml(data, esc, onResearch) {
  const news = data.news || [];
  const addr = data.address || "";
  const zurl = data.zillow_url || (addr ? zillowUrl(addr) : "");
  const meta = data._meta || {};
  const { hail, wind, storms } = filterDossier(data, wxFilters);
  const years = [
    ...new Set((data.hail || []).map((h) => String(h.date || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y))),
  ].sort((a, b) => b.localeCompare(a));
  return `
    <details class="wx-roof-fold">
      <summary class="wx-roof-sum">ROOFING · ${hail.length ? `${hail.length} hail day(s)` : "hail trace"}${selectedStormDate ? ` · ${selectedStormDate}` : ""}</summary>
      <div class="wx-roof-body">
        <p class="muted wx-roof-blurb">Insurance-grade hail trace — tap a date to draw merged zones on the map above. Solid = spotter-confirmed · dashed = radar-only.</p>
        ${renderStormGraph(hail, esc, selectedStormDate)}
        <div class="wx-links">
          ${zurl ? `<a href="${esc(zurl)}" target="_blank" rel="noopener">ZILLOW SEARCH</a>` : ""}
          ${onResearch ? `<button type="button" id="wx-deep" class="primary">DEEP RESEARCH</button>` : ""}
        </div>
        <p class="muted wx-meta">${meta.deep ? `Deep scan · ${meta.fetchedDays || "?"}d · ${meta.fetchedKm || "?"} km` : "Quick scan · DEEP RESEARCH for full trace + news · Shingle ID → CHAT → LENS"}</p>
        <div class="wx-filters">
          <label>NEAR <select id="wx-f-km">
            <option value="8"${wxFilters.km == 8 ? " selected" : ""}>8 km</option>
            <option value="15"${wxFilters.km == 15 ? " selected" : ""}>15 km</option>
            <option value="25"${wxFilters.km == 25 ? " selected" : ""}>25 km</option>
            <option value="40"${wxFilters.km == 40 ? " selected" : ""}>40 km</option>
            <option value="50"${wxFilters.km == 50 ? " selected" : ""}>50 km</option>
          </select></label>
          <label>HAIL ≥ <select id="wx-f-hail">
            <option value="0"${wxFilters.hailIn == 0 ? " selected" : ""}>any</option>
            <option value="0.75"${wxFilters.hailIn == 0.75 ? " selected" : ""}>0.75"</option>
            <option value="1"${wxFilters.hailIn == 1 ? " selected" : ""}>1"</option>
            <option value="1.5"${wxFilters.hailIn == 1.5 ? " selected" : ""}>1.5"</option>
            <option value="2"${wxFilters.hailIn == 2 ? " selected" : ""}>2"</option>
          </select></label>
          <label>WIND ≥ <select id="wx-f-wind">
            <option value="0"${wxFilters.windMph == 0 ? " selected" : ""}>any</option>
            <option value="38"${wxFilters.windMph == 38 ? " selected" : ""}>38 mph</option>
            <option value="50"${wxFilters.windMph == 50 ? " selected" : ""}>50 mph</option>
            <option value="58"${wxFilters.windMph == 58 ? " selected" : ""}>58 mph</option>
          </select></label>
          <label>WINDOW <select id="wx-f-days">
            <option value="30"${wxFilters.days == 30 ? " selected" : ""}>30d</option>
            <option value="90"${wxFilters.days == 90 ? " selected" : ""}>90d</option>
            <option value="180"${wxFilters.days == 180 ? " selected" : ""}>180d</option>
            <option value="365"${wxFilters.days == 365 ? " selected" : ""}>1y</option>
          </select></label>
          <label>YEAR <select id="wx-f-year">
            <option value="all"${wxFilters.year === "all" || !wxFilters.year ? " selected" : ""}>all</option>
            ${years.map((y) => `<option value="${esc(y)}"${String(wxFilters.year) === y ? " selected" : ""}>${esc(y)}</option>`).join("")}
          </select></label>
          <label>SORT <select id="wx-f-sort">
            <option value="date"${wxFilters.sort !== "size" ? " selected" : ""}>chrono</option>
            <option value="size"${wxFilters.sort === "size" ? " selected" : ""}>extreme ★</option>
          </select></label>
        </div>
        <div class="wx-contacts">
          ${data.owner_name ? `<div>Owner: ${esc(data.owner_name)}</div>` : ""}
          ${data.owner_phone ? `<div>Phone: ${esc(data.owner_phone)}</div>` : ""}
          ${data.owner_email ? `<div>Email: ${esc(data.owner_email)}</div>` : ""}
        </div>
        <h4>HAIL TRACE · ${hail.length} DAYS${selectedStormDate ? ` · MAP ${esc(selectedStormDate)}` : ""}</h4>
        <div class="wx-hail-legend muted">Tap date → map zones · red dot = spotter · green = radar sig · ☆→★★★★★</div>
        <div class="wx-hail">${
          hail.length
            ? hail
                .slice(0, 36)
                .map((h) => {
                  const stars = h.stars || hailStars(h.size_in);
                  const sev = h.severity || hailSeverityLabel(h.size_in);
                  const src =
                    h.source === "mixed"
                      ? "ZONE"
                      : h.source === "noaa-swdi-radar"
                        ? "RADAR"
                        : h.source === "iem-lsr"
                          ? "LSR"
                          : "SPOT";
                  const on = selectedStormDate === h.date ? " on" : "";
                  return `<div class="wx-hail-row sev-${esc(String(sev).toLowerCase())}${on}" data-storm-date="${esc(h.date)}">
            <span class="stars">${esc(stars)}</span>
            <span class="date">${esc(h.date)}</span>
            <span class="size">${esc(h.size_in)}"</span>
            <span class="sev">${esc(sev)}</span>
            <span class="src">${esc(src)}</span>
            <span class="dist">${esc(String(h.distance_km ?? "—"))} km</span>
            <span class="loc">${esc(h.hits || 1)} sig${(h.hits || 1) === 1 ? "" : "s"}${h.zone_r_km ? ` · ~${esc(String(h.zone_r_km))}km` : ""}</span>
          </div>`;
                })
                .join("")
            : `<p class="muted">No hail days this close after filters. Widen NEAR, drop HAIL ≥, or change YEAR.</p>`
        }</div>
        <h4>WIND NEAR PIN</h4>
        <div class="wx-wind">${
          wind.length
            ? wind
                .slice(0, 12)
                .map(
                  (w) => `
          <div class="wx-hail-row"><span class="date">${esc(w.date)}</span>
          <span class="size">${esc(String(w.wind_mph))} mph</span>
          <span class="dist">${esc(String(w.distance_km))} km</span>
          ${esc(w.location)}, ${esc(w.state)}</div>`,
                )
                .join("")
            : `<p class="muted">No wind reports this close after filters.</p>`
        }</div>
        <h4>STORM DATES (THIS PIN)</h4>
        <div class="wx-storms">${
          storms.length
            ? storms
                .slice(0, 16)
                .map(
                  (s) => `
          <div class="wx-storm"><span class="date">${esc(s.date)}</span> <span class="score">${esc(String(s.hail_in ? `${s.hail_in}"` : s.wind_mph || s.score))}${s.hail_in ? "" : s.wind_mph ? " mph" : ""}</span> ${esc((s.reasons || []).join(" · ") || s.label)}</div>`,
                )
                .join("")
            : `<p class="muted">No storm days at this pin after filters.</p>`
        }</div>
        <h4>NEWS</h4>
        <div class="wx-news">${
          news.length
            ? news
                .slice(0, 8)
                .map((n) => `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>`)
                .join("")
            : `<p class="muted">News pulls on deep research.</p>`
        }</div>
      </div>
    </details>`;
}

function bindRoofDossier(root, data, esc, onResearch, onRefetch) {
  if (!root) return;
  const hailRaw = filterHailRaw(data, wxFilters);
  const { wind } = filterDossier(data, wxFilters);
  const meta = data._meta || {};
  const btn = root.querySelector("#wx-deep");
  if (btn && onResearch) btn.onclick = onResearch;
  const onStormPick = (date) => {
    selectStormDate(date, { fit: true });
    renderRoofDossier(root, data, esc, onResearch, onRefetch);
  };
  bindStormGraph(root, onStormPick);
  root.querySelectorAll(".wx-hail-row[data-storm-date]").forEach((row) => {
    row.onclick = () => onStormPick(row.getAttribute("data-storm-date"));
  });
  const bind = (id, key, cast) => {
    const el = root.querySelector(id);
    if (!el) return;
    el.onchange = async () => {
      wxFilters[key] = cast(el.value);
      if (key === "km") drawPinRadius();
      const needRefetch =
        onRefetch &&
        ((key === "days" && Number(wxFilters.days) > (meta.fetchedDays || 0)) ||
          (key === "km" && Number(wxFilters.km) > (meta.fetchedKm || 0)));
      if (needRefetch) {
        const metaEl = root.querySelector(".wx-meta");
        if (metaEl) metaEl.textContent = "Refetching storm data…";
        try {
          const fresh = await onRefetch({ ...wxFilters });
          if (fresh) {
            renderWxPanels(fresh, esc, onResearch, onRefetch);
            const f = filterDossier(fresh, wxFilters);
            drawHailMarkers(filterHailRaw(fresh, wxFilters), f.wind, { fit: false });
            return;
          }
        } catch {
          /* fall through */
        }
      }
      renderRoofDossier(root, data, esc, onResearch, onRefetch);
      const f = filterDossier(data, wxFilters);
      drawHailMarkers(filterHailRaw(data, wxFilters), f.wind, { fit: false });
    };
  };
  bind("#wx-f-km", "km", Number);
  bind("#wx-f-hail", "hailIn", Number);
  bind("#wx-f-wind", "windMph", Number);
  bind("#wx-f-days", "days", Number);
  bind("#wx-f-year", "year", String);
  bind("#wx-f-sort", "sort", String);
}

export function renderRoofDossier(root, data, esc, onResearch, onRefetch) {
  if (!root) return;
  const { hail } = filterDossier(data, wxFilters);
  if (selectedStormDate && !hail.some((h) => h.date === selectedStormDate)) {
    selectedStormDate = null;
  }
  if (!selectedStormDate && hail.length) {
    selectedStormDate = hail[0]?.date || null;
  }
  root.innerHTML = roofDossierHtml(data, esc, onResearch);
  bindRoofDossier(root, data, esc, onResearch, onRefetch);
}

export function renderWxPanels(data, esc, onResearch, onRefetch) {
  renderWeatherPanel(document.getElementById("wx-panel"), data, esc);
  renderRoofDossier(document.getElementById("wx-roof-panel"), data, esc, onResearch, onRefetch);
}

/** @deprecated use renderWxPanels */
export function renderDossier(root, data, esc, onResearch, onRefetch) {
  renderWxPanels(data, esc, onResearch, onRefetch);
}

export function prettyStormDate(iso) {
  const s = String(iso || "").slice(0, 10);
  const d = new Date(`${s}T12:00:00`);
  if (Number.isNaN(d.getTime())) return s || "Unknown date";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function hailSourceLabel(h) {
  if (h.source === "mixed" || h.source === "spot+radar") return "Spotter + radar";
  if (h.source === "noaa-swdi-radar") return "Radar";
  if (h.source === "iem-lsr") return "Local storm report";
  return "Spotter";
}

function hailDayMatchesQuery(h, q) {
  if (!q) return true;
  const hay = [
    h.date,
    prettyStormDate(h.date),
    h.size_in,
    h.severity || hailSeverityLabel(h.size_in),
    hailSourceLabel(h),
    h.location,
    h.state,
    h.hits,
    h.distance_km,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export function hailScopeDays(data, filters = wxFilters, q = hailSearchQ) {
  const { hail } = filterDossier(data, filters);
  return hail.filter((h) => hailDayMatchesQuery(h, q));
}

function hailScopeHtml(data, days, esc) {
  const addr = data.address || "Dropped pin";
  const years = [
    ...new Set((data.hail || []).map((h) => String(h.date || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y))),
  ].sort((a, b) => b.localeCompare(a));
  const q = hailSearchQ;
  return `
    <p class="hs-pin"><strong>${esc(addr)}</strong>${
      selectedStormDate
        ? `Showing zones for ${esc(prettyStormDate(selectedStormDate))}`
        : "Tap a storm date to draw hail zones"
    }</p>
    <p class="hs-legend"><span class="hs-dot hs-dot-spot"></span>Spotter report <span class="hs-dot hs-dot-radar"></span>Radar only</p>
    <div class="hs-filters">
      <input type="search" id="hs-q" placeholder="Search dates, size, place…" value="${esc(q)}" />
      <select id="hs-f-km" aria-label="Radius">
        <option value="8"${wxFilters.km == 8 ? " selected" : ""}>8 km</option>
        <option value="15"${wxFilters.km == 15 ? " selected" : ""}>15 km</option>
        <option value="25"${wxFilters.km == 25 ? " selected" : ""}>25 km</option>
        <option value="40"${wxFilters.km == 40 ? " selected" : ""}>40 km</option>
        <option value="50"${wxFilters.km == 50 ? " selected" : ""}>50 km</option>
      </select>
      <select id="hs-f-hail" aria-label="Hail size">
        <option value="0"${wxFilters.hailIn == 0 ? " selected" : ""}>Any size</option>
        <option value="0.75"${wxFilters.hailIn == 0.75 ? " selected" : ""}>0.75″+</option>
        <option value="1"${wxFilters.hailIn == 1 ? " selected" : ""}>1″+</option>
        <option value="1.5"${wxFilters.hailIn == 1.5 ? " selected" : ""}>1.5″+</option>
        <option value="2"${wxFilters.hailIn == 2 ? " selected" : ""}>2″+</option>
      </select>
      <select id="hs-f-days" aria-label="Time window">
        <option value="30"${wxFilters.days == 30 ? " selected" : ""}>30 days</option>
        <option value="90"${wxFilters.days == 90 ? " selected" : ""}>90 days</option>
        <option value="180"${wxFilters.days == 180 ? " selected" : ""}>6 months</option>
        <option value="365"${wxFilters.days == 365 ? " selected" : ""}>1 year</option>
      </select>
      <select id="hs-f-year" aria-label="Year">
        <option value="all"${wxFilters.year === "all" || !wxFilters.year ? " selected" : ""}>All years</option>
        ${years.map((y) => `<option value="${esc(y)}"${String(wxFilters.year) === y ? " selected" : ""}>${esc(y)}</option>`).join("")}
      </select>
      <select id="hs-f-sort" aria-label="Sort">
        <option value="date"${wxFilters.sort !== "size" ? " selected" : ""}>Newest</option>
        <option value="size"${wxFilters.sort === "size" ? " selected" : ""}>Largest hail</option>
      </select>
    </div>
    <div class="hs-dates">${hailScopeDateRows(days, esc)}</div>`;
}

function bindHailScopeDates(root, data, esc, { onRefetch } = {}) {
  root.querySelectorAll(".hs-date[data-storm-date]").forEach((row) => {
    row.onclick = () => {
      const date = row.getAttribute("data-storm-date");
      if (selectedStormDate === date) selectStormDate(null, { fit: false, requireDate: true });
      else selectStormDate(date, { fit: false, requireDate: true });
      const pin = root.querySelector(".hs-pin");
      if (pin) {
        const addr = data.address || "Dropped pin";
        pin.innerHTML = `<strong>${esc(addr)}</strong>${
          selectedStormDate
            ? `Showing zones for ${esc(prettyStormDate(selectedStormDate))}`
            : "Tap a storm date to draw hail zones"
        }`;
      }
      const box = root.querySelector(".hs-dates");
      if (box) {
        box.innerHTML = hailScopeDateRows(hailScopeDays(data), esc);
        bindHailScopeDates(root, data, esc, { onRefetch });
      }
    };
  });
}

function hailScopeDateRows(days, esc) {
  if (!days.length) {
    return `<p class="hs-empty">${hailSearchQ ? "No storms match that search." : "No storms in this window. Widen the radius, drop the hail size, or tap another place."}</p>`;
  }
  return days
    .slice(0, 80)
    .map((h) => {
      const on = selectedStormDate === h.date ? " on" : "";
      const sev = (h.severity || hailSeverityLabel(h.size_in) || "").toLowerCase();
      const src = hailSourceLabel(h);
      return `<button type="button" class="hs-date${on}" data-storm-date="${esc(h.date)}">
                <span class="when">${esc(prettyStormDate(h.date))}</span>
                <span class="size">${esc(h.size_in)}″</span>
                <span class="meta">${esc(sev)} · ${esc(src)} · ${esc(String(h.hits || 1))} hit${(h.hits || 1) === 1 ? "" : "s"} · ${esc(String(h.distance_km ?? "—"))} km</span>
              </button>`;
    })
    .join("");
}

function bindHailScopeSheet(root, data, esc, { onRefetch } = {}) {
  if (!root) return;
  const meta = data._meta || {};
  const qEl = root.querySelector("#hs-q");
  if (qEl) {
    qEl.oninput = () => {
      hailSearchQ = String(qEl.value || "").trim().toLowerCase();
      const box = root.querySelector(".hs-dates");
      if (box) {
        box.innerHTML = hailScopeDateRows(hailScopeDays(data), esc);
        bindHailScopeDates(root, data, esc, { onRefetch });
      }
    };
  }
  bindHailScopeDates(root, data, esc, { onRefetch });
  const bind = (id, key, cast) => {
    const el = root.querySelector(id);
    if (!el) return;
    el.onchange = async () => {
      wxFilters[key] = cast(el.value);
      if (key === "km") drawPinRadius();
      const needRefetch =
        onRefetch &&
        ((key === "days" && Number(wxFilters.days) > (meta.fetchedDays || 0)) ||
          (key === "km" && Number(wxFilters.km) > (meta.fetchedKm || 0)));
      if (needRefetch) {
        try {
          const fresh = await onRefetch({ ...wxFilters });
          if (fresh) {
            renderHailScopeSheet(root, fresh, esc, { onRefetch });
            drawHailMarkers(filterHailRaw(fresh, wxFilters), [], { requireDate: true });
            return;
          }
        } catch {
          /* fall through */
        }
      }
      renderHailScopeSheet(root, data, esc, { onRefetch });
      drawHailMarkers(filterHailRaw(data, wxFilters), [], { requireDate: true });
    };
  };
  bind("#hs-f-km", "km", Number);
  bind("#hs-f-hail", "hailIn", Number);
  bind("#hs-f-days", "days", Number);
  bind("#hs-f-year", "year", String);
  bind("#hs-f-sort", "sort", String);
}

export function renderHailScopeSheet(root, data, esc, { onRefetch } = {}) {
  if (!root) return;
  const days = hailScopeDays(data);
  if (selectedStormDate && !days.some((h) => h.date === selectedStormDate)) {
    selectedStormDate = null;
    drawHailMarkers(filterHailRaw(data, wxFilters), [], { requireDate: true });
  }
  root.innerHTML = hailScopeHtml(data, days, esc);
  bindHailScopeSheet(root, data, esc, { onRefetch });
}

export function baseLayerButtons(config, esc) {
  const bases = (config.layers || []).filter((l) => l.kind !== "overlay" && l.kind !== "wx");
  return bases
    .map(
      (l) =>
        `<button type="button" data-layer="${esc(l.id)}" class="${l.id === activeLayer ? "on" : ""}">${esc(l.label)}</button>`,
    )
    .join("");
}

export function layerButtons(config, esc) {
  const bases = (config.layers || []).filter((l) => l.kind !== "overlay" && l.kind !== "wx");
  const wx = (config.layers || []).filter((l) => l.kind === "wx" || l.kind === "overlay");
  const baseBtns = (bases.length ? bases : [])
    .map((l) => `<button type="button" data-layer="${esc(l.id)}" class="${l.id === activeLayer ? "on" : ""}">${esc(l.label)}</button>`)
    .join("");
  const wxBtns = wx
    .map((l) => {
      const id = l.id === "radar" ? "precip" : l.id === "clouds" ? "cloud" : l.id;
      const on = activeWxProduct === id;
      const label = id === "precip" ? "NOW" : l.label;
      return `<button type="button" data-layer="${esc(id)}" class="wx-product ${on ? "on" : ""}">${esc(label)}</button>`;
    })
    .join("");
  const row = wxBtns ? `${baseBtns}<span class="wx-split"></span>${wxBtns}` : baseBtns;
  return row;
}

export async function fetchLiveWeather(lat, lon) {
  const wx = await currentWeather(lat, lon);
  let alerts = [];
  try {
    const { body } = await httpGet(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, 6000, {
      "User-Agent": "GroundControl/1.0 (joshuagwatts)",
      Accept: "application/geo+json",
    });
    const data = JSON.parse(body || "{}");
    alerts = (data.features || []).slice(0, 8).map((f) => {
      const p = f.properties || {};
      return { id: p.id || f.id || p.event, event: p.event || "", severity: p.severity || "", headline: String(p.headline || p.event || "").slice(0, 220) };
    });
  } catch {
    alerts = [];
  }
  const code = wx.code || 0;
  const gust = wx.gust_mph || wx.wind_mph || 0;
  const warning = alerts.some((a) => /warning/i.test(a.event) || /extreme|severe/i.test(a.severity));
  const crummy = warning || [82, 95, 96, 99, 65].includes(code) || gust >= 50;
  let level = "ok";
  let line = "";
  if (warning || code === 96 || code === 99) {
    level = "severe";
    line = "Weather is getting seriously crummy. Stay in or get cover.";
  } else if (alerts.some((a) => /watch/i.test(a.event)) || code === 95 || gust >= 45) {
    level = "watch";
    line = "Storms nearby. Keep an eye on it.";
  } else if (crummy) {
    level = "rough";
    line = "It's turning ugly out. Plan around it.";
  }
  return { ...wx, alerts, severity: { level, crummy, line, warning } };
}

export function startWeatherWatch(getCenter, onAlert, everyMs = 8 * 60 * 1000) {
  let lastId = "";
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const c = await getCenter();
      if (stopped || !c?.lat) return;
      const live = await fetchLiveWeather(c.lat, c.lon);
      if (stopped || !live.severity?.crummy) return;
      const id = (live.alerts[0] && live.alerts[0].id) || `${live.severity.level}:${live.label}`;
      if (id === lastId) return;
      lastId = id;
      onAlert(live);
    } catch {
      /* keep watching while WX tab is open */
    }
  };
  // Defer first tick so map paint isn't competing with weather fetches.
  const kick = setTimeout(tick, 2500);
  const iv = setInterval(tick, everyMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(kick);
      clearInterval(iv);
    },
  };
}
