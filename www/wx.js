/** WX map + storm dossier — runs on phone (public APIs). */
import { httpGet, httpLanGet, httpLanPostJson, openUrl } from "./net.js";
import { locateDevice, watchGps } from "./geo.js";
import {
  lookupPlaceContacts,
  formatPhone,
  phoneDigits,
  mergeContacts,
  listingForPin,
  parseStreetAddress,
  resolveZillowUrl,
  isUsableZillowUrl,
  fillContactGapsWithChat,
} from "./contacts.js";
import { geocodeCandidates, geoCacheOk } from "./geocode.js";
import { lookupAssessorParcel } from "./assessor.js";
import { kindMeta, validMarkCoord, markBadge, markTint, clampPinScale } from "./marks.js";

let map = null;
let pin = null;
let hailLayer = null;
let layers = {};
let activeLayer = "sat";

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

export const DEFAULT_FILTERS = {
  km: 10,
  hailIn: 0.75,
  windMph: 38,
  days: 730,
  year: "all",
  sort: "date",
  stormSize: "any",
};
/** First paint radius — center-out so OKC lists land in ~1 request. */
export const PIN_FETCH_FAST_KM = 40;
/** Background widen after first paint (regional storm footprint). */
export const PIN_FETCH_WIDE_KM = 120;
/** @deprecated use PIN_FETCH_FAST_KM / PIN_FETCH_WIDE_KM */
export const PIN_FETCH_MIN_KM = PIN_FETCH_FAST_KM;
/** Hail that can count for this roof (~1 mi). Bigger reports farther out are context, not the claim size. */
export const HOUSE_HAIL_KM = 1.6;
/** Draw filled zones only this close to the pin. Dots still show the rest of the radius. */
export const HOUSE_ZONE_KM = 2.5;
/** Cap is soft guidance only — user can overlay as many storm dates as they want. */
export const MAX_STORM_DATES = 500;
const HAIL_IN_CHOICES = [0, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
let wxFilters = { ...DEFAULT_FILTERS };
const RADIUS_KM = [5, 10, 16, 25, 40, 50];
let wxUnits = "imperial";

export function setWxUnits(units) {
  wxUnits = String(units || "").toLowerCase() === "metric" ? "metric" : "imperial";
}

export function getWxUnits() {
  return wxUnits;
}

function filterKm(filters = wxFilters) {
  const n = Number(filters.km);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FILTERS.km;
}

export function dossierFetchKm(filters = wxFilters) {
  return Math.max(filterKm(filters), PIN_FETCH_FAST_KM);
}

export function dossierWideKm(filters = wxFilters) {
  return Math.max(filterKm(filters), PIN_FETCH_WIDE_KM);
}

function kmToMi(km) {
  return Number(km) * 0.621371;
}

export function formatDistance(km) {
  const n = Number(km);
  if (!Number.isFinite(n)) return "—";
  if (wxUnits === "metric") {
    const s = Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1);
    return `${s} km`;
  }
  const mi = kmToMi(n);
  const s = Math.abs(mi) >= 10 ? mi.toFixed(0) : mi.toFixed(1);
  return `${s} mi`;
}

function radiusLabel(km) {
  if (wxUnits === "metric") return `${km} km`;
  return `${Math.round(kmToMi(km))} mi`;
}

function radiusOptionHtml() {
  const cur = filterKm();
  const vals = RADIUS_KM.includes(cur) ? RADIUS_KM : [cur, ...RADIUS_KM].sort((a, b) => a - b);
  return vals.map((km) => `<option value="${km}"${Number(km) === Number(cur) ? " selected" : ""}>${radiusLabel(km)}</option>`).join("");
}
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
/** ISO dates (YYYY-MM-DD) selected for map overlay — multi-check allowed. */
let selectedStormDates = new Set();
/** HailScope: never auto-pick a storm date; zones wait for a tap. */
let hailScopeMode = false;

function stormDateKey(date) {
  const k = String(date || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : "";
}

function hasSelectedStormDates() {
  return selectedStormDates.size > 0;
}

function isStormDateSelected(date) {
  const k = stormDateKey(date);
  return Boolean(k && selectedStormDates.has(k));
}

function selectedStormDateList() {
  return [...selectedStormDates].sort((a, b) => b.localeCompare(a));
}

function selectedStormDateSig() {
  return selectedStormDateList().join(",");
}

function clearStormDateSelection() {
  selectedStormDates.clear();
}

function pruneStormDateSelection(validDates) {
  // Sticky selection: once the user checks storm dates, only they can uncheck.
  if (hasSelectedStormDates()) return;
  const ok = validDates instanceof Set ? validDates : new Set(validDates || []);
  for (const d of [...selectedStormDates]) {
    if (!ok.has(d)) selectedStormDates.delete(d);
  }
}

function setStormDateSelection(dates, { replace = true } = {}) {
  const next = (Array.isArray(dates) ? dates : [dates]).map(stormDateKey).filter(Boolean);
  if (replace) selectedStormDates.clear();
  for (const d of next) selectedStormDates.add(d);
}

function toggleStormDateSelection(date) {
  const k = stormDateKey(date);
  if (!k) return;
  if (selectedStormDates.has(k)) {
    selectedStormDates.delete(k);
    return;
  }
  selectedStormDates.add(k);
}

function hailInOptionHtml(cur = wxFilters.hailIn, { short = false } = {}) {
  return HAIL_IN_CHOICES.map((v) => {
    const label = v === 0 ? (short ? "any" : "Any size") : short ? `${v}"` : `${v}″+`;
    const sel = Number(cur) === Number(v) ? " selected" : "";
    return `<option value="${v}"${sel}>${label}</option>`;
  }).join("");
}

/** Bounding-box diagonal of a day's hits — proxy for storm footprint. */
function footprintSpanKm(pts) {
  if (!pts || pts.length < 2) return 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  if (!Number.isFinite(minLat) || minLat === maxLat && minLon === maxLon) return 0;
  return haversineKm(minLat, minLon, maxLat, maxLon);
}

export function stormPassesSizeFilter(h, filters = wxFilters) {
  const mode = String(filters.stormSize || "any");
  if (mode === "any" || !mode) return true;
  const hits = Number(h.hits) || 0;
  const spanMi = kmToMi(Number(h.span_km) || 0);
  if (mode === "small" || mode === "busy") return hits >= 12;
  if (mode === "medium" || mode === "wide") return spanMi >= 15 || hits >= 25;
  if (mode === "large" || mode === "huge") return hits >= 40 || spanMi >= 30;
  if (mode === "giant" || mode === "epic") return hits >= 80 || spanMi >= 50;
  return true;
}

function selectedStormsPinText(esc) {
  const list = selectedStormDateList();
  if (!list.length) return "";
  if (list.length === 1) return `Showing zones for ${esc(prettyStormDate(list[0]))}`;
  if (list.length <= 3) return `Overlay ${list.map((d) => esc(prettyStormDate(d))).join(" · ")}`;
  return `Overlay ${list.length} storm days — tap to toggle`;
}
let hailSearchQ = "";
let meMarker = null;
let meRing = null;
let meStop = null;
let lastMe = null;
let locateBtnEl = null;
let showMyLocation = true;
let houseLayer = null;
let houseTimer = 0;
let houseGen = 0;
let houseCache = { key: "", rings: [], nums: [] };
let housePaintSig = "";
let houseHoldUntil = 0;
let markLayer = null;
let doneLayer = null;
let fieldOverlay = { marks: [], done: [], showMarks: true, showDone: true, showHailDots: true, onMark: null, onDone: null };
const livePinMarkers = { marks: new Map(), done: new Map() };

export function setHailScopeMode(on) {
  hailScopeMode = Boolean(on);
  if (!hailScopeMode) hailSearchQ = "";
}
/** HailScope live radar — separate from pip wx timeline filters. */
let hailScopeRadarOn = true;
export const hailScopeRadarFilters = { precip: true, wind: false };

function hailScopeRadarActive() {
  return hailScopeMode && hailScopeRadarOn !== false;
}

function wantPrecipRadarTiles() {
  if (hailScopeRadarActive() && hailScopeRadarFilters.precip) return true;
  return (
    wxTimelineFilters.precip &&
    (activeWxProduct === "precip" || activeOverlays.has("precip") || activeOverlays.has("radar"))
  );
}
let radarFrames = [];
let radarFrameIdx = 0;
let radarPlayRaf = null;
let radarPlaying = false;
let hourPlayTimer = null;
/** Dual-buffer radar tiles — crossfade instead of black flash between frames. */
let radarLayers = [null, null];
let radarActiveSlot = 0;
/** Open-Meteo hourly wind frames for the HailScope wind scrubber. */
let windFrames = [];
let windFrameIdx = 0;
let windPlayTimer = 0;
let windPlaying = false;
let windFetchGen = 0;
/** Shared HailScope live playhead (precip + wind on one scrubber). */
let liveTlIdx = 0;
/** Amber wind noise field — distinct from precip greens/blues. */
const WIND_FIELD_COLOR = "#ff9f1a";
const windNoise = {
  canvas: null,
  ctx: null,
  particles: [],
  frame: null,
  raf: 0,
  lastTs: 0,
  bound: false,
  reseedTimer: 0,
};
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

function pickZillowUrl(data = {}) {
  return resolveZillowUrl(data.address || "", data.zillow_url || "");
}

function bindPlaceLinks(root) {
  if (!root) return;
  root.querySelectorAll("a.hs-zillow, a.hs-assessor").forEach((a) => {
    if (a.dataset.placeBound) return;
    a.dataset.placeBound = "1";
    a.addEventListener("click", async (e) => {
      const href = a.getAttribute("href");
      if (!href || !/^https?:/i.test(href)) return;
      const cap = window.Capacitor;
      const inApp = Boolean(cap?.Plugins?.Browser || cap?.Plugins?.App?.openUrl);
      if (!inApp) return;
      e.preventDefault();
      try {
        await openUrl(href);
      } catch {
        window.open(href, "_blank", "noopener,noreferrer");
      }
    });
  });
}

function ownerFields(people = {}, assessor = null) {
  return {
    owner_name: (assessor && assessor.name) || people.name || people.owner_name || "",
    owner_phone: people.phone || people.owner_phone || "",
    owner_email: people.email || people.owner_email || "",
    owner_mail: (assessor && assessor.mail) || "",
    assessor_url: (assessor && assessor.url) || "",
    assessor_source: (assessor && assessor.source) || "",
    homestead: Boolean(assessor && assessor.homestead),
    facebook_url: people.facebook || people.facebook_url || "",
    instagram_url: people.instagram || people.instagram_url || "",
    zillow_url: people.zillow_url || "",
  };
}

function placeContactHtml(data, esc) {
  const addr = data.address || "";
  const zurl = pickZillowUrl(data);
  const phone = formatPhone(data.owner_phone || "");
  const email = String(data.owner_email || "").trim();
  const name = String(data.owner_name || "").trim();
  const homestead = Boolean(data.homestead);
  const e164 = phoneDigits(phone);
  const assessorUrl = String(data.assessor_url || "").trim();
  const bits = [];
  if (zurl) bits.push(`<a class="hs-zillow" href="${zurl}" target="_blank" rel="noopener noreferrer">Zillow</a>`);
  if (assessorUrl) {
    const lab = data.assessor_source ? `${esc(data.assessor_source)} assessor` : "Assessor";
    bits.push(`<a class="hs-assessor" href="${esc(assessorUrl)}" target="_blank" rel="noopener noreferrer">${lab}</a>`);
  }
  if (e164) {
    bits.push(`<a class="hs-tel" href="tel:${esc(e164)}">${esc(phone)}</a>`);
    bits.push(`<a class="hs-sms" href="sms:${esc(e164)}">Text</a>`);
  }
  if (email) bits.push(`<a class="hs-mail" href="mailto:${esc(email)}">${esc(email)}</a>`);
  // Mailing address omitted — street address is already shown above the contacts row.
  if (homestead) bits.push(`<span class="hs-homestead" title="Homestead exemption on file">Homestead</span>`);
  const miss = !name && !e164 && !email ? `<span class="hs-place-miss">No owner, phone, or email for this house yet</span>` : "";
  return `<div class="hs-place">${name ? `<span class="hs-who">${esc(name)}</span>` : ""}${bits.join("")}${miss}</div>`;
}

async function mergePlaceOwner(settings, lat, lon, addr, geo, base = {}) {
  const [contacts, assessor] = await Promise.all([
    lookupPlaceContacts(lat, lon, addr, geo, settings).catch(() => ({})),
    lookupAssessorParcel(lat, lon, addr).catch(() => null),
  ]);
  let people = mergeContacts(listingForPin(geo, addr), contacts);
  let fields = ownerFields(people, assessor);
  let dossier = {
    ...base,
    ...fields,
    zillow_url: pickZillowUrl({ address: addr, zillow_url: people.zillow_url || fields.zillow_url }),
  };
  // Chat APIs extract missing phone/email/name from public listing + assessor pages only
  if (settings && (!fields.owner_phone || !fields.owner_email || !fields.owner_name)) {
    const ai = await fillContactGapsWithChat(settings, {
      address: addr,
      assessor,
      contacts: { ...people, ...contacts, _public_text: contacts._public_text },
      publicText: contacts._public_text || "",
    }).catch(() => null);
    if (ai) {
      people = mergeContacts(people, ai);
      fields = ownerFields(people, assessor);
      dossier = {
        ...dossier,
        ...fields,
        zillow_url: pickZillowUrl({ address: addr, zillow_url: people.zillow_url || fields.zillow_url }),
      };
    }
  }
  return dossier;
}

async function api() {
  return null;
}

async function reverseNominatim(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&extratags=1&namedetails=1&zoom=18`;
  try {
    const { body } = await httpGet(url, 9000, {
      "Accept-Language": "en",
      "User-Agent": "GroundControl/1.0 (joshuagwatts)",
    });
    const data = JSON.parse(body || "{}");
    const a = data.address || {};
    const extra = data.extratags || {};
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
    return {
      ok: true,
      address: line,
      city: city || line.split(",")[0],
      state,
      zip,
      hasHouse: Boolean(a.house_number && a.road),
      lat,
      lon,
      source: "nominatim",
      name: data.name || extra.operator || "",
      phone: extra.phone || extra["contact:phone"] || extra["contact:mobile"] || "",
      email: extra.email || extra["contact:email"] || "",
      website: extra.website || extra["contact:website"] || extra.url || "",
      facebook: extra.facebook || extra["contact:facebook"] || "",
      instagram: extra.instagram || extra["contact:instagram"] || "",
      wikidata: extra.wikidata || "",
    };
  } catch {
    return { ok: false };
  }
}

/** ArcGIS World reverse geocode — free, and returns rooftop house numbers where OSM has none. */
async function reverseArcgis(lat, lon) {
  try {
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=${lon}%2C${lat}&distance=80&featureTypes=PointAddress&outSR=4326&f=json`;
    const { body } = await httpGet(url, 9000);
    const a = JSON.parse(body || "{}").address || {};
    const line = String(a.Address || "").trim() || String(a.Match_addr || "").split(",")[0].trim();
    if (!/^\d+[A-Za-z]?\s+\S/.test(line)) return { ok: false };
    const city = String(a.City || "").trim();
    const state = String(a.RegionAbbr || a.Region || "").trim();
    const zip = String(a.Postal || "").trim();
    const address = [line, city, state, zip].filter(Boolean).join(", ");
    return { ok: true, address, city, state, zip, hasHouse: true, lat, lon, source: "arcgis" };
  } catch {
    return { ok: false };
  }
}

/** Snap a tap to the nearest on-screen OSM house-number point (the yellow numbers). */
function nearestHouseAddress(lat, lon, maxM = 64) {
  if (!map) return null;
  let best = null;
  let bestM = maxM;
  for (const n of houseCache.nums || []) {
    if (!n?.num || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue;
    let m;
    try {
      m = map.distance([lat, lon], [n.lat, n.lon]);
    } catch {
      continue;
    }
    if (Number.isFinite(m) && m < bestM) {
      bestM = m;
      best = n;
    }
  }
  return best;
}

function streetFromGeo(geo) {
  if (!geo?.ok) return "";
  const parts = parseStreetAddress(geo.address || "");
  return parts.street || "";
}

function packHouseAddress(num, street, city, state, zip) {
  const line = [String(num || "").trim(), String(street || "").trim()].filter(Boolean).join(" ");
  if (!line || !/^\d/.test(line)) return "";
  return [line, city, state, zip].map((p) => String(p || "").trim()).filter(Boolean).join(", ");
}

export async function reverseGeocode(lat, lon) {
  // Prefer the yellow on-screen house number the user is looking at, then rooftop ArcGIS, then Nominatim.
  const snap = nearestHouseAddress(lat, lon);
  const [nom, arc] = await Promise.all([reverseNominatim(lat, lon), reverseArcgis(lat, lon)]);
  if (snap?.num) {
    const street = snap.street || streetFromGeo(arc) || streetFromGeo(nom);
    const city = snap.city || arc.city || nom.city || "";
    const state = arc.state || nom.state || "";
    const zip = snap.zip || arc.zip || nom.zip || "";
    const address = packHouseAddress(snap.num, street, city, state, zip);
    if (address) {
      return {
        ok: true,
        address,
        city,
        state,
        zip,
        hasHouse: true,
        lat: snap.lat,
        lon: snap.lon,
        source: "osm-house",
      };
    }
  }
  if (arc.ok) return { ...arc, lat: arc.lat ?? lat, lon: arc.lon ?? lon };
  if (nom.ok && nom.hasHouse) return nom;
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
  return /spc|lsr|spot|iem/i.test(src) || src === "hail" || src === "noaa-spc";
}

function hitDistKm(p) {
  const d = Number(p?.distance_km);
  if (Number.isFinite(d) && d < 900) return d;
  const pin = pinCoords();
  if (pin && Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) {
    return haversineKm(pin.lat, pin.lon, p.lat, p.lon);
  }
  return 999;
}

function pinCoords() {
  if (Number.isFinite(pinLat) && Number.isFinite(pinLon)) return { lat: pinLat, lon: pinLon };
  return null;
}

function parseSwdiShape(shape) {
  const s = String(shape || "").trim();
  const pt = s.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (pt) {
    const lon = parseFloat(pt[1]);
    const lat = parseFloat(pt[2]);
    return Number.isNaN(lon) || Number.isNaN(lat) ? null : { type: "point", lon, lat };
  }
  const parseRing = (text) => {
    const ring = [];
    for (const pair of String(text || "").split(",")) {
      const bits = pair.trim().split(/\s+/);
      if (bits.length < 2) continue;
      const lon = parseFloat(bits[0]);
      const lat = parseFloat(bits[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) ring.push([lat, lon]);
    }
    return ring.length >= 3 ? ring : null;
  };
  const ringArea = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [y1, x1] = ring[i];
      const [y2, x2] = ring[(i + 1) % ring.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a);
  };
  const multi = s.match(/MULTIPOLYGON\s*\(([\s\S]+)\)\s*$/i);
  if (multi) {
    const rings = [];
    for (const m of multi[1].matchAll(/\(\(([^()]+)\)\)/g)) {
      const ring = parseRing(m[1]);
      if (ring) rings.push(ring);
    }
    if (rings.length) {
      rings.sort((a, b) => ringArea(b) - ringArea(a));
      return { type: "polygon", ring: rings[0] };
    }
  }
  const poly = s.match(/POLYGON\s*\(\(([^()]+)\)/i);
  if (poly) {
    const ring = parseRing(poly[1]);
    if (ring) return { type: "polygon", ring };
  }
  return null;
}

function isRadarHail(p) {
  return !isSpotterHail(p);
}

/** SWDI history window — full 730d on wide ring; fast ring uses recent window so radar lands quickly. */
function swdiDaysForRing(radiusKm, filterDays = 730) {
  const days = Math.min(Math.max(Number(filterDays) || 730, 7), 730);
  if (radiusKm >= PIN_FETCH_WIDE_KM - 1) return days;
  return Math.min(days, 120);
}

async function fetchSwdiHail(lat, lon, radiusKm = 25, daysBack = 90, { onProgress } = {}) {
  const today = new Date();
  const days = Math.min(Math.max(daysBack, 7), 730);
  const km = Math.min(Math.max(radiusKm, 3), MAP_HAIL_MAX_KM);
  const bbox = bboxForKm(lat, lon, km);
  const startLimit = new Date(today);
  startLimit.setDate(startLimit.getDate() - days);
  const chunks = [];
  let cursor = new Date(today);
  // Wider rings use fewer, longer chunks so SWDI doesn't stall the sheet.
  const span = km >= 100 ? 45 : days > 365 ? 28 : days > 120 ? 18 : 13;
  const maxChunks = Math.min(km >= 100 ? 18 : 28, Math.ceil(days / span) + 1);
  while (cursor > startLimit && chunks.length < maxChunks) {
    const chunkEnd = new Date(cursor);
    const chunkStart = new Date(cursor);
    chunkStart.setDate(chunkStart.getDate() - span);
    if (chunkStart < startLimit) chunkStart.setTime(startLimit.getTime());
    chunks.push({ start: chunkStart, end: chunkEnd });
    cursor = new Date(chunkStart);
    cursor.setDate(cursor.getDate() - 1);
  }
  const hits = new Map();
  const batch = km >= 100 ? 3 : 4;
  const timeout = km >= 100 ? 12000 : 14000;
  for (let i = 0; i < chunks.length; i += batch) {
    const part = await Promise.all(
      chunks.slice(i, i + batch).map(async ({ start, end }) => {
        const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
        const url = `https://www.ncdc.noaa.gov/swdiws/json/nx3hail/${fmt(start)}:${fmt(end)}?bbox=${bbox}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { body } = await httpGet(url, timeout);
            const data = JSON.parse(body || "{}");
            return data.result || [];
          } catch {
            if (attempt) return [];
          }
        }
        return [];
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
    if (onProgress && hits.size) onProgress([...hits.values()], { chunk: i / batch + 1, total: Math.ceil(chunks.length / batch) });
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
  const km = Math.min(Math.max(radiusKm, 5), MAP_HAIL_MAX_KM);
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
  if (sz >= 4) return { stroke: "#ffffff", fill: "#fce4ec", core: "#ffffff" };
  if (sz >= 3) return { stroke: "#f8bbd0", fill: "#f48fb1", core: "#ffffff" };
  if (sz >= 2.5) return { stroke: "#f8bbd0", fill: "#ce93d8", core: "#ffffff" };
  if (sz >= 2) return { stroke: "#e040fb", fill: "#ab47bc", core: "#f8bbd0" };
  if (sz >= 1.5) return { stroke: "#ff1744", fill: "#e53935", core: "#ff8a80" };
  if (sz >= 1) return { stroke: "#ff6d00", fill: "#ef6c00", core: "#ffab40" };
  if (sz >= 0.75) return { stroke: "#ffb300", fill: "#f9a825", core: "#ffe082" };
  return { stroke: "#c0ca33", fill: "#d4e157", core: "#f0f4c3" };
}

export function mergeHailRows(...groups) {
  const seen = new Set();
  const spots = [];
  const radar = [];
  for (const h of groups.flat()) {
    if (!h) continue;
    const key = `${String(h.date || "").slice(0, 10)}|${Number(h.lat).toFixed(3)}|${Number(h.lon).toFixed(3)}|${h.size_in}|${isSpotterHail(h) ? "s" : "r"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isSpotterHail(h)) spots.push(h);
    else radar.push(h);
  }
  // Radar drives zones — never let a spotter flood push SWDI out of the cache.
  const maxTotal = 3200;
  const radarKeep = radar.slice(0, 2000);
  const spotKeep = spots.slice(0, Math.max(0, maxTotal - radarKeep.length));
  const uniq = [...radarKeep, ...spotKeep];
  uniq.sort((a, b) => {
    const ds = String(b.date || "").localeCompare(String(a.date || ""));
    if (ds) return ds;
    return (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0);
  });
  return uniq;
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
        ? { lat: h.lat, lon: h.lon, size_in: size, source: h.source || "hail", swdi_ring: h.swdi_ring || null, distance_km: distN }
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
    if (pt) prev.zone_pts.push(pt);
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
    const hasSpot = srcs.some((s) => /spc|lsr|spot|iem/i.test(s) || s === "hail");
    let source = "hail";
    if (hasRadar && hasSpot) source = "mixed";
    else if (hasRadar) source = "noaa-swdi-radar";
    else if (hasSpot) source = "noaa-spc";
    const pts = row.zone_pts || [];
    const near = pts.filter((p) => (Number(p.distance_km) || 999) <= HOUSE_HAIL_KM);
    const maxNear = near.reduce((m, p) => Math.max(m, Number(p.size_in) || 0), 0);
    const nearest = [...pts].sort((a, b) => (Number(a.distance_km) || 999) - (Number(b.distance_km) || 999))[0];
    const size = maxNear > 0 ? maxNear : Number(nearest?.size_in) || Number(row.max_size) || 0;
    const farHit = [...pts]
      .filter((p) => (Number(p.size_in) || 0) > size + 0.04)
      .sort((a, b) => (Number(b.size_in) || 0) - (Number(a.size_in) || 0))[0];
    const use = near.length ? near : nearest ? [nearest] : pts;
    let zone_lat = row.lat;
    let zone_lon = row.lon;
    if (use.length) {
      zone_lat = use.reduce((a, p) => a + p.lat, 0) / use.length;
      zone_lon = use.reduce((a, p) => a + p.lon, 0) / use.length;
    }
    let zone_r_km = Math.max(0.6, Math.min(2.4, (size || 0.5) * 1.1));
    if (near.length) {
      let maxSpread = 0;
      for (const p of near) maxSpread = Math.max(maxSpread, haversineKm(zone_lat, zone_lon, p.lat, p.lon));
      zone_r_km = Math.max(zone_r_km, maxSpread + 0.35);
    }
    const span_km = Math.round(footprintSpanKm(pts) * 10) / 10;
    return {
      kind: "hail",
      date: row.date,
      time: row.time || "",
      lat: zone_lat,
      lon: zone_lon,
      size_in: size ? size.toFixed(2) : row.size_in,
      size_far: farHit ? Number(farHit.size_in).toFixed(2) : "",
      far_km: farHit ? Number(farHit.distance_km) : null,
      near_hits: near.length,
      location: row.location || "Hail zone",
      county: row.county || "",
      state: row.state || "",
      comments: row.comments || `${row.hits} signature${row.hits === 1 ? "" : "s"}`,
      source,
      distance_km: Number.isFinite(Number(nearest?.distance_km)) ? Number(nearest.distance_km) : row.distance_km,
      score: row.score || (size >= 1 ? 5 : 3),
      hits: row.hits,
      span_km,
      zone_pts: pts,
      zone_r_km: Math.round(zone_r_km * 10) / 10,
      severity: hailSeverityLabel(size || row.size_in),
      stars: hailStars(size || row.size_in),
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
  const km = Math.min(Math.max(radiusKm, 3), MAP_HAIL_MAX_KM);
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
let mapBusy = 0;
let lastHailDrawSig = "";

export function mapContainer() {
  try {
    return map?.getContainer?.() || null;
  } catch {
    return null;
  }
}

export function mapIsLive() {
  if (!map) return false;
  try {
    const c = map.getContainer();
    const el = document.getElementById("wx-map");
    return Boolean(c && el && document.body.contains(el) && (c === el || el.contains(c)));
  } catch {
    return false;
  }
}

export function defaultMapCenter(settings) {
  const lat = Number(settings?.lat);
  const lon = Number(settings?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
    return { lat, lon };
  }
  return { lat: 35.4676, lon: -97.5164 };
}

export function quickMapConfig(settings) {
  return applyBaseLayers({
    center: defaultMapCenter(settings),
    layers: [
      ...BASE_LAYERS,
      { id: "hail", label: "Hail", kind: "wx", synthetic: true },
      { id: "wind", label: "Wind", kind: "wx", synthetic: true },
    ],
  });
}

/** Leaflet often mounts at 0×0 on phone WebViews until layout settles. */
export function refreshMapSize() {
  if (!map) return;
  const run = () => {
    try {
      map.invalidateSize({ animate: false, pan: false });
    } catch {
      /* ignore */
    }
  };
  run();
  requestAnimationFrame(run);
  setTimeout(run, 150);
  setTimeout(run, 500);
}
const MAP_MAX_ZOOM = 22;
const MAP_MIN_ZOOM = 3;
/** Max hail fetch radius when zoomed out to regional / multi-state view. */
const MAP_HAIL_MAX_KM = 450;
const HOUSE_NUM_ZOOM = 16;
const HOUSE_FOOTPRINT_MAX = 2000;
const HOUSE_ZOOM = 20;
const ZOOM_UI_REF = 18;
let lastZoomUiScale = 0;
const hailDotMarkers = [];
/** @type {{ layer: object, confirmed: boolean, size: number, kind: "zone"|"core"|"wind" }[]} */
const hailStrokeLayers = [];
let windFieldCenterDot = null;

/** Screen-pixel scale — shrinks when zoomed out; ~1.0 at street zoom. Pin slider sets base size. */
export function zoomUiScale(z) {
  const zoom = Number.isFinite(z) ? z : map?.getZoom?.();
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(1, Math.max(0.4, Math.pow(2, (zoom - ZOOM_UI_REF) / 3)));
}

/** Hail spot/radar dots — keep readable when a storm day is selected and zoomed out. */
export function hailDotZoomScale(z) {
  const zoom = Number.isFinite(z) ? z : map?.getZoom?.();
  if (!Number.isFinite(zoom)) return 1;
  const raw = Math.min(1, Math.max(0.08, Math.pow(2, (zoom - ZOOM_UI_REF) / 1.85)));
  if (hasSelectedStormDates()) return Math.min(1, Math.max(0.42, raw));
  return raw;
}

/** Stroke style for hail/wind topo — keep zoomed-in weight/detail when far out. */
function hailZoneStrokeStyle(isConfirm, sz, z, { radar = false } = {}) {
  const zoom = Number.isFinite(z) ? z : map?.getZoom?.() || 14;
  const size = Number(sz) || 0;
  const solid = isConfirm || radar;
  const base = {
    weight: solid ? (size >= 2 ? 3.2 : 2.6) : size >= 2 ? 2.4 : 1.8,
    opacity: solid ? 0.96 : 0.88,
    dashArray: solid ? null : size >= 1 ? "5 4" : "7 5",
  };
  if (zoom < 11) {
    return {
      weight: base.weight,
      opacity: isConfirm ? 0.94 : 0.82,
      dashArray: null,
    };
  }
  if (zoom < 13) {
    return {
      weight: base.weight,
      opacity: isConfirm ? 0.92 : 0.78,
      dashArray: isConfirm ? null : "2 6",
    };
  }
  return base;
}

function hailCoreStrokeStyle(z) {
  const zoom = Number.isFinite(z) ? z : map?.getZoom?.() || 14;
  if (zoom < 12) return { weight: 0.9, opacity: 0.55, dashArray: null };
  if (zoom < 14) return { weight: 1.1, opacity: 0.75, dashArray: "2 5" };
  return { weight: 1.4, opacity: 0.9, dashArray: "3 4" };
}

function trackHailStroke(layer, meta) {
  if (!layer) return layer;
  hailStrokeLayers.push({ layer, ...meta });
  return layer;
}

function applyHailStrokeZoomStyles(force = false) {
  if (!hailStrokeLayers.length) return;
  const z = map?.getZoom?.();
  const bucket = !Number.isFinite(z) ? 14 : z < 9 ? -1 : z < 11 ? 0 : z < 13 ? 1 : z < 14 ? 2 : 3;
  if (!force && applyHailStrokeZoomStyles._bucket === bucket) return;
  applyHailStrokeZoomStyles._bucket = bucket;
  for (const entry of hailStrokeLayers) {
    const { layer, confirmed, size, kind } = entry;
    if (!layer?.setStyle) continue;
    const style =
      kind === "core"
        ? hailCoreStrokeStyle(z)
        : kind === "wind"
          ? (() => {
              const s = hailZoneStrokeStyle(false, size, z);
              return { weight: Math.min(1.4, s.weight), opacity: Math.min(0.65, s.opacity), dashArray: s.dashArray };
            })()
          : hailZoneStrokeStyle(confirmed, size, z);
    try {
      layer.setStyle(style);
    } catch {
      /* ignore */
    }
  }
}

let zoomUiFrame = 0;

function scheduleZoomUiRefresh(force = false) {
  if (!map) return;
  if (zoomUiFrame) cancelAnimationFrame(zoomUiFrame);
  zoomUiFrame = requestAnimationFrame(() => {
    zoomUiFrame = 0;
    refreshZoomScaledUi(force);
  });
}

function refreshZoomScaledUi(force = false) {
  if (!map) return;
  ensureHailPanes();
  const ui = zoomUiScale();
  if (!force && Math.abs(ui - lastZoomUiScale) < 0.02) {
    applyHailStrokeZoomStyles(false);
    return;
  }
  lastZoomUiScale = ui;
  const dotUi = hailDotZoomScale();
  for (const m of hailDotMarkers) {
    if (!m?.setRadius) continue;
    const br = m.options.baseRadius || 6;
    const spot = /wx-hail-spot/.test(String(m.options.className || ""));
    m.setRadius(Math.max(spot ? 1.4 : 0.9, br * dotUi));
  }
  applyHailStrokeZoomStyles(force);
  for (const [id, marker] of livePinMarkers.done) {
    marker.setIcon(donePinIcon(fieldOverlay.donePinScale, ui));
  }
  for (const [id, marker] of livePinMarkers.marks) {
    const m = fieldOverlay.marks?.find((x) => String(x.id) === id);
    if (m) marker.setIcon(markDivIcon(m, ui));
  }
}

/** Single fill opacity for every hail band — cutout holes prevent stacking mud. */
const HAIL_BAND_FILL = 0.78;
const HAIL_BAND_FILL_SAT = 0.84;

function hailZoneOpacityBoost(_base) {
  void _base;
  return activeLayer === "sat" ? HAIL_BAND_FILL_SAT : HAIL_BAND_FILL;
}

/** Pane stays fully opaque; nested solid fills overwrite (HailTrace cut-out). */
function hailFillPaneOpacity() {
  return 1;
}

function ensureHailPanes() {
  if (!map) return;
  if (!map.getPane("hailFills")) {
    map.createPane("hailFills");
    map.getPane("hailFills").style.zIndex = 640;
  }
  if (!map.getPane("hailDots")) {
    map.createPane("hailDots");
    map.getPane("hailDots").style.zIndex = 655;
  }
  if (!map.getPane("hailVectors")) {
    map.createPane("hailVectors");
    map.getPane("hailVectors").style.zIndex = 650;
  }
  const fills = map.getPane("hailFills");
  if (fills) fills.style.opacity = String(hailFillPaneOpacity());
}

const HOUSE_NUM_MAX = 400;
/** Keep tiles warm while panning — avoids blank flashes without filter cost. */
const BASE_TILE_OPTS = {
  maxZoom: MAP_MAX_ZOOM,
  tileSize: 256,
  detectRetina: false,
  updateWhenIdle: false,
  updateWhenZooming: false,
  keepBuffer: 6,
};
const FEMA_STRUCTURES =
  "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query";
const MS_BUILDINGS =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/MSBFP2/FeatureServer/0/query";
const RADAR_NATIVE_ZOOM = 7;
const RADAR_TILE_SIZE = 512;

function rainTileUrl(host, path, color = "2/1_1") {
  const base = String(host || "https://tilecache.rainviewer.com").replace(/\/+$/, "");
  return `${base}${path}/${RADAR_TILE_SIZE}/{z}/{x}/{y}/${color}.png`;
}

export function hailStars(sizeIn) {
  const sz = parseFloat(sizeIn);
  if (Number.isNaN(sz)) return "☆";
  if (sz >= 4) return "★★★★★+";
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
  if (sz >= 4) return "GIANT";
  if (sz >= 3) return "COLOSSAL";
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
  const wantOn = wantPrecipRadarTiles();

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
  for (const id of ["wx-radar-play", "hs-live-play"]) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.textContent = "PLAY";
      btn.classList.remove("on");
    }
  }
}

export function stopHourPlay() {
  if (hourPlayTimer) {
    clearInterval(hourPlayTimer);
    hourPlayTimer = null;
  }
}

function hailScopeLiveTimeline() {
  const f = hailScopeRadarFilters;
  // Prefer RainViewer cadence when precip is on — denser than hourly wind.
  if (f.precip && radarFrames.length >= 2) {
    return radarFrames.map((fr, i) => ({ time: fr.time, radarIdx: i }));
  }
  if (f.wind && windFrames.length >= 2) {
    return windFrames.map((fr, i) => ({ time: fr.time, windIdx: i }));
  }
  return [];
}

function nearestFrameIdx(frames, timeSec) {
  let best = 0;
  let bestD = Infinity;
  const t = Number(timeSec) || 0;
  for (let i = 0; i < frames.length; i++) {
    const d = Math.abs((Number(frames[i].time) || 0) - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function updateHailScopeLiveLabel(timeSec) {
  const label = document.getElementById("hs-live-label") || document.getElementById("wx-radar-label");
  if (!label) return;
  const d = new Date((Number(timeSec) || 0) * 1000);
  const when = Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "…";
  const windOn = hailScopeRadarFilters.wind && windFrames[windFrameIdx];
  const mph = windOn ? ` · ${Math.round(windFrames[windFrameIdx].speed || 0)} mph` : "";
  label.textContent = `${when}${mph}`;
}

export function setHailScopeLiveFrame(idx, { crossfade = false } = {}) {
  const steps = hailScopeLiveTimeline();
  if (!steps.length) return;
  const i = Math.max(0, Math.min(steps.length - 1, Number(idx) || 0));
  liveTlIdx = i;
  const t = steps[i].time;
  if (hailScopeRadarFilters.precip && radarFrames.length) {
    setRadarFrame(nearestFrameIdx(radarFrames, t), { crossfade });
  }
  if (hailScopeRadarFilters.wind && windFrames.length) {
    const wi = nearestFrameIdx(windFrames, t);
    windFrameIdx = wi;
    paintWindFieldFromFrame(windFrames[wi]);
  }
  updateHailScopeLiveLabel(t);
  const range = document.getElementById("hs-live-range") || document.getElementById("wx-radar-range");
  if (range && String(range.value) !== String(i)) range.value = String(i);
}

function radarPresentMarkPct(steps) {
  if (!steps?.length) return null;
  const t0 = Number(steps[0].time) || 0;
  const t1 = Number(steps[steps.length - 1].time) || t0;
  if (!(t1 > t0)) return t1 === t0 ? 100 : null;
  const now = Date.now() / 1000;
  return Math.max(0, Math.min(100, ((now - t0) / (t1 - t0)) * 100));
}

function radarRangeTrackHtml(id, max, idx, steps) {
  const pct = radarPresentMarkPct(steps);
  const mark =
    pct == null
      ? ""
      : `<span class="wx-radar-now" style="--now:${pct.toFixed(2)}" title="Present" aria-hidden="true"></span>`;
  return `<div class="wx-radar-track" data-radar-track>${mark}<input type="range" id="${id}" min="0" max="${max}" value="${idx}" step="1" /></div>`;
}

function hailScopeLiveScrubberInnerHtml() {
  if (!hailScopeRadarActive()) return "";
  const f = hailScopeRadarFilters;
  if (!f.precip && !f.wind) return "";
  const steps = hailScopeLiveTimeline();
  if (steps.length < 2) return "";
  const max = steps.length - 1;
  const idx = Math.max(0, Math.min(max, liveTlIdx));
  const tag =
    f.precip && f.wind ? "LIVE" : f.precip ? "LIVE PRECIP" : "LIVE WIND";
  const tagCls = f.wind && !f.precip ? "wx-radar-tag hs-live-tag-wind" : "wx-radar-tag";
  return `<div class="wx-radar-scrub-row">
    <button type="button" id="hs-live-play" class="wx-play-btn${radarPlaying ? " on" : ""}">${radarPlaying ? "PAUSE" : "PLAY"}</button>
    <span class="${tagCls}">${tag}</span>
    ${radarRangeTrackHtml("hs-live-range", max, idx, steps)}
    <span id="hs-live-label" class="wx-radar-label">…</span>
  </div>`;
}

export function hailScopeRadarBarHtml(settings) {
  if (settings) hailScopeRadarOn = settings.showRadar !== false;
  if (!hailScopeRadarActive()) return "";
  const f = hailScopeRadarFilters;
  const scrub = hailScopeLiveScrubberInnerHtml();
  return `<div class="hs-radar-bar" id="hs-radar-bar">
    <div class="wx-tl-filters hs-radar-filters">
      <button type="button" data-hs-radar-fl="precip" class="${f.precip ? "on" : ""}">PRECIP</button>
      <button type="button" data-hs-radar-fl="wind" class="${f.wind ? "on" : ""}">WIND</button>
    </div>
    ${scrub ? `<div class="wx-radar-scrub hs-live-scrub" id="hs-live-scrub">${scrub}</div>` : ""}
  </div>`;
}

function bindHailScopeLiveScrubber(root = document) {
  const range = root.querySelector?.("#hs-live-range") || document.getElementById("hs-live-range");
  const play = root.querySelector?.("#hs-live-play") || document.getElementById("hs-live-play");
  if (!range) return;
  setHailScopeLiveFrame(liveTlIdx);
  range.oninput = () => {
    stopRadarPlay();
    stopWindPlay();
    setHailScopeLiveFrame(range.value);
  };
  if (play) {
    play.onclick = () => {
      if (radarPlaying) {
        stopRadarPlay();
        return;
      }
      const steps = hailScopeLiveTimeline();
      if (steps.length < 2) return;
      play.textContent = "PAUSE";
      play.classList.add("on");
      radarPlaying = true;
      const tick = () => {
        if (!radarPlaying) return;
        const next = (liveTlIdx + 1) % hailScopeLiveTimeline().length;
        setHailScopeLiveFrame(next, { crossfade: true });
        radarPlayRaf = window.setTimeout(tick, 520);
      };
      tick();
    };
  }
}

export function bindHailScopeRadar(root = document) {
  bindHailScopeLiveScrubber(root);
  root.querySelectorAll("[data-hs-radar-fl]").forEach((btn) => {
    btn.onclick = async () => {
      const k = btn.dataset.hsRadarFl;
      if (k === "precip" || k === "wind") hailScopeRadarFilters[k] = !hailScopeRadarFilters[k];
      if (k === "wind" && !hailScopeRadarFilters.wind) {
        stopWindPlay();
        clearWindFieldLayer();
      }
      if (k === "wind" && hailScopeRadarFilters.wind) {
        await ensureWindFrames({ force: true });
        // Keep shared playhead time when wind joins precip.
        if (hailScopeRadarFilters.precip && radarFrames[radarFrameIdx]) {
          windFrameIdx = nearestFrameIdx(windFrames, radarFrames[radarFrameIdx].time);
        }
        paintWindFieldFromFrame(windFrames[windFrameIdx] || windFrames[windFrames.length - 1]);
      }
      // Snap live index onto the active timeline without jumping the clock.
      const steps = hailScopeLiveTimeline();
      if (steps.length) {
        const prefer =
          (hailScopeRadarFilters.precip && radarFrames[radarFrameIdx]?.time) ||
          (hailScopeRadarFilters.wind && windFrames[windFrameIdx]?.time) ||
          steps[Math.min(liveTlIdx, steps.length - 1)].time;
        liveTlIdx = nearestFrameIdx(steps, prefer);
      }
      syncHailScopeRadarLayers();
      const host = root.querySelector?.("#hs-radar-bar") || document.getElementById("hs-radar-bar");
      if (host) {
        host.outerHTML = hailScopeRadarBarHtml();
        bindHailScopeRadar(root);
      }
    };
  });
}

export function applyLoadedMapConfig(config, settings) {
  upgradeMapFromConfig(config);
  syncHailScopeRadar(settings);
}

function upgradeMapFromConfig(config) {
  if (!map || !window.L || !config?.layers) return;
  for (const layer of config.layers) {
    if (layer.synthetic || !layer.url || overlays[layer.id]) continue;
    const isWx = layer.kind === "wx" || layer.kind === "overlay";
    if (!isWx) continue;
    const tile = window.L.tileLayer(layer.url, {
      attribution: layer.attribution || "",
      opacity: layer.opacity ?? 1,
      className: layer.className || "",
      maxNativeZoom: layer.maxNativeZoom ?? RADAR_NATIVE_ZOOM,
      subdomains: layer.subdomains || "abc",
      maxZoom: MAP_MAX_ZOOM,
      tileSize: 256,
      detectRetina: false,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 4,
    });
    overlays[layer.id] = tile;
    if (layer.id === "precip") overlays.radar = tile;
  }
}

async function fetchRainViewerFrames() {
  if (radarFrames.length) return;
  try {
    const { body } = await httpGet("https://api.rainviewer.com/public/weather-maps.json", 2500);
    const rv = JSON.parse(body || "{}");
    radarHost = rv.host || "https://tilecache.rainviewer.com";
    const past = ((rv.radar || {}).past || []).slice(-12);
    const nowcast = ((rv.radar || {}).nowcast || []).slice(0, 3);
    radarFrames = [...past, ...nowcast].filter((f) => f && f.path);
    radarFrameIdx = Math.max(0, past.length - 1);
  } catch {
    /* optional */
  }
}

export async function ensureHailScopeRadarLayers(settings) {
  if (!map || !hailScopeRadarActive()) return;
  await fetchRainViewerFrames();
  if (!overlays.precip && radarFrames.length) {
    const frame = radarFrames[radarFrameIdx] || radarFrames[radarFrames.length - 1];
    if (frame?.path) {
      const url = rainTileUrl(radarHost, frame.path, radarColor);
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
    }
  }
  syncHailScopeRadarLayers();
  const shell = document.getElementById("hs-map-shell");
  const bar = document.getElementById("hs-radar-bar");
  if (shell && bar && hailScopeRadarActive()) {
    if (radarFrames.length) liveTlIdx = radarFrameIdx;
    bar.outerHTML = hailScopeRadarBarHtml();
    bindHailScopeRadar(shell);
  }
}

function syncHailScopeRadarLayers() {
  if (!map) return;
  const wantPrecip = hailScopeRadarActive() && hailScopeRadarFilters.precip;
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
  if (wantPrecip && overlays.precip) {
    const frame = radarFrames[radarFrameIdx];
    if (frame?.path) setRadarTilePath(frame.path);
    else {
      try {
        if (!map.hasLayer(overlays.precip)) overlays.precip.addTo(map);
      } catch {
        /* ignore */
      }
    }
  } else if (overlays.precip) {
    try {
      map.removeLayer(overlays.precip);
    } catch {
      /* ignore */
    }
    for (const layer of radarLayers) {
      if (!layer) continue;
      try {
        map.removeLayer(layer);
      } catch {
        /* ignore */
      }
    }
  }
  applyOverlays();
}

export function syncHailScopeRadar(settings) {
  hailScopeRadarOn = settings?.showRadar !== false;
  if (!hailScopeMode || !map) return;
  if (!hailScopeRadarActive()) {
    stopRadarPlay();
    stopWindPlay();
    clearWindFieldLayer();
    syncHailScopeRadarLayers();
    return;
  }
  void ensureHailScopeRadarLayers(settings);
  if (hailScopeRadarFilters.wind) {
    void ensureWindFrames().then(() => {
      if (!hailScopeRadarActive() || !hailScopeRadarFilters.wind) return;
      if (hailScopeRadarFilters.precip && radarFrames[radarFrameIdx]) {
        windFrameIdx = nearestFrameIdx(windFrames, radarFrames[radarFrameIdx].time);
        liveTlIdx = radarFrameIdx;
      } else {
        liveTlIdx = windFrameIdx;
      }
      paintWindFieldFromFrame(windFrames[windFrameIdx] || windFrames[windFrames.length - 1]);
      const shell = document.getElementById("hs-map-shell");
      const bar = document.getElementById("hs-radar-bar");
      if (shell && bar) {
        bar.outerHTML = hailScopeRadarBarHtml();
        bindHailScopeRadar(shell);
      }
    });
  } else if (hailScopeRadarFilters.precip && radarFrames.length) {
    liveTlIdx = radarFrameIdx;
  }
}

function radarScrubberInnerHtml() {
  if (radarFrames.length < 2 || !wxTimelineFilters.precip) return "";
  const max = radarFrames.length - 1;
  const steps = radarFrames.map((fr) => ({ time: fr.time }));
  return `<div class="wx-radar-scrub-row">
    <button type="button" id="wx-radar-play" class="wx-play-btn${radarPlaying ? " on" : ""}">${radarPlaying ? "PAUSE" : "PLAY"}</button>
    <span class="wx-radar-tag">LIVE PRECIP</span>
    ${radarRangeTrackHtml("wx-radar-range", max, radarFrameIdx, steps)}
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

const GOOGLE_TILES = "https://mt{s}.google.com/vt/lyrs={lyrs}&hl=en&scale=2&x={x}&y={y}&z={z}";
const GOOGLE_SUBDOMAINS = "0123";

const BASE_LAYERS = [
  {
    id: "osm",
    label: "Street",
    kind: "base",
    url: GOOGLE_TILES.replace("{lyrs}", "m"),
    subdomains: GOOGLE_SUBDOMAINS,
    maxNativeZoom: 22,
    attribution: "© Google",
  },
  {
    id: "dark",
    label: "Night",
    kind: "base",
    url: GOOGLE_TILES.replace("{lyrs}", "m"),
    subdomains: GOOGLE_SUBDOMAINS,
    maxNativeZoom: 22,
    attribution: "© Google",
    className: "hs-night-tiles",
  },
  {
    id: "sat",
    label: "Sat",
    kind: "base",
    url: GOOGLE_TILES.replace("{lyrs}", "y"),
    subdomains: GOOGLE_SUBDOMAINS,
    maxNativeZoom: 21,
    attribution: "© Google",
    className: "hs-sat-tiles",
  },
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
export function renderStormGraph(hailDays, esc, selectedDate = null, { viewport = false } = {}) {
  const selected =
    selectedDate instanceof Set
      ? selectedDate
      : selectedDate
        ? new Set([stormDateKey(selectedDate)].filter(Boolean))
        : selectedStormDates;
  const rows = [...(hailDays || [])]
    .filter((h) => parseFloat(h.size_in) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-24);
  if (!rows.length) {
    const hint = viewport
      ? "No hail days match these filters."
      : `No hail days within ${formatDistance(filterKm())} of this pin — widen NEAR or loosen hail/storm filters.`;
    return `<div class="wx-storm-graph empty"><p class="muted">${hint}</p></div>`;
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
      const on = selected.has(row.date);
      const dist = row.distance_km != null ? formatDistance(row.distance_km) : "";
      return `<g class="wx-sg-bar${on ? " on" : ""}" data-storm-date="${esc(row.date)}" role="button" tabindex="0">
        <rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" fill="${col.fill}" stroke="${on ? "var(--phos)" : col.stroke}" stroke-width="${on ? 1.8 : 0.6}" opacity="${on ? 1 : 0.88}" />
        <text x="${(x + bw / 2).toFixed(1)}" y="${Math.max(10, y - 3)}" text-anchor="middle" class="wx-sg-v">${esc(String(sz))}"</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${h - 16}" text-anchor="middle" class="wx-sg-x">${esc(label)}</text>
        ${dist ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle" class="wx-sg-dist muted">${esc(dist)}</text>` : ""}
      </g>`;
    })
    .join("");
  const biggest = [...rows].sort((a, b) => (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0))[0];
  const selList = [...selected].sort((a, b) => b.localeCompare(a));
  const selLabel = selList.length
    ? selList.length === 1
      ? selList[0]
      : `${selList.length} days`
    : biggest.date;
  return `<div class="wx-storm-graph">
    <div class="wx-storm-graph-head">
      <span>HAIL ZONES · ${viewport ? "MAP VIEW" : "THIS PIN"}</span>
      <span class="wx-storm-graph-peak">${esc(selLabel)} · ${rows.length} day(s) · ${viewport ? "visible area" : esc(formatDistance(filterKm()))}</span>
    </div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Hail size by storm date near pin">${bars}</svg>
    <div class="wx-storm-graph-legend muted">Tap a bar → storm zones on map · height = hail at this roof · width = signatures · label = nearest hit</div>
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

export function selectStormDate(date, { fit = false, requireDate, hailRows, windRows, toggle = false } = {}) {
  if (!date) {
    clearStormDateSelection();
  } else if (toggle) {
    toggleStormDateSelection(date);
  } else {
    setStormDateSelection([date], { replace: true });
  }
  const needDate = requireDate === true || (requireDate !== false && hailScopeMode);
  const hail = hailRows || lastHailRows;
  const wind = windRows || lastWindRows;
  clearPinRadius();
  if (hail.length || wind.length) {
    lastHailDrawSig = "";
    try {
      drawHailMarkers(hail, wind, { fit, requireDate: needDate });
    } catch (err) {
      console.warn("drawHailMarkers failed", err);
    }
  }
  if (hasSelectedStormDates()) {
    scheduleHailMapFill(120);
  }
  if (hasSelectedStormDates() && wxTimelineFilters.hail && activeWxProduct !== "hail" && activeWxProduct !== "precip") {
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
  return selectedStormDateList()[0] || null;
}

export function getSelectedStormDates() {
  return selectedStormDateList();
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
  clearStormDateSelection();
  if (hailRows.length) {
    setStormDateSelection(
      [[...hailRows].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.date].filter(Boolean),
    );
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
      <p class="muted wx-boot-hint">Scroll up on the map for full screen · storm dates below</p>
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
  if (d.address) d.zillow_url = pickZillowUrl(d);
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

async function localResearch(lat, lon, address = "", { deep = true, filters = wxFilters, news = false, place = true, archive = true, settings = null } = {}) {
  const geoP = address ? Promise.resolve({ ok: true, address, city: address.split(",")[0] }) : reverseGeocode(lat, lon);
  const filterDays = Number(filters.days) || 730;
  const archiveDays = Math.min(filterDays, 730);
  const viewport = Boolean(filters.viewport);
  const km = viewport ? filterKm(filters) : dossierWideKm(filters);
  const swdiDays = swdiDaysForRing(km, filterDays);
  const spcDays = Math.min(filterDays, deep ? 90 : 30);
  const geo = await geoP;
  const addr = address || geo.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const placeP = place
    ? mergePlaceOwner(settings, lat, lon, addr, geo, { ok: true, address: addr, lat, lon })
    : Promise.resolve({ ok: true, address: addr, lat, lon, ...ownerFields({}, null) });
  const [wxNow, archiveStorms, spc, swdi, lsr, placeHit] = await Promise.all([
    currentWeather(lat, lon).catch(() => ({ ok: false })),
    archive ? historicalStorms(lat, lon, archiveDays) : Promise.resolve([]),
    fetchSpcReports(lat, lon, km, spcDays),
    fetchSwdiHail(lat, lon, km, swdiDays),
    fetchIemLsrHail(lat, lon, km, filterDays).catch(() => []),
    placeP,
  ]);
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
    ...placeHit,
    address: addr,
    lat,
    lon,
    weather: wxNow,
    storms,
    hail,
    wind,
    news: newsHits,
    zillow_url: pickZillowUrl({ address: addr, zillow_url: placeHit.zillow_url }),
    _meta: { fetchedDays: Math.max(archiveDays, swdiDays, spcDays, filterDays), fetchedKm: km, deep: Boolean(deep), lat, lon },
  };
}

export async function quickDossier(settings, lat, lon, { onPartial, address: pinAddress } = {}) {
  const geo = pinAddress
    ? { ok: true, address: pinAddress, city: pinAddress.split(",")[1]?.trim() || pinAddress.split(",")[0] || "" }
    : await reverseGeocode(lat, lon);
  const addr = pinAddress || geo.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const people0 = listingForPin(geo, addr);
  const partial = {
    ok: true,
    address: addr,
    lat,
    lon,
    zillow_url: pickZillowUrl({ address: addr }),
    storms: [],
    hail: [],
    wind: [],
    news: [],
    ...ownerFields(people0),
  };
  if (onPartial) onPartial(partial);
  const fastKm = dossierFetchKm();
  const wideKm = dossierWideKm();
  const days = Number(wxFilters.days) || 730;
  const swdiFastDays = swdiDaysForRing(fastKm, days);
  const swdiWideDays = swdiDaysForRing(wideKm, days);
  const wideFetch = wideKm > fastKm + 1;
  const placeP = mergePlaceOwner(settings, lat, lon, addr, geo, partial);
  const wxP = currentWeather(lat, lon).catch(() => ({ ok: false }));
  const lsrFastP = fetchIemLsrHail(lat, lon, fastKm, days).catch(() => []);
  const spcFastP = fetchSpcReports(lat, lon, fastKm, 30);
  const lsrWideP = wideFetch ? fetchIemLsrHail(lat, lon, wideKm, days).catch(() => []) : null;
  const spcWideP = wideFetch ? fetchSpcReports(lat, lon, wideKm, 30) : null;

  let accHail = [];
  let accWind = [];
  let wxNow = { ok: false };
  let placeHit = partial;
  let spcFast = { hail: [], wind: [] };
  let lsrFast = [];

  const pushPartial = (tag, { loading = false, fetchedKm = fastKm } = {}) => {
    if (!onPartial) return;
    onPartial({
      ...partial,
      ...placeHit,
      weather: wxNow,
      hail: accHail,
      wind: accWind,
      storms: enrichStormDates([], accHail, accWind),
      zillow_url: pickZillowUrl({ address: addr, zillow_url: placeHit.zillow_url }),
      lat,
      lon,
      _meta: {
        fetchedDays: days,
        fetchedKm,
        deep: false,
        partial: tag,
        loading,
        radarN: accHail.filter((h) => !isSpotterHail(h)).length,
        spotN: accHail.filter(isSpotterHail).length,
      },
    });
  };

  lsrFast = await lsrFastP;
  accHail = mergeHailRows([], [], lsrFast);
  pushPartial("lsr", { loading: true, fetchedKm: fastKm });

  [wxNow, spcFast, placeHit] = await Promise.all([wxP, spcFastP, placeP]);
  accHail = mergeHailRows(spcFast.hail || [], accHail, lsrFast);
  accWind = spcFast.wind || [];
  pushPartial("spc", { loading: true, fetchedKm: fastKm });

  const swdiFast = await fetchSwdiHail(lat, lon, fastKm, swdiFastDays, {
    onProgress: (swdiBatch) => {
      accHail = mergeHailRows(spcFast.hail || [], swdiBatch, lsrFast);
      pushPartial("swdi", { loading: true, fetchedKm: fastKm });
    },
  });
  accHail = mergeHailRows(spcFast.hail || [], swdiFast || [], lsrFast);
  pushPartial("swdi-fast", { loading: wideFetch, fetchedKm: fastKm });

  if (wideFetch) {
    const [lsrWide, swdiWide, spcWide] = await Promise.all([
      lsrWideP,
      fetchSwdiHail(lat, lon, wideKm, swdiWideDays),
      spcWideP,
    ]);
    accHail = mergeHailRows(spcWide.hail || [], swdiWide || [], lsrWide, accHail);
    accWind = spcWide.wind?.length ? spcWide.wind : accWind;
    pushPartial("wide", { loading: false, fetchedKm: wideKm });
  }

  return {
    ...partial,
    ...placeHit,
    weather: wxNow,
    hail: accHail,
    wind: accWind,
    storms: enrichStormDates([], accHail, accWind),
    zillow_url: pickZillowUrl({ address: addr, zillow_url: placeHit.zillow_url }),
    lat,
    lon,
    _meta: { fetchedDays: days, fetchedKm: wideFetch ? wideKm : fastKm, deep: false, loading: false },
  };
}

export async function refetchDossier(settings, lat, lon, address, filters = wxFilters) {
  const f = { ...wxFilters, ...filters };
  return localResearch(lat, lon, address, { deep: true, filters: f, settings });
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
  const local = await localResearch(lat, lon, address, { deep, filters: wxFilters, news: deep, settings });
  if (usableRemote(remote)) {
    const norm = normalizeDossier(remote) || local;
    norm.lat = lat;
    norm.lon = lon;
    const merged = mergeHailRows(norm.hail || [], local.hail || []);
    norm.hail = pinFilterHailRows(merged, lat, lon, dossierWideKm());
    norm.wind = (local.wind?.length || 0) >= (norm.wind?.length || 0) ? local.wind : norm.wind;
    norm.storms = local.storms?.length ? local.storms : norm.storms;
    norm._meta = local._meta || norm._meta;
    return norm;
  }
  return local;
}

export async function pinDossier(settings, lat, lon, { onPartial, deep = false, address: pinAddress } = {}) {
  if (!deep) {
    return normalizeDossier(await quickDossier(settings, lat, lon, { onPartial, address: pinAddress })) || null;
  }
  const geo = pinAddress
    ? { ok: true, address: pinAddress, city: pinAddress.split(",")[1]?.trim() || pinAddress.split(",")[0] || "" }
    : await reverseGeocode(lat, lon);
  const addr = pinAddress || geo.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const people0 = listingForPin(geo, addr);
  const partial = {
    ok: true,
    address: addr,
    lat,
    lon,
    zillow_url: pickZillowUrl({ address: addr }),
    storms: [],
    hail: [],
    news: [],
    ...ownerFields(people0),
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
        norm.hail = pinFilterHailRows(r.hail, lat, lon, filterKm());
      }
    }
    return norm;
  }
  if (remote) {
    const norm = normalizeDossier(remote) || remote;
    norm.lat = lat;
    norm.lon = lon;
    norm.hail = pinFilterHailRows(norm.hail || [], lat, lon, dossierWideKm());
    return norm;
  }
  const [geo, wx] = await Promise.all([
    reverseGeocode(lat, lon),
    currentWeather(lat, lon),
  ]);
  return { ok: true, geo, lat, lon, address: geo?.address || "", weather: wx, hail: [], recent_storms: [] };
}

function pinFilterHailRows(rows, lat, lon, km = PIN_FETCH_WIDE_KM) {
  const pinLat = Number(lat);
  const pinLon = Number(lon);
  const radius = Number(km) || PIN_FETCH_WIDE_KM;
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

function mapViewBounds(pad = 0.03) {
  try {
    return map?.getBounds?.()?.pad?.(pad) || null;
  } catch {
    return null;
  }
}

/** Center + search radius from the current map frame. */
export function mapViewHailQuery() {
  if (!map) return null;
  const b = mapViewBounds(0.05);
  if (!b) return null;
  const c = b.getCenter();
  const lat = c.lat;
  const lon = c.lng;
  const corners = [b.getNorthEast(), b.getNorthWest(), b.getSouthEast(), b.getSouthWest()];
  let radiusKm = 5;
  for (const p of corners) {
    radiusKm = Math.max(radiusKm, haversineKm(lat, lon, p.lat, p.lng));
  }
  return { lat, lon, radiusKm: Math.max(5, radiusKm * 1.08), bounds: b };
}

/** Hail fetch radius from current map frame — grows when zoomed out for statewide storm view. */
export function mapViewFetchKm() {
  const q = mapViewHailQuery();
  if (!q) return filterKm();
  const z = map?.getZoom?.() ?? 14;
  // Oklahoma ~400km across — keep caps high enough that a state frame actually fills.
  const cap =
    z <= 5
      ? MAP_HAIL_MAX_KM
      : z <= 6
        ? 420
        : z <= 7
          ? 340
          : z <= 8
            ? 260
            : z <= 9
              ? 180
              : z <= 10
                ? 120
                : z <= 11
                  ? 80
                  : 55;
  return Math.min(cap, Math.max(12, Math.ceil(q.radiusKm * 1.06)));
}

export function hailInMapView(rows) {
  const b = mapViewBounds(0.02);
  if (!b) return rows || [];
  return (rows || []).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon) && b.contains([h.lat, h.lon]));
}

export function wxPinSelected() {
  return Number.isFinite(pinLat) && Number.isFinite(pinLon);
}

export function clearWxPin() {
  pinLat = null;
  pinLon = null;
  clearStormDateSelection();
  lastHailDrawSig = "";
  clearPinRadius();
  if (pin) {
    try {
      map.removeLayer(pin);
    } catch {
      /* ignore */
    }
    try {
      pin.off?.();
      pin.remove?.();
    } catch {
      /* ignore */
    }
    pin = null;
  }
  syncHailBottomChrome();
}

export async function viewportDossier(settings, filters = wxFilters) {
  const q = mapViewHailQuery();
  if (!q) return null;
  const km = Math.max(filterKm(filters), mapViewFetchKm());
  const f = { ...filters, km };
  // Hail-only for map overview — skip Zillow/assessor/Open-Meteo archive.
  let data = await localResearch(q.lat, q.lon, "Map view", {
    deep: true,
    filters: f,
    news: false,
    place: false,
    archive: false,
  });
  data = normalizeDossier(data) || data;
  data.address = "Map view";
  data.viewport = true;
  data.lat = q.lat;
  data.lon = q.lon;
  data.hail = (data.hail || []).map((h) => ({
    ...h,
    distance_km: Math.round(haversineKm(q.lat, q.lon, h.lat, h.lon) * 10) / 10,
  }));
  data.wind = (data.wind || []).map((w) => ({
    ...w,
    distance_km: Math.round(haversineKm(q.lat, q.lon, w.lat, w.lon) * 10) / 10,
  }));
  data._meta = {
    ...(data._meta || {}),
    viewport: true,
    fetchedKm: km,
    lat: q.lat,
    lon: q.lon,
    // Allow geographic re-fetch as the map pans/zooms; days filter still refetches via onRefetch.
    listLocked: false,
  };
  return data;
}

let selectPinClearHandler = null;
/** Ignore clear taps briefly after placing so the drop gesture can't clear itself. */
let selectPinClearReadyAt = 0;

export function bindSelectPinDblTap(fn) {
  selectPinClearHandler = typeof fn === "function" ? fn : null;
  if (pin) wireSelectPinClear(pin);
}

function wireSelectPinClear(marker) {
  if (!marker || marker._gcClearBound) return;
  marker._gcClearBound = true;
  const fire = (e) => {
    if (!selectPinClearHandler) return;
    if (Date.now() < selectPinClearReadyAt) return;
    window.L.DomEvent.stop(e);
    if (e.originalEvent) {
      e.originalEvent.preventDefault?.();
      e.originalEvent.stopPropagation?.();
    }
    wxSuppressMapTap = true;
    selectPinClearHandler();
    setTimeout(() => {
      wxSuppressMapTap = false;
    }, 450);
  };
  // Single tap/click — easier than double-tap on a phone
  marker.on("click", fire);
}

function selectPinIcon() {
  return window.L.divIcon({
    className: "hs-select-pin",
    iconSize: [52, 52],
    iconAnchor: [26, 46],
    html: '<span class="hs-select-pin-glyph" aria-hidden="true"></span>',
  });
}

function hailNearPin(rows, day = null) {
  let pool = rows || [];
  if (day) pool = pool.filter((h) => String(h.date || "").slice(0, 10) === day);
  // Selected storm date(s): use the full cached footprint so zones don't morph
  // as the phone pans (never rebuild from only on-screen dots).
  if (hasSelectedStormDates()) {
    return pool.filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
  }
  if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon)) {
    return hailInMapView(pool);
  }
  const km = filterKm();
  return pool.filter((h) => {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) return false;
    const dist = Number.isFinite(h.distance_km) ? h.distance_km : haversineKm(pinLat, pinLon, h.lat, h.lon);
    return dist <= km;
  });
}

function windNearPin(rows, day = null) {
  let pool = rows || [];
  if (day) pool = pool.filter((w) => String(w.date || "").slice(0, 10) === day);
  if (hasSelectedStormDates()) {
    return pool.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon));
  }
  if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon)) {
    return hailInMapView(pool);
  }
  const km = filterKm();
  return pool.filter((w) => {
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) return false;
    const dist = Number.isFinite(w.distance_km) ? w.distance_km : haversineKm(pinLat, pinLon, w.lat, w.lon);
    return dist <= km;
  });
}

export function setWxPin(lat, lon) {
  pinLat = Number(lat);
  pinLon = Number(lon);
  placeSelectPin([lat, lon]);
  clearPinRadius();
  if (lastHailRows.length || lastWindRows.length) {
    drawHailMarkers(lastHailRows, lastWindRows);
  }
}

/** Search-radius circle removed — hail fills the map when a storm date is selected. */
function clearPinRadius() {
  if (!pinRadiusLayer) return;
  try {
    map?.removeLayer(pinRadiusLayer);
  } catch {
    /* ignore */
  }
  pinRadiusLayer = null;
}

function drawPinRadius() {
  clearPinRadius();
}

let hailMapFillGen = 0;
let hailMapFillTimer = 0;

/** When a storm date is on, keep the visible map stocked with hail (not a pin circle). */
async function refreshHailMapFill() {
  if (!hasSelectedStormDates() || !map) return;
  const q = mapViewHailQuery();
  if (!q) return;
  const gen = ++hailMapFillGen;
  const days = Number(wxFilters.days) || 730;
  const km = mapViewFetchKm();
  try {
    const [spc, swdi, lsr] = await Promise.all([
      fetchSpcReports(q.lat, q.lon, km, Math.min(days, 90)),
      fetchSwdiHail(q.lat, q.lon, km, swdiDaysForRing(km, days)),
      fetchIemLsrHail(q.lat, q.lon, km, days).catch(() => []),
    ]);
    if (gen !== hailMapFillGen || !hasSelectedStormDates()) return;
    const merged = mergeHailRows(spc.hail || [], swdi || [], lsr || []);
    const byKey = new Map();
    for (const h of [...(lastHailRows || []), ...merged]) {
      if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
      const k = `${String(h.date || "").slice(0, 10)}|${h.lat.toFixed(4)}|${h.lon.toFixed(4)}|${h.size_in}|${h.source || ""}`;
      byKey.set(k, h);
    }
    lastHailDrawSig = "";
    drawHailMarkers([...byKey.values()], lastWindRows);
  } catch {
    /* keep whatever is already on the map */
  }
}

function scheduleHailMapFill(ms = 280) {
  if (!hasSelectedStormDates()) return;
  if (hailMapFillTimer) clearTimeout(hailMapFillTimer);
  hailMapFillTimer = setTimeout(() => {
    hailMapFillTimer = 0;
    void refreshHailMapFill();
  }, ms);
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

function clusterPoints(pts, splitKm = 1.5) {
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
function hailFootprintM(sizeIn, source, zoom) {
  const sz = parseFloat(sizeIn);
  const s = Number.isNaN(sz) ? 0.75 : sz;
  const radar = /swdi|radar/i.test(String(source || ""));
  const z = Number.isFinite(zoom) ? zoom : map?.getZoom?.() || 14;
  // Zoomed-out: fatten kernels so pockets merge into continuous news-radar corridors.
  const zoomScale = z < 8 ? 2.8 : z < 10 ? 2.1 : z < 12 ? 1.45 : 1;
  const base = (radar ? 900 : 420) + s * (radar ? 720 : 400);
  return Math.max(500, Math.min(6200, base * zoomScale));
}

/**
 * Hailswath / MESH-style region builder (Cheresnick & Basara 2005; MRMS MESH contouring).
 * Rasterize size-weighted footprints onto a local km grid, morphologically close gaps
 * between volume-scan-like hits, then extract nested isosurfaces at hail-size thresholds.
 */
const HAIL_SWATH_THRESHOLDS = [0.75, 1.0, 1.5, 2.0, 2.5];
const HAIL_SWATH_THRESHOLDS_WIDE = [0.75, 1.25, 2.0];

function chaikinSmoothRing(ring, iters = 2) {
  if (!ring || ring.length < 4) return ring;
  let pts = ring.slice();
  const closed =
    pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (!closed) pts = pts.concat([pts[0]]);
  for (let n = 0; n < iters; n++) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(next[0]);
    pts = next;
  }
  return pts;
}

function dilateBinary(grid, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (grid[yy * w + xx]) on = 1;
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

function erodeBinary(grid, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = grid[y * w + x] ? 1 : 0;
      if (!on) {
        out[y * w + x] = 0;
        continue;
      }
      for (let dy = -1; dy <= 1 && on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          // Ignore OOB — don't eat the swath edge on thin grids
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (!grid[yy * w + xx]) on = 0;
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

/** Morphological close — fills small gaps between successive radar footprints (Hailswath smoothing). */
function morphClose(grid, w, h, passes = 1) {
  let g = grid;
  for (let i = 0; i < passes; i++) g = erodeBinary(dilateBinary(g, w, h), w, h);
  return g;
}

/**
 * Moore neighborhood exterior walk — keeps elongated storm corridors instead of
 * ballooning them into convex-hull bubbles (the HailTrace / TV-radar look).
 */
function walkBinaryExterior(grid, w, h, sx, sy, cellKm, xyToLatLon) {
  const isOn = (x, y) => x >= 0 && y >= 0 && x < w && y < h && grid[y * w + x];
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  if (!isOn(sx, sy)) return null;
  let startDir = -1;
  for (let d = 0; d < 8; d++) {
    if (!isOn(sx + DX[d], sy + DY[d])) {
      startDir = d;
      break;
    }
  }
  if (startDir < 0) return null;

  const ring = [];
  let x = sx;
  let y = sy;
  let dir = startDir;
  const maxSteps = w * h * 4;
  for (let step = 0; step < maxSteps; step++) {
    ring.push(xyToLatLon((x + 0.5) * cellKm, (y + 0.5) * cellKm));
    let nextDir = -1;
    let nx = x;
    let ny = y;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const tx = x + DX[d];
      const ty = y + DY[d];
      if (isOn(tx, ty)) {
        nextDir = d;
        nx = tx;
        ny = ty;
        break;
      }
    }
    if (nextDir < 0) break;
    x = nx;
    y = ny;
    dir = nextDir;
    if (x === sx && y === sy && ring.length > 3) break;
  }
  if (ring.length < 4) return null;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : ring.concat([ring[0]]);
  if (closed.length > 48) {
    const stride = Math.ceil(closed.length / 36);
    const slim = [];
    for (let i = 0; i < closed.length - 1; i += stride) slim.push(closed[i]);
    slim.push(slim[0]);
    return slim;
  }
  return closed;
}

/**
 * Connected components on a binary grid → smoothed exterior rings.
 * Prefers contour walking (elongated swaths) over convex hulls (bubble look).
 */
function traceBinaryExteriorRings(grid, w, h, cellKm, xyToLatLon, maxRings = 24) {
  const seen = new Uint8Array(w * h);
  const rings = [];
  const isOn = (x, y) => x >= 0 && y >= 0 && x < w && y < h && grid[y * w + x];
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];

  for (let y = 0; y < h && rings.length < maxRings; y++) {
    for (let x = 0; x < w && rings.length < maxRings; x++) {
      const start = y * w + x;
      if (!grid[start] || seen[start]) continue;
      const q = [[x, y]];
      seen[start] = 1;
      let seedX = x;
      let seedY = y;
      let qi = 0;
      while (qi < q.length) {
        const [cx, cy] = q[qi++];
        for (let k = 0; k < 8; k++) {
          if (!isOn(cx + DX[k], cy + DY[k])) {
            seedX = cx;
            seedY = cy;
            break;
          }
        }
        for (let k = 0; k < 8; k++) {
          const nx = cx + DX[k];
          const ny = cy + DY[k];
          if (!isOn(nx, ny)) continue;
          const ni = ny * w + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          q.push([nx, ny]);
        }
      }
      let closed = walkBinaryExterior(grid, w, h, seedX, seedY, cellKm, xyToLatLon);
      if (!closed || closed.length < 4) {
        const edgePts = [];
        for (const [cx, cy] of q) {
          let edge = false;
          for (let k = 0; k < 8; k++) {
            if (!isOn(cx + DX[k], cy + DY[k])) {
              edge = true;
              break;
            }
          }
          if (!edge && q.length > 1) continue;
          edgePts.push({
            lat: xyToLatLon((cx + 0.5) * cellKm, (cy + 0.5) * cellKm)[0],
            lon: xyToLatLon((cx + 0.5) * cellKm, (cy + 0.5) * cellKm)[1],
          });
        }
        if (edgePts.length < 3) continue;
        const hull = convexHullLatLon(edgePts);
        if (!hull || hull.length < 3) continue;
        closed =
          hull[0][0] === hull[hull.length - 1][0] && hull[0][1] === hull[hull.length - 1][1]
            ? hull
            : hull.concat([hull[0]]);
      }
      rings.push(chaikinSmoothRing(closed, 2));
    }
  }
  return rings;
}

/**
 * Build nested hail-swath polygons from point/radar hits.
 * Inspired by MESH isosurfaces + Hailswath footprint accumulation.
 */
function buildHailSwathRings(rawPts, zone = {}) {
  const pts = (rawPts || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const z = map?.getZoom?.() ?? 14;
  const wide = z < 11;
  // Never paint raw SWDI polygons as separate bubbles — fold them into the mesh so
  // nested bands + cutouts stay clean (no double-fill / fake subtraction).
  const swdiRings = [];

  if (pts.length < 2 && !swdiRings.length) {
    if (pts.length === 1) {
      const p = pts[0];
      const sz = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75;
      return [
        {
          ring: ringPolygon(p.lat, p.lon, hailFootprintM(sz, p.source, z), wide ? 20 : 14),
          maxSize: sz,
          hits: 1,
          confirmed: isSpotterHail(p),
          source: isSpotterHail(p) ? "spot+radar" : "radar-merge",
        },
      ];
    }
    return swdiRings;
  }

  const oLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const oLon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
  const cos = Math.cos((oLat * Math.PI) / 180);
  const toXY = (lat, lon) => ({
    x: ((lon - oLon) * 111.32 * Math.max(0.2, cos)),
    y: (lat - oLat) * 111.32,
  });
  const xyToLatLon = (xKm, yKm) => [
    oLat + yKm / 111.32,
    oLon + xKm / (111.32 * Math.max(0.2, cos)),
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const kernels = pts.map((p) => {
    const sz = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75;
    const rKm = hailFootprintM(sz, p.source, z) / 1000;
    const { x, y } = toXY(p.lat, p.lon);
    minX = Math.min(minX, x - rKm);
    maxX = Math.max(maxX, x + rKm);
    minY = Math.min(minY, y - rKm);
    maxY = Math.max(maxY, y + rKm);
    return { x, y, rKm, size: sz, spot: isSpotterHail(p) };
  });
  // Always seed kernels from SWDI polygon centroids so radar footprints join the swath.
  for (const p of pts) {
    if (!p.swdi_ring || p.swdi_ring.length < 3) continue;
    const sz = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75;
    const cLat = p.swdi_ring.reduce((a, c) => a + c[0], 0) / p.swdi_ring.length;
    const cLon = p.swdi_ring.reduce((a, c) => a + c[1], 0) / p.swdi_ring.length;
    const rKm = hailFootprintM(sz, "noaa-swdi-radar", z) / 1000;
    const { x, y } = toXY(cLat, cLon);
    minX = Math.min(minX, x - rKm);
    maxX = Math.max(maxX, x + rKm);
    minY = Math.min(minY, y - rKm);
    maxY = Math.max(maxY, y + rKm);
    kernels.push({ x, y, rKm, size: Math.max(sz, 0.85), spot: false });
  }
  const pad = wide ? 2.4 : 1.2;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;

  const span = Math.max(maxX - minX, maxY - minY, 2);
  // Zoomed-out: coarser cells + stronger close → continuous weather-pattern corridors.
  const maxCells = wide ? 160 : hasSelectedStormDates() ? 192 : 128;
  const cellKm = Math.max(wide ? 0.35 : 0.18, Math.min(wide ? 1.4 : 0.85, span / maxCells));
  const w = Math.min(maxCells, Math.max(16, Math.ceil((maxX - minX) / cellKm)));
  const h = Math.min(maxCells, Math.max(16, Math.ceil((maxY - minY) / cellKm)));
  const field = new Float32Array(w * h);

  for (const k of kernels) {
    const gx0 = Math.max(0, Math.floor((k.x - k.rKm - minX) / cellKm));
    const gx1 = Math.min(w - 1, Math.ceil((k.x + k.rKm - minX) / cellKm));
    const gy0 = Math.max(0, Math.floor((k.y - k.rKm - minY) / cellKm));
    const gy1 = Math.min(h - 1, Math.ceil((k.y + k.rKm - minY) / cellKm));
    const r2 = k.rKm * k.rKm;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const cx = minX + (gx + 0.5) * cellKm;
        const cy = minY + (gy + 0.5) * cellKm;
        const d2 = (cx - k.x) * (cx - k.x) + (cy - k.y) * (cy - k.y);
        if (d2 > r2) continue;
        const t = 1 - Math.sqrt(d2) / Math.max(0.05, k.rKm);
        const radarBoost = k.spot ? 1 : 1.65;
        const contrib = k.size * (0.5 + 0.5 * t) * radarBoost;
        const i = gy * w + gx;
        if (contrib > field[i]) field[i] = contrib;
      }
    }
  }

  const spotConfirm = kernels.some((k) => k.spot);
  const radarCount = kernels.filter((k) => !k.spot).length;
  const out = [...swdiRings];
  const xyCell = (xKm, yKm) => xyToLatLon(minX + xKm, minY + yKm);
  const thresholds = wide ? HAIL_SWATH_THRESHOLDS_WIDE : HAIL_SWATH_THRESHOLDS;

  for (const thr of thresholds) {
    const binary = new Uint8Array(w * h);
    let any = 0;
    for (let i = 0; i < field.length; i++) {
      if (field[i] >= thr) {
        binary[i] = 1;
        any = 1;
      }
    }
    if (!any) continue;
    // Aggressive close when zoomed out — fills gaps into continuous swaths like TV radar.
    const closePasses = wide ? (thr <= 1 ? 6 : thr <= 1.5 ? 4 : 3) : thr <= 1 ? 3 : thr <= 1.5 ? 2 : 1;
    const closed = morphClose(binary, w, h, closePasses);
    const rings = traceBinaryExteriorRings(closed, w, h, cellKm, xyCell, wide ? 8 : 12);
    for (const ring of rings) {
      if (!ring || ring.length < 4) continue;
      const smooth = chaikinSmoothRing(ring, wide ? 3 : 2);
      const meshConfirmed =
        (spotConfirm && thr >= 1) || (radarCount >= 2 && thr >= 0.75) || (radarCount >= 1 && thr >= 1);
      out.push({
        ring: padPolygon(smooth, Math.max(wide ? 140 : 90, thr * (wide ? 80 : 55))),
        maxSize: thr,
        hits: kernels.filter((k) => k.size >= thr).length,
        confirmed: meshConfirmed,
        source: spotConfirm && radarCount ? "spot+radar" : radarCount ? "mesh-swath" : "spotter",
      });
    }
  }

  if (!out.length) {
    return [
      {
        ring: topoZoneRing(zone, rawPts),
        maxSize: parseFloat(zone.size_in) || 0.75,
        hits: pts.length,
        confirmed: spotConfirm || radarCount > 0,
        source: spotConfirm && radarCount ? "spot+radar" : radarCount ? "radar-merge" : "spotter",
      },
    ];
  }
  // Prefer continuous mesh corridors over a pile of tiny radar-poly bubbles.
  out.sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));
  return out;
}

function zoneHitPool(zone, rawPts) {
  const day = String(zone.date || "").slice(0, 10);
  const fromRows = (rawPts || []).filter(
    (p) => String(p.date || "").slice(0, 10) === day && Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
  const fromZone = (zone.zone_pts || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({
      lat: p.lat,
      lon: p.lon,
      size_in: p.size_in || zone.size_in,
      source: p.source || zone.source,
      swdi_ring: p.swdi_ring || null,
      date: day,
    }));
  return mergeHailRows(fromRows, fromZone);
}

function buildDetailedZoneRings(zone, rawPts) {
  const pool = zoneHitPool(zone, rawPts);
  if (!pool.length) {
    return [{ ring: topoZoneRing(zone, rawPts), maxSize: parseFloat(zone.size_in) || 0, hits: 1, confirmed: false }];
  }
  const radarN = pool.filter(isRadarHail).length;
  if (radarN || pool.length >= 2 || pool.some((p) => p.swdi_ring?.length >= 3) || hasSelectedStormDates()) {
    return buildHailSwathRings(pool, zone);
  }
  const p = pool[0];
  const sz = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75;
  return [
    {
      ring: ringPolygon(p.lat, p.lon, hailFootprintM(sz, p.source) * 1.25, 16),
      maxSize: sz,
      hits: 1,
      confirmed: isSpotterHail(p),
      source: isSpotterHail(p) ? "spotter" : "radar-merge",
    },
  ];
}

function topoZoneRing(zone, rawPts) {
  const lat = zone.lat;
  const lon = zone.lon;
  const sz = parseFloat(zone.size_in);
  const baseM = Math.max(400, Math.min(2400, (zone.zone_r_km || 1) * 1000));
  const dayPts = (rawPts || []).filter((p) => String(p.date || "").slice(0, 10) === zone.date);
  const hull = convexHullLatLon(dayPts);
  if (hull) return padPolygon(hull, Math.max(400, baseM * 0.15));
  return ringPolygon(lat, lon, baseM, sz >= 1.5 ? 8 : 6);
}

function ensureClosedRing(ring) {
  if (!ring || ring.length < 3) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a && b && a[0] === b[0] && a[1] === b[1]) return ring;
  return ring.concat([ring[0]]);
}

function reverseRing(ring) {
  return ensureClosedRing(ring || []).slice().reverse();
}

function ringCentroidLatLon(ring) {
  if (!ring?.length) return null;
  let lat = 0;
  let lon = 0;
  let n = 0;
  const lim = ring.length - (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
  for (let i = 0; i < lim; i++) {
    const p = ring[i];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    lat += p[0];
    lon += p[1];
    n++;
  }
  return n ? { lat: lat / n, lon: lon / n } : null;
}

/** Ray-cast point-in-polygon for [lat, lon] rings. */
function pointInLatLonRing(lat, lon, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    const denom = yj - yi || 1e-12;
    const intersect = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Nest weaker→stronger isosurfaces into annulus bands (outer ring with holes).
 * Prevents opacity stacking: each band paints once; stronger cores sit in the cutouts.
 */
function nestHailBandPolys(subs) {
  const bands = (subs || [])
    .filter((s) => Array.isArray(s?.ring) && s.ring.length >= 3)
    .map((s) => ({ ...s, ring: ensureClosedRing(s.ring) }))
    .sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));

  return bands.map((band, i) => {
    const holes = [];
    for (let j = i + 1; j < bands.length; j++) {
      const stronger = bands[j];
      const c = ringCentroidLatLon(stronger.ring);
      if (!c || !pointInLatLonRing(c.lat, c.lon, band.ring)) continue;
      // Only cut with immediate children — skip rings already nested inside a mid band.
      let nestedDeeper = false;
      for (let k = i + 1; k < j; k++) {
        const mid = bands[k];
        const mc = ringCentroidLatLon(mid.ring);
        if (
          mc &&
          pointInLatLonRing(c.lat, c.lon, mid.ring) &&
          pointInLatLonRing(mc.lat, mc.lon, band.ring)
        ) {
          nestedDeeper = true;
          break;
        }
      }
      if (!nestedDeeper) holes.push(reverseRing(stronger.ring));
    }
    return { ...band, holes };
  });
}

function hailZonePopupHtml(h, sub) {
  const sz = sub.maxSize || parseFloat(h.size_in) || 0;
  const srcKey =
    sub.source === "mesh-swath" || sub.source === "radar-poly" || sub.source === "radar-merge"
      ? "noaa-swdi-radar"
      : sub.source === "spot+radar"
        ? "mixed"
        : sub.source || h.source;
  const src = hailSourceLabel({ source: srcKey });
  const when = prettyStormDate(h.date);
  const hits = sub.hits || h.hits || 1;
  const span = h.span_km ? ` · ${formatDistance(h.span_km)} wide` : "";
  const near = (h.near_hits || 0) > 0 ? ` · ${h.near_hits} at roof` : "";
  return `<div class="hs-zone-pop">
    <strong>${when}</strong>
    <span class="hs-zone-size">${Number(sz).toFixed(2)}″ · ${hailSeverityLabel(sz)}</span>
    <span class="hs-zone-meta">${src} · ${hits} sig${span}${near}</span>
  </div>`;
}

function bindHailZoneTap(layer, h, sub) {
  if (!layer || !window.L) return layer;
  layer.on("click", (e) => {
    window.L.DomEvent.stopPropagation(e);
    window.L.DomEvent.preventDefault(e);
    const latlng = e.latlng || layer.getBounds?.()?.getCenter?.();
    if (!latlng || !map) return;
    window.L.popup({ className: "hs-zone-popup", closeButton: true, maxWidth: 260 })
      .setLatLng(latlng)
      .setContent(hailZonePopupHtml(h, sub))
      .openOn(map);
  });
  return layer;
}

export function drawHailMarkers(hailRows, windRows, opts = {}) {
  if (!map || !window.L) return;
  lastHailRows = hailRows || [];
  lastWindRows = windRows || [];
  const requireDate = opts.requireDate === true || (opts.requireDate !== false && hailScopeMode);
  // Do not prune selection from map-visible hits — that cleared taps when a day's
  // points were off-screen or still loading. Filters/sheet own pruning.
  const nearHail = hailNearPin(hailRows || [], null);
  const collapsed = collapseHailByDate(nearHail);
  const activeDays = selectedStormDates;
  const pin = pinCoords();
  const radarN = (hailRows || []).filter(isRadarHail).length;
  const zDraw = map?.getZoom?.() ?? 14;
  const zBucket = zDraw < 9 ? 0 : zDraw < 11 ? 1 : zDraw < 13 ? 2 : 3;
  // Geometry is lat/lon — do not key the draw cache on map bounds or zones morph while panning.
  const drawSig = `${selectedStormDateSig()}|${requireDate}|${lastHailRows.length}|${lastWindRows.length}|${pin?.lat ?? ""}|${pin?.lon ?? ""}|${activeLayer}|${opts.fit ? 1 : 0}|${fieldOverlay.showHailDots !== false ? 1 : 0}|r${radarN}|z${zBucket}`;
  if (drawSig === lastHailDrawSig && hailLayer && map.hasLayer(hailLayer)) {
    syncHazardLayers();
    scheduleZoomUiRefresh();
    return;
  }
  lastHailDrawSig = drawSig;
  hailDotMarkers.length = 0;
  hailStrokeLayers.length = 0;
  applyHailStrokeZoomStyles._bucket = -1;
  if (requireDate && !activeDays.size) {
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
    hailLayer = null;
    windLayer = null;
    syncHazardLayers();
    return;
  }
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
  ensureHailPanes();
  const hailFillSvg = window.L.svg({ pane: "hailFills", padding: 0.8 });
  const hailDotSvg = window.L.svg({ pane: "hailDots", padding: 0.6 });

  const day = activeDays.size ? activeDays : null;
  // Zoomed-out overlays keep the same zone budget as close-in (detail over culling).
  const zoneLimit = day
    ? Math.min(800, Math.max(200, activeDays.size * 80) + (zDraw < 9 ? 160 : 0))
    : 36;
  const zones = collapsed
    .filter((h) => !day || day.has(h.date))
    .sort((a, b) => (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0))
    .slice(0, zoneLimit);
  const wideView = zDraw < 11;

  const fitPts = [];
  for (const h of zones) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
    const dayHits = zoneHitPool(h, hailRows || []);
    const atRoof = dayHits.filter((p) => hitDistKm(p) <= HOUSE_HAIL_KM);
    const pin = pinCoords();
    const subRings = [];
    const roofHit = (h.near_hits || 0) > 0 || atRoof.length > 0;
    // Close-in only — yellow roof ring reads as a bubble when zoomed out.
    if (roofHit && pin && !wideView) {
      const sz = atRoof.reduce((m, p) => Math.max(m, parseFloat(p.size_in) || 0), parseFloat(h.size_in) || 0);
      const col = hailZoneColor(sz);
      bindHailZoneTap(
        window.L.circle([pin.lat, pin.lon], {
          radius: Math.max(50, Math.min(140, 48 + sz * 42)),
          color: "#ffcc00",
          fillColor: col.fill,
          fillOpacity: hailZoneOpacityBoost(0.9),
          weight: 3,
          opacity: 1,
          pane: "hailDots",
          renderer: hailDotSvg,
          interactive: true,
          className: "wx-hail-pin-zone",
        }).addTo(hailLayer),
        h,
        { maxSize: sz, hits: atRoof.length || 1, source: "spot+radar" },
      );
    }
    const zoneHits = dayHits;
    for (const sub of buildDetailedZoneRings(h, zoneHits)) subRings.push(sub);
    if (!subRings.length && dayHits.length) {
      subRings.push({
        ring: topoZoneRing(h, zoneHits),
        maxSize: parseFloat(h.size_in) || parseFloat(dayHits[0]?.size_in) || 0.75,
        hits: dayHits.length,
        confirmed: dayHits.some(isSpotterHail),
        source: dayHits.some((p) => !isSpotterHail(p)) ? "spot+radar" : "spotter",
      });
    }
    // Outer / weaker first — nest stronger rings as holes (true bands, no opacity stack).
    subRings.sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));
    const sat = activeLayer === "sat";
    const bands = nestHailBandPolys(subRings);
    const fillOp = hailZoneOpacityBoost(1);
    for (const sub of bands) {
      const sz = sub.maxSize || parseFloat(h.size_in);
      const col = hailZoneColor(sz);
      const isRadarZone = /radar|mesh|swdi/i.test(String(sub.source || ""));
      const isConfirm = Boolean(sub.confirmed) || sub.source === "spot+radar" || isRadarZone;
      fitPts.push(...sub.ring);
      const stroke = hailZoneStrokeStyle(isConfirm, sz, undefined, { radar: isRadarZone });
      const holes = sub.holes || [];
      const latlngs = holes.length ? [sub.ring, ...holes] : sub.ring;
      const poly = window.L.polygon(latlngs, {
        color: col.stroke,
        fillColor: col.fill,
        fillOpacity: fillOp,
        weight: Math.max(1.2, stroke.weight + (wideView ? 0.6 : sat && zDraw < 13 ? 0.45 : 0)),
        opacity: 1,
        dashArray: wideView ? null : stroke.dashArray,
        pane: "hailFills",
        renderer: hailFillSvg,
        interactive: true,
        bubblingMouseEvents: false,
        className: isConfirm
          ? "wx-hail-topo wx-hail-confirmed"
          : isRadarZone
            ? "wx-hail-topo wx-hail-radar"
            : "wx-hail-topo",
      }).addTo(hailLayer);
      trackHailStroke(bindHailZoneTap(poly, h, sub), { confirmed: isConfirm, size: sz, kind: "zone" });
    }
    const spots = dayHits.filter(isSpotterHail);
    const radar = dayHits.filter((p) => !isSpotterHail(p));
    const zNow = map?.getZoom?.() || 14;
    // Zoomed-out storm view: continuous swaths only — dots read as bubble clutter.
    const stormOn = hasSelectedStormDates();
    const dotsAllowed = fieldOverlay.showHailDots !== false && !wideView;
    const showRadarDots = dotsAllowed && (stormOn || zNow >= 11);
    const showSpotDots = dotsAllowed && (stormOn || zNow >= 10);
    const showRadarHalos = dotsAllowed && (stormOn ? zNow >= 12 : zNow >= 15.5);
    const radarCap = stormOn ? (zNow < 9 ? 420 : 320) : 180;
    const spotCap = stormOn ? (zNow < 9 ? 280 : 200) : 120;
    const toDraw = showRadarDots || showSpotDots
      ? [...(showRadarDots ? radar.slice(0, radarCap) : []), ...(showSpotDots ? spots.slice(0, spotCap) : [])]
      : [];
    const dotUi = hailDotZoomScale(zNow);
    for (const p of toDraw) {
      const isSpot = isSpotterHail(p);
      const baseR = isSpot ? 7 : 5.5;
      const mark = window.L.circleMarker([p.lat, p.lon], {
        radius: Math.max(isSpot ? 1.4 : 0.9, baseR * dotUi),
        color: isSpot ? "#ffffff" : "#b8ff6a",
        fillColor: isSpot ? "#ff2d2d" : "#4caf2a",
        fillOpacity: isSpot ? 0.95 : 0.88,
        weight: isSpot ? 1.6 : 1.1,
        pane: "hailDots",
        renderer: hailDotSvg,
        interactive: false,
        className: isSpot ? "wx-hail-spot" : "wx-hail-radar-pt",
      });
      mark.options.baseRadius = baseR;
      hailDotMarkers.push(mark);
      if (!isSpot && showRadarHalos && dotUi >= 0.55) {
        const pSz = parseFloat(p.size_in) || 0.75;
        window.L.circle([p.lat, p.lon], {
          radius: Math.max(48, Math.min(140, 52 + pSz * 38)),
          color: "#7dff5a",
          fillColor: "#3f8f32",
          fillOpacity: 0.28 + Math.min(0.14, pSz * 0.06),
          weight: 1,
          pane: "hailDots",
          renderer: hailDotSvg,
          className: "wx-hail-radar-pt",
          interactive: false,
        }).addTo(hailLayer);
      }
      mark.addTo(hailLayer);
    }
  }

  const nearWind = windNearPin(windRows || [], null);
  const windDays = new Map();
  for (const w of nearWind) {
    const wday = String(w.date || "").slice(0, 10);
    if (!wday) continue;
    if (day && !day.has(wday)) continue;
    const mph = Number(w.wind_mph) || 0;
    const prev = windDays.get(wday);
    if (!prev || mph > (Number(prev.wind_mph) || 0)) windDays.set(wday, w);
  }
  for (const w of [...windDays.values()].slice(0, 24)) {
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) continue;
    const mph = Number(w.wind_mph) || 0;
    const stroke = hailZoneStrokeStyle(false, Math.min(2, mph / 40));
    trackHailStroke(
      window.L.polygon(ringPolygon(w.lat, w.lon, Math.max(1200, Math.min(9000, mph * 75)), 6), {
        color: "#4a9eff",
        fillColor: "#4a9eff",
        fillOpacity: 0.1,
        weight: Math.min(1.4, stroke.weight),
        opacity: Math.min(0.65, stroke.opacity),
        dashArray: stroke.dashArray || "5 6",
        interactive: false,
        className: "wx-wind-topo",
      }).addTo(windLayer),
      { confirmed: false, size: mph / 40, kind: "wind" },
    );
  }
  const showHail = hailScopeMode || wxTimelineFilters.hail || activeWxProduct === "hail";
  if (hailLayer && showHail) {
    try {
      if (!map.hasLayer(hailLayer)) hailLayer.addTo(map);
    } catch {
      /* ignore */
    }
  }
  syncHazardLayers();
  scheduleZoomUiRefresh(true);
  if (opts.fit && map) {
    const pts = [];
    if (Number.isFinite(pinLat) && Number.isFinite(pinLon)) pts.push([pinLat, pinLon]);
    for (const h of nearHail.filter((p) => !day || day.has(String(p.date || "").slice(0, 10)))) {
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
  const showHail = hailScopeMode || wxTimelineFilters.hail || activeWxProduct === "hail";
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
  const hsRadar = hailScopeRadarActive();
  for (const id of Object.keys(overlays)) {
    if (id === "radar") continue;
    let on = activeWxProduct === id || (id === "precip" && activeWxProduct === "precip");
    if (id === "precip") {
      on = (on && wxTimelineFilters.precip) || (hsRadar && hailScopeRadarFilters.precip);
    }
    if (id === "cloud" || id === "vis") on = (activeWxProduct === id || activeWxProduct === "cloud" || activeWxProduct === "vis") && wxTimelineFilters.precip;
    if (id === "wind") on = activeWxProduct === "wind" && wxTimelineFilters.wind && !hsRadar;
    try {
      if (on) overlays[id].addTo(map);
      else map.removeLayer(overlays[id]);
    } catch {
      /* ignore */
    }
  }
  const wantWindField = activeWxProduct === "wind" || (hsRadar && hailScopeRadarFilters.wind);
  if (wantWindField) refreshWindField();
  else clearWindFieldLayer();
  syncHazardLayers();
  refreshZoomScaledUi(true);
}

async function refreshWindField() {
  if (!map || !window.L) return;
  const hsRadar = hailScopeRadarActive();
  if (activeWxProduct !== "wind" && !(hsRadar && hailScopeRadarFilters.wind)) {
    clearWindFieldLayer();
    return;
  }
  if (hsRadar && hailScopeRadarFilters.wind) {
    await ensureWindFrames();
    paintWindFieldFromFrame(windFrames[windFrameIdx] || windFrames[windFrames.length - 1]);
    return;
  }
  // Legacy wind product: single current reading at map center
  const c = map.getCenter();
  if (!c) return;
  try {
    const params = new URLSearchParams({
      latitude: c.lat,
      longitude: c.lng,
      current: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      wind_speed_unit: "mph",
      timezone: "auto",
    });
    const { body } = await httpGet(`https://api.open-meteo.com/v1/forecast?${params}`, 8000);
    const data = JSON.parse(body || "{}");
    const cur = data.current || {};
    paintWindFieldFromFrame({
      speed: Number(cur.wind_speed_10m) || 0,
      gust: Number(cur.wind_gusts_10m) || Number(cur.wind_speed_10m) || 0,
      dir: Number(cur.wind_direction_10m) || 0,
      time: Date.now() / 1000,
    });
  } catch {
    /* wind field optional */
  }
}

function windHash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function stopWindNoiseAnim() {
  if (windNoise.raf) {
    cancelAnimationFrame(windNoise.raf);
    windNoise.raf = 0;
  }
  windNoise.lastTs = 0;
}

function clearWindFieldLayer() {
  stopWindNoiseAnim();
  if (windNoise.reseedTimer) {
    clearTimeout(windNoise.reseedTimer);
    windNoise.reseedTimer = 0;
  }
  if (windNoise.canvas?.parentNode) {
    try {
      windNoise.canvas.remove();
    } catch {
      /* ignore */
    }
  }
  windNoise.canvas = null;
  windNoise.ctx = null;
  windNoise.particles = [];
  windNoise.frame = null;
  if (windFieldLayer) {
    try {
      map.removeLayer(windFieldLayer);
    } catch {
      /* ignore */
    }
  }
  windFieldLayer = null;
  windFieldCenterDot = null;
}

function onWindMapGeom() {
  if (!windNoise.frame) return;
  if (windNoise.reseedTimer) clearTimeout(windNoise.reseedTimer);
  windNoise.reseedTimer = window.setTimeout(() => {
    windNoise.reseedTimer = 0;
    if (!windNoise.frame || !map) return;
    sizeWindNoiseCanvas();
    seedWindNoiseParticles();
    drawWindNoiseField(performance.now());
  }, 80);
}

function ensureWindNoiseCanvas() {
  if (!map) return null;
  if (!map.getPane("windField")) {
    map.createPane("windField");
    const pane = map.getPane("windField");
    pane.style.zIndex = 460;
    pane.style.pointerEvents = "none";
  }
  if (!windNoise.canvas) {
    const canvas = document.createElement("canvas");
    canvas.className = "hs-wind-noise";
    canvas.setAttribute("aria-hidden", "true");
    map.getPane("windField").appendChild(canvas);
    windNoise.canvas = canvas;
    windNoise.ctx = canvas.getContext("2d");
    if (!windNoise.bound) {
      windNoise.bound = true;
      map.on("move zoom resize viewreset", onWindMapGeom);
    }
  }
  sizeWindNoiseCanvas();
  return windNoise.ctx;
}

function sizeWindNoiseCanvas() {
  if (!map || !windNoise.canvas || !windNoise.ctx) return;
  const size = map.getSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  windNoise.canvas.width = Math.max(1, Math.floor(size.x * dpr));
  windNoise.canvas.height = Math.max(1, Math.floor(size.y * dpr));
  windNoise.canvas.style.width = `${size.x}px`;
  windNoise.canvas.style.height = `${size.y}px`;
  windNoise.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function seedWindNoiseParticles() {
  if (!map) return;
  const size = map.getSize();
  // Speckle density like precip noise — jittered cells, not a rigid arrow grid.
  const target = Math.min(240, Math.max(70, Math.round((size.x * size.y) / 850)));
  const aspect = size.x / Math.max(1, size.y);
  const cols = Math.max(5, Math.round(Math.sqrt(target * aspect)));
  const rows = Math.max(5, Math.round(target / cols));
  const particles = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const jx = windHash01(id * 3.17 + 0.71);
      const jy = windHash01(id * 5.91 + 1.37);
      particles.push({
        x: ((c + jx) / cols) * size.x,
        y: ((r + jy) / rows) * size.y,
        phase: windHash01(id * 9.23),
        lenJ: 0.55 + windHash01(id * 2.41) * 0.9,
        dirJ: (windHash01(id * 4.13) - 0.5) * 22,
        alpha: 0.22 + windHash01(id * 6.61) * 0.58,
      });
      id += 1;
    }
  }
  windNoise.particles = particles;
}

function drawWindNoiseField(ts) {
  const ctx = windNoise.ctx;
  const frame = windNoise.frame;
  if (!ctx || !frame || !map) return;
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);
  const spd = Number(frame.speed) || 0;
  const gust = Number(frame.gust) || spd;
  // Meteorological FROM → flow TO (0 = north).
  const baseTo = (((Number(frame.dir) || 0) + 180) * Math.PI) / 180;
  const baseLen = Math.max(5, Math.min(16, 4.5 + spd * 0.26));
  const pulseBoost = 0.55 + Math.min(0.45, gust / 55);

  for (const p of windNoise.particles) {
    const ang = baseTo + (p.dirJ * Math.PI) / 180;
    const breathe = 0.88 + 0.12 * Math.sin(ts / 1100 + p.phase * 6.283);
    const len = baseLen * p.lenJ * breathe;
    const sx = Math.sin(ang) * len;
    const sy = -Math.cos(ang) * len;
    const x0 = p.x - sx * 0.4;
    const y0 = p.y - sy * 0.4;
    const x1 = p.x + sx * 0.6;
    const y1 = p.y + sy * 0.6;
    ctx.globalAlpha = Math.min(0.92, p.alpha * pulseBoost);
    ctx.strokeStyle = WIND_FIELD_COLOR;
    ctx.fillStyle = WIND_FIELD_COLOR;
    ctx.lineWidth = 1.25;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // Tiny tip — reads as motion flecks, not a heavy arrow grid.
    const tip = Math.max(2.2, len * 0.22);
    const ax = Math.sin(ang + 2.7) * tip;
    const ay = -Math.cos(ang + 2.7) * tip;
    const bx = Math.sin(ang - 2.7) * tip;
    const by = -Math.cos(ang - 2.7) * tip;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + ax, y1 + ay);
    ctx.lineTo(x1 + bx, y1 + by);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function startWindNoiseAnim() {
  if (windNoise.raf) return;
  const loop = (ts) => {
    const want =
      windNoise.frame &&
      map &&
      (activeWxProduct === "wind" || (hailScopeRadarActive() && hailScopeRadarFilters.wind));
    if (!want) {
      windNoise.raf = 0;
      return;
    }
    const frame = windNoise.frame;
    const spd = Number(frame.speed) || 0;
    const ang = (((Number(frame.dir) || 0) + 180) * Math.PI) / 180;
    const dt = windNoise.lastTs ? Math.min(48, ts - windNoise.lastTs) : 16;
    windNoise.lastTs = ts;
    // Slow advection — suggests flow without thrashing markers.
    const drift = (0.012 + spd * 0.00105) * dt;
    const size = map.getSize();
    const pad = 24;
    for (const p of windNoise.particles) {
      p.x += Math.sin(ang) * drift;
      p.y += -Math.cos(ang) * drift;
      if (p.x < -pad) p.x += size.x + pad * 2;
      else if (p.x > size.x + pad) p.x -= size.x + pad * 2;
      if (p.y < -pad) p.y += size.y + pad * 2;
      else if (p.y > size.y + pad) p.y -= size.y + pad * 2;
    }
    drawWindNoiseField(ts);
    windNoise.raf = requestAnimationFrame(loop);
  };
  windNoise.raf = requestAnimationFrame(loop);
}

function paintWindFieldFromFrame(frame) {
  if (!map || !frame) return;
  windNoise.frame = frame;
  ensureWindNoiseCanvas();
  if (!windNoise.particles.length) seedWindNoiseParticles();
  drawWindNoiseField(performance.now());
  startWindNoiseAnim();
  updateWindScrubLabel(frame);
  updateHailScopeLiveLabel(frame.time);
}

function updateWindScrubLabel(frame) {
  const label = document.getElementById("wx-wind-label");
  if (!label || !frame) return;
  const d = new Date((frame.time || 0) * 1000);
  const when = Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
  label.textContent = `${Math.round(frame.speed || 0)} mph${when ? ` · ${when}` : ""}`;
}

async function ensureWindFrames({ force = false } = {}) {
  if (!map) return;
  if (windFrames.length && !force) return;
  const c = map.getCenter();
  if (!c) return;
  const gen = ++windFetchGen;
  try {
    const params = new URLSearchParams({
      latitude: c.lat,
      longitude: c.lng,
      hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      past_days: "1",
      forecast_days: "1",
      wind_speed_unit: "mph",
      timezone: "auto",
    });
    const { body } = await httpGet(`https://api.open-meteo.com/v1/forecast?${params}`, 10000);
    if (gen !== windFetchGen) return;
    const data = JSON.parse(body || "{}");
    const h = data.hourly || {};
    const times = h.time || [];
    const speeds = h.wind_speed_10m || [];
    const dirs = h.wind_direction_10m || [];
    const gusts = h.wind_gusts_10m || [];
    const frames = [];
    const now = Date.now() / 1000;
    for (let i = 0; i < times.length; i++) {
      const t = Date.parse(times[i]);
      if (!Number.isFinite(t)) continue;
      const sec = t / 1000;
      // Keep roughly last 12h through next 12h for a precip-like scrub window
      if (sec < now - 12 * 3600 || sec > now + 12 * 3600) continue;
      frames.push({
        time: sec,
        speed: Number(speeds[i]) || 0,
        gust: Number(gusts[i]) || Number(speeds[i]) || 0,
        dir: Number(dirs[i]) || 0,
      });
    }
    if (!frames.length) return;
    windFrames = frames;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i].time - now);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    windFrameIdx = nearest;
  } catch {
    /* wind timeline optional */
  }
}

export function setWindFrame(idx) {
  if (!windFrames.length) return;
  const i = Math.max(0, Math.min(windFrames.length - 1, Number(idx) || 0));
  windFrameIdx = i;
  const frame = windFrames[i];
  paintWindFieldFromFrame(frame);
  const windRange = document.getElementById("wx-wind-range");
  if (windRange && String(windRange.value) !== String(i)) windRange.value = String(i);
}

export function stopWindPlay() {
  windPlaying = false;
  if (windPlayTimer) {
    clearTimeout(windPlayTimer);
    windPlayTimer = 0;
  }
  const btn = document.getElementById("wx-wind-play");
  if (btn) {
    btn.textContent = "PLAY";
    btn.classList.remove("on");
  }
}

export function bindWindScrubber(root = document) {
  const range = root.querySelector?.("#wx-wind-range") || document.getElementById("wx-wind-range");
  const play = root.querySelector?.("#wx-wind-play") || document.getElementById("wx-wind-play");
  if (!range) return;
  setWindFrame(windFrameIdx);
  range.oninput = () => {
    stopWindPlay();
    setWindFrame(range.value);
  };
  if (play) {
    play.onclick = () => {
      if (windPlaying) {
        stopWindPlay();
        return;
      }
      if (windFrames.length < 2) return;
      play.textContent = "PAUSE";
      play.classList.add("on");
      windPlaying = true;
      const tick = () => {
        if (!windPlaying) return;
        const next = (windFrameIdx + 1) % windFrames.length;
        setWindFrame(next);
        windPlayTimer = window.setTimeout(tick, 700);
      };
      tick();
    };
  }
}

function stopMyLocation() {
  if (typeof meStop === "function") {
    try {
      meStop();
    } catch {
      /* ignore */
    }
  }
  meStop = null;
  meMarker = null;
  meRing = null;
  lastMe = null;
  locateBtnEl = null;
}

function ensureMePane() {
  if (!map.getPane("meDot")) {
    map.createPane("meDot");
    map.getPane("meDot").style.zIndex = 680;
  }
  if (!map.getPane("meRing")) {
    map.createPane("meRing");
    map.getPane("meRing").style.zIndex = 455;
    map.getPane("meRing").style.pointerEvents = "none";
  }
}

function hideMyLocationLayers() {
  if (meMarker) {
    try {
      map.removeLayer(meMarker);
    } catch {
      /* ignore */
    }
    meMarker = null;
  }
  if (meRing) {
    try {
      map.removeLayer(meRing);
    } catch {
      /* ignore */
    }
    meRing = null;
  }
}

function drawMyLocationLayers(hit) {
  if (!map || !window.L || !hit) return;
  const { lat, lon } = hit;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  ensureMePane();
  const acc = Number(hit.acc);
  const radius = Number.isFinite(acc) && acc > 8 && acc < 400 ? acc : 0;
  if (radius) {
    if (meRing) meRing.setLatLng([lat, lon]).setRadius(radius);
    else {
      meRing = window.L.circle([lat, lon], {
        pane: "meRing",
        radius,
        color: "#3b82f6",
        weight: 1,
        fillColor: "#3b82f6",
        fillOpacity: 0.14,
        interactive: false,
      }).addTo(map);
    }
  } else if (meRing) {
    try {
      map.removeLayer(meRing);
    } catch {
      /* ignore */
    }
    meRing = null;
  }
  if (meMarker) meMarker.setLatLng([lat, lon]);
  else {
    meMarker = window.L.marker([lat, lon], {
      pane: "meDot",
      interactive: false,
      keyboard: false,
      zIndexOffset: 800,
      icon: window.L.divIcon({
        className: "hs-me",
        html: "<i></i>",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    }).addTo(map);
  }
}

export function setMyLocationVisible(on) {
  showMyLocation = on !== false;
  syncMyLocationDot();
  // Turning back on: nudge a fresh GPS fix so the blue dot can reappear
  if (showMyLocation && map) {
    locateDevice({}, httpGet, { force: true })
      .then((hit) => {
        if (hit && showMyLocation) updateMyLocation(hit);
      })
      .catch(() => {
        /* keep watching via watchGps */
      });
  }
}

function syncMyLocationDot() {
  if (!map) return;
  if (!showMyLocation || !lastMe) {
    hideMyLocationLayers();
    if (locateBtnEl) locateBtnEl.classList.toggle("on", showMyLocation && Boolean(lastMe));
    return;
  }
  drawMyLocationLayers(lastMe);
  if (locateBtnEl) locateBtnEl.classList.add("on");
}

function updateMyLocation(hit) {
  if (!hit) return;
  const { lat, lon } = hit;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  lastMe = hit;
  syncMyLocationDot();
}

function panToMe() {
  if (!map || !lastMe) return;
  const z = Math.max(map.getZoom(), HOUSE_ZOOM);
  map.setView([lastMe.lat, lastMe.lon], z, { animate: true });
  const shell = document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  if (shell?.classList.contains("expanded")) revealHailAddressPeek();
}

function isPhoneUi() {
  try {
    if (window.Capacitor?.getPlatform?.() === "android" || window.Capacitor?.getPlatform?.() === "ios") return true;
  } catch {
    /* web */
  }
  return window.matchMedia?.("(pointer: coarse)").matches === true;
}

function addLocateControl() {
  if (!map || !window.L) return;
  const Ctl = window.L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const wrap = window.L.DomUtil.create("div", "leaflet-bar hs-locate-ctl");
      const btn = window.L.DomUtil.create("a", "hs-locate-btn", wrap);
      btn.href = "#";
      btn.title = "My location";
      btn.setAttribute("aria-label", "My location");
      btn.innerHTML = "<span></span>";
      window.L.DomEvent.disableClickPropagation(wrap);
      window.L.DomEvent.on(btn, "click", (e) => {
        window.L.DomEvent.stop(e);
        panToMe();
      });
      locateBtnEl = btn;
      if (lastMe) btn.classList.add("on");
      return wrap;
    },
  });
  new Ctl().addTo(map);
}

function startMyLocation() {
  if (typeof meStop === "function") {
    try {
      meStop();
    } catch {
      /* ignore */
    }
    meStop = null;
  }
  meStop = watchGps(updateMyLocation);
}

function stopHouseNumbers() {
  if (houseTimer) {
    clearTimeout(houseTimer);
    houseTimer = 0;
  }
  houseGen += 1;
  houseCache = { key: "", rings: [], nums: [] };
  housePaintSig = "";
  if (houseLayer) {
    try {
      houseLayer.clearLayers();
    } catch {
      /* ignore */
    }
  }
}

function ensureHousePane() {
  if (!map.getPane("houseNums")) {
    map.createPane("houseNums");
    const pane = map.getPane("houseNums");
    pane.style.zIndex = 625;
    pane.style.pointerEvents = "none";
  }
  if (!houseLayer) houseLayer = window.L.layerGroup().addTo(map);
}

function escHouseNum(s) {
  return String(s || "").replace(/[<>&"'`]/g, "").slice(0, 10);
}

function scheduleHouseNumbers() {
  if (Date.now() < houseHoldUntil || mapBusy > 0) return;
  if (houseTimer) clearTimeout(houseTimer);
  houseTimer = setTimeout(() => {
    houseTimer = 0;
    if (Date.now() < houseHoldUntil || mapBusy > 0) return;
    refreshHouseNumbers();
  }, 750);
}

function holdHouseOutlines(ms = 1500) {
  houseHoldUntil = Date.now() + ms;
  if (houseTimer) {
    clearTimeout(houseTimer);
    houseTimer = 0;
  }
}

function buildingStyle() {
  const sat = activeLayer === "sat";
  const night = activeLayer === "dark";
  return {
    pane: "houseNums",
    interactive: false,
    color: "#ffcc00",
    weight: sat ? 1.15 : 2,
    fillColor: "#ffcc00",
    fillOpacity: sat ? 0.03 : night ? 0.1 : 0.05,
    opacity: 1,
  };
}

function overpassRing(el) {
  const g = el?.geometry;
  if (!Array.isArray(g) || g.length < 4) return null;
  const ring = [];
  for (const p of g) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    ring.push([lat, lon]);
  }
  return ring;
}

function esriRingToLatLngs(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const out = [];
  for (const pt of ring) {
    const lon = Number(pt?.[0]);
    const lat = Number(pt?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    out.push([lat, lon]);
  }
  return out;
}

function isOutbuilding(v) {
  return /^(y|yes|true|1|out|outbuilding)$/i.test(String(v || "").trim());
}

function houseBoundsKey(b, z) {
  const q = z >= 18 ? 0.0015 : z >= 16 ? 0.003 : 0.006;
  const r = (v) => Math.round(v / q);
  return `${z}|${r(b.getSouth())}|${r(b.getWest())}|${r(b.getNorth())}|${r(b.getEast())}`;
}

function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const last = ring[ring.length - 1];
  const closed = ring[0][0] === last[0] && ring[0][1] === last[1];
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 3) return null;
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < n; i++) {
    lat += ring[i][0];
    lon += ring[i][1];
  }
  return { lat: lat / n, lon: lon / n };
}

function paintHouseLayer(rings, nums, style) {
  const sig = `${houseCache.key}|${(nums || []).length}`;
  if (sig === housePaintSig && houseLayer?.getLayers?.().length) return;
  housePaintSig = sig;
  houseLayer.clearLayers();
  for (const n of nums || []) {
    const icon = window.L.divIcon({
      className: "hs-housenum",
      html: `<span>${n.num}</span>`,
      iconSize: [44, 16],
      iconAnchor: [22, 8],
    });
    window.L.marker([n.lat, n.lon], {
      icon,
      pane: "houseNums",
      interactive: false,
      keyboard: false,
    }).addTo(houseLayer);
  }
}

async function arcgisGet(url, timeoutMs = 14000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      return { body: await res.text(), status: res.status };
    } finally {
      clearTimeout(t);
    }
  } catch {
    return httpGet(url, timeoutMs);
  }
}

function envelopeGeom(south, west, north, east) {
  return JSON.stringify({
    xmin: west,
    ymin: south,
    xmax: east,
    ymax: north,
    spatialReference: { wkid: 4326 },
  });
}

async function arcgisObjectIds(url, south, west, north, east) {
  const q = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnIdsOnly: "true",
    geometry: envelopeGeom(south, west, north, east),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  const { body } = await arcgisGet(`${url}?${q}`, 12000);
  const data = JSON.parse(body || "{}");
  const ids = Array.isArray(data.objectIds) ? data.objectIds : [];
  return ids.slice(0, HOUSE_FOOTPRINT_MAX);
}

async function arcgisRingsByIds(url, ids, outFields, keep) {
  const rings = [];
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const q = new URLSearchParams({
      f: "json",
      objectIds: chunk.join(","),
      returnGeometry: "true",
      outSR: "4326",
      outFields,
      geometryPrecision: "6",
    });
    const { body } = await arcgisGet(`${url}?${q}`, 14000);
    const data = JSON.parse(body || "{}");
    for (const f of data.features || []) {
      if (keep && !keep(f.attributes || {})) continue;
      const ring = esriRingToLatLngs((f.geometry?.rings || [])[0]);
      if (ring) rings.push(ring);
    }
  }
  return rings;
}

async function fetchStructureFootprints(south, west, north, east) {
  try {
    const ids = await arcgisObjectIds(FEMA_STRUCTURES, south, west, north, east);
    if (ids.length) {
      const rings = await arcgisRingsByIds(FEMA_STRUCTURES, ids, "OBJECTID,OUTBLDG,SQFEET", (a) => {
        if (isOutbuilding(a.OUTBLDG)) return false;
        const sq = Number(a.SQFEET);
        return !Number.isFinite(sq) || sq >= 400;
      });
      if (rings.length) return rings;
    }
  } catch {
    /* Microsoft footprints next */
  }
  try {
    const ids = await arcgisObjectIds(MS_BUILDINGS, south, west, north, east);
    if (!ids.length) return [];
    return arcgisRingsByIds(MS_BUILDINGS, ids, "OBJECTID", () => true);
  } catch {
    return [];
  }
}

async function fetchOsmHouseData(south, west, north, east) {
  const q = `[out:json][timeout:15][bbox:${south},${west},${north},${east}];(way["building"];node["addr:housenumber"];way["addr:housenumber"];);out tags center geom;`;
  const urls = [
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`,
    `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(q)}`,
    `https://overpass.osm.ch/api/interpreter?data=${encodeURIComponent(q)}`,
  ];
  let data = null;
  for (const url of urls) {
    try {
      const { body } = await httpGet(url, 14000);
      data = JSON.parse(body || "{}");
      if (data && Array.isArray(data.elements)) break;
    } catch {
      /* try next Overpass host */
    }
  }
  const rings = [];
  const nums = [];
  const seen = new Set();
  for (const el of data?.elements || []) {
    if (el.type === "way" && el.tags?.building && rings.length < HOUSE_FOOTPRINT_MAX) {
      const ring = overpassRing(el);
      if (ring) rings.push(ring);
    }
    const num = escHouseNum(el.tags?.["addr:housenumber"]);
    if (!num || nums.length >= HOUSE_NUM_MAX) continue;
    const lat = Number(el.lat ?? el.center?.lat);
    const lon = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${num}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nums.push({
      num,
      lat,
      lon,
      street: String(el.tags?.["addr:street"] || "").trim(),
      city: String(el.tags?.["addr:city"] || "").trim(),
      zip: String(el.tags?.["addr:postcode"] || "").trim(),
    });
  }
  return { rings, nums };
}

async function refreshHouseNumbers() {
  if (!map || !window.L) return;
  ensureHousePane();
  const z = map.getZoom();
  const b = map.getBounds();
  if (z < HOUSE_NUM_ZOOM || !b || b.getNorth() - b.getSouth() > 0.035 || b.getEast() - b.getWest() > 0.05) {
    houseLayer.clearLayers();
    houseCache = { key: "", rings: [], nums: [] };
    housePaintSig = "";
    return;
  }
  const key = houseBoundsKey(b, z);
  if (houseCache.key === key && houseCache.nums.length) {
    paintHouseLayer([], houseCache.nums);
    return;
  }
  const padB = b.pad(0.18);
  const south = padB.getSouth();
  const west = padB.getWest();
  const north = padB.getNorth();
  const east = padB.getEast();
  const gen = ++houseGen;
  const osm = await fetchOsmHouseData(south, west, north, east).catch(() => ({ rings: [], nums: [] }));
  if (gen !== houseGen || !map) return;
  const nums = osm.nums || [];
  houseCache = { key, rings: [], nums };
  paintHouseLayer([], nums);
}

function stopFieldOverlay() {
  if (markLayer) {
    try {
      markLayer.clearLayers();
      markLayer.remove();
    } catch {
      /* ignore */
    }
  }
  if (doneLayer) {
    try {
      doneLayer.clearLayers();
      doneLayer.remove();
    } catch {
      /* ignore */
    }
  }
  markLayer = null;
  doneLayer = null;
}

function ensureFieldPanes() {
  if (!map.getPane("fieldMarks")) {
    map.createPane("fieldMarks");
    map.getPane("fieldMarks").style.zIndex = 660;
  }
  if (!map.getPane("doneHouses")) {
    map.createPane("doneHouses");
    map.getPane("doneHouses").style.zIndex = 655;
  }
}

function markDivIcon(mark, zoomUi = zoomUiScale()) {
  const meta = kindMeta(mark.kind);
  const prod = String(mark.productId || "").replace(/[^a-z0-9:-]/gi, "");
  const text = markBadge(mark);
  const scale = clampPinScale(mark.iconScale) * zoomUi;
  const w = Math.round(52 * scale);
  const h = Math.round(22 * scale);
  const fs = Math.max(9, Math.round(11 * scale));
  return window.L.divIcon({
    className: `hs-mark hs-mark-${meta.id}${prod ? ` hs-mark-p` : ""}`,
    html: `<span style="background:${markTint(mark)};font-size:${fs}px;transform:scale(1);line-height:1.1">${text}</span>`,
    iconSize: [w, h],
    iconAnchor: [Math.round(w / 2), h],
  });
}

function donePinIcon(scaleRaw = 1, zoomUi = zoomUiScale()) {
  const scale = clampPinScale(scaleRaw) * zoomUi;
  const w = Math.round(25 * scale);
  const h = Math.round(41 * scale);
  return window.L.divIcon({
    className: "hs-done-pin",
    html: `<svg viewBox="0 0 32 48" style="width:${w}px;height:${h}px" width="${w}" height="${h}" aria-hidden="true"><path fill="#ffcc00" fill-rule="evenodd" d="M16 0C7.16 0 0 7.16 0 16c0 11.2 16 32 16 32s16-20.8 16-32C32 7.16 24.84 0 16 0zm0 21.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z"/></svg>`,
    iconSize: [w, h],
    iconAnchor: [Math.round(w * 0.48), h],
  });
}

let pinScalePopover = null;
let pinScaleMoveOff = null;

export function updatePinScaleLive(kind, id, item) {
  const ref = kind === "done" ? livePinMarkers.done.get(String(id)) : livePinMarkers.marks.get(String(id));
  if (!ref) return false;
  if (kind === "done") ref.setIcon(donePinIcon(item?.iconScale, zoomUiScale()));
  else ref.setIcon(markDivIcon(item, zoomUiScale()));
  return true;
}

export function applyDonePinScaleLive(scale) {
  if (!map) return;
  const next = clampPinScale(scale);
  fieldOverlay.donePinScale = next;
  lastZoomUiScale = 0;
  const ui = zoomUiScale();
  for (const marker of livePinMarkers.done.values()) {
    marker.setIcon(donePinIcon(next, ui));
  }
  scheduleZoomUiRefresh(true);
}

export function hidePinScalePopover() {
  if (pinScaleMoveOff) {
    try {
      pinScaleMoveOff();
    } catch {
      /* ignore */
    }
    pinScaleMoveOff = null;
  }
  if (pinScalePopover) {
    pinScalePopover.remove();
    pinScalePopover = null;
  }
}

/** Small slider popover — hold a done/mark pin to open. */
export function showPinScalePopover({ lat, lon, scale = 1, title = "Pin size", onChange, onDone }) {
  hidePinScalePopover();
  const shell = document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  if (!map || !shell || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const pop = document.createElement("div");
  pop.className = "hs-pin-scale-pop";
  const pct = Math.round(clampPinScale(scale) * 100);
  pop.innerHTML = `<strong>${String(title || "Pin size").replace(/[<>&]/g, "")}</strong>
    <input type="range" min="25" max="250" step="5" value="${pct}" aria-label="Pin size" />
    <span class="hs-pin-scale-val">${pct}%</span>
    <button type="button" class="hs-pin-scale-done">Done</button>`;
  shell.appendChild(pop);
  pinScalePopover = pop;

  const place = () => {
    const pt = map.latLngToContainerPoint([lat, lon]);
    const rect = shell.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.width - 168, pt.x - 84));
    const top = Math.max(8, pt.y - 72);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };
  place();
  pinScaleMoveOff = () => {
    map.off("move zoom", place);
  };
  map.on("move zoom", place);

  const slider = pop.querySelector("input");
  const val = pop.querySelector(".hs-pin-scale-val");
  slider.oninput = () => {
    const next = clampPinScale(Number(slider.value) / 100);
    if (val) val.textContent = `${Math.round(next * 100)}%`;
    onChange?.(next);
  };
  pop.querySelector(".hs-pin-scale-done")?.addEventListener("click", () => {
    onDone?.(clampPinScale(Number(slider.value) / 100));
    hidePinScalePopover();
  });
}

function bindPinScaleHold(marker, { onHold }) {
  if (!marker || typeof onHold !== "function") return;
  const HOLD_MS = 520;
  let timer = 0;
  let start = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
    start = null;
  };
  const fire = (e) => {
    clear();
    if (e) window.L.DomEvent.stopPropagation(e);
    wxSuppressMapTap = true;
    holdHouseOutlines(1800);
    onHold();
    setTimeout(() => {
      wxSuppressMapTap = false;
    }, 450);
  };
  const arm = (e) => {
    window.L.DomEvent.stopPropagation(e);
    const oe = e.originalEvent || e;
    if (oe.touches && oe.touches.length > 1) return;
    start = oe.touches?.[0] || oe;
    timer = setTimeout(() => fire(e), HOLD_MS);
  };
  const move = (e) => {
    if (!start) return;
    const oe = e.originalEvent || e;
    const pt = oe.touches?.[0] || oe;
    if (Math.abs(pt.clientX - start.clientX) > 12 || Math.abs(pt.clientY - start.clientY) > 12) clear();
  };
  marker.on("mousedown", arm);
  marker.on("touchstart", arm);
  marker.on("mousemove", move);
  marker.on("touchmove", move);
  marker.on("mouseup", clear);
  marker.on("touchend", clear);
  marker.on("contextmenu", (e) => fire(e));
}

function ensureSelectPane() {
  if (!map.getPane("selectPin")) {
    map.createPane("selectPin");
    map.getPane("selectPin").style.zIndex = 670;
  }
}

function placeSelectPin(latlng) {
  if (!map || !window.L || !latlng) return;
  ensureSelectPane();
  selectPinClearReadyAt = Date.now() + 420;
  if (pin) {
    pin.setLatLng(latlng);
    // After clear/remove, the marker object can linger without being on the map
    if (!map.hasLayer(pin)) {
      try {
        pin.addTo(map);
      } catch {
        pin = null;
      }
    }
  }
  if (!pin) {
    pin = window.L.marker(latlng, {
      pane: "selectPin",
      keyboard: false,
      zIndexOffset: 900,
      icon: selectPinIcon(),
      title: "Tap to clear",
      alt: "Selected house — tap to clear",
    }).addTo(map);
  }
  wireSelectPinClear(pin);
}

export function setFieldOverlay({
  marks = [],
  done = [],
  donePinScale = 1,
  showMarks = true,
  showDone = true,
  showHailDots = true,
  onMark,
  onDone,
  onMarkScale,
} = {}) {
  const prevDots = fieldOverlay.showHailDots !== false;
  fieldOverlay = { marks, done, donePinScale, showMarks, showDone, showHailDots, onMark, onMarkScale, onDone };
  if (prevDots !== (showHailDots !== false) && (lastHailRows.length || lastWindRows.length)) {
    lastHailDrawSig = "";
    drawHailMarkers(lastHailRows, lastWindRows);
  }
  if (!map || !window.L) return;
  ensureFieldPanes();
  if (!markLayer) markLayer = window.L.layerGroup().addTo(map);
  if (!doneLayer) doneLayer = window.L.layerGroup().addTo(map);
  markLayer.clearLayers();
  doneLayer.clearLayers();
  livePinMarkers.marks.clear();
  livePinMarkers.done.clear();
  if (showMarks) {
    for (const m of marks || []) {
      if (!validMarkCoord(m.lat, m.lon)) continue;
      const tint = markTint(m);
      if (m.kind === "zone" && Number(m.radiusM) > 0) {
        window.L.circle([m.lat, m.lon], {
          pane: "fieldMarks",
          radius: Number(m.radiusM),
          color: tint,
          weight: 2,
          fillColor: tint,
          fillOpacity: 0.16,
          interactive: true,
        })
          .on("click", (e) => {
            window.L.DomEvent.stop(e);
            onMark?.(m);
          })
          .addTo(markLayer);
      }
      const marker = window.L.marker([m.lat, m.lon], {
        pane: "fieldMarks",
        icon: markDivIcon(m),
        keyboard: false,
      })
        .on("click", (e) => {
          window.L.DomEvent.stop(e);
          onMark?.(m);
        })
        .addTo(markLayer);
      livePinMarkers.marks.set(String(m.id), marker);
      bindPinScaleHold(marker, {
        onHold: () => {
          if (typeof onMarkScale !== "function") return;
          showPinScalePopover({
            lat: m.lat,
            lon: m.lon,
            scale: m.iconScale,
            title: m.label || kindMeta(m.kind).label,
            onChange: (s) => onMarkScale(m, s, { live: true }),
            onDone: (s) => onMarkScale(m, s, { live: false }),
          });
        },
      });
    }
  }
  if (showDone) {
    for (const h of done || []) {
      if (!validMarkCoord(h.lat, h.lon)) continue;
      const marker = window.L.marker([h.lat, h.lon], {
        pane: "doneHouses",
        icon: donePinIcon(donePinScale),
        keyboard: false,
        title: h.address || "Completed house",
      })
        .on("click", (e) => {
          window.L.DomEvent.stop(e);
          wxSuppressMapTap = true;
          holdHouseOutlines(2000);
          onDone?.(h);
          setTimeout(() => {
            wxSuppressMapTap = false;
          }, 500);
        })
        .addTo(doneLayer);
      livePinMarkers.done.set(String(h.id), marker);
    }
  }
  scheduleZoomUiRefresh(true);
}

function bindLongPress(onHold) {
  if (!map || typeof onHold !== "function") return;
  const HOLD_MS = 560;
  let timer = 0;
  let startPt = null;
  let lastFire = 0;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    startPt = null;
  };
  const fire = (latlng) => {
    if (!latlng) return;
    const now = Date.now();
    if (now - lastFire < 700) return;
    lastFire = now;
    wxSuppressMapTap = true;
    try {
      onHold(latlng.lat, latlng.lng);
    } catch {
      /* composer optional */
    }
    setTimeout(() => {
      wxSuppressMapTap = false;
    }, 550);
  };
  const start = (e) => {
    const orig = e.originalEvent;
    if (orig && orig.touches && orig.touches.length > 1) {
      clear();
      return;
    }
    startPt = e.containerPoint;
    const ll = e.latlng;
    timer = setTimeout(() => {
      timer = 0;
      fire(ll);
    }, HOLD_MS);
  };
  const move = (e) => {
    if (!startPt || !e.containerPoint) return;
    if (e.containerPoint.distanceTo(startPt) > 18) clear();
  };
  map.on("mousedown", start);
  map.on("touchstart", start);
  map.on("mousemove", move);
  map.on("touchmove", move);
  map.on("mouseup", clear);
  map.on("touchend", clear);
  map.on("dragstart", clear);
  map.on("contextmenu", (e) => {
    try {
      window.L.DomEvent.preventDefault(e);
      window.L.DomEvent.stop(e);
    } catch {
      /* ignore */
    }
    fire(e.latlng);
  });
}

function bindPinchZoomInertia(leafletMap) {
  const el = leafletMap.getContainer();
  let tracking = false;
  let samples = [];
  let focal = null;

  const stopCoast = () => {
    try {
      leafletMap.stop();
    } catch {
      /* ignore */
    }
  };

  const pinchSpan = (touches) => {
    if (touches.length < 2) return 0;
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  };

  const pinchFocal = (touches) => {
    if (touches.length < 2) return leafletMap.getCenter();
    const rect = el.getBoundingClientRect();
    const x = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
    const y = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
    return leafletMap.containerPointToLatLng([x, y]);
  };

  const onStart = (e) => {
    if (e.touches.length !== 2) return;
    stopCoast();
    tracking = true;
    focal = pinchFocal(e.touches);
    samples = [{ t: performance.now(), z: leafletMap.getZoom(), span: pinchSpan(e.touches) }];
  };

  const onMove = (e) => {
    if (!tracking || e.touches.length < 2) return;
    const now = performance.now();
    focal = pinchFocal(e.touches);
    samples.push({ t: now, z: leafletMap.getZoom(), span: pinchSpan(e.touches) });
    while (samples.length > 2 && now - samples[0].t > 240) samples.shift();
  };

  const onEnd = (e) => {
    if (e.touches.length >= 2) return;
    if (!tracking) return;
    tracking = false;
    const now = performance.now();
    const win = samples.filter((s) => now - s.t <= 220);
    if (win.length < 2 || !focal) return;

    const first = win[0];
    const last = win[win.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.035) return;

    const zoomVel = (last.z - first.z) / dt;
    const avgSpan = Math.max(1, (first.span + last.span) / 2);
    const spanVel = (last.span - first.span) / dt;
    const spanZoomVel = (spanVel / avgSpan) * 2.8;
    let vel = zoomVel * 0.5 + spanZoomVel * 0.5;
    vel = Math.max(-7, Math.min(7, vel * 0.92));
    if (Math.abs(vel) < 0.28) return;

    const minZ = leafletMap.getMinZoom();
    const maxZ = leafletMap.getMaxZoom();
    const z = leafletMap.getZoom();
    const targetZ = Math.max(minZ, Math.min(maxZ, z + vel * 0.3));
    if (Math.abs(targetZ - z) < 0.08) return;
    const duration = Math.min(0.48, 0.16 + Math.abs(vel) * 0.04);
    leafletMap.flyTo(focal, targetZ, { duration, easeLinearity: 0.28, animate: true });
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", onEnd, { passive: true });
  el.addEventListener("touchcancel", onEnd, { passive: true });

  return () => {
    stopCoast();
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onEnd);
  };
}

export function destroyMap() {
  stopRadarPlay();
  stopWindPlay();
  stopHourPlay();
  stopMyLocation();
  stopHouseNumbers();
  stopFieldOverlay();
  hidePinScalePopover();
  clearWindFieldLayer();
  windNoise.bound = false;
  windFrames = [];
  windFrameIdx = 0;
  liveTlIdx = 0;
  houseLayer = null;
  lastHailDrawSig = "";
  lastSyncHailN = 0;
  lastSyncRadarN = 0;
  if (selectedStormRedrawTimer) {
    clearTimeout(selectedStormRedrawTimer);
    selectedStormRedrawTimer = 0;
  }
  pendingSelectedStormRows = null;
  mapBusy = 0;
  hailDotMarkers.length = 0;
  hailStrokeLayers.length = 0;
  applyHailStrokeZoomStyles._bucket = -1;
  windFieldCenterDot = null;
  lastZoomUiScale = 0;
  if (zoomUiFrame) {
    cancelAnimationFrame(zoomUiFrame);
    zoomUiFrame = 0;
  }
  livePinMarkers.marks.clear();
  livePinMarkers.done.clear();
  if (map) {
    try {
      map._pinchInertiaOff?.();
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
  clearStormDateSelection();
  hailSearchQ = "";
  layers = {};
  overlays = {};
  radarLayers = [null, null];
  radarActiveSlot = 0;
  radarPlaying = false;
  activeOverlays = new Set(["precip"]);
  activeWxProduct = "precip";
}

export function mountMap(container, config, { onTap, onHold, center, product, base, initialPin = true } = {}) {
  if (!window.L) throw new Error("Leaflet not loaded");
  destroyMap();
  const c = center || config.center || { lat: 0, lon: 0 };
  const zoom = Math.abs(c.lat) < 1 && Math.abs(c.lon) < 1 ? 3 : HOUSE_ZOOM;
  map = window.L.map(container, {
    zoomControl: false,
    preferCanvas: false,
    scrollWheelZoom: true,
    touchZoom: true,
    doubleClickZoom: false,
    fadeAnimation: false,
    zoomAnimationThreshold: 4,
    maxZoom: MAP_MAX_ZOOM,
    minZoom: MAP_MIN_ZOOM,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    inertia: true,
    inertiaDeceleration: 2800,
    inertiaMaxSpeed: 1600,
  }).setView([c.lat, c.lon], zoom);
  map._pinchInertiaOff = bindPinchZoomInertia(map);
  if (container?.style) {
    container.style.background = "#000";
    container.style.position = "absolute";
    container.style.inset = "0";
    container.style.width = "100%";
    container.style.height = "100%";
  }
  if (!isPhoneUi()) {
    window.L.control.zoom({ position: "bottomleft" }).addTo(map);
  }
  const all = config.layers || [];
  for (const layer of all) {
    if (layer.synthetic || !layer.url) continue;
    const isWx = layer.kind === "wx" || layer.kind === "overlay";
    const tile = window.L.tileLayer(layer.url, {
      attribution: layer.attribution || "",
      opacity: layer.opacity ?? 1,
      className: layer.className || "",
      maxNativeZoom: isWx ? layer.maxNativeZoom ?? RADAR_NATIVE_ZOOM : layer.maxNativeZoom ?? MAP_MAX_ZOOM,
      subdomains: layer.subdomains || "abc",
      ...(isWx
        ? {
            maxZoom: MAP_MAX_ZOOM,
            tileSize: 256,
            detectRetina: false,
            updateWhenIdle: true,
            updateWhenZooming: false,
            keepBuffer: 4,
          }
        : BASE_TILE_OPTS),
    });
    if (isWx) {
      overlays[layer.id] = tile;
      if (layer.id === "precip") overlays.radar = tile;
    } else layers[layer.id] = tile;
  }
  const prefer = base || (product === "hail" ? "sat" : null);
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
    // Storm overlay mode: taps hit zones for info — don't drop/move the blue pin.
    if (hasSelectedStormDates()) return;
    let { lat, lng } = e.latlng;
    const snap = nearestHouseAddress(lat, lng);
    let address = "";
    if (snap) {
      // Land the blue pin on the yellow number the user tapped near
      lat = snap.lat;
      lng = snap.lon;
      if (snap.street) {
        address = packHouseAddress(snap.num, snap.street, snap.city, "", snap.zip);
      }
    }
    setWxPin(lat, lng);
    if (onTap) onTap(lat, lng, address ? { address } : undefined);
  });
  map.on("movestart zoomstart", () => {
    mapBusy += 1;
    document.getElementById("hs-map-shell")?.classList.add("map-moving");
    if (houseTimer) {
      clearTimeout(houseTimer);
      houseTimer = 0;
    }
    // Pan/zoom must not yank the storm sheet into fullscreen — that kills date loading.
  });
  map.on("zoom", () => scheduleZoomUiRefresh());
  map.on("zoomend", () => {
    lastZoomUiScale = 0;
    scheduleZoomUiRefresh(true);
    // Re-mesh swaths when crossing zoom bands (wide corridors ↔ detail bubbles).
    if (hasSelectedStormDates() && (lastHailRows.length || lastWindRows.length)) {
      lastHailDrawSig = "";
      drawHailMarkers(lastHailRows, lastWindRows);
    }
  });
  map.on("moveend zoomend", () => {
    mapBusy = Math.max(0, mapBusy - 1);
    if (mapBusy > 0) return;
    document.getElementById("hs-map-shell")?.classList.remove("map-moving");
    if (activeWxProduct === "wind" || (hailScopeRadarActive() && hailScopeRadarFilters.wind)) {
      if (windNoise.frame) {
        sizeWindNoiseCanvas();
        seedWindNoiseParticles();
        drawWindNoiseField(performance.now());
        startWindNoiseAnim();
      } else {
        void refreshWindField();
      }
    }
    scheduleHouseNumbers();
    // Widen storm footprint as the map covers more ground (merge into cache — no screen-space rebuild).
    if (hasSelectedStormDates()) {
      const z = map?.getZoom?.() ?? 14;
      scheduleHailMapFill(z < 10 ? 350 : 700);
    } else if (!wxPinSelected()) {
      // No pin: keep storm-date search matched to the visible frame (OK / statewide).
      const z = map?.getZoom?.() ?? 14;
      scheduleMapViewStormMove(z < 9 ? 550 : 900);
    }
    ensureHailPanes();
  });
  addLocateControl();
  startMyLocation();
  scheduleHouseNumbers();
  if (onHold) bindLongPress(onHold);
  setFieldOverlay(fieldOverlay);
  refreshMapSize();
  if (initialPin !== false && Number.isFinite(c.lat) && Number.isFinite(c.lon)) setWxPin(c.lat, c.lon);
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
  if (activeLayer === id && map.hasLayer(layers[id])) return;
  Object.values(layers).forEach((l) => {
    if (map.hasLayer(l)) map.removeLayer(l);
  });
  layers[id].addTo(map);
  applyOverlays();
  activeLayer = id;
  scheduleHouseNumbers();
  if (hasSelectedStormDates() && (lastHailRows.length || lastWindRows.length)) {
    lastHailDrawSig = "";
    drawHailMarkers(lastHailRows, lastWindRows);
  }
}

export function flyToPin(lat, lon, zoom = HOUSE_ZOOM, opts = {}) {
  if (!map || !window.L || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  // stay:true = just frame the map (boot / recenter) — do not drop/keep a select pin
  if (!opts.stay) setWxPin(lat, lon);
  const inView = Boolean(map.getBounds?.()?.pad(0.08)?.contains([lat, lon]));
  const zoomOk = Math.abs((map.getZoom?.() || 0) - zoom) <= 1;
  if (opts.stay !== true && inView && zoomOk) return;
  map.setView([lat, lon], zoom, { animate: opts.stay ? false : true });
}

/** Expand / collapse map — swipe down on the address bar for fullscreen; swipe up from tabs to peek again. */
const MAP_SHELL_MS = 360;

function scrollViewToAddressPeek() {
  const view = document.getElementById("view");
  const search = document.getElementById("hs-search");
  const shell = document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  if (!view || !shell) return;
  if (search) {
    const top = search.offsetTop + search.offsetHeight - Math.min(view.clientHeight * 0.22, 96);
    view.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return;
  }
  const top = shell.offsetTop + shell.offsetHeight;
  view.scrollTo({ top: Math.max(0, top - 4), behavior: "smooth" });
}

/** Bottom panel tier: hidden (fullscreen) → address → sheet. */
let hailBottomTier = "hidden";
/** True while an address-peek upward swipe is opening the storm sheet (blocks movestart→fullscreen). */
let addressSwipeOpeningSheet = false;
/** One advancement per finger-down so a continuous drag can't skip address → sheet. */
let hailTierGestureLocked = false;

function lockHailTierGesture() {
  hailTierGestureLocked = true;
}
function unlockHailTierGesture() {
  hailTierGestureLocked = false;
}

/**
 * Second swipe from the address peek: open storm dates, then scroll the view
 * 1:1 with the finger — Instagram-feed style (no timed open animation).
 */
function bindAddressSwipeToStormSheet(el) {
  if (!el || el.dataset.addrSwipeBound) return;
  el.dataset.addrSwipeBound = "1";
  let active = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startScroll = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0; // scroll px/ms (finger up → positive)
  let coastId = 0;

  const viewEl = () => document.getElementById("view");
  const pt = (e) => (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;

  const stopCoast = () => {
    if (coastId) cancelAnimationFrame(coastId);
    coastId = 0;
  };

  const coastScroll = () => {
    const view = viewEl();
    if (!view || Math.abs(vel) < 0.05) {
      vel = 0;
      coastId = 0;
      return;
    }
    view.scrollTop += vel * 16;
    vel *= 0.92;
    coastId = requestAnimationFrame(coastScroll);
  };

  const openFeed = () => {
    if (hailBottomTier === "sheet") return;
    addressSwipeOpeningSheet = true;
    lockHailTierGesture();
    revealHailStormSheet({ interactive: true, scroll: false });
  };

  const syncScroll = (clientY) => {
    const view = viewEl();
    if (!view) return;
    view.scrollTop = Math.max(0, startScroll + (startY - clientY));
  };

  const onDown = (e) => {
    if (hailBottomTier !== "address") return;
    if (e.touches && e.touches.length !== 1) return;
    if (e.target.closest("a, button, input, select, textarea, .hs-date, .hs-dates, .hs-filters")) return;
    // Whole peek band — works with or without a selected house / .hs-pin
    stopCoast();
    unlockHailTierGesture();
    const p = pt(e);
    const view = viewEl();
    active = true;
    dragging = false;
    startX = p.clientX;
    startY = p.clientY;
    startScroll = view?.scrollTop || 0;
    lastY = startY;
    lastT = performance.now();
    vel = 0;
  };

  const onMove = (e) => {
    // Keep tracking after sheet opens mid-gesture
    if (!active) return;
    if (hailBottomTier !== "address" && hailBottomTier !== "sheet") return;
    const p = pt(e);
    const dx = p.clientX - startX;
    const dy = startY - p.clientY; // up positive
    if (!dragging) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dx) > Math.abs(dy) && dy < 8) {
        active = false;
        return;
      }
      if (dy < 4) return; // need a clear upward pull
      dragging = true;
      openFeed();
    }
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    vel = (lastY - p.clientY) / dt;
    lastY = p.clientY;
    lastT = now;
    syncScroll(p.clientY);
  };

  const endGesture = () => {
    if (!active) return;
    active = false;
    addressSwipeOpeningSheet = false;
    unlockHailTierGesture();
    if (!dragging) return;
    dragging = false;
    if (vel > 0.15) coastScroll();
  };

  el.addEventListener("touchstart", onDown, { capture: true, passive: true });
  el.addEventListener("touchmove", onMove, { capture: true, passive: false });
  el.addEventListener("touchend", endGesture, { capture: true, passive: true });
  el.addEventListener("touchcancel", endGesture, { capture: true, passive: true });
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    onDown(e);
    if (!active) return;
    const move = (ev) => onMove(ev);
    const up = () => {
      endGesture();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  });
}

function scrollViewToStormSheet(smooth = true) {
  const view = document.getElementById("view");
  const panel = document.getElementById("hs-bottom-panel");
  const sheet = document.getElementById("hs-sheet");
  if (!view) return;
  const target = panel || sheet;
  if (!target) return scrollViewToAddressPeek();
  view.scrollTo({ top: Math.max(0, target.offsetTop - 6), behavior: smooth ? "smooth" : "auto" });
}

/** Apply address-only vs full storm sheet visibility. */
export function syncHailBottomChrome() {
  const panel = document.getElementById("hs-bottom-panel");
  const field = document.getElementById("hs-field");
  if (panel) {
    panel.classList.toggle("hs-sheet-open", hailBottomTier === "sheet");
    panel.classList.toggle("hs-addr-open", hailBottomTier === "address" || hailBottomTier === "sheet");
  }
  // Completed jobs / field marks ride with the storm sheet tier
  field?.classList.toggle("hs-field-open", hailBottomTier === "sheet");
}

function pulseBottomPanel({ light = false } = {}) {
  const panel = document.getElementById("hs-bottom-panel");
  if (!panel) return;
  panel.classList.remove("hs-bottom-reveal", "hs-bottom-reveal-light");
  void panel.offsetWidth;
  panel.classList.add(light ? "hs-bottom-reveal-light" : "hs-bottom-reveal");
  clearTimeout(pulseBottomPanel._t);
  pulseBottomPanel._t = setTimeout(() => {
    panel.classList.remove("hs-bottom-reveal", "hs-bottom-reveal-light");
  }, MAP_SHELL_MS + 40);
}

function scheduleSheetScroll(fn, { waitForMap = false } = {}) {
  const run = () => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  };
  if (waitForMap) {
    // Let the map height ease down a beat, then scroll so dates + jobs land in view
    setTimeout(() => requestAnimationFrame(run), Math.round(MAP_SHELL_MS * 0.45));
  } else {
    requestAnimationFrame(() => requestAnimationFrame(run));
  }
}

/** Slide up address search only — storm sheet stays hidden until explicitly opened. */
export function revealHailAddressPeek() {
  const shell = document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  const fromHidden = hailBottomTier === "hidden" || shell?.classList.contains("expanded");
  const wasExpanded = Boolean(shell?.classList.contains("expanded"));
  hailBottomTier = "address";
  syncHailBottomChrome();
  // No house yet: quiet loading peek — no redundant "Map view" title
  if (!Number.isFinite(pinLat) && !Number.isFinite(pinLon)) {
    const sheet = document.getElementById("hs-sheet");
    if (sheet && !sheet.querySelector(".hs-pin") && !sheet.querySelector(".hs-date")) {
      sheet.innerHTML = '<p class="hs-pin hs-pin-ready">Loading storm dates…</p>';
    }
  }
  if (wasExpanded) {
    setWxMapExpanded(false, { scrollToSheet: false });
  }
  if (fromHidden) pulseBottomPanel();
  scheduleSheetScroll(scrollViewToAddressPeek, { waitForMap: wasExpanded });
}

/** Optional hook when storm sheet opens with no house pin (e.g. load map-view storms). */
let stormSheetOpenHook = null;
export function bindStormSheetOpen(fn) {
  stormSheetOpenHook = typeof fn === "function" ? fn : null;
}

/** Optional hook when the map view moves and no house pin is set (refresh statewide dates). */
let mapViewStormMoveHook = null;
let mapViewStormMoveTimer = 0;
export function bindMapViewStormMove(fn) {
  mapViewStormMoveHook = typeof fn === "function" ? fn : null;
}

function scheduleMapViewStormMove(ms = 700) {
  if (wxPinSelected() || !hailScopeMode) return;
  if (mapViewStormMoveTimer) clearTimeout(mapViewStormMoveTimer);
  mapViewStormMoveTimer = setTimeout(() => {
    mapViewStormMoveTimer = 0;
    if (wxPinSelected() || !hailScopeMode) return;
    try {
      mapViewStormMoveHook?.();
    } catch {
      /* ignore */
    }
  }, ms);
}

/** Slide open storm dates + completed jobs list. */
export function revealHailStormSheet({ interactive = false, scroll = true } = {}) {
  const shell = document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  const fromAddress = hailBottomTier === "address";
  const wasExpanded = Boolean(shell?.classList.contains("expanded"));
  hailBottomTier = "sheet";
  syncHailBottomChrome();
  if (wasExpanded) {
    setWxMapExpanded(false, { scrollToSheet: false });
  }
  // Gesture already opened the sheet — skip pulse / auto-scroll
  if (!interactive) {
    pulseBottomPanel({ light: fromAddress && !wasExpanded });
  }
  if (scroll) {
    if (interactive) {
      try {
        scrollViewToStormSheet(false);
      } catch {
        /* ignore */
      }
    } else {
      scheduleSheetScroll(scrollViewToStormSheet, { waitForMap: wasExpanded });
    }
  }
  if (!Number.isFinite(pinLat) && !Number.isFinite(pinLon)) {
    try {
      stormSheetOpenHook?.();
    } catch {
      /* ignore */
    }
  }
}

/** First swipe up: address peek. Second: storm dates. Fullscreen only via address-bar swipe down. */
export function advanceHailBottomReveal() {
  const shell = document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  if (shell?.classList.contains("expanded") || hailBottomTier === "hidden") {
    revealHailAddressPeek();
    return "address";
  }
  if (hailBottomTier === "address") {
    revealHailStormSheet();
    return "sheet";
  }
  return hailBottomTier;
}

export function setWxMapExpanded(on, { scrollToSheet = false } = {}) {
  const shell = document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  const view = document.getElementById("view");
  if (!shell) return;
  if (on === shell.classList.contains("expanded")) return;
  shell.classList.toggle("expanded", on);
  document.body.classList.toggle("wx-map-expanded", on);
  document.body.classList.add("wx-map-animating");
  clearTimeout(setWxMapExpanded._animTimer);
  setWxMapExpanded._animTimer = setTimeout(() => {
    document.body.classList.remove("wx-map-animating");
  }, MAP_SHELL_MS);
  if (on) hailBottomTier = "hidden";
  syncHailBottomChrome();
  if (view) view.style.overflowY = on ? "hidden" : "";
  const invalidate = () => {
    try {
      map?.invalidateSize?.({ animate: false, pan: false });
    } catch {
      /* ignore */
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(invalidate));
  clearTimeout(setWxMapExpanded._sizeTimer);
  setWxMapExpanded._sizeTimer = setTimeout(invalidate, MAP_SHELL_MS + 48);
  if (!on && scrollToSheet) {
    setTimeout(() => {
      try {
        revealHailAddressPeek();
      } catch {
        /* ignore */
      }
    }, MAP_SHELL_MS - 80);
  }
}

export function bindWxMapScrollExpand(view, shell, sheet, tabs) {
  if (!view || !shell || shell.dataset.scrollExpandBound) return;
  shell.dataset.scrollExpandBound = "1";
  // Address peek → storm sheet is feed-scroll (bindAddressSwipeToStormSheet)
  bindAddressSwipeToStormSheet(document.getElementById("hs-bottom-panel"));
  const mapBar = shell.querySelector(".hs-map-bar");
  const tabNav = tabs || document.getElementById("tabs");
  const isExpanded = () => shell.classList.contains("expanded");
  const onPeekBand = (t) => Boolean(t?.closest?.("#hs-bottom-panel"));
  /** Address search strip / pin header — swipe down here enters fullscreen (not map pan). */
  const onAddressBar = (t) =>
    Boolean(
      t?.closest?.(
        "#hs-search, #hs-goto, .hs-goto, .hs-pin, .hs-place, .hs-pin-ready, #hs-bottom-panel > form",
      ),
    );
  const blockMapChrome = (e) =>
    e.target.closest(".leaflet-control, .hs-composer, .hs-pin-scale-pop, .hs-layers, input, select, textarea");
  const collapseFromBar = (e) => {
    if (!isExpanded() || !mapBar?.contains(e.target)) return false;
    return true;
  };
  const tryExpandFromAddressBar = () => {
    if (isExpanded()) return false;
    // Recover if tier got stuck hidden while the shell is collapsed.
    if (hailBottomTier === "hidden") {
      hailBottomTier = "address";
      syncHailBottomChrome();
    }
    if (hailBottomTier !== "address" && hailBottomTier !== "sheet") return false;
    setWxMapExpanded(true);
    return true;
  };
  const tryCollapse = () => {
    if (isExpanded()) {
      // Leave fullscreen → address peek (interactive UI again)
      revealHailAddressPeek();
      return true;
    }
    return false;
  };
  /** Tabs / chrome: fullscreen → address; address → open sheet (peek band also feed-scrolls). */
  const tryBottomSwipeUp = () => {
    if (hailTierGestureLocked) return false;
    if (hailBottomTier === "sheet" && !isExpanded()) return false;
    lockHailTierGesture();
    if (hailBottomTier === "address") {
      revealHailStormSheet({ interactive: true, scroll: false });
      scheduleSheetScroll(() => {
        const v = document.getElementById("view");
        if (v) v.scrollBy({ top: Math.min(200, Math.round(v.clientHeight * 0.32)), behavior: "smooth" });
      });
    } else {
      advanceHailBottomReveal();
    }
    clearTimeout(tryBottomSwipeUp._unlock);
    tryBottomSwipeUp._unlock = setTimeout(unlockHailTierGesture, 220);
    return true;
  };
  view.addEventListener(
    "wheel",
    (e) => {
      if (blockMapChrome(e)) return;
      if (collapseFromBar(e) && e.deltaY > 0) {
        e.preventDefault();
        tryCollapse();
        return;
      }
      // Address bar: wheel down → fullscreen
      if (!isExpanded() && e.deltaY > 0 && onAddressBar(e.target)) {
        e.preventDefault();
        tryExpandFromAddressBar();
        return;
      }
      // Address peek: wheel up opens dates + scrolls like a feed
      if (!isExpanded() && hailBottomTier === "address" && e.deltaY < 0 && onPeekBand(e.target)) {
        e.preventDefault();
        revealHailStormSheet({ interactive: true, scroll: false });
        view.scrollTop += Math.min(140, Math.max(28, -e.deltaY));
        return;
      }
      if (isExpanded() && e.deltaY > 0 && !e.target.closest("#wx-map, .leaflet-container")) {
        e.preventDefault();
        tryCollapse();
      }
    },
    { passive: false },
  );
  let touchY = 0;
  let touchInBar = false;
  let touchOnAddr = false;
  let touchAccum = 0;
  let touchGestureDone = false;
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    unlockHailTierGesture();
    touchY = e.touches[0].clientY;
    touchInBar = Boolean(mapBar?.contains(e.target) && !e.target.closest('input[type="range"]'));
    touchOnAddr = onAddressBar(e.target);
    touchAccum = 0;
    touchGestureDone = false;
  };
  const onTouchMove = (e) => {
    if (touchGestureDone || e.touches.length !== 1) return;
    if (blockMapChrome(e)) return;
    const y = e.touches[0].clientY;
    const dy = y - touchY;
    touchY = y;
    touchAccum += dy;
    // Fullscreen: one clean swipe-down from address/pin strip OR map bar (not date list).
    const wantExpand =
      !isExpanded() &&
      touchAccum > 36 &&
      ((touchOnAddr && onPeekBand(e.target) && !e.target.closest?.(".hs-dates, .hs-filters, #hs-q")) ||
        touchInBar);
    if (wantExpand) {
      e.preventDefault();
      touchGestureDone = true;
      tryExpandFromAddressBar();
      touchAccum = 0;
      return;
    }
    if (isExpanded() && touchInBar && touchAccum > 28) {
      e.preventDefault();
      touchGestureDone = true;
      tryCollapse();
      touchAccum = 0;
    }
  };
  view.addEventListener("touchstart", onTouchStart, { passive: true });
  view.addEventListener("touchmove", onTouchMove, { passive: false });
  if (mapBar) {
    mapBar.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY <= 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (isExpanded()) tryCollapse();
        else tryExpandFromAddressBar();
      },
      { passive: false },
    );
  }
  if (tabNav) {
    let tabTouchY = 0;
    let tabAccum = 0;
    tabNav.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        unlockHailTierGesture();
        tabTouchY = e.touches[0].clientY;
        tabAccum = 0;
      },
      { passive: true },
    );
    tabNav.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1) return;
        // Swipe up from tabs: fullscreen → address → storm dates
        if (!(isExpanded() || hailBottomTier === "address" || hailBottomTier === "hidden")) return;
        const y = e.touches[0].clientY;
        const dy = y - tabTouchY;
        tabTouchY = y;
        tabAccum += dy;
        if (tabAccum < -8) {
          e.preventDefault();
          tryBottomSwipeUp();
          tabAccum = 0;
        }
      },
      { passive: false },
    );
  }
}

/** @deprecated use bindWxMapScrollExpand */
export function bindWxMapExpand(shell) {
  bindWxMapScrollExpand(document.getElementById("view"), shell, document.getElementById("hs-sheet"));
}

async function snapToHouse(hit, query) {
  if (!hit) return hit;
  const want = parseStreetAddress(query);
  const houseOk = Boolean(want.house) && Number(hit.score) >= 70;
  const stamped = { ...hit, v: 2, houseOk };
  if (!want.house) return stamped;
  if (hit.addrType === "PointAddress" || Number(hit.score) >= 140) return stamped;
  const pad = 0.001;
  const south = hit.lat - pad;
  const west = hit.lon - pad;
  const north = hit.lat + pad;
  const east = hit.lon + pad;
  const wait = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  try {
    const osm = await wait(fetchOsmHouseData(south, west, north, east), 6000);
    const wantNum = String(want.house).replace(/^0+/, "").toLowerCase();
    const match = (osm.nums || []).find((n) => String(n.num).replace(/^0+/, "").toLowerCase() === wantNum);
    if (match) return { ...stamped, lat: match.lat, lon: match.lon, houseOk: true, source: `${hit.source}+osm` };
  } catch {
    /* rooftop footprints next */
  }
  if (!houseOk) return stamped;
  try {
    const rings = await wait(fetchStructureFootprints(south, west, north, east), 7000);
    let best = null;
    let bestM = 40;
    for (const ring of rings || []) {
      const c = ringCentroid(ring);
      if (!c) continue;
      const m = haversineKm(hit.lat, hit.lon, c.lat, c.lon) * 1000;
      if (m < bestM) {
        bestM = m;
        best = c;
      }
    }
    if (best) return { ...stamped, lat: best.lat, lon: best.lon, houseOk: true, source: `${hit.source}+roof` };
  } catch {
    /* keep interpolated point */
  }
  return stamped;
}

/** Forward geocode an address/place for WX search. Prefers the house, not the street centroid. */
export async function geocodeAddress(query) {
  const ranked = await geocodeCandidates(query);
  const top = await snapToHouse(ranked[0], query);
  return [top, ...ranked.slice(1)];
}

export { geoCacheOk };

function cutoffDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 730));
  return d.toISOString().slice(0, 10);
}

export function filterHailRaw(data, filters = wxFilters, { forMap = false } = {}) {
  const since = cutoffDate(filters.days);
  const km = filterKm(filters);
  const hailMin = Number(filters.hailIn) || 0;
  const year = String(filters.year || "all");
  const pinLatN = Number(data.lat ?? data._meta?.lat);
  const pinLonN = Number(data.lon ?? data._meta?.lon);
  const viewport = Boolean(data.viewport || data._meta?.viewport);
  // Selected storm overlay: paint the full fetched footprint (not the NEAR list radius).
  const skipDist = forMap && (viewport || hasSelectedStormDates());
  const paintKm = forMap
    ? Math.max(km, Number(data._meta?.fetchedKm) || 0, PIN_FETCH_WIDE_KM, mapViewFetchKm())
    : km;
  return (data.hail || []).filter((h) => {
    if (year !== "all") {
      if (!h.date || !String(h.date).startsWith(year)) return false;
    } else if (h.date && h.date < since) {
      return false;
    }
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) return false;
    if (!viewport && !skipDist) {
      let dist = h.distance_km;
      if (Number.isFinite(pinLatN) && Number.isFinite(pinLonN)) {
        dist = haversineKm(pinLatN, pinLonN, h.lat, h.lon);
      }
      if (dist != null && dist > paintKm) return false;
    }
    const sz = parseFloat(h.size_in);
    return Number.isNaN(sz) || sz >= hailMin;
  });
}

/** Hail rows for map paint — wider than the sheet NEAR filter when a storm day is on. */
export function mapHailRows(data, filters = wxFilters) {
  return filterHailRaw(data, filters, { forMap: true });
}

export function filterDossier(data, filters = wxFilters) {
  const since = cutoffDate(filters.days);
  const km = filterKm(filters);
  const windMin = Number(filters.windMph) || 0;
  const year = String(filters.year || "all");
  const sort = String(filters.sort || "date");
  let hailRaw = filterHailRaw(data, filters);
  // One extremeness tag per date (HailTrace-style).
  let hail = collapseHailByDate(hailRaw).filter((h) => stormPassesSizeFilter(h, filters));
  hail = [...hail].sort((a, b) => {
    // Newest mode: pure date order — no near_hits reshuffle as partials land.
    if (sort === "date") {
      return String(b.date).localeCompare(String(a.date)) || (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0);
    }
    const aNear = (a.near_hits || 0) > 0 ? 0 : 1;
    const bNear = (b.near_hits || 0) > 0 ? 0 : 1;
    if (aNear !== bNear) return aNear - bNear;
    if (sort === "size") {
      return (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0) || String(b.date).localeCompare(String(a.date));
    }
    if (sort === "storm") {
      return (
        (Number(b.hits) || 0) - (Number(a.hits) || 0) ||
        (Number(b.span_km) || 0) - (Number(a.span_km) || 0) ||
        (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0) ||
        String(b.date).localeCompare(String(a.date))
      );
    }
    return String(b.date).localeCompare(String(a.date)) || (parseFloat(b.size_in) || 0) - (parseFloat(a.size_in) || 0);
  });
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
  } else if (sort === "storm") {
    storms = [...storms].sort((a, b) => {
      const as = Number(a.hits) || parseFloat(a.hail_in) || a.score || 0;
      const bs = Number(b.hits) || parseFloat(b.hail_in) || b.score || 0;
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
  const meta = data._meta || {};
  const { hail, wind, storms } = filterDossier(data, wxFilters);
  const years = [
    ...new Set((data.hail || []).map((h) => String(h.date || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y))),
  ].sort((a, b) => b.localeCompare(a));
  return `
    <details class="wx-roof-fold">
      <summary class="wx-roof-sum">ROOFING · ${hail.length ? `${hail.length} hail day(s)` : "hail trace"}${hasSelectedStormDates() ? ` · ${esc(selectedStormDateSig())}` : ""}</summary>
      <div class="wx-roof-body">
        <p class="muted wx-roof-blurb">Insurance-grade hail trace — tap dates to overlay zones (multi-check). Solid = spotter-confirmed · dashed = radar-only.</p>
        ${renderStormGraph(hail, esc)}
        ${placeContactHtml(data, esc)}
        <div class="wx-links">
          ${onResearch ? `<button type="button" id="wx-deep" class="primary">DEEP RESEARCH</button>` : ""}
        </div>
        <p class="muted wx-meta">${meta.deep ? `Deep scan · ${meta.fetchedDays || "?"}d · ${meta.fetchedKm != null ? formatDistance(meta.fetchedKm) : "?"}` : "Quick scan · DEEP RESEARCH for full trace + news · Shingle ID → CHAT → LENS"}</p>
        <div class="wx-filters">
          <label>NEAR <select id="wx-f-km">
            ${radiusOptionHtml()}
          </select></label>
          <label>HAIL ≥ <select id="wx-f-hail">
            ${hailInOptionHtml(wxFilters.hailIn, { short: true })}
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
            <option value="730"${wxFilters.days == 730 ? " selected" : ""}>2y</option>
          </select></label>
          <label>YEAR <select id="wx-f-year">
            <option value="all"${wxFilters.year === "all" || !wxFilters.year ? " selected" : ""}>all</option>
            ${years.map((y) => `<option value="${esc(y)}"${String(wxFilters.year) === y ? " selected" : ""}>${esc(y)}</option>`).join("")}
          </select></label>
          <label>SORT <select id="wx-f-sort">
            <option value="date"${wxFilters.sort !== "size" && wxFilters.sort !== "storm" ? " selected" : ""}>chrono</option>
            <option value="size"${wxFilters.sort === "size" ? " selected" : ""}>extreme ★</option>
            <option value="storm"${wxFilters.sort === "storm" ? " selected" : ""}>biggest storm</option>
          </select></label>
        </div>
        <h4>HAIL TRACE · ${hail.length} DAYS${hasSelectedStormDates() ? ` · MAP ${esc(selectedStormDateSig())}` : ""}</h4>
        <div class="wx-hail-legend muted">Tap dates → overlay zones · red = spotter · green = radar · size = this roof, not the farthest cell</div>
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
                  const on = isStormDateSelected(h.date) ? " on" : "";
                  const span = h.span_km ? ` · ~${esc(formatDistance(h.span_km))} wide` : "";
                  return `<div class="wx-hail-row sev-${esc(String(sev).toLowerCase())}${on}" data-storm-date="${esc(h.date)}">
            <span class="stars">${esc(stars)}</span>
            <span class="date">${esc(h.date)}</span>
            <span class="size">${esc(h.size_in)}"</span>
            <span class="sev">${esc(sev)}</span>
            <span class="src">${esc(src)}</span>
            <span class="dist">${esc(formatDistance(h.distance_km))}</span>
            <span class="loc">${esc(h.hits || 1)} sig${(h.hits || 1) === 1 ? "" : "s"}${span}${h.zone_r_km ? ` · zone ~${esc(formatDistance(h.zone_r_km))}` : ""}</span>
          </div>`;
                })
                .join("")
            : `<p class="muted">No hail days this close after filters. Widen NEAR, drop HAIL ≥ / STORM, or change YEAR.</p>`
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
          <span class="dist">${esc(formatDistance(w.distance_km))}</span>
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
    selectStormDate(date, { fit: true, toggle: true });
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
            drawHailMarkers(mapHailRows(fresh, wxFilters), f.wind, { fit: false });
            return;
          }
        } catch {
          /* fall through */
        }
      }
      renderRoofDossier(root, data, esc, onResearch, onRefetch);
      const f = filterDossier(data, wxFilters);
      drawHailMarkers(mapHailRows(data, wxFilters), f.wind, { fit: false });
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
  pruneStormDateSelection(new Set(hail.map((h) => h.date)));
  if (!hasSelectedStormDates() && hail.length) {
    setStormDateSelection([hail[0]?.date].filter(Boolean));
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
    h.size_far,
    h.near_hits,
    h.hits,
    h.span_km,
    h.severity || hailSeverityLabel(h.size_in),
    hailSourceLabel(h),
    h.location,
    h.state,
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

function syncHailStormDateSelection(data) {
  // Checked storm dates stay on until the user toggles them off — never auto-clear
  // while radar/spotter batches are still landing.
  if (hasSelectedStormDates()) return;
  const days = hailScopeDays(data);
  if (!days.length) return;
}

export function clearSelectedStormDate() {
  clearStormDateSelection();
  lastHailDrawSig = "";
  if (selectedStormRedrawTimer) {
    clearTimeout(selectedStormRedrawTimer);
    selectedStormRedrawTimer = 0;
  }
  pendingSelectedStormRows = null;
}

/** Update address/contacts while storm list still loading — avoids wiping the sheet. */
export function patchHailScopePartial(root, partial, esc) {
  if (!root) return;
  const addr = partial.address || "Dropped pin";
  const box = document.getElementById("hs-addr-q");
  if (box && addr && parseStreetAddress(addr).house && !/^map\s*view$/i.test(addr)) box.value = addr;
  let pin = root.querySelector(".hs-pin");
  if (!pin) {
    root.innerHTML = `<p class="hs-pin"><strong>${esc(addr)}</strong>Finding storms…</p>${placeContactHtml(partial, esc)}<p class="hs-empty">Loading storm history…</p>`;
    bindPlaceLinks(root);
    return;
  }
  pin.innerHTML = `<strong>${esc(addr)}</strong>Finding storms…`;
  const place = root.querySelector(".hs-place");
  if (place) place.outerHTML = placeContactHtml(partial, esc);
  else {
    pin.insertAdjacentHTML("afterend", placeContactHtml(partial, esc));
  }
  bindPlaceLinks(root);
}

let lastSyncHailN = 0;
let lastSyncRadarN = 0;
let selectedStormRedrawTimer = 0;
let pendingSelectedStormRows = null;

function scheduleSelectedStormZoneRedraw(hailRows, windRows = []) {
  pendingSelectedStormRows = { hailRows, windRows };
  if (selectedStormRedrawTimer) return;
  selectedStormRedrawTimer = window.setTimeout(() => {
    selectedStormRedrawTimer = 0;
    const pending = pendingSelectedStormRows;
    pendingSelectedStormRows = null;
    if (!pending || !hasSelectedStormDates()) return;
    lastHailDrawSig = "";
    drawHailMarkers(pending.hailRows, pending.windRows, { requireDate: true });
  }, 280);
}

/** Soft sheet patch — keep selected dates lit while list/radar keep loading. */
function softUpdateHailScopeSheet(root, data, esc, { onRefetch } = {}) {
  if (!root || !data) return;
  const days = hailScopeDays(data);
  const box = root.querySelector(".hs-dates");
  if (box) {
    box.innerHTML = hailScopeDateRows(days, esc, {
      viewport: Boolean(data.viewport || data._meta?.viewport),
      data,
    });
    box._hsData = data;
    box._hsEsc = esc;
  } else {
    renderHailScopeSheet(root, data, esc, { onRefetch, drawMap: false });
    return;
  }
  paintHailScopeDateSelection(root, data, esc);
  bindHailScopeDates(root, data, esc, { onRefetch });
  const filters = root.querySelector(".hs-filters");
  if (filters && !root.querySelector("#hs-q")) {
    /* sheet skeleton missing — full rebuild once */
    renderHailScopeSheet(root, data, esc, { onRefetch, drawMap: false });
  }
}

/** One coordinated map + sheet refresh after dossier data arrives. */
export function syncHailScopeView(root, data, esc, { onRefetch, fit = false, revealSheet = false } = {}) {
  if (!root || !data) return;
  syncHailStormDateSelection(data);
  const hailRows = mapHailRows(data, wxFilters);
  const radarN = hailRows.filter((h) => !isSpotterHail(h)).length;
  const locked = hasSelectedStormDates();
  const hailGrew = hailRows.length !== lastSyncHailN || radarN !== lastSyncRadarN;
  lastSyncHailN = hailRows.length;
  lastSyncRadarN = radarN;

  if (locked) {
    // Keep selection; debounce zone rebuilds so SWDI batches don't thrash the map.
    if (hailGrew || fit) scheduleSelectedStormZoneRedraw(hailRows, []);
    softUpdateHailScopeSheet(root, data, esc, { onRefetch });
  } else {
    if (hailGrew) lastHailDrawSig = "";
    drawHailMarkers(hailRows, [], { fit, requireDate: true, hailRows });
    renderHailScopeSheet(root, data, esc, { onRefetch, drawMap: false });
  }
  if (revealSheet) revealHailStormSheet({ interactive: true, scroll: false });
  else if (hailScopeDays(data).length && hailBottomTier === "address") {
    // Dates loaded while address peek was up — open the list without waiting for a swipe.
    revealHailStormSheet({ interactive: true, scroll: false });
  }
}

function hailScopePinHtml(data, esc) {
  const viewport = Boolean(data.viewport || data._meta?.viewport);
  const pinLine = selectedStormsPinText(esc);
  if (viewport) {
    const line =
      pinLine ||
      "Storms in the visible map area — tap dates to overlay (multi-check)";
    return `<p class="hs-pin hs-pin-ready">${line}</p>`;
  }
  const addr = data.address || "Dropped pin";
  const loading = data._meta?.loading ? " · loading radar…" : "";
  return `<p class="hs-pin hs-pin-ready"><strong class="hs-addr-copy" role="button" tabindex="0" title="Tap to copy address" data-copy="${esc(addr)}">${esc(addr)}</strong>${
    pinLine || `Tap storm dates to overlay hail zones (multi-check)${loading}`
  }</p>`;
}

function hailScopeHtml(data, days, esc) {
  const viewport = Boolean(data.viewport || data._meta?.viewport);
  const years = [
    ...new Set((data.hail || []).map((h) => String(h.date || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y))),
  ].sort((a, b) => b.localeCompare(a));
  const q = hailSearchQ;
  return `
    ${hailScopePinHtml(data, esc)}
    ${viewport ? "" : placeContactHtml(data, esc)}
    <p class="hs-legend"><span class="hs-legend-item"><span class="hs-dot hs-dot-spot"></span>Spotter</span><span class="hs-legend-item"><span class="hs-dot hs-dot-radar"></span>Radar</span><span class="hs-legend-item"><span class="hs-dot hs-dot-done"></span>Done</span><span class="hs-legend-item"><span class="hs-dot hs-dot-ping"></span>Ping</span></p>
    <div class="hs-filters">
      <input type="search" id="hs-q" placeholder="Search dates, size, place…" value="${esc(q)}" />
      ${
        viewport
          ? ""
          : `<label class="hs-select"><span class="hs-select-lab">Near</span><select id="hs-f-km" aria-label="Radius">
        ${radiusOptionHtml()}
      </select></label>`
      }
      <label class="hs-select"><span class="hs-select-lab">Hail</span><select id="hs-f-hail" aria-label="Hail size">
        ${hailInOptionHtml(wxFilters.hailIn)}
      </select></label>
      <label class="hs-select"><span class="hs-select-lab">Window</span><select id="hs-f-days" aria-label="Time window">
        <option value="30"${wxFilters.days == 30 ? " selected" : ""}>30 days</option>
        <option value="90"${wxFilters.days == 90 ? " selected" : ""}>90 days</option>
        <option value="180"${wxFilters.days == 180 ? " selected" : ""}>6 months</option>
        <option value="365"${wxFilters.days == 365 ? " selected" : ""}>1 year</option>
        <option value="730"${wxFilters.days == 730 ? " selected" : ""}>2 years</option>
      </select></label>
      <label class="hs-select"><span class="hs-select-lab">Year</span><select id="hs-f-year" aria-label="Year">
        <option value="all"${wxFilters.year === "all" || !wxFilters.year ? " selected" : ""}>All years</option>
        ${years.map((y) => `<option value="${esc(y)}"${String(wxFilters.year) === y ? " selected" : ""}>${esc(y)}</option>`).join("")}
      </select></label>
      <label class="hs-select"><span class="hs-select-lab">Sort</span><select id="hs-f-sort" aria-label="Sort">
        <option value="date"${wxFilters.sort !== "size" && wxFilters.sort !== "storm" ? " selected" : ""}>Newest</option>
        <option value="size"${wxFilters.sort === "size" ? " selected" : ""}>Largest hail</option>
        <option value="storm"${wxFilters.sort === "storm" ? " selected" : ""}>Biggest storm</option>
      </select></label>
    </div>
    <div class="hs-dates">${hailScopeDateRows(days, esc, { viewport, data })}</div>`;
}

function paintHailScopeDateSelection(root, data, esc) {
  if (!root) return;
  const pinEl = root.querySelector(".hs-pin");
  if (pinEl) {
    const tmp = document.createElement("div");
    tmp.innerHTML = hailScopePinHtml(data, esc);
    const next = tmp.firstElementChild;
    if (next) pinEl.replaceWith(next);
  }
  root.querySelectorAll(".hs-date[data-storm-date]").forEach((row) => {
    const on = isStormDateSelected(row.getAttribute("data-storm-date"));
    row.classList.toggle("on", on);
    row.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function bindHailScopeDates(root, data, esc, { onRefetch } = {}) {
  const box = root.querySelector(".hs-dates");
  if (!box) return;
  box._hsData = data;
  box._hsEsc = esc;
  if (box._hsDateBound) return;
  box._hsDateBound = true;
  box.addEventListener("click", (e) => {
    const row = e.target?.closest?.(".hs-date[data-storm-date]");
    if (!row || !box.contains(row)) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    const live = box._hsData || data;
    const liveEsc = box._hsEsc || esc;
    const date = row.getAttribute("data-storm-date");
    const hailRows = mapHailRows(live, wxFilters);
    try {
      selectStormDate(date, { fit: false, requireDate: true, hailRows, toggle: true });
    } catch (err) {
      console.warn("selectStormDate failed", err);
    }
    // Toggle classes in place — full list rebuild was dropping taps mid-gesture.
    paintHailScopeDateSelection(root, live, liveEsc);
  });
}

function hailScopeDateRows(days, esc, { viewport = false, data = null } = {}) {
  if (!days.length) {
    const cached = (data?.hail || []).length;
    if (cached > 0) {
      const msg = hailSearchQ
        ? "Nothing matches that search — clear the search box or loosen filters."
        : viewport
          ? "Adjust filters to see dates — try a longer window or lower hail size."
          : `Adjust filters to see dates — widen Near (${formatDistance(filterKm())}) or lower hail size.`;
      return `<p class="hs-empty">${msg}</p>`;
    }
    const empty = viewport
      ? "Adjust filters or pan the map — try a longer time window."
      : hailSearchQ
        ? "Nothing matches that search — clear the search box or loosen filters."
        : "Adjust filters to see storm dates — try a longer window or lower hail size.";
    return `<p class="hs-empty">${empty}</p>`;
  }
  return days
    .slice(0, 80)
    .map((h) => {
      const on = isStormDateSelected(h.date) ? " on" : "";
      const atRoof = (h.near_hits || 0) > 0;
      const sev = (h.severity || hailSeverityLabel(h.size_in) || "").toLowerCase();
      const src = hailSourceLabel(h);
      const far = h.size_far && h.far_km != null ? ` · ${h.size_far}″ also ${formatDistance(h.far_km)} out` : "";
      const span = h.span_km ? ` · ${formatDistance(h.span_km)} wide` : "";
      const meta = viewport
        ? `${sev} · ${src} · ${h.hits || 1} in view${span} · nearest ${formatDistance(h.distance_km)}${far}`
        : atRoof
          ? `${sev} · ${src} · ${h.near_hits} at this roof · ${h.hits || 1} sig${span} · nearest ${formatDistance(h.distance_km)}${far}`
          : `No hail signature at this roof · ${h.hits || 1} sig${span} · nearest ${formatDistance(h.distance_km)}${far || ` · ${h.size_in}″`}`;
      return `<button type="button" class="hs-date${on}${atRoof ? "" : " away"}" data-storm-date="${esc(h.date)}" aria-pressed="${on ? "true" : "false"}">
                <span class="mark" aria-hidden="true"></span>
                <span class="when">${esc(prettyStormDate(h.date))}</span>
                <span class="size">${esc(h.size_in)}″</span>
                <span class="meta">${esc(meta)}</span>
              </button>`;
    })
    .join("");
}

function bindHailScopeSheet(root, data, esc, { onRefetch } = {}) {
  if (!root) return;
  const meta = data._meta || {};
  const viewport = Boolean(data.viewport || meta.viewport);
  const qEl = root.querySelector("#hs-q");
  if (qEl) {
    qEl.oninput = () => {
      hailSearchQ = String(qEl.value || "").trim().toLowerCase();
      const box = root.querySelector(".hs-dates");
      if (box) {
        box.innerHTML = hailScopeDateRows(hailScopeDays(data), esc, { viewport, data });
        bindHailScopeDates(root, data, esc, { onRefetch });
      }
    };
  }
  bindHailScopeDates(root, data, esc, { onRefetch });
  bindPlaceLinks(root);
  const bind = (id, key, cast) => {
    const el = root.querySelector(id);
    if (!el) return;
    el.onchange = async () => {
      wxFilters[key] = cast(el.value);
      if (key === "km" && wxPinSelected()) drawPinRadius();
      const needRefetch =
        onRefetch &&
        !meta.listLocked &&
        (viewport
          ? key === "days"
          : (key === "days" && Number(wxFilters.days) > (meta.fetchedDays || 0)) ||
            (key === "km" && Number(wxFilters.km) > (meta.fetchedKm || 0)));
      if (needRefetch) {
        try {
          const fresh = await onRefetch({ ...wxFilters });
          if (fresh) {
            syncHailScopeView(root, fresh, esc, { onRefetch });
            return;
          }
        } catch {
          /* fall through */
        }
      }
      syncHailStormDateSelection(data);
      renderHailScopeSheet(root, data, esc, { onRefetch, drawMap: false });
      drawHailMarkers(mapHailRows(data, wxFilters), [], { requireDate: true });
    };
  };
  bind("#hs-f-km", "km", Number);
  bind("#hs-f-hail", "hailIn", Number);
  bind("#hs-f-days", "days", Number);
  bind("#hs-f-year", "year", String);
  bind("#hs-f-sort", "sort", String);
  bindHailAddrCopy(root);
}

async function copyTextToClipboard(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function bindHailAddrCopy(root) {
  if (!root || root._hsAddrCopyBound) return;
  root._hsAddrCopyBound = true;
  const flash = (el, ok) => {
    if (!el) return;
    el.classList.toggle("copied", ok);
    el.classList.toggle("copy-fail", !ok);
    clearTimeout(el._copyFlash);
    el._copyFlash = setTimeout(() => {
      el.classList.remove("copied", "copy-fail");
    }, 1200);
  };
  root.addEventListener("click", async (e) => {
    const el = e.target?.closest?.(".hs-addr-copy");
    if (!el || !root.contains(el)) return;
    e.preventDefault();
    e.stopPropagation();
    const text = el.getAttribute("data-copy") || el.textContent || "";
    const ok = await copyTextToClipboard(text);
    flash(el, ok);
  });
  root.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target?.closest?.(".hs-addr-copy");
    if (!el || !root.contains(el)) return;
    e.preventDefault();
    const text = el.getAttribute("data-copy") || el.textContent || "";
    const ok = await copyTextToClipboard(text);
    flash(el, ok);
  });
}

export function renderHailScopeSheet(root, data, esc, { onRefetch, drawMap = true } = {}) {
  if (!root) return;
  const days = hailScopeDays(data);
  // Never prune checked dates from progressive loads / filter churn.
  root.innerHTML = hailScopeHtml(data, days, esc);
  bindHailScopeSheet(root, data, esc, { onRefetch });
  if (drawMap) drawHailMarkers(mapHailRows(data, wxFilters), [], { requireDate: true });
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
