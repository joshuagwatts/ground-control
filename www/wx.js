/** WX map + storm dossier — runs on phone (public APIs). */
import { httpGet, httpLanGet, httpLanPostJson, openUrl, overpassJson, osmMapJson } from "./net.js";
import { locateDevice, watchGps } from "./geo.js";
import {
  lookupPlaceContacts,
  lookupFlagPhone,
  lookupListingRentPhone,
  formatPhone,
  phoneDigits,
  isJunkPhone,
  mergeContacts,
  listingForPin,
  parseStreetAddress,
  streetKey,
  resolveZillowUrl,
  isUsableZillowUrl,
  fillContactGapsWithChat,
  classifyFlagPhone,
  isOsmBusinessTags,
  lookupViewportRentFlags,
  isOklahomaLatLon,
  inferOkCity,
  citiesInMapBounds,
  rentFlagsForViewport,
  loadPersistedRentFlags,
  persistRentFlags,
  clearPersistedRentFlags,
  cancelRentFlagSweep,
} from "./contacts.js";
import { geocodeCandidates, geoCacheOk } from "./geocode.js";
import { lookupAssessorParcel } from "./assessor.js";
import { kindMeta, validMarkCoord, markBadge, markTint, clampPinScale } from "./marks.js";
import { flagNetProfile, isAndroid, isSlowBrowserNet, useDesktopChrome, usePhoneChrome } from "./device.js";

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
  km: 16,
  hailIn: 0.75,
  windMph: 38,
  days: 730,
  year: "all",
  // Map view (no address): biggest storm first.
  sort: "storm",
  stormSize: "any",
};
/** Pin / address selected — newest day with ≥1″ hail. */
export const PIN_AUTO_FILTERS = { hailIn: 1, sort: "date", km: 16 };
/** No address — keep discovery aimed at the biggest storm. */
export const MAP_AUTO_FILTERS = { hailIn: 0.75, sort: "storm", km: 16 };
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
const HAIL_IN_CHOICES = [0, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
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
/** Storm-date list page (20 per page so the field footer stays below). */
export const STORM_LIST_PAGE_SIZE = 20;
let hailStormPage = 0;
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
let persistHydrated = false;
let lastRentSweepAt = 0;
let lastRentSweepLat = NaN;
let lastRentSweepLon = NaN;
let lastRentSweepCity = "";
let flagPaintTimer = 0;
let flagPaintQueued = false;
let flagPaintImmediateDone = false;
const BIZ_STORE_KEY = "hs-biz-flags-v1";
const BIZ_STORE_MAX = 800;
/** Short cool — map-view flags should retarget quickly after a pan. */
const RENT_SWEEP_COOL_MS = 4 * 1000;
/** Re-kick rent/city sweep when the map center moves this far (km). */
const RENT_SWEEP_MOVE_KM = 2;
/** Session map of house keys → owner phone (drives green house-number labels). */
const housePhoneByKey = new Map();
/** Session map of house keys → { phone, name, email } when public info exists. */
const houseUsefulByKey = new Map();
let houseEnrichTimer = 0;
/** Session keys already scanned for Flags — skip so we don't re-hammer listings. */
const houseEnrichTried = new Set();
let flagDockIdx = 0;
const flagHiddenKeys = new Set();
let flagKindFilter = { rental: true, business: true };
try {
  const raw = sessionStorage.getItem("hs-flag-hidden");
  for (const k of JSON.parse(raw || "[]")) flagHiddenKeys.add(String(k));
} catch {
  /* ignore */
}
let houseHoldUntil = 0;
let markLayer = null;
let doneLayer = null;
let fieldOverlay = {
  marks: [],
  done: [],
  showMarks: true,
  showDone: true,
  showHailDots: true,
  showPhoneFlags: false,
  onMark: null,
  onDone: null,
};
const livePinMarkers = { marks: new Map(), done: new Map() };

export function setHailScopeMode(on) {
  hailScopeMode = Boolean(on);
  if (!hailScopeMode) hailSearchQ = "";
}
/** HailScope live radar — separate from pip wx timeline filters. */
let hailScopeRadarOn = false;
export const hailScopeRadarFilters = { precip: true, wind: true };

function hailScopeRadarActive() {
  return hailScopeMode && hailScopeRadarOn === true;
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
/** Live scrubber half-window in hours (±2 / ±6 / ±12 / ±24). Default 6. */
export const LIVE_WINDOW_HOURS = [2, 6, 12, 24];
let liveWindowHrs = 6;
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
  fetchBounds: null, // { west, south, east, north } of last grid fetch
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
  if (fields.owner_phone || fields.owner_name || fields.owner_email) {
    noteHouseOwnerPhone(lat, lon, addr, fields.owner_phone, fields);
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
  // Mobile Safari / GitHub Pages: every chunk goes through a CORS proxy — fewer, wider chunks.
  const slow = isSlowBrowserNet();
  const span = slow
    ? km >= 80
      ? 75
      : days > 180
        ? 50
        : 35
    : km >= 100
      ? 45
      : days > 365
        ? 28
        : days > 120
          ? 18
          : 13;
  const maxChunks = Math.min(slow ? (km >= 80 ? 8 : 10) : km >= 100 ? 18 : 28, Math.ceil(days / span) + 1);
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
  const batch = slow ? 6 : km >= 100 ? 3 : 4;
  const timeout = slow ? 8000 : km >= 100 ? 12000 : 14000;
  const attempts = slow ? 1 : 2;
  for (let i = 0; i < chunks.length; i += batch) {
    const part = await Promise.all(
      chunks.slice(i, i + batch).map(async ({ start, end }) => {
        const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
        const url = `https://www.ncdc.noaa.gov/swdiws/json/nx3hail/${fmt(start)}:${fmt(end)}?bbox=${bbox}`;
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            const { body } = await httpGet(url, timeout);
            const data = JSON.parse(body || "{}");
            return data.result || [];
          } catch {
            if (attempt >= attempts - 1) return [];
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

const lsrHailCache = new Map();

/** First LSR window — keep the CSV small so iPhone Safari can paint dates before the 2-year dump. */
export function lsrFirstDays(requested = 730) {
  const days = Math.min(Math.max(Number(requested) || 730, 7), 730);
  return isSlowBrowserNet() ? Math.min(days, 120) : Math.min(days, 400);
}

async function fetchIemLsrHail(lat, lon, radiusKm = 40, daysBack = 365) {
  const km = Math.min(Math.max(radiusKm, 5), MAP_HAIL_MAX_KM);
  const days = Math.min(Math.max(Number(daysBack) || 365, 7), 730);
  const cacheKey = `${lat.toFixed(2)}|${lon.toFixed(2)}|${Math.round(km / 10) * 10}|${days}`;
  if (lsrHailCache.has(cacheKey)) return lsrHailCache.get(cacheKey);
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
  const timeout = isSlowBrowserNet() ? 9000 : 20000;
  for (const url of urls) {
    try {
      const { body } = await httpGet(url, timeout);
      const rows = /"features"|FeatureCollection/i.test(body || "")
        ? parseIemLsrGeojson(body, lat, lon, km)
        : parseIemLsrCsv(body, lat, lon, km);
      if (rows.length) {
        lsrHailCache.set(cacheKey, rows);
        return rows;
      }
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
  // 0.5″ fringe — large soft white envelope under the yellow cores.
  if (sz >= 0.5) return { stroke: "#eceff1", fill: "#fafafa", core: "#ffffff" };
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

const spcDayCache = new Map();
const spcDayInflight = new Map();

/** SPC filtered CSVs are one HTTP hit per day — keep this tiny on iPhone Safari/CORS. */
export function spcLookbackDays(requested = 16) {
  const want = Math.min(Math.max(Number(requested) || 16, 7), 90);
  return Math.min(want, isSlowBrowserNet() ? 8 : 16);
}

async function fetchSpcDay(stamp, iso) {
  if (spcDayCache.has(stamp)) return spcDayCache.get(stamp);
  if (spcDayInflight.has(stamp)) return spcDayInflight.get(stamp);
  const job = (async () => {
    try {
      const { body, status } = await httpGet(
        `https://www.spc.noaa.gov/climo/reports/${stamp}_rpts_filtered.csv`,
        isSlowBrowserNet() ? 4000 : 5500,
      );
      if (status === 404) {
        const empty = { hail: [], wind: [] };
        spcDayCache.set(stamp, empty);
        return empty;
      }
      const row = {
        hail: parseSpcHailCsv(body, iso),
        wind: parseSpcSection(body, iso, "Time,Speed,", "wind", "wind_mph"),
      };
      spcDayCache.set(stamp, row);
      return row;
    } catch {
      return { hail: [], wind: [] };
    }
  })();
  spcDayInflight.set(stamp, job);
  try {
    return await job;
  } finally {
    spcDayInflight.delete(stamp);
  }
}

async function fetchSpcReports(lat, lon, radiusKm = 25, daysBack = 16, { onProgress } = {}) {
  const today = new Date();
  const days = spcLookbackDays(daysBack);
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
  const takeDay = (dayRows) => {
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
  };
  const batch = isSlowBrowserNet() ? 6 : 10;
  for (let i = 0; i < stamps.length; i += batch) {
    const chunk = stamps.slice(i, i + batch);
    const parts = await Promise.all(chunk.map(({ stamp, iso }) => fetchSpcDay(stamp, iso)));
    for (const dayRows of parts) takeDay(dayRows);
    if (onProgress && (hailHits.length || windHits.length)) {
      onProgress({ hail: hailHits.slice(), wind: windHits.slice() });
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
/** Search radius (km) around map center for OSM business flags. */
const FLAG_SEARCH_KM_MIN = 2.2;
const FLAG_SEARCH_KM_MAX = 14;
/** Painted flag cap — business POIs only; rentals in view are never dropped. */
function flagBizPaintMax() {
  return Math.min(Number(flagNetProfile()?.paintMax) || (isAndroid() ? 260 : 450), 150);
}
const HOUSE_FETCH_PAD = 0.2;
/** Viewport lookups per settle — keep this small so Flags never stall the map. */
const HOUSE_ENRICH_MAX = 20;
const HOUSE_ENRICH_GAP_MS = 380;
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
    const { layer, confirmed, size, kind, outer } = entry;
    if (!layer?.setStyle) continue;
    const style =
      kind === "core"
        ? hailCoreStrokeStyle(z)
        : kind === "wind"
          ? (() => {
              const s = hailZoneStrokeStyle(false, size, z);
              return { weight: Math.min(1.4, s.weight), opacity: Math.min(0.65, s.opacity), dashArray: s.dashArray };
            })()
          : kind === "fill"
            ? hailZoneStrokeStyle(confirmed, size, z, { radar: entry.radar })
            : kind === "zone"
              ? { weight: 1.35, opacity: 0.72, stroke: true, dashArray: null }
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

/** Per-band fill (composited inside pane). Pane opacity caps total map coverage ~50%. */
const HAIL_BAND_FILL = 0.72;
const HAIL_BAND_FILL_SAT = 0.78;

function hailZoneOpacityBoost(_base) {
  void _base;
  return activeLayer === "sat" ? HAIL_BAND_FILL_SAT : HAIL_BAND_FILL;
}

/** Cap stacked hail fills so overlaps never fully block the basemap (~50%). */
function hailFillPaneOpacity() {
  return 0.5;
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
const RADAR_TILE_SIZE = 256;

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

function setRadarTilePath(path, { crossfade = false, play = false } = {}) {
  if (!map || !window.L || !path) return Promise.resolve();
  const url = rainTileUrl(radarHost, path, radarColor);
  const wantOn = wantPrecipRadarTiles();

  // PLAY path: instant URL swap — no dual-layer fade wait (that made 24h crawl).
  if (play || !crossfade) {
    const layer = ensureRadarLayer(url) || overlays.precip;
    if (layer) {
      if (layer._url !== url) layer.setUrl(url);
      overlays.precip = layer;
      overlays.radar = layer;
      if (wantOn && !map.hasLayer(layer)) layer.addTo(map);
      layer.setOpacity(0.72);
    } else {
      overlays.precip = window.L.tileLayer(url, {
        attribution: "© RainViewer",
        opacity: 0.72,
        maxZoom: MAP_MAX_ZOOM,
        maxNativeZoom: RADAR_NATIVE_ZOOM,
        tileSize: 256,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 6,
      });
      overlays.radar = overlays.precip;
      if (wantOn) overlays.precip.addTo(map);
    }
    return Promise.resolve();
  }

  ensureRadarLayer(url);
  const front = radarActiveSlot;
  const back = 1 - front;
  const frontLayer = radarLayers[front];
  const backLayer = radarLayers[back];
  if (!frontLayer || !backLayer) return Promise.resolve();
  if (backLayer._url === url && backLayer.options?.opacity > 0.3) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    let tilesHit = 0;
    const finish = () => {
      if (done) return;
      done = true;
      backLayer.off("load", onReady);
      backLayer.off("tileload", onTile);
      const frontEl = frontLayer.getContainer?.();
      const backEl = backLayer.getContainer?.();
      if (frontEl) frontEl.style.transition = "opacity 0.28s ease";
      if (backEl) backEl.style.transition = "opacity 0.28s ease";
      backLayer.setOpacity(0.72);
      frontLayer.setOpacity(0);
      window.setTimeout(() => {
        if (frontEl) {
          frontEl.style.transition = "";
          frontEl.style.opacity = "";
        }
        if (backEl) {
          backEl.style.transition = "";
          backEl.style.opacity = "";
        }
        try {
          if (map.hasLayer(frontLayer) && frontLayer !== backLayer) map.removeLayer(frontLayer);
        } catch {
          /* ignore */
        }
        radarActiveSlot = back;
        overlays.precip = backLayer;
        overlays.radar = backLayer;
        resolve();
      }, 300);
    };
    const onReady = () => finish();
    const onTile = () => {
      tilesHit += 1;
      if (tilesHit >= 3) finish();
    };

    backLayer.setOpacity(0);
    backLayer.setUrl(url);
    if (wantOn && !map.hasLayer(backLayer)) backLayer.addTo(map);
    backLayer.on("load", onReady);
    backLayer.on("tileload", onTile);
    window.setTimeout(finish, 420);
  });
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

export function setRadarFrame(idx, { crossfade = false, play = false } = {}) {
  if (!radarFrames.length) return Promise.resolve();
  const i = Math.max(0, Math.min(radarFrames.length - 1, Number(idx) || 0));
  radarFrameIdx = i;
  const frame = radarFrames[i];
  const paint = frame?.path ? setRadarTilePath(frame.path, { crossfade, play }) : Promise.resolve();
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
  return paint;
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

/**
 * Build a precip scrubber with Present near the middle: past half + nowcast/future half.
 * Uses full RainViewer nowcast when present; if the API omits forecast frames,
 * mirrors the past window with forward time slots (last tile held) so wind/play
 * still have a future half and Present stays centered.
 */
export function assembleRainViewerRadarFrames(pastIn, nowcastIn) {
  const pastAll = (pastIn || []).filter((f) => f && f.path);
  const nowAll = (nowcastIn || []).filter((f) => f && f.path);
  if (!pastAll.length && !nowAll.length) return { frames: [], presentIdx: 0 };

  const nowcast = nowAll.slice(0, 18);
  // Keep the full RainViewer past (typically ~2h). Longer live windows use this
  // tile set plus hourly wind — do not trim past down to the nowcast length.
  const past = pastAll;
  if (nowcast.length) {
    return { frames: [...past, ...nowcast], presentIdx: Math.max(0, past.length - 1) };
  }

  // No nowcast from API — synthesize a future half so Present stays mid-track.
  if (!past.length) return { frames: [], presentIdx: 0 };
  const last = past[past.length - 1];
  const dt =
    past.length >= 2
      ? Math.max(300, Number(past[past.length - 1].time) - Number(past[past.length - 2].time) || 600)
      : 600;
  const futureN = Math.max(6, Math.min(12, past.length));
  const future = [];
  for (let i = 1; i <= futureN; i++) {
    future.push({
      time: Number(last.time) + dt * i,
      path: last.path,
      forecast: true,
    });
  }
  return { frames: [...past, ...future], presentIdx: Math.max(0, past.length - 1) };
}

export function getLiveWindowHrs() {
  return liveWindowHrs;
}

export function setLiveWindowHrs(h) {
  const n = Number(h);
  liveWindowHrs = LIVE_WINDOW_HOURS.includes(n) ? n : 6;
  return liveWindowHrs;
}

export function liveWindowStepSec(hrs = liveWindowHrs) {
  if (hrs <= 2) return 600;
  if (hrs <= 6) return 900;
  if (hrs <= 12) return 1500;
  // ±24h: fewer steps so PLAY can finish a full pass quickly.
  return 2400;
}

export function liveWindowBounds(nowSec, hrs = liveWindowHrs) {
  const now = Number(nowSec);
  const t = Number.isFinite(now) ? now : Date.now() / 1000;
  const half = Math.max(1, Number(hrs) || 6) * 3600;
  return { t0: t - half, t1: t + half };
}

export function buildLiveTimelineSteps({ t0, t1, dt, radar = [], wind = [] } = {}) {
  const start = Number(t0);
  const end = Number(t1);
  const step = Math.max(60, Number(dt) || 600);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const steps = [];
  for (let t = start; t <= end + 1; t += step) {
    const row = { time: t };
    if (radar.length) row.radarIdx = nearestFrameIdx(radar, t);
    if (wind.length) row.windIdx = nearestFrameIdx(wind, t);
    steps.push(row);
  }
  return steps;
}

function hailScopeLiveTimeWindow() {
  return liveWindowBounds(Date.now() / 1000, liveWindowHrs);
}

/** PLAY cadence — keep the scrubber snappy; do not await tile fades. */
function livePlayTickMs() {
  if (liveWindowHrs >= 24) return 70;
  if (liveWindowHrs >= 12) return 85;
  if (liveWindowHrs >= 6) return 100;
  return 120;
}

function livePlayStride() {
  if (liveWindowHrs >= 24) return 2;
  if (liveWindowHrs >= 12) return 1;
  return 1;
}

function hailScopeLiveTimeline() {
  const f = hailScopeRadarFilters;
  if (!f.precip && !f.wind) return [];
  const { t0, t1 } = hailScopeLiveTimeWindow();
  const radar = f.precip && radarFrames.length >= 2 ? radarFrames : [];
  const wind = f.wind && windFrames.length ? windFrames : [];
  // 2h precip-only: ride the native 10-min RainViewer frames.
  if (f.precip && !f.wind && liveWindowHrs <= 2 && radar.length >= 2) {
    const inWin = radar.filter((fr) => Number(fr.time) >= t0 - 1 && Number(fr.time) <= t1 + 1);
    if (inWin.length >= 2) {
      return inWin.map((fr) => ({ time: fr.time, radarIdx: nearestFrameIdx(radarFrames, fr.time) }));
    }
  }
  const steps = buildLiveTimelineSteps({
    t0,
    t1,
    dt: liveWindowStepSec(liveWindowHrs),
    radar,
    wind,
  });
  if (steps.length >= 2) return steps;
  if (radar.length >= 2) return radar.map((fr, i) => ({ time: fr.time, radarIdx: i }));
  if (wind.length >= 2) return wind.map((fr, i) => ({ time: fr.time, windIdx: i }));
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
  const t = Number(timeSec) || 0;
  const d = new Date(t * 1000);
  const when = Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "…";
  const windOn = hailScopeRadarFilters.wind && windFrames[windFrameIdx];
  const mph = windOn ? ` · ${Math.round(windFrames[windFrameIdx].speed || 0)} mph` : "";
  const now = Date.now() / 1000;
  const fr = radarFrames[radarFrameIdx];
  const forecast =
    (fr && fr.forecast) || (t > now + 90) ? " · forecast" : "";
  label.textContent = `${when}${mph}${forecast}`;
}

export function setHailScopeLiveFrame(idx, { crossfade = false, play = false } = {}) {
  const steps = hailScopeLiveTimeline();
  if (!steps.length) return Promise.resolve();
  const i = Math.max(0, Math.min(steps.length - 1, Number(idx) || 0));
  liveTlIdx = i;
  const t = steps[i].time;
  const jobs = [];
  if (hailScopeRadarFilters.precip && radarFrames.length) {
    jobs.push(setRadarFrame(nearestFrameIdx(radarFrames, t), { crossfade, play }));
  }
  if (hailScopeRadarFilters.wind && windFrames.length) {
    const wi = nearestFrameIdx(windFrames, t);
    // During play, only repaint wind every few steps — full field redraw every frame tanks FPS.
    const skipWindPaint = play
      ? i % 3 !== 0 && wi === windFrameIdx
      : crossfade && radarPlaying && i % 2 === 1 && wi === windFrameIdx;
    windFrameIdx = wi;
    if (!skipWindPaint) paintWindFieldFromFrame(windFrames[wi]);
  }
  updateHailScopeLiveLabel(t);
  const range = document.getElementById("hs-live-range") || document.getElementById("wx-radar-range");
  if (range && String(range.value) !== String(i)) range.value = String(i);
  return Promise.all(jobs);
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
  const tag = f.precip && f.wind ? "LIVE" : f.precip ? "LIVE PRECIP" : "LIVE WIND";
  const tagCls = "wx-radar-tag";
  return `<div class="wx-radar-scrub-row">
    <button type="button" id="hs-live-play" class="wx-play-btn${radarPlaying ? " on" : ""}">${radarPlaying ? "PAUSE" : "PLAY"}</button>
    <span class="${tagCls}">${tag}</span>
    ${radarRangeTrackHtml("hs-live-range", max, idx, steps)}
    <span id="hs-live-label" class="wx-radar-label">…</span>
  </div>`;
}

export function hailScopeRadarBarHtml(settings) {
  if (settings) hailScopeRadarOn = settings.showRadar === true;
  if (!hailScopeRadarActive()) return "";
  const f = hailScopeRadarFilters;
  const scrub = hailScopeLiveScrubberInnerHtml();
  const win = LIVE_WINDOW_HOURS.map(
    (h) =>
      `<button type="button" data-hs-live-win="${h}" class="${liveWindowHrs === h ? "on" : ""}" title="±${h} hour window">${h}H</button>`,
  ).join("");
  return `<div class="hs-radar-bar" id="hs-radar-bar">
    <div class="wx-tl-filters hs-radar-filters">
      <button type="button" data-hs-radar-fl="precip" class="${f.precip ? "on" : ""}">PRECIP</button>
      <button type="button" data-hs-radar-fl="wind" class="${f.wind ? "on" : ""}">WIND</button>
      <span class="wx-split" aria-hidden="true"></span>
      ${win}
    </div>
    ${scrub ? `<div class="wx-radar-scrub hs-live-scrub" id="hs-live-scrub">${scrub}</div>` : ""}
  </div>`;
}

function bindHailScopeLiveScrubber(root = document) {
  const range = root.querySelector?.("#hs-live-range") || document.getElementById("hs-live-range");
  const play = root.querySelector?.("#hs-live-play") || document.getElementById("hs-live-play");
  if (!range) return;
  void setHailScopeLiveFrame(liveTlIdx);
  range.oninput = () => {
    stopRadarPlay();
    stopWindPlay();
    void setHailScopeLiveFrame(range.value, { crossfade: true });
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
        const len = hailScopeLiveTimeline().length;
        if (len < 2) {
          stopRadarPlay();
          return;
        }
        const next = (liveTlIdx + livePlayStride()) % len;
        // Fire-and-forget — awaiting tile crossfade made PLAY feel stuck.
        void setHailScopeLiveFrame(next, { play: true });
        radarPlayRaf = window.setTimeout(tick, livePlayTickMs());
      };
      tick();
    };
  }
}

export function bindHailScopeRadar(root = document) {
  bindHailScopeLiveScrubber(root);
  root.querySelectorAll("[data-hs-live-win]").forEach((btn) => {
    btn.onclick = async () => {
      const hrs = Number(btn.dataset.hsLiveWin);
      if (!LIVE_WINDOW_HOURS.includes(hrs)) return;
      if (hrs === liveWindowHrs) return;
      const keep =
        hailScopeLiveTimeline()[Math.min(liveTlIdx, Math.max(0, hailScopeLiveTimeline().length - 1))]?.time ||
        Date.now() / 1000;
      setLiveWindowHrs(hrs);
      if (hailScopeRadarFilters.wind) await ensureWindFrames({ force: true });
      const steps = hailScopeLiveTimeline();
      liveTlIdx = steps.length ? nearestFrameIdx(steps, keep) : 0;
      const host = root.querySelector?.("#hs-radar-bar") || document.getElementById("hs-radar-bar");
      if (host) {
        host.outerHTML = hailScopeRadarBarHtml();
        bindHailScopeRadar(root);
      }
    };
  });
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
          steps[Math.min(liveTlIdx, steps.length - 1)]?.time ||
          (hailScopeRadarFilters.precip && radarFrames[radarFrameIdx]?.time) ||
          (hailScopeRadarFilters.wind && windFrames[windFrameIdx]?.time) ||
          steps[0].time;
        liveTlIdx = nearestFrameIdx(steps, prefer);
      } else liveTlIdx = 0;
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
    const assembled = assembleRainViewerRadarFrames((rv.radar || {}).past, (rv.radar || {}).nowcast);
    radarFrames = assembled.frames;
    radarFrameIdx = assembled.presentIdx;
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
  hailScopeRadarOn = settings?.showRadar === true;
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
      // Shared RainViewer clock whenever frames exist — Present must not jump
      // between precip-only (10‑min) and wind-only (hourly) scrubbers.
      const keep =
        (radarFrames[radarFrameIdx] && radarFrames[radarFrameIdx].time) ||
        windFrames[windFrameIdx]?.time ||
        Date.now() / 1000;
      if (radarFrames.length) {
        windFrameIdx = nearestFrameIdx(windFrames, keep);
        liveTlIdx = nearestFrameIdx(hailScopeLiveTimeline(), keep);
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
    liveTlIdx = nearestFrameIdx(hailScopeLiveTimeline(), radarFrames[radarFrameIdx]?.time);
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
  void setRadarFrame(radarFrameIdx);
  range.oninput = () => {
    stopRadarPlay();
    void setRadarFrame(range.value, { crossfade: true });
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
        void setRadarFrame(next, { play: true });
        radarPlayRaf = window.setTimeout(tick, 110);
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
  const hadSelection = hasSelectedStormDates();
  if (!date) {
    clearStormDateSelection();
  } else if (toggle) {
    toggleStormDateSelection(date);
  } else {
    setStormDateSelection([date], { replace: true });
  }
  if (hadSelection && !hasSelectedStormDates()) {
    emitMapStatus("Hail zones cleared");
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
  } else if (hadSelection && !wxPinSelected() && hailScopeMode) {
    // Cleared every storm date — leave list as-is; Search storms refreshes on demand.
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
    const assembled = assembleRainViewerRadarFrames((rv.radar || {}).past, (rv.radar || {}).nowcast);
    radarFrames = assembled.frames;
    radarFrameIdx = assembled.presentIdx;
    const frame = radarFrames[radarFrameIdx] || radarFrames[0];
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
  const spcDays = spcLookbackDays(deep ? 16 : 8);
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
  const lsrFastP = fetchIemLsrHail(lat, lon, fastKm, lsrFirstDays(days)).catch(() => []);
  const lsrWideP = wideFetch ? fetchIemLsrHail(lat, lon, wideKm, days).catch(() => []) : null;

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

  // Start SWDI + a short SPC lookback — don't wait for contacts before radar dates.
  const swdiFastP = fetchSwdiHail(lat, lon, fastKm, swdiFastDays, {
    onProgress: (swdiBatch) => {
      accHail = mergeHailRows(spcFast.hail || [], swdiBatch, lsrFast);
      pushPartial("swdi", { loading: true, fetchedKm: fastKm });
    },
  });
  const spcFastP = fetchSpcReports(lat, lon, fastKm, 14, {
    onProgress: (part) => {
      spcFast = part;
      accHail = mergeHailRows(part.hail || [], accHail, lsrFast);
      accWind = part.wind || accWind;
      pushPartial("spc", { loading: true, fetchedKm: fastKm });
    },
  });

  [wxNow, spcFast, placeHit] = await Promise.all([wxP, spcFastP, placeP]);
  accHail = mergeHailRows(spcFast.hail || [], accHail, lsrFast);
  accWind = spcFast.wind || [];
  pushPartial("spc", { loading: true, fetchedKm: fastKm });

  const swdiFast = await swdiFastP;
  accHail = mergeHailRows(spcFast.hail || [], swdiFast || [], lsrFast);
  pushPartial("swdi-fast", { loading: wideFetch, fetchedKm: fastKm });

  if (wideFetch) {
    const [lsrWide, swdiWide] = await Promise.all([
      lsrWideP,
      fetchSwdiHail(lat, lon, wideKm, swdiWideDays),
    ]);
    accHail = mergeHailRows(spcFast.hail || [], swdiWide || [], lsrWide, accHail);
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
  applyContextStormFilters("map");
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

/**
 * Map-view storm search — streams partials so the sheet can show the biggest
 * few dates ASAP, then appends as SWDI/SPC/LSR keep landing.
 */
export async function viewportDossier(settings, filters = wxFilters, { onPartial } = {}) {
  const q = mapViewHailQuery();
  if (!q) return null;
  const slow = isSlowBrowserNet();
  const kmFull = Math.max(filterKm(filters), mapViewFetchKm());
  // iPhone Safari/Pages: start with a tighter ring so dates appear before statewide SWDI.
  const km = slow ? Math.min(kmFull, 110) : kmFull;
  const days = Number(filters.days) || 730;
  const lsrDays = lsrFirstDays(days);
  const spcDays = spcLookbackDays(14);
  const recentDays = Math.min(days, slow ? 90 : 120);
  const deepDays = slow ? Math.min(days, 365) : days;
  const deepKm = slow ? Math.min(kmFull, 200) : kmFull;

  const distRows = (rows) =>
    (rows || []).map((h) => ({
      ...h,
      distance_km: Math.round(haversineKm(q.lat, q.lon, h.lat, h.lon) * 10) / 10,
    }));

  const pack = (hail, wind, meta = {}) => {
    let data = {
      ok: true,
      address: "Map view",
      lat: q.lat,
      lon: q.lon,
      viewport: true,
      storms: enrichStormDates([], hail, wind),
      hail: distRows(hail),
      wind: distRows(wind),
      news: [],
      weather: { ok: false },
      _meta: {
        viewport: true,
        fetchedKm: Math.max(km, Number(meta.fetchedKm) || km),
        fetchedDays: days,
        lat: q.lat,
        lon: q.lon,
        listLocked: false,
        ...meta,
      },
    };
    data = normalizeDossier(data) || data;
    data.address = "Map view";
    data.viewport = true;
    return data;
  };

  const push = (hail, wind, meta) => {
    const data = pack(hail, wind, meta);
    if (onPartial) onPartial(data);
    return data;
  };

  let accHail = [];
  let accWind = [];
  let lsr = [];
  let spc = { hail: [], wind: [] };

  // LSR + SWDI first. SPC is a short recent supplement — 90 daily CSVs freeze iPhone Safari.
  const lsrP = fetchIemLsrHail(q.lat, q.lon, km, lsrDays).catch(() => []);
  const swdiP = fetchSwdiHail(q.lat, q.lon, km, recentDays, {
    onProgress: (batch) => {
      accHail = mergeHailRows(spc.hail || [], batch, lsr);
      push(accHail, accWind, { loading: true, partial: "swdi", fetchedKm: km });
    },
  });

  lsr = await lsrP;
  accHail = mergeHailRows([], [], lsr);
  push(accHail, accWind, { loading: true, partial: "lsr", fetchedKm: km });
  const lsrDeepP = days > lsrDays + 20 ? fetchIemLsrHail(q.lat, q.lon, km, days).catch(() => []) : null;

  const spcP = fetchSpcReports(q.lat, q.lon, km, spcDays, {
    onProgress: (part) => {
      spc = part;
      accHail = mergeHailRows(part.hail || [], accHail, lsr);
      accWind = part.wind || accWind;
      push(accHail, accWind, { loading: true, partial: "spc", fetchedKm: km });
    },
  });
  spc = await spcP;
  accHail = mergeHailRows(spc.hail || [], accHail, lsr);
  accWind = spc.wind || [];
  push(accHail, accWind, { loading: true, partial: "spc", fetchedKm: km });

  const swdiRecent = await swdiP;
  if (lsrDeepP) {
    const lsrDeep = await lsrDeepP;
    if (lsrDeep?.length) lsr = mergeHailRows(lsr, lsrDeep);
  }
  accHail = mergeHailRows(spc.hail || [], swdiRecent || [], lsr);
  const needDeep = deepDays > recentDays + 7 || deepKm > km + 8;
  push(accHail, accWind, { loading: needDeep, partial: "swdi-recent", fetchedKm: km });

  if (needDeep) {
    const swdiDeep = await fetchSwdiHail(q.lat, q.lon, deepKm, deepDays, {
      onProgress: (batch) => {
        accHail = mergeHailRows(spc.hail || [], batch, lsr);
        push(accHail, accWind, { loading: true, partial: "swdi-deep", fetchedKm: deepKm });
      },
    });
    accHail = mergeHailRows(spc.hail || [], swdiDeep || [], lsr);
  }

  const final = push(accHail, accWind, { loading: false, partial: "done", fetchedKm: deepKm });
  lastMapViewStormFetch = { lat: q.lat, lon: q.lon, km: deepKm };
  return final;
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
  applyContextStormFilters("pin");
  placeSelectPin([lat, lon]);
  clearPinRadius();
  if (lastHailRows.length || lastWindRows.length) {
    drawHailMarkers(lastHailRows, lastWindRows);
  }
}

/** Switch automatic hail filters for pin vs map-view (user can still change them after). */
export function applyContextStormFilters(mode) {
  const next = mode === "pin" ? PIN_AUTO_FILTERS : MAP_AUTO_FILTERS;
  wxFilters.hailIn = next.hailIn;
  wxFilters.sort = next.sort;
  if (Number(next.km) > 0) wxFilters.km = Math.max(10, Number(next.km));
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
      fetchSpcReports(q.lat, q.lon, km, 14),
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

/**
 * Roofer/industry-style footprint radius from hail size + source type.
 * Zoom-INVARIANT on purpose: the swath is fixed geography — zooming must only
 * change render resolution, never how far hits reach or merge.
 */
function hailFootprintM(sizeIn, source) {
  const sz = parseFloat(sizeIn);
  const s = Number.isNaN(sz) ? 0.75 : sz;
  const radar = /swdi|radar/i.test(String(source || ""));
  const base = (radar ? 780 : 380) + s * (radar ? 620 : 360);
  return Math.max(480, Math.min(4800, base * 1.2));
}

/**
 * Hailswath / MESH-style region builder (Cheresnick & Basara 2005; MRMS MESH contouring).
 * Rasterize size-weighted footprints onto a local km grid, lightly close stair-steps,
 * then extract nested isosurfaces — separate lobes may overlap; we do not fuse them.
 */
const HAIL_SWATH_THRESHOLDS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5];
/** Light morphological close only — wide closes were gluing every core into one blob. */
const HAIL_CLOSE_KM = (thr) => (thr <= 0.5 ? 3.2 : thr <= 0.75 ? 2.4 : thr <= 1 ? 1.6 : thr <= 1.5 ? 1.1 : 0.75);
/** Hits farther than this become separate overlapping zones (not one mega-corridor). */
const HAIL_LOBE_SPLIT_KM = 11;

function blurFloatField(field, w, h, passes = 2) {
  let src = field;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const wgt = dx && dy ? 1 : dx || dy ? 2 : 4;
            s += src[yy * w + xx] * wgt;
            n += wgt;
          }
        }
        out[y * w + x] = s / Math.max(1, n);
      }
    }
    src = out;
  }
  return src;
}

/** Neighbor average — kills remaining stair-steps after Chaikin. */
function relaxRing(ring, iters = 2) {
  if (!ring || ring.length < 5) return ring;
  let pts = ring.slice();
  const closed =
    pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (!closed) pts = pts.concat([pts[0]]);
  for (let n = 0; n < iters; n++) {
    const next = [];
    const lim = pts.length - 1;
    for (let i = 0; i < lim; i++) {
      const a = pts[(i - 1 + lim) % lim];
      const b = pts[i];
      const c = pts[(i + 1) % lim];
      next.push([a[0] * 0.25 + b[0] * 0.5 + c[0] * 0.25, a[1] * 0.25 + b[1] * 0.5 + c[1] * 0.25]);
    }
    next.push(next[0]);
    pts = next;
  }
  return pts;
}

function slimRingVerts(ring, target = 120) {
  if (!ring || ring.length <= target + 1) return ring;
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const open = closed ? ring.slice(0, -1) : ring.slice();
  const stride = Math.max(1, Math.ceil(open.length / Math.max(8, target)));
  const slim = [];
  for (let i = 0; i < open.length; i += stride) slim.push(open[i]);
  if (slim.length < 3) return ring;
  slim.push(slim[0]);
  return slim;
}

function chaikinSmoothRing(ring, iters = 2) {
  if (!ring || ring.length < 4) return ring;
  let pts = slimRingVerts(ring, 140);
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
    // Cap growth — repeated pad→Chaikin used to explode to OOM (500MB+).
    pts = next.length > 360 ? slimRingVerts(next, 160) : next;
  }
  return pts;
}

/** Two-pass chamfer distance (km) from every cell to the nearest ON cell. */
function chamferDistKm(onMask, w, h, cellKm) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = onMask[i] ? 0 : INF;
  const st = cellKm;
  const dg = cellKm * Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + st);
      if (y > 0) {
        v = Math.min(v, d[i - w] + st);
        if (x > 0) v = Math.min(v, d[i - w - 1] + dg);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + dg);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + st);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + st);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + dg);
        if (x > 0) v = Math.min(v, d[i + w - 1] + dg);
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * Morphological close by a fixed km radius (dilate r → erode r) via distance
 * transforms. Resolution-independent: the same gap bridges at any cell size,
 * so zooming refines detail without re-merging shapes.
 */
function closeBinaryKm(grid, w, h, cellKm, closeKm) {
  const r = closeKm / 2;
  if (!(r > 0)) return grid;
  const dOn = chamferDistKm(grid, w, h, cellKm);
  const dil = new Uint8Array(w * h);
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < dil.length; i++) {
    dil[i] = dOn[i] <= r ? 1 : 0;
    inv[i] = dil[i] ? 0 : 1;
  }
  const dOff = chamferDistKm(inv, w, h, cellKm);
  const out = new Uint8Array(w * h);
  // Union with the original mask — closing must never lose real hits.
  for (let i = 0; i < out.length; i++) out[i] = grid[i] || (dil[i] && dOff[i] > r) ? 1 : 0;
  return out;
}

/**
 * Exterior contour from binary occupancy: chain cell-border edges (CCW, interior left).
 * Corner vertices + Chaikin → continuous corridors instead of cell-center balloons.
 */
function walkBinaryExterior(grid, w, h, sx, sy, cellKm, xyToLatLon) {
  const isOn = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !!grid[y * w + x];
  if (!isOn(sx, sy)) return null;

  const seen = new Uint8Array(w * h);
  const q = [[sx, sy]];
  seen[sy * w + sx] = 1;
  const DX4 = [1, -1, 0, 0];
  const DY4 = [0, 0, 1, -1];
  for (let qi = 0; qi < q.length; qi++) {
    const [cx, cy] = q[qi];
    for (let k = 0; k < 4; k++) {
      const nx = cx + DX4[k];
      const ny = cy + DY4[k];
      if (!isOn(nx, ny)) continue;
      const ni = ny * w + nx;
      if (seen[ni]) continue;
      seen[ni] = 1;
      q.push([nx, ny]);
    }
  }

  // Oriented half-edges along the OUTSIDE of ON cells (CCW around the component).
  const nextCorner = new Map();
  const edge = (ax, ay, bx, by) => {
    nextCorner.set(`${ax},${ay}`, [bx, by]);
  };
  for (const [x, y] of q) {
    if (!isOn(x - 1, y)) edge(x, y, x, y + 1); // west side ↑
    if (!isOn(x, y + 1)) edge(x, y + 1, x + 1, y + 1); // north →
    if (!isOn(x + 1, y)) edge(x + 1, y + 1, x + 1, y); // east ↓
    if (!isOn(x, y - 1)) edge(x + 1, y, x, y); // south ←
  }
  if (!nextCorner.size) return null;

  const used = new Set();
  let best = null;
  for (const start of nextCorner.keys()) {
    if (used.has(start)) continue;
    const ring = [];
    let cur = start;
    let guard = 0;
    const maxGuard = nextCorner.size + 4;
    while (guard++ < maxGuard) {
      used.add(cur);
      const [cx, cy] = cur.split(",").map(Number);
      ring.push(xyToLatLon(cx * cellKm, cy * cellKm));
      const n = nextCorner.get(cur);
      if (!n) break;
      cur = `${n[0]},${n[1]}`;
      if (cur === start) {
        ring.push(ring[0]);
        break;
      }
    }
    if (ring.length >= 4 && (!best || ring.length > best.length)) best = ring;
  }
  if (!best || best.length < 4) return null;
  // Light slim only — aggressive striding turned long perimeters into straight boxy runs.
  if (best.length > 260) {
    const stride = Math.max(1, Math.ceil(best.length / 200));
    const slim = [];
    for (let i = 0; i < best.length - 1; i += stride) slim.push(best[i]);
    slim.push(slim[0]);
    return slim;
  }
  return best;
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
        // Rounded bbox capsule — never convexHull (fake right angles) and never
        // softOrganicEnvelopeRing (that calls back into this tracer).
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const [cx, cy] of q) {
          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);
        }
        const midX = (minX + maxX + 1) * 0.5;
        const midY = (minY + maxY + 1) * 0.5;
        const rx = Math.max(1.2, (maxX - minX + 1) * 0.55 + 1.2);
        const ry = Math.max(1.2, (maxY - minY + 1) * 0.55 + 1.2);
        const oval = [];
        const n = 28;
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          oval.push(xyToLatLon((midX + Math.cos(a) * rx) * cellKm, (midY + Math.sin(a) * ry) * cellKm));
        }
        closed = oval;
      }
      rings.push(chaikinSmoothRing(closed, 2));
    }
  }
  return rings;
}

/**
 * Build hail-swath polygons from point/radar hits.
 * Target look: elongated organic corridors (0.2.121 screenshot) — nested unique
 * contours — NEVER a pile of soft circles or rounded SWDI boxes.
 */
function buildHailSwathRings(rawPts, zone = {}) {
  const pts = (rawPts || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) return [];
  // One isolated hit is the only case where a soft disk is honest.
  if (pts.length === 1) {
    const p = pts[0];
    const sz = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75;
    return softCircleBands(p.lat, p.lon, sz, p);
  }

  // Split into local lobes (~11 km). Overlapping is fine — one metro mesh was
  // gluing every core into a single white blob.
  const clusters = clusterPoints(pts, HAIL_LOBE_SPLIT_KM);
  const out = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      const p = cluster[0];
      const sz = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75;
      out.push(...softCircleBands(p.lat, p.lon, sz, p));
      continue;
    }
    out.push(...buildHailSwathRingsCluster(cluster, zone));
  }
  out.sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));
  return ensureRadarInsideBands(out, pts);
}

/** True when a ring is basically an axis-aligned rectangle (SWDI box / coarse voxel). */
function isAxisBoxRing(ring) {
  if (!ring || ring.length < 4) return false;
  const pts =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  if (pts.length < 4) return false;
  let axis = 0;
  let n = 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    minLat = Math.min(minLat, a[0]);
    maxLat = Math.max(maxLat, a[0]);
    minLon = Math.min(minLon, a[1]);
    maxLon = Math.max(maxLon, a[1]);
    area2 += a[1] * b[0] - b[1] * a[0];
    const dLat = Math.abs(a[0] - b[0]);
    const dLon = Math.abs(a[1] - b[1]);
    if (dLat < 1e-12 && dLon < 1e-12) continue;
    n++;
    if (dLat < 1e-5 || dLon < 1e-5) axis++;
  }
  if (n < 4) return false;
  const axisFrac = axis / n;
  const bbox = Math.max(1e-18, (maxLat - minLat) * (maxLon - minLon));
  const fill = Math.abs(area2) / 2 / bbox;
  // True SWDI rectangles: few verts + orthogonal edges, or densified box filling its AABB.
  // Do NOT flag long Chaikin-smoothed corridors just because some edges are near-cardinal.
  if (pts.length <= 8 && axisFrac >= 0.75) return true;
  if (pts.length <= 48 && fill >= 0.85 && axisFrac >= 0.62) return true;
  return false;
}

/** Coefficient of variation of radius — low means a near-circle (bad for swaths). */
function ringRadiusCv(ring) {
  const c = ringCentroidLatLon(ring);
  if (!c || !ring || ring.length < 5) return 0;
  const dists = [];
  for (const p of ring) {
    if (!p) continue;
    const d = haversineKm(c.lat, c.lon, p[0], p[1]);
    if (d > 1e-6) dists.push(d);
  }
  if (dists.length < 4) return 0;
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  if (!(mean > 0)) return 0;
  let v = 0;
  for (const d of dists) v += (d - mean) * (d - mean);
  return Math.sqrt(v / dists.length) / mean;
}

function softCircleBands(lat, lon, sizeIn, p) {
  const sz = parseFloat(sizeIn) || 0.75;
  const baseM = hailFootprintM(sz, p?.source);
  const bands = [];
  for (const thr of HAIL_SWATH_THRESHOLDS) {
    if (sz + 0.01 < thr) continue;
    const scale = thr <= 0.5 ? 1.45 : thr <= 0.75 ? 1.15 : thr <= 1 ? 0.92 : thr <= 1.5 ? 0.7 : 0.48;
    bands.push({
      ring: relaxRing(chaikinSmoothRing(ringPolygon(lat, lon, baseM * scale, 36), 3), 2),
      maxSize: thr,
      hits: 1,
      confirmed: isSpotterHail(p) || thr >= 0.75,
      source: isSpotterHail(p) ? "spot+radar" : "radar-merge",
    });
  }
  return bands.length
    ? bands
    : [
        {
          ring: chaikinSmoothRing(ringPolygon(lat, lon, baseM, 32), 2),
          maxSize: sz,
          hits: 1,
          confirmed: isSpotterHail(p),
          source: isSpotterHail(p) ? "spotter" : "radar-merge",
        },
      ];
}

/** Principal storm axis in local km space — elongates kernels into corridors. */
function stormAxisFromPts(pts, toXY) {
  if (!pts || pts.length < 2) return { ax: 1, ay: 0 };
  const xy = pts.map((p) => toXY(p.lat, p.lon));
  const mx = xy.reduce((a, p) => a + p.x, 0) / xy.length;
  const my = xy.reduce((a, p) => a + p.y, 0) / xy.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of xy) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy || 1e-9);
  return { ax: Math.cos(ang), ay: Math.sin(ang) };
}

function buildHailSwathRingsCluster(pts, zone = {}) {
  const swdiRings = [];

  const oLat = Math.round((pts.reduce((a, p) => a + p.lat, 0) / pts.length) * 4) / 4;
  const oLon = Math.round((pts.reduce((a, p) => a + p.lon, 0) / pts.length) * 4) / 4;
  const cos = Math.cos((oLat * Math.PI) / 180);
  const toXY = (lat, lon) => ({
    x: (lon - oLon) * 111.32 * Math.max(0.2, cos),
    y: (lat - oLat) * 111.32,
  });
  const xyToLatLon = (xKm, yKm) => [
    oLat + yKm / 111.32,
    oLon + xKm / (111.32 * Math.max(0.2, cos)),
  ];
  const { ax, ay } = stormAxisFromPts(pts, toXY);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const kernels = pts.map((p) => {
    const raw = parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75;
    const spot = isSpotterHail(p);
    // Radar greens always count — never treat UNK/tiny SWDI as invisible.
    const sz = spot ? raw : Math.max(raw, 0.85);
    const rKm = (hailFootprintM(sz, p.source) / 1000) * (spot ? 0.9 : 1.28);
    const { x, y } = toXY(p.lat, p.lon);
    minX = Math.min(minX, x - rKm * 1.6);
    maxX = Math.max(maxX, x + rKm * 1.6);
    minY = Math.min(minY, y - rKm * 1.6);
    maxY = Math.max(maxY, y + rKm * 1.6);
    return { x, y, rKm, size: sz, spot };
  });
  for (const p of pts) {
    if (!p.swdi_ring || p.swdi_ring.length < 3) continue;
    const sz = Math.max(parseFloat(p.size_in) || parseFloat(zone.size_in) || 0.75, 0.85);
    const ring = p.swdi_ring;
    const cLat = ring.reduce((a, c) => a + c[0], 0) / ring.length;
    const cLon = ring.reduce((a, c) => a + c[1], 0) / ring.length;
    const coreR = hailFootprintM(sz, "noaa-swdi-radar") / 1000;
    const pushK = (lat, lon, rKm) => {
      const { x, y } = toXY(lat, lon);
      minX = Math.min(minX, x - rKm * 1.4);
      maxX = Math.max(maxX, x + rKm * 1.4);
      minY = Math.min(minY, y - rKm * 1.4);
      maxY = Math.max(maxY, y + rKm * 1.4);
      kernels.push({ x, y, rKm, size: sz, spot: false });
    };
    // Boxes → centroid only (no rectangular stamp). Organic SWDI → edge samples.
    if (isAxisBoxRing(ring)) {
      pushK(cLat, cLon, coreR * 0.85);
      continue;
    }
    const edgeR = Math.max(0.2, coreR * 0.32);
    pushK(cLat, cLon, coreR);
    const step = Math.max(1, Math.floor(ring.length / 28));
    for (let i = 0; i < ring.length - 1; i += step) {
      const pt = ring[i];
      if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
      pushK(pt[0], pt[1], edgeR);
    }
  }
  const pad = 2.4;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;

  const span = Math.max(maxX - minX, maxY - minY, 2);
  const maxCells = 208;
  const cellKm = Math.max(0.1, Math.min(0.4, Math.ceil(span / maxCells / 0.05) * 0.05));
  minX = Math.floor(minX / cellKm) * cellKm;
  minY = Math.floor(minY / cellKm) * cellKm;
  const w = Math.min(maxCells + 2, Math.max(24, Math.ceil((maxX - minX) / cellKm)));
  const h = Math.min(maxCells + 2, Math.max(24, Math.ceil((maxY - minY) / cellKm)));
  const field = new Float32Array(w * h);

  for (const k of kernels) {
    // Compact kernels — long anisotropic stretch was bridging separate cores.
    const alongSig = Math.max(0.14, k.rKm * (k.spot ? 0.7 : 0.92));
    const acrossSig = Math.max(0.1, k.rKm * (k.spot ? 0.48 : 0.4));
    const reach = Math.max(alongSig, acrossSig) * 2.05;
    const gx0 = Math.max(0, Math.floor((k.x - reach - minX) / cellKm));
    const gx1 = Math.min(w - 1, Math.ceil((k.x + reach - minX) / cellKm));
    const gy0 = Math.max(0, Math.floor((k.y - reach - minY) / cellKm));
    const gy1 = Math.min(h - 1, Math.ceil((k.y + reach - minY) / cellKm));
    const radarBoost = k.spot ? 1 : 2.35;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const cx = minX + (gx + 0.5) * cellKm;
        const cy = minY + (gy + 0.5) * cellKm;
        const dx = cx - k.x;
        const dy = cy - k.y;
        const along = dx * ax + dy * ay;
        const across = -dx * ay + dy * ax;
        const d2 = (along * along) / (alongSig * alongSig) + (across * across) / (acrossSig * acrossSig);
        if (d2 > 5.5) continue;
        const contrib = k.size * radarBoost * Math.exp(-0.5 * d2);
        const i = gy * w + gx;
        if (contrib > field[i]) field[i] = contrib;
      }
    }
  }

  const spotConfirm = kernels.some((k) => k.spot);
  const radarCount = kernels.filter((k) => !k.spot).length;
  const out = [...swdiRings];
  const xyCell = (xKm, yKm) => xyToLatLon(minX + xKm, minY + yKm);
  const softField = blurFloatField(field, w, h, 1);

  for (const thr of HAIL_SWATH_THRESHOLDS) {
    const binary = new Uint8Array(w * h);
    let any = 0;
    for (let i = 0; i < softField.length; i++) {
      if (softField[i] >= thr) {
        binary[i] = 1;
        any = 1;
      }
    }
    if (!any) continue;
    const closed = closeBinaryKm(binary, w, h, cellKm, HAIL_CLOSE_KM(thr));
    const rings = traceBinaryExteriorRings(closed, w, h, cellKm, xyCell, 18);
    for (const rawRing of rings) {
      if (!rawRing || rawRing.length < 4) continue;
      // Keep the walked contour — never collapse to a circle (that killed unique shapes).
      let ring = rawRing;
      if (ring.length > 160) {
        const stride = Math.ceil(ring.length / 120);
        const slim = [];
        for (let i = 0; i < ring.length - 1; i += stride) slim.push(ring[i]);
        slim.push(slim[0]);
        ring = slim;
      }
      let smooth = relaxRing(chaikinSmoothRing(ring, 4), 2);
      if (isAxisBoxRing(smooth)) {
        smooth = relaxRing(chaikinSmoothRing(ring, 5), 3);
      }
      const meshConfirmed =
        (spotConfirm && thr >= 1) || (radarCount >= 2 && thr >= 0.5) || (radarCount >= 1 && thr >= 0.75);
      out.push({
        ring: padPolygon(smooth, 48),
        maxSize: thr,
        hits: kernels.filter((k) => k.size >= thr).length,
        confirmed: meshConfirmed,
        source: spotConfirm && radarCount ? "spot+radar" : radarCount ? "mesh-swath" : "spotter",
      });
    }
  }

  if (!out.length) {
    // Fallback: soft organic envelope of hits (still not a convex right-angle box).
    const env = softOrganicEnvelopeRing(
      pts.map((p) => ({ lat: p.lat, lon: p.lon })),
      3.5,
    );
    if (env && env.length >= 4) {
      const sz = Math.max(...pts.map((p) => parseFloat(p.size_in) || 0), parseFloat(zone.size_in) || 0.75);
      const bands = [];
      for (const thr of HAIL_SWATH_THRESHOLDS) {
        if (sz + 0.01 < thr) continue;
        const padM = thr <= 0.5 ? 80 : thr <= 0.75 ? 40 : thr <= 1 ? 0 : -80;
        bands.push({
          ring: padM ? relaxRing(chaikinSmoothRing(padPolygon(env, padM), 4), 2) : env,
          maxSize: thr,
          hits: pts.length,
          confirmed: spotConfirm || radarCount > 0,
          source: radarCount ? "mesh-swath" : "spotter",
        });
      }
      return ensureRadarInsideBands(bands, pts);
    }
    const p = pts[0];
    return softCircleBands(p.lat, p.lon, parseFloat(zone.size_in) || parseFloat(p.size_in) || 0.75, p);
  }
  out.sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));
  return ensureRadarInsideBands(out, pts);
}

/**
 * Guarantee every green radar hit sits inside an outer band.
 * Prefer adding/growing organic lobes over merging everything into one hull.
 */
function ensureRadarInsideBands(bands, pts) {
  const radar = (pts || []).filter(
    (p) => p && !isSpotterHail(p) && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)),
  );
  if (!radar.length) return bands || [];
  let out = (bands || [])
    .filter((b) => Array.isArray(b?.ring) && b.ring.length >= 3)
    .map((b) => ({ ...b, ring: ensureClosedRing(b.ring) }));
  let thr = 0.5;
  if (out.length) {
    thr = out.reduce((m, b) => Math.min(m, Number(b.maxSize) || 9), 9);
    if (!(thr < 9)) thr = 0.5;
  }
  const inOuter = (lat, lon) =>
    out.some((b) => Number(b.maxSize) <= thr + 0.05 && pointInLatLonRing(lat, lon, b.ring));

  let misses = radar.filter((p) => !inOuter(p.lat, p.lon));
  for (let guard = 0; guard < 5 && misses.length; guard++) {
    const clusters = clusterPoints(
      misses.map((p) => ({ lat: p.lat, lon: p.lon, size_in: p.size_in, source: p.source })),
      18,
    );
    for (const cluster of clusters) {
      let env = softOrganicEnvelopeRing(
        cluster.map((p) => ({ lat: p.lat, lon: p.lon })),
        4.2,
      );
      if (!env || env.length < 4) {
        // Single green (or envelope fail) → soft radar disk so the hit still counts.
        for (const p of cluster) {
          const sz = Math.max(parseFloat(p.size_in) || 0.85, 0.85);
          const ring = relaxRing(
            chaikinSmoothRing(ringPolygon(p.lat, p.lon, hailFootprintM(sz, "noaa-swdi-radar") * 1.15, 28), 2),
            2,
          );
          out.unshift({
            ring,
            maxSize: thr,
            hits: 1,
            confirmed: true,
            source: "mesh-swath",
          });
        }
        continue;
      }
      // Grow until every green in this cluster is inside — centroid-in-outer is not enough.
      let covered = cluster.every((p) => pointInLatLonRing(p.lat, p.lon, env));
      if (!covered) {
        for (let padM = 180; padM <= 2800 && !covered; padM += 180) {
          const next = slimRingVerts(padPolygon(env, padM), 140);
          if (cluster.every((p) => pointInLatLonRing(p.lat, p.lon, next))) {
            env = relaxRing(chaikinSmoothRing(next, 2), 2);
            covered = true;
          } else if (padM >= 2800) {
            env = relaxRing(chaikinSmoothRing(next, 2), 2);
          }
        }
      }
      out.unshift({
        ring: env,
        maxSize: thr,
        hits: cluster.length,
        confirmed: true,
        source: "mesh-swath",
      });
    }
    misses = radar.filter((p) => !inOuter(p.lat, p.lon));
  }
  out.sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));
  return out;
}

/** Soft distance-field envelope through points — rounded corridor, not a convex box. */
function softOrganicEnvelopeRing(points, padKm = 3) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (!pts.length) return null;
  // Lone green radar still needs a zone — soft disk, not a dropped hit.
  if (pts.length === 1) {
    const p = pts[0];
    const rM = Math.max(1100, (padKm + 0.8) * 1000);
    return relaxRing(chaikinSmoothRing(ringPolygon(p.lat, p.lon, rM, 28), 2), 2);
  }
  const oLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const oLon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
  const cos = Math.cos((oLat * Math.PI) / 180);
  const toXY = (lat, lon) => ({
    x: (lon - oLon) * 111.32 * Math.max(0.2, cos),
    y: (lat - oLat) * 111.32,
  });
  const xyToLatLon = (xKm, yKm) => [oLat + yKm / 111.32, oLon + xKm / (111.32 * Math.max(0.2, cos))];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const xy = pts.map((p) => {
    const q = toXY(p.lat, p.lon);
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
    return q;
  });
  const pad = Math.max(2.5, padKm + 1.5);
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const span = Math.max(maxX - minX, maxY - minY, 2);
  const maxCells = 96;
  const cellKm = Math.max(0.18, Math.min(0.55, Math.ceil(span / maxCells / 0.05) * 0.05));
  minX = Math.floor(minX / cellKm) * cellKm;
  minY = Math.floor(minY / cellKm) * cellKm;
  const w = Math.min(maxCells + 2, Math.max(20, Math.ceil((maxX - minX) / cellKm)));
  const h = Math.min(maxCells + 2, Math.max(20, Math.ceil((maxY - minY) / cellKm)));
  const field = new Float32Array(w * h);
  const rKm = Math.max(1.2, padKm * 0.85);
  const sigma = rKm * 0.72;
  const twoSig2 = 2 * sigma * sigma;
  for (const k of xy) {
    const reach = rKm * 1.8;
    const gx0 = Math.max(0, Math.floor((k.x - reach - minX) / cellKm));
    const gx1 = Math.min(w - 1, Math.ceil((k.x + reach - minX) / cellKm));
    const gy0 = Math.max(0, Math.floor((k.y - reach - minY) / cellKm));
    const gy1 = Math.min(h - 1, Math.ceil((k.y + reach - minY) / cellKm));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const cx = minX + (gx + 0.5) * cellKm;
        const cy = minY + (gy + 0.5) * cellKm;
        const d2 = (cx - k.x) * (cx - k.x) + (cy - k.y) * (cy - k.y);
        if (d2 > reach * reach) continue;
        const contrib = Math.exp(-d2 / twoSig2);
        const i = gy * w + gx;
        if (contrib > field[i]) field[i] = contrib;
      }
    }
  }
  const soft = blurFloatField(field, w, h, 2);
  const binary = new Uint8Array(w * h);
  let any = 0;
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] >= 0.22) {
      binary[i] = 1;
      any = 1;
    }
  }
  if (!any) return null;
  const closed = closeBinaryKm(binary, w, h, cellKm, Math.max(4, padKm));
  const xyCell = (xKm, yKm) => xyToLatLon(minX + xKm, minY + yKm);
  let seedX = -1;
  let seedY = -1;
  for (let y = 0; y < h && seedX < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (closed[y * w + x]) {
        seedX = x;
        seedY = y;
        break;
      }
    }
  }
  if (seedX < 0) return null;
  let best = walkBinaryExterior(closed, w, h, seedX, seedY, cellKm, xyCell);
  if (!best || best.length < 4) {
    // Direct oval from point cloud — avoid tracer recursion / hull corners.
    const oval = [];
    const n = 32;
    const rx = Math.max(1.5, (maxX - minX) * 0.5);
    const ry = Math.max(1.5, (maxY - minY) * 0.5);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      oval.push(xyToLatLon(Math.cos(a) * rx, Math.sin(a) * ry));
    }
    best = oval;
  }
  const ring = slimRingVerts(best, 96);
  return relaxRing(chaikinSmoothRing(padPolygon(ring, 120), 2), 2);
}

/** Fraction of ring edges that run N/S or E/W — high means chunky / voxel look. */
function ringBoxiness(ring) {
  if (!ring || ring.length < 4) return 0;
  let axis = 0;
  let n = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const dLat = Math.abs(ring[i + 1][0] - ring[i][0]);
    const dLon = Math.abs(ring[i + 1][1] - ring[i][1]);
    if (dLat < 1e-12 && dLon < 1e-12) continue;
    n++;
    if (dLat < 1e-9 || dLon < 1e-9) axis++;
  }
  return n ? axis / n : 0;
}

function ringAreaApproxM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat0 = ring[0][0];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][1] * kx * ring[i + 1][0] * ky - ring[i + 1][1] * kx * ring[i][0] * ky;
  }
  return Math.abs(a / 2);
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
 * Each hail-size threshold keeps its own full region (HailTrace / TV-radar style).
 * Layers stack as translucent fills — no hole cutouts, no shared wire mesh.
 */
function stackHailBandPolys(subs) {
  return (subs || [])
    .filter((s) => Array.isArray(s?.ring) && s.ring.length >= 3)
    .map((s) => ({ ...s, ring: ensureClosedRing(s.ring), holes: [] }))
    .sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));
}

function hailLayerFillOpacity(sz) {
  // Relative strength only — hailFills pane opacity (~0.5) caps how much map is blocked.
  const s = Number(sz) || 0;
  if (s <= 0.5) return 0.45;
  if (s < 1) return 0.58;
  if (s < 1.5) return 0.68;
  if (s < 2) return 0.78;
  return 0.85;
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
  const stormOn = hasSelectedStormDates();
  const wideView = zDraw < 11 && !stormOn;

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
      const hasSpot = dayHits.some(isSpotterHail);
      const hasRadar = dayHits.some(isRadarHail);
      subRings.push({
        ring: topoZoneRing(h, zoneHits),
        maxSize: parseFloat(h.size_in) || parseFloat(dayHits[0]?.size_in) || 0.75,
        hits: dayHits.length,
        confirmed: hasSpot || hasRadar,
        source: hasSpot && hasRadar ? "spot+radar" : hasSpot ? "spotter" : hasRadar ? "radar-merge" : "spotter",
      });
    }
    // Weak → strong: each size layer is its own full region (overlapping translucent fills).
    subRings.sort((a, b) => (Number(a.maxSize) || 0) - (Number(b.maxSize) || 0));
    const bands = stackHailBandPolys(subRings);
    for (const sub of bands) {
      const sz = sub.maxSize || parseFloat(h.size_in);
      const col = hailZoneColor(sz);
      const isMixed = sub.source === "spot+radar";
      const isRadarZone = !isMixed && /radar|mesh|swdi/i.test(String(sub.source || ""));
      const isConfirm = isMixed || (Boolean(sub.confirmed) && !isRadarZone);
      fitPts.push(...sub.ring);
      const poly = window.L.polygon(sub.ring, {
        color: col.stroke,
        fillColor: col.fill,
        fillOpacity: hailLayerFillOpacity(sz),
        weight: 1.2,
        opacity: 0.7,
        stroke: true,
        smoothFactor: 2.4,
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
      trackHailStroke(bindHailZoneTap(poly, h, sub), {
        confirmed: isConfirm,
        size: sz,
        kind: "fill",
        radar: isRadarZone,
        outer: true,
      });
    }
    const spots = dayHits.filter(isSpotterHail);
    const radar = dayHits.filter(isRadarHail);
    const zNow = map?.getZoom?.() || 14;
    const dotsAllowed = fieldOverlay.showHailDots !== false && !wideView;
    const showRadarDots = dotsAllowed && (stormOn || zNow >= 11);
    const showSpotDots = dotsAllowed && (stormOn || zNow >= 10);
    const showRadarHalos = dotsAllowed && (stormOn ? zNow >= 12 : zNow >= 15.5);
    const radarCap = stormOn ? (zNow < 9 ? 420 : 320) : 180;
    const spotCap = stormOn ? (zNow < 9 ? 280 : 200) : 120;
    // Cap keeps the dots nearest map center — a raw first-N slice dropped the
    // visible ones whenever a statewide day pool exceeded the cap.
    const c = map?.getCenter?.();
    const nearest = (arr, cap) => {
      if (arr.length <= cap || !c) return arr.slice(0, cap);
      return arr
        .slice()
        .sort(
          (a, b) =>
            (a.lat - c.lat) * (a.lat - c.lat) + (a.lon - c.lng) * (a.lon - c.lng) -
            ((b.lat - c.lat) * (b.lat - c.lat) + (b.lon - c.lng) * (b.lon - c.lng)),
        )
        .slice(0, cap);
    };
    const toDraw = showRadarDots || showSpotDots
      ? [...(showRadarDots ? nearest(radar, radarCap) : []), ...(showSpotDots ? nearest(spots, spotCap) : [])]
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
    // Keep world-anchored particles; only refill if the view emptied them.
    if (windNoise.particles.length < 40) seedWindNoiseParticles();
    drawWindNoiseField(performance.now());
    // Refetch spatial grid when the map has moved off the last sample window.
    if (hailScopeRadarFilters.wind || activeWxProduct === "wind") {
      void ensureWindFrames({ force: windGridNeedsRefresh() });
    }
  }, 120);
}

function windGridNeedsRefresh() {
  if (!map || !windNoise.fetchBounds) return true;
  const b = map.getBounds?.();
  if (!b) return true;
  const fb = windNoise.fetchBounds;
  const c = map.getCenter();
  if (!c) return true;
  // Refresh when center leaves the inner 50% of the fetched window.
  const midLat = (fb.south + fb.north) / 2;
  const midLon = (fb.west + fb.east) / 2;
  const halfLat = (fb.north - fb.south) * 0.25;
  const halfLon = (fb.east - fb.west) * 0.25;
  return (
    c.lat < midLat - halfLat ||
    c.lat > midLat + halfLat ||
    c.lng < midLon - halfLon ||
    c.lng > midLon + halfLon
  );
}

function ensureWindNoiseCanvas() {
  if (!map) return null;
  const container = map.getContainer?.();
  if (!container) return null;
  // Sit on the map container — not a transforming Leaflet pane — so
  // latLngToContainerPoint stays aligned while the map pans.
  if (!windNoise.canvas) {
    const canvas = document.createElement("canvas");
    canvas.className = "hs-wind-noise";
    canvas.setAttribute("aria-hidden", "true");
    const controls = container.querySelector(".leaflet-control-container");
    if (controls) container.insertBefore(canvas, controls);
    else container.appendChild(canvas);
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

/** Seed particles as lat/lon so they stick to the map, not the screen. */
function seedWindNoiseParticles() {
  if (!map) return;
  const b = map.getBounds?.()?.pad?.(0.08);
  const size = map.getSize();
  if (!b || !size) return;
  const target = Math.min(260, Math.max(80, Math.round((size.x * size.y) / 800)));
  const aspect = size.x / Math.max(1, size.y);
  const cols = Math.max(5, Math.round(Math.sqrt(target * aspect)));
  const rows = Math.max(5, Math.round(target / cols));
  const south = b.getSouth();
  const north = b.getNorth();
  const west = b.getWest();
  const east = b.getEast();
  const particles = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const jx = windHash01(id * 3.17 + 0.71);
      const jy = windHash01(id * 5.91 + 1.37);
      particles.push({
        lat: south + ((r + jy) / rows) * (north - south),
        lon: west + ((c + jx) / cols) * (east - west),
        phase: windHash01(id * 9.23),
        lenJ: 0.55 + windHash01(id * 2.41) * 0.9,
        dirJ: (windHash01(id * 4.13) - 0.5) * 6, // tiny jitter — direction must read as real wind
        alpha: 0.22 + windHash01(id * 6.61) * 0.58,
      });
      id += 1;
    }
  }
  windNoise.particles = particles;
}

function sampleWindAt(frame, lat, lon) {
  const g = frame?.grid;
  if (!g || !g.cols || !g.rows) {
    return {
      speed: Number(frame?.speed) || 0,
      dir: Number(frame?.dir) || 0,
      gust: Number(frame?.gust) || Number(frame?.speed) || 0,
    };
  }
  const fx = (lon - g.west) / g.dLon - 0.5;
  const fy = (lat - g.south) / g.dLat - 0.5;
  const x0 = Math.max(0, Math.min(g.cols - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(g.rows - 1, Math.floor(fy)));
  const x1 = Math.min(g.cols - 1, x0 + 1);
  const y1 = Math.min(g.rows - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const idx = (x, y) => y * g.cols + x;
  const lerp = (a, b, t) => a + (b - a) * t;
  const s00 = g.speed[idx(x0, y0)];
  const s10 = g.speed[idx(x1, y0)];
  const s01 = g.speed[idx(x0, y1)];
  const s11 = g.speed[idx(x1, y1)];
  const speed = lerp(lerp(s00, s10, tx), lerp(s01, s11, tx), ty);
  // Direction via unit-vector blend so 350°↔10° doesn't average to 180°.
  const toUV = (deg) => {
    const r = ((Number(deg) || 0) * Math.PI) / 180;
    return { u: Math.sin(r), v: Math.cos(r) };
  };
  const d00 = toUV(g.dir[idx(x0, y0)]);
  const d10 = toUV(g.dir[idx(x1, y0)]);
  const d01 = toUV(g.dir[idx(x0, y1)]);
  const d11 = toUV(g.dir[idx(x1, y1)]);
  const u = lerp(lerp(d00.u, d10.u, tx), lerp(d01.u, d11.u, tx), ty);
  const v = lerp(lerp(d00.v, d10.v, tx), lerp(d01.v, d11.v, tx), ty);
  const dir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const g00 = g.gust[idx(x0, y0)];
  const g10 = g.gust[idx(x1, y0)];
  const g01 = g.gust[idx(x0, y1)];
  const g11 = g.gust[idx(x1, y1)];
  const gust = lerp(lerp(g00, g10, tx), lerp(g01, g11, tx), ty);
  return { speed, dir, gust };
}

function drawWindNoiseField(ts) {
  const ctx = windNoise.ctx;
  const frame = windNoise.frame;
  if (!ctx || !frame || !map) return;
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);

  for (const p of windNoise.particles) {
    const sample = sampleWindAt(frame, p.lat, p.lon);
    const spd = sample.speed;
    const gust = sample.gust;
    // Meteorological FROM → flow TO (0 = north).
    const baseTo = (((sample.dir || 0) + 180) * Math.PI) / 180;
    const ang = baseTo; // exact meteorological flow — no fake swirl
    const baseLen = Math.max(5, Math.min(18, 4.5 + spd * 0.28));
    const pulseBoost = 0.55 + Math.min(0.45, gust / 55);
    const breathe = 0.88 + 0.12 * Math.sin(ts / 1100 + p.phase * 6.283);
    const len = baseLen * p.lenJ * breathe;
    const pt = map.latLngToContainerPoint([p.lat, p.lon]);
    if (pt.x < -40 || pt.y < -40 || pt.x > size.x + 40 || pt.y > size.y + 40) continue;
    const sx = Math.sin(ang) * len;
    const sy = -Math.cos(ang) * len;
    const x0 = pt.x - sx * 0.4;
    const y0 = pt.y - sy * 0.4;
    const x1 = pt.x + sx * 0.6;
    const y1 = pt.y + sy * 0.6;
    ctx.globalAlpha = Math.min(0.92, p.alpha * pulseBoost);
    ctx.strokeStyle = WIND_FIELD_COLOR;
    ctx.fillStyle = WIND_FIELD_COLOR;
    ctx.lineWidth = 1.25;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
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
    const dt = windNoise.lastTs ? Math.min(48, ts - windNoise.lastTs) : 16;
    windNoise.lastTs = ts;
    const b = map.getBounds?.()?.pad?.(0.15);
    for (const p of windNoise.particles) {
      const sample = sampleWindAt(frame, p.lat, p.lon);
      const ang = (((sample.dir || 0) + 180) * Math.PI) / 180;
      // Visual scale: real wind is slow on a map — amplify so flow reads at radar pace.
      const driftKm = (0.012 + (sample.speed || 0) * 0.0011) * dt * 0.045;
      p.lat += (Math.cos(ang) * driftKm) / 111.32;
      p.lon += (Math.sin(ang) * driftKm) / (111.32 * Math.max(0.2, Math.cos((p.lat * Math.PI) / 180)));
      if (b) {
        const h = b.getNorth() - b.getSouth();
        const w = b.getEast() - b.getWest();
        if (p.lat < b.getSouth()) p.lat += h;
        else if (p.lat > b.getNorth()) p.lat -= h;
        if (p.lon < b.getWest()) p.lon += w;
        else if (p.lon > b.getEast()) p.lon -= w;
      }
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

/**
 * Fetch a spatial wind grid over the visible map (Open-Meteo multi-point) so
 * particles sample local direction/speed instead of one map-center value.
 */
async function ensureWindFrames({ force = false } = {}) {
  if (!map) return;
  if (windFrames.length && !force && !windGridNeedsRefresh()) return;
  const c = map.getCenter();
  if (!c) return;
  const gen = ++windFetchGen;
  // Cap the sample window (~400 km). Zoomed-out continent views used to stretch
  // a 5×5 grid across the whole map — every fleck shared one fake direction.
  const MAX_HALF_KM = 200;
  const b0 = map.getBounds?.()?.pad?.(0.15);
  let west;
  let east;
  let south;
  let north;
  if (b0) {
    const halfLat = Math.min(MAX_HALF_KM / 111.32, (b0.getNorth() - b0.getSouth()) / 2);
    const halfLon = Math.min(
      MAX_HALF_KM / (111.32 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180))),
      (b0.getEast() - b0.getWest()) / 2,
    );
    south = c.lat - halfLat;
    north = c.lat + halfLat;
    west = c.lng - halfLon;
    east = c.lng + halfLon;
  } else {
    const dLat = MAX_HALF_KM / 111.32;
    const dLon = MAX_HALF_KM / (111.32 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)));
    south = c.lat - dLat;
    north = c.lat + dLat;
    west = c.lng - dLon;
    east = c.lng + dLon;
  }
  const cols = 6;
  const rows = 6;
  const dLon = (east - west) / cols;
  const dLat = (north - south) / rows;
  const lats = [];
  const lons = [];
  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      lats.push(south + (r + 0.5) * dLat);
      lons.push(west + (cc + 0.5) * dLon);
    }
  }
  try {
    const params = new URLSearchParams({
      latitude: lats.map((v) => v.toFixed(4)).join(","),
      longitude: lons.map((v) => v.toFixed(4)).join(","),
      hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      past_days: "1",
      forecast_days: "1",
      wind_speed_unit: "mph",
      timezone: "auto",
    });
    const { body } = await httpGet(`https://api.open-meteo.com/v1/forecast?${params}`, 14000);
    if (gen !== windFetchGen) return;
    let parsed = JSON.parse(body || "{}");
    // Multi-location → array; single → object.
    const places = Array.isArray(parsed) ? parsed : [parsed];
    if (!places.length || !places[0]?.hourly?.time?.length) return;

    const times = places[0].hourly.time || [];
    const now = Date.now() / 1000;
    const frames = [];
    for (let ti = 0; ti < times.length; ti++) {
      const t = Date.parse(times[ti]);
      if (!Number.isFinite(t)) continue;
      const sec = t / 1000;
      const half = liveWindowHrs * 3600 + 1800;
      if (sec < now - half || sec > now + half) continue;
      const speed = new Float32Array(cols * rows);
      const dir = new Float32Array(cols * rows);
      const gust = new Float32Array(cols * rows);
      for (let pi = 0; pi < places.length && pi < cols * rows; pi++) {
        const h = places[pi]?.hourly || {};
        speed[pi] = Number(h.wind_speed_10m?.[ti]) || 0;
        dir[pi] = Number(h.wind_direction_10m?.[ti]) || 0;
        gust[pi] = Number(h.wind_gusts_10m?.[ti]) || speed[pi];
      }
      // Center cell for the scrubber label.
      const mid = Math.floor((rows * cols) / 2);
      frames.push({
        time: sec,
        speed: speed[mid] || speed[0] || 0,
        dir: dir[mid] || dir[0] || 0,
        gust: gust[mid] || gust[0] || 0,
        grid: { west, south, dLon, dLat, cols, rows, speed, dir, gust },
      });
    }
    if (!frames.length) return;
    const keepTime =
      windFrames[windFrameIdx]?.time ||
      radarFrames[radarFrameIdx]?.time ||
      now;
    windFrames = frames;
    windNoise.fetchBounds = { west, south, east, north };
    windFrameIdx = nearestFrameIdx(frames, keepTime);
    if (hailScopeRadarFilters.wind || activeWxProduct === "wind") {
      paintWindFieldFromFrame(windFrames[windFrameIdx]);
    }
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
  // Tablets keep the phone chrome; only true desktop gets mouse/scroll UI.
  return usePhoneChrome();
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
  persistHydrated = false;
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
    // Above Google labels baked into tiles; below pins/popups.
    pane.style.zIndex = 685;
    pane.style.pointerEvents = "none";
  }
  if (!houseLayer) houseLayer = window.L.layerGroup();
  if (!map.hasLayer(houseLayer)) houseLayer.addTo(map);
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
  }, 220);
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
  const q = z >= 18 ? 0.0015 : z >= 16 ? 0.003 : z >= 12 ? 0.01 : 0.025;
  const r = (v) => Math.round(v / q);
  return `${z}|${r(b.getSouth())}|${r(b.getWest())}|${r(b.getNorth())}|${r(b.getEast())}`;
}

/** Km radius for Flags around map center — wider when zoomed out, always available. */
function flagSearchKm() {
  const z = map?.getZoom?.() ?? 14;
  if (z >= 17) return FLAG_SEARCH_KM_MIN;
  if (z >= 15) return 3.5;
  if (z >= 13) return 5;
  if (z >= 11) return 7;
  return FLAG_SEARCH_KM_MAX;
}

/** Bounds for Flags — the visible map frame (not a tiny center circle / not OKC). */
function flagSearchBounds() {
  if (!map || !window.L) return null;
  const view = map.getBounds?.();
  if (view?.isValid?.()) {
    // Slight pad so edge-of-screen listings still load.
    let b = view.pad(0.1);
    const c = map.getCenter?.();
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      // Cap runaway zoom-out so one pan doesn't request half the state.
      const diag = haversineKm(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
      const maxDiag = 48;
      if (diag > maxDiag) {
        const km = maxDiag / 2;
        const dLat = km / 111.32;
        const dLon = km / (111.32 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)));
        b = window.L.latLngBounds([c.lat - dLat, c.lng - dLon], [c.lat + dLat, c.lng + dLon]);
      }
    }
    return b;
  }
  const c = map.getCenter?.();
  if (!c) return null;
  const km = flagSearchKm();
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)));
  return window.L.latLngBounds(
    [c.lat - dLat, c.lng - dLon],
    [c.lat + dLat, c.lng + dLon],
  );
}

function flagViewBoundsPayload() {
  const b = flagSearchBounds();
  if (!b?.isValid?.()) return null;
  return {
    south: b.getSouth(),
    west: b.getWest(),
    north: b.getNorth(),
    east: b.getEast(),
  };
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

function housePhoneKey({ num, street, lat, lon } = {}) {
  const n = String(num || "")
    .trim()
    .toLowerCase();
  const s = streetKey(street || "");
  if (n && s) return `${n}|${s}`;
  if (Number.isFinite(lat) && Number.isFinite(lon)) return `@${lat.toFixed(4)},${lon.toFixed(4)}`;
  return n ? `n:${n}` : "";
}

function firstTagPhone(tags = {}) {
  return (
    String(tags.phone || tags["contact:phone"] || tags["contact:mobile"] || "")
      .split(/[;,/|]/)
      .map((s) => s.trim())
      .find(Boolean) || ""
  );
}

function rememberHousePhone(info, phone) {
  if (isJunkPhone(phone)) return "";
  const digits = phoneDigits(phone);
  if (!digits) return "";
  const pretty = formatPhone(phone) || digits;
  const key = housePhoneKey(info);
  if (key) housePhoneByKey.set(key, pretty);
  if (Number.isFinite(info?.lat) && Number.isFinite(info?.lon)) {
    housePhoneByKey.set(housePhoneKey({ lat: info.lat, lon: info.lon }), pretty);
  }
  return pretty;
}

function houseHasPhone(n) {
  if (!n) return false;
  if (n.phone && !isJunkPhone(n.phone) && phoneDigits(n.phone)) return true;
  const key = housePhoneKey(n);
  return Boolean(key && housePhoneByKey.has(key));
}

function housePhoneFor(n) {
  if (n?.phone && !isJunkPhone(n.phone) && phoneDigits(n.phone)) return formatPhone(n.phone) || n.phone;
  const key = housePhoneKey(n);
  return (key && housePhoneByKey.get(key)) || "";
}

function houseHasUseful(n) {
  return houseHasFlag(n);
}

function houseHasFlag(n) {
  if (!n || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) return false;
  const kind = housePhoneKind(n);
  if ((kind === "rental" || kind === "business") && houseHasPhone(n)) return true;
  // Zillow / listing map pin — show in-frame even before a public leasing phone lands.
  if (kind === "rental" && String(n.zillow_url || "").trim()) return true;
  return false;
}

function rememberHouseUseful(info, { phone = "", name = "", email = "", kind = "", source = "" } = {}) {
  const key = housePhoneKey(info);
  if (!key) return;
  const prev = houseUsefulByKey.get(key) || {};
  const nextKind =
    classifyFlagPhone({
      phone: phone || prev.phone || "",
      source: source || kind || prev.source || "",
      phone_kind: kind || prev.kind || "",
      zillow_url: info?.zillow_url || "",
      zillow_rent: info?.zillow_rent === true,
    }) ||
    (info?.zillow_rent || /zillow-rent|rent-com|apartments/i.test(String(source || kind || ""))
      ? "rental"
      : "");
  if (!nextKind) return;
  const next = {
    phone: phone || prev.phone || "",
    name: name || prev.name || "",
    email: email || prev.email || "",
    kind: nextKind,
    source: source || prev.source || "",
  };
  if (!next.phone && !(info?.zillow_rent && info?.zillow_url)) return;
  houseUsefulByKey.set(key, next);
  if (next.phone) rememberHousePhone(info, next.phone);
  if (Number.isFinite(info?.lat) && Number.isFinite(info?.lon)) {
    houseUsefulByKey.set(housePhoneKey({ lat: info.lat, lon: info.lon }), next);
  }
}

function housePhoneKind(n) {
  const key = housePhoneKey(n);
  const u = key ? houseUsefulByKey.get(key) : null;
  const classified = classifyFlagPhone({
    phone: housePhoneFor(n) || n?.phone || u?.phone || "",
    source: n?.source || u?.source || "",
    phone_kind: n?.phone_kind || u?.kind || "",
    zillow_url: n?.zillow_url || "",
    zillow_rent: n?.zillow_rent === true,
  });
  if (classified) return classified;
  if (
    n?.zillow_rent === true ||
    n?.phone_kind === "rental" ||
    /zillow-rent|rent-com|apartments/i.test(String(n?.source || u?.source || ""))
  ) {
    return "rental";
  }
  return "";
}

function houseKindLabel(n) {
  const kind = housePhoneKind(n);
  if (kind === "business") return "Business";
  if (kind === "rental") return "For rent";
  return "";
}

function houseUsefulTip(n) {
  const key = housePhoneKey(n);
  const u = key ? houseUsefulByKey.get(key) : null;
  const phone = housePhoneFor(n) || n.phone || u?.phone || "";
  const name = String(n.owner_name || u?.name || "").trim();
  const email = String(n.email || u?.email || "").trim();
  return [houseKindLabel(n), name, phone, email].filter(Boolean).join(" · ");
}

/** Pin dossier — only paint a flag when the phone is a rental listing or a public business. */
function noteHouseOwnerPhone(lat, lon, addr, phone, extra = {}) {
  const parts = parseStreetAddress(addr || "");
  const info = { num: parts.house, street: parts.street, lat, lon, zillow_url: extra.zillow_url || "" };
  const kind = classifyFlagPhone({
    phone: phone || "",
    source: extra.source || "",
    phone_kind: extra.phone_kind || "",
    zillow_url: extra.zillow_url || "",
    zillow_rent: extra.zillow_rent === true,
  });
  if (!kind || !phone) return;
  rememberHouseUseful(info, {
    phone,
    name: extra.owner_name || extra.name || "",
    email: extra.owner_email || extra.email || "",
    kind,
    source: extra.source || "",
  });
  const pretty = rememberHousePhone(info, phone);
  let changed = false;
  let matched = false;
  for (const n of houseCache.nums || []) {
    const sameNum =
      parts.house && String(n.num || "").toLowerCase() === String(parts.house).toLowerCase();
    const sameStreet =
      !parts.street || !n.street || streetKey(n.street) === streetKey(parts.street);
    const near =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Number.isFinite(n.lat) &&
      Number.isFinite(n.lon) &&
      haversineKm(lat, lon, n.lat, n.lon) <= 0.05;
    if (!(sameNum && sameStreet) && !near) continue;
    matched = true;
    if (pretty && n.phone !== pretty) {
      n.phone = pretty;
      changed = true;
    }
    if (extra.owner_name && n.owner_name !== extra.owner_name) {
      n.owner_name = extra.owner_name;
      changed = true;
    }
    if (extra.owner_email && n.email !== extra.owner_email) {
      n.email = extra.owner_email;
      changed = true;
    }
    if (n.phone_kind !== kind) {
      n.phone_kind = kind;
      changed = true;
    }
    if (extra.source && n.source !== extra.source) n.source = extra.source;
    if (!n.street && parts.street) n.street = parts.street;
  }
  if (!matched && parts.house && Number.isFinite(lat) && Number.isFinite(lon)) {
    if (!Array.isArray(houseCache.nums)) houseCache.nums = [];
    houseCache.nums.push({
      num: parts.house,
      street: parts.street || "",
      city: parts.city || "",
      zip: parts.zip || "",
      lat,
      lon,
      phone: pretty || "",
      owner_name: extra.owner_name || extra.name || "",
      email: extra.owner_email || extra.email || "",
      phone_kind: kind,
      source: extra.source || "",
    });
    changed = true;
  }
  if (changed) {
    housePaintSig = "";
    paintHouseLayer([], houseCache.nums);
  }
}

/**
 * Green phone flags (not address text) — tap Call/Text, hold to copy.
 * Only drawn when the Flags layer is on and a public phone is known.
 */
function phoneFlagsEnabled() {
  return fieldOverlay.showPhoneFlags === true;
}

function flagMarkerKind(n) {
  return housePhoneKind(n) === "business" ? "business" : "home";
}

function phoneFlagIcon(tip = "", kind = "home") {
  const title = tip ? ` title="${tip}"` : "";
  if (kind === "business" || kind === "info") {
    return window.L.divIcon({
      className: "hs-phone-flag hs-flag-pin",
      html: `<span class="hs-phone-flag-ico ${kind === "business" ? "biz" : "info"} has-phone"${title} aria-hidden="true"><svg viewBox="0 0 24 36" width="14" height="21" focusable="false"><path fill="#2A81CB" d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z"/><circle cx="12" cy="12" r="5.2" fill="#fff"/></svg></span>`,
      iconSize: [14, 21],
      iconAnchor: [7, 21],
    });
  }
  return window.L.divIcon({
    className: "hs-phone-flag",
    html: `<span class="hs-phone-flag-ico has-phone"${title} aria-hidden="true"><svg viewBox="0 0 16 22" width="13" height="18" focusable="false"><path fill="#0b0b0d" d="M2.4 0.8h1.8v20.2H2.4z"/><path fill="#1dff6e" d="M4.2 1.6h9.6l-2.6 3.5 2.6 3.5H4.2z"/><circle cx="3.3" cy="20.6" r="1.3" fill="#1dff6e"/></svg></span>`,
    iconSize: [13, 18],
    iconAnchor: [3, 18],
  });
}

function flagDist2(n, c) {
  if (!c) return 0;
  const dLat = n.lat - c.lat;
  const dLon = n.lon - c.lng;
  return dLat * dLat + dLon * dLon;
}

function flagItemKey(n) {
  const phone = phoneDigits(housePhoneFor(n) || n?.phone || "");
  if (phone && Number.isFinite(n?.lat) && Number.isFinite(n?.lon)) {
    return `${phone}|${n.lat.toFixed(4)}|${n.lon.toFixed(4)}`;
  }
  return housePhoneKey(n) || (Number.isFinite(n?.lat) ? `@${n.lat.toFixed(4)},${n.lon.toFixed(4)}` : "");
}

function persistFlagHidden() {
  try {
    sessionStorage.setItem("hs-flag-hidden", JSON.stringify([...flagHiddenKeys].slice(-500)));
  } catch {
    /* ignore */
  }
}

function hideFlag(n) {
  const k = flagItemKey(n);
  if (!k) return;
  flagHiddenKeys.add(k);
  persistFlagHidden();
  housePaintSig = "";
  paintHouseLayer([], houseCache.nums);
}

function setFlagKindFilter(kind, on) {
  if (kind !== "rental" && kind !== "business") return;
  flagKindFilter[kind] = on !== false;
  if (!flagKindFilter.rental && !flagKindFilter.business) {
    flagKindFilter[kind === "rental" ? "business" : "rental"] = true;
  }
  housePaintSig = "";
  paintHouseLayer([], houseCache.nums);
}

function borrowPhonesForRentFlags(nums) {
  const donors = (nums || []).filter((n) => housePhoneKind(n) === "rental" && houseHasPhone(n));
  if (!donors.length) return;
  for (const n of nums || []) {
    if (housePhoneKind(n) !== "rental" || houseHasPhone(n)) continue;
    let best = null;
    let bestD = 1.6;
    for (const d of donors) {
      const dist = haversineKm(n.lat, n.lon, d.lat, d.lon);
      if (dist <= bestD) {
        bestD = dist;
        best = d;
      }
    }
    if (!best) continue;
    const ph = housePhoneFor(best);
    if (!ph) continue;
    n.phone = ph;
    rememberHouseUseful(n, {
      phone: ph,
      kind: "rental",
      source: n.source || best.source || "rent-com",
    });
  }
}

function readyFlagList(nums) {
  const c = map?.getCenter?.();
  const b = map?.getBounds?.();
  borrowPhonesForRentFlags(nums);
  // Show rentals in / near the map frame (generous pad — city search hits sit across town).
  const list = (nums || []).filter((n) => {
    if (!houseHasFlag(n) || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) return false;
    if (flagHiddenKeys.has(flagItemKey(n))) return false;
    const kind = housePhoneKind(n);
    if (kind === "rental" && !flagKindFilter.rental) return false;
    if (kind === "business" && !flagKindFilter.business) return false;
    if (b?.isValid?.()) {
      const s = b.getSouth();
      const n0 = b.getNorth();
      const w = b.getWest();
      const e = b.getEast();
      const dLat = Math.max(0.05, (n0 - s) * 1.1);
      const dLon = Math.max(0.05, (e - w) * 1.1);
      const inFrame = n.lat >= s - dLat && n.lat <= n0 + dLat && n.lon >= w - dLon && n.lon <= e + dLon;
      if (inFrame) return true;
      if (c && haversineKm(c.lat, c.lng, n.lat, n.lon) <= Math.max(flagSearchKm() * 4.5, 28)) return true;
      return false;
    }
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      const maxKm = Math.max(flagSearchKm() * 4.5, 28);
      if (haversineKm(c.lat, c.lng, n.lat, n.lon) > maxKm) return false;
    }
    return true;
  });
  const rentals = list.filter((n) => housePhoneKind(n) === "rental");
  const biz = list.filter((n) => housePhoneKind(n) !== "rental");
  rentals.sort((a, b) => flagDist2(a, c) - flagDist2(b, c));
  biz.sort((a, b) => flagDist2(a, c) - flagDist2(b, c));
  const bizCap = flagBizPaintMax();
  return [...rentals, ...biz.slice(0, bizCap)];
}

function flyToFlag(n) {
  if (!map || !n || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) return;
  const z = map.getZoom?.() || 0;
  map.flyTo([n.lat, n.lon], Math.max(19, z), { duration: 0.45 });
}

function paintFlagDock() {
  const shell = document.getElementById("hs-map-shell");
  if (!shell) return;
  let dock = document.getElementById("hs-flag-dock");
  const ready = readyFlagList(houseCache.nums);
  if (!phoneFlagsEnabled() || !ready.length) {
    if (dock) dock.hidden = true;
    return;
  }
  if (!dock) {
    dock = document.createElement("div");
    dock.id = "hs-flag-dock";
    dock.className = "hs-flag-dock";
    shell.appendChild(dock);
    dock.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-flag-act]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const list = readyFlagList(houseCache.nums);
      if (!list.length) return;
      const act = btn.getAttribute("data-flag-act");
      if (act === "rent") {
        setFlagKindFilter("rental", !flagKindFilter.rental);
        return;
      }
      if (act === "biz") {
        setFlagKindFilter("business", !flagKindFilter.business);
        return;
      }
      if (act === "hide") {
        const cur = list[Math.max(0, Math.min(list.length - 1, flagDockIdx))];
        hideFlag(cur);
        return;
      }
      if (act === "prev") flagDockIdx = (flagDockIdx - 1 + list.length) % list.length;
      else if (act === "next") flagDockIdx = (flagDockIdx + 1) % list.length;
      const n = list[Math.max(0, Math.min(list.length - 1, flagDockIdx))];
      flyToFlag(n);
      paintFlagDock();
    });
  }
  flagDockIdx = ((flagDockIdx % ready.length) + ready.length) % ready.length;
  const cur = ready[flagDockIdx];
  const kind = flagMarkerKind(cur);
  const kindLabel = houseKindLabel(cur);
  const label = [kindLabel, cur.num, cur.street].filter(Boolean).join(" ") || housePhoneFor(cur) || "Flag";
  dock.hidden = false;
  dock.innerHTML = `<button type="button" class="hs-flag-dock-kind ${flagKindFilter.rental ? "on" : ""}" data-flag-act="rent" aria-pressed="${flagKindFilter.rental ? "true" : "false"}" title="Show or hide for-rent flags">Rent</button>
    <button type="button" class="hs-flag-dock-kind ${flagKindFilter.business ? "on" : ""}" data-flag-act="biz" aria-pressed="${flagKindFilter.business ? "true" : "false"}" title="Show or hide business flags">Biz</button>
    <button type="button" class="hs-flag-dock-nav" data-flag-act="prev" aria-label="Previous flag">‹</button>
    <button type="button" class="hs-flag-dock-go" data-flag-act="go" title="Zoom to this flag">
      <i class="hs-flag-dock-dot ${kind === "home" ? "home" : "biz"}" aria-hidden="true"></i>
      <span>${escHousePop(label)}</span>
    </button>
    <button type="button" class="hs-flag-dock-nav" data-flag-act="next" aria-label="Next flag">›</button>
    <button type="button" class="hs-flag-dock-hide" data-flag-act="hide" title="Hide this flag">Hide</button>
    <span class="hs-flag-dock-n">${flagDockIdx + 1}/${ready.length}</span>`;
}

function paintHouseLayer(_rings, nums) {
  ensureHousePane();
  if (!phoneFlagsEnabled()) {
    houseLayer?.clearLayers?.();
    housePaintSig = "off";
    paintFlagDock();
    return;
  }
  const list = readyFlagList(nums);
  const phoneBits = list.map((n) => `${n.num}|${housePhoneFor(n)}|${flagMarkerKind(n)}`).join(";");
  const sig = `${houseCache.key}|flags:${list.length}|${phoneBits}`;
  if (sig === housePaintSig && houseLayer?.getLayers?.().length) {
    paintFlagDock();
    return;
  }
  housePaintSig = sig;
  houseLayer.clearLayers();
  for (const n of list) {
    const tip = houseUsefulTip(n).replace(/"/g, "");
    const kind = flagMarkerKind(n);
    const marker = window.L.marker([n.lat, n.lon], {
      icon: phoneFlagIcon(tip, kind),
      pane: "houseNums",
      interactive: true,
      keyboard: true,
      bubblingMouseEvents: false,
      title: tip || `Flag · #${n.num}`,
    }).addTo(houseLayer);
    bindHousePhoneMarker(marker, n);
  }
  paintFlagDock();
}

function escHousePop(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function housePhonePopupHtml(n) {
  const phone = housePhoneFor(n);
  const pretty = formatPhone(phone) || phone;
  const e164 = phoneDigits(pretty);
  const name = String(n.owner_name || houseUsefulByKey.get(housePhoneKey(n))?.name || "").trim();
  const street = [n.num, n.street].filter(Boolean).join(" ");
  const kindLabel = houseKindLabel(n);
  const biz = housePhoneKind(n) === "business";
  const listUrl = String(n.zillow_url || "").trim();
  const listLink = listUrl
    ? `<a class="hs-list" href="${escHousePop(listUrl)}" target="_blank" rel="noopener">Open listing</a>`
    : "";
  if (!e164) {
    return `<div class="hs-house-pop${biz ? " biz" : ""}">
      <strong class="hs-house-pop-num">${escHousePop(street || n.num || name)}</strong>
      ${kindLabel || name ? `<span class="hs-house-pop-who">${escHousePop([name, kindLabel].filter(Boolean).join(" · "))}</span>` : ""}
      <div class="hs-house-pop-actions">
        ${listLink || `<span class="hs-place-miss">No phone yet</span>`}
        <button type="button" class="hs-flag-hide" data-flag-hide="1">Hide</button>
      </div>
    </div>`;
  }
  return `<div class="hs-house-pop${biz ? " biz" : ""}">
    <strong class="hs-house-pop-num">${escHousePop(street || n.num || name)}</strong>
    ${name || kindLabel ? `<span class="hs-house-pop-who">${escHousePop([name, kindLabel].filter(Boolean).join(" · "))}</span>` : ""}
    <div class="hs-house-pop-actions">
      <a class="hs-tel" href="tel:${escHousePop(e164)}">${escHousePop(pretty)}</a>
      <a class="hs-sms" href="sms:${escHousePop(e164)}">Text</a>
      ${listLink}
      <button type="button" class="hs-flag-hide" data-flag-hide="1">Hide</button>
    </div>
    <span class="hs-house-pop-hint">${useDesktopChrome() ? "Right-click or long-press to copy" : "Hold flag to copy"}</span>
  </div>`;
}

function bindHousePhoneMarker(marker, n) {
  const phone = housePhoneFor(n);
  const pretty = formatPhone(phone) || phone;
  const e164 = phoneDigits(pretty);
  marker.bindPopup(housePhonePopupHtml(n), {
    className: "hs-zone-popup hs-house-popup",
    closeButton: true,
    maxWidth: 240,
    offset: [0, -6],
    autoPan: true,
  });
  marker.on("popupopen", () => {
    const root = marker.getPopup()?.getElement?.();
    const hideBtn = root?.querySelector?.("[data-flag-hide]");
    if (!hideBtn || hideBtn._hsBound) return;
    hideBtn._hsBound = true;
    hideBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideFlag(n);
      try {
        marker.closePopup();
      } catch {
        /* ignore */
      }
    });
  });
  const zoomTo = () => {
    if ((map?.getZoom?.() || 0) < 18) flyToFlag(n);
  };
  if (!e164) {
    marker.on("click", zoomTo);
    return;
  }
  let holdTimer = 0;
  let held = false;
  const clearHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = 0;
    }
  };
  const flashCopied = (ok) => {
    const el = marker.getElement()?.querySelector?.(".has-phone");
    if (!el) return;
    el.classList.toggle("copied", ok);
    el.classList.toggle("copy-fail", !ok);
    clearTimeout(el._copyFlash);
    el._copyFlash = setTimeout(() => el.classList.remove("copied", "copy-fail"), 1400);
  };
  const onHoldCopy = async () => {
    held = true;
    holdTimer = 0;
    const ok = await copyTextToClipboard(pretty);
    flashCopied(ok);
    try {
      marker.closePopup();
    } catch {
      /* ignore */
    }
    try {
      navigator.vibrate?.(12);
    } catch {
      /* ignore */
    }
  };
  const startHold = (ev) => {
    if (ev?.type === "mousedown" && ev.button != null && ev.button !== 0) return;
    held = false;
    clearHold();
    holdTimer = setTimeout(onHoldCopy, 480);
  };
  const endHold = () => clearHold();
  marker.on("mousedown", startHold);
  marker.on("touchstart", startHold, { passive: true });
  marker.on("mouseup", endHold);
  marker.on("mouseleave", endHold);
  marker.on("touchend", endHold);
  marker.on("touchcancel", endHold);
  marker.on("dragstart", endHold);
  marker.on("click", (e) => {
    if (held) {
      held = false;
      if (window.L?.DomEvent) {
        window.L.DomEvent.stop(e);
        if (e.originalEvent) window.L.DomEvent.stop(e.originalEvent);
      }
      try {
        marker.closePopup();
      } catch {
        /* ignore */
      }
      return;
    }
    zoomTo();
  });
}

/** Build a lookup address for an OSM house point (street often missing in OK). */
async function addressForHouseNum(n) {
  if (!n?.num) return "";
  const finish = (addr) => {
    let a = String(addr || "").trim();
    if (!a) return "";
    if (!/,\s*[A-Z]{2}\b|Oklahoma/i.test(a)) a = `${a}, OK`;
    return a;
  };
  if (n.street) {
    const cityBit = n.city ? `, ${n.city}` : "";
    const zipBit = n.zip ? ` ${n.zip}` : "";
    return finish(`${n.num} ${n.street}${cityBit}${zipBit}`);
  }
  try {
    const geo = await reverseGeocode(n.lat, n.lon);
    if (geo?.ok && geo.address && /^\d/.test(geo.address)) {
      const parts = parseStreetAddress(geo.address);
      if (parts.street) n.street = parts.street;
      if (parts.city && !n.city) n.city = parts.city;
      if (parts.zip && !n.zip) n.zip = parts.zip;
      return finish(geo.address);
    }
  } catch {
    /* fall through */
  }
  // Last resort — house # + reverse street from ArcGIS only.
  try {
    const arc = await reverseArcgis(n.lat, n.lon);
    if (arc?.ok && arc.address && /^\d/.test(arc.address)) {
      const parts = parseStreetAddress(arc.address);
      if (parts.street) n.street = parts.street;
      if (parts.city) n.city = parts.city;
      return finish(arc.address);
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** Merge OSM house / POI points into the session pool (keeps phones found off-screen). */
function mergeHouseNums(into, nums) {
  const out = Array.isArray(into) ? [...into] : [];
  const idx = new Map();
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    const k =
      housePhoneKey(n) ||
      (Number.isFinite(n.lat) && Number.isFinite(n.lon) ? `@${n.lat.toFixed(5)},${n.lon.toFixed(5)}` : "");
    if (k) idx.set(k, i);
  }
  for (const n of nums || []) {
    if (!n || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue;
    if (!n.num && !n.owner_name && !n.phone) continue;
    const k =
      housePhoneKey(n) ||
      `@${n.lat.toFixed(5)},${n.lon.toFixed(5)}`;
    const cachedPhone = housePhoneFor(n);
    const u = houseUsefulByKey.get(housePhoneKey(n));
    const next = {
      ...n,
      num: n.num || n.owner_name || "",
      phone: n.phone || cachedPhone || "",
      owner_name: n.owner_name || u?.name || "",
      email: n.email || u?.email || "",
      phone_kind: n.phone_kind || u?.kind || "",
      source: n.source || u?.source || "",
    };
    if (idx.has(k)) {
      const i = idx.get(k);
      out[i] = {
        ...out[i],
        ...next,
        phone: next.phone || out[i].phone || "",
        phone_kind: next.phone_kind || out[i].phone_kind || "",
        source: next.source || out[i].source || "",
      };
    } else {
      idx.set(k, out.length);
      out.push(next);
    }
  }
  // Cap pool so long sessions don't balloon — keep rentals first.
  if (out.length > 1600) {
    const rentals = out.filter((n) => n.phone_kind === "rental" || /rent/i.test(n.source || ""));
    const rest = out.filter((n) => n.phone_kind !== "rental" && !/rent/i.test(n.source || ""));
    return [...rentals.slice(-900), ...rest.slice(-400)];
  }
  return out;
}

function flagStatusLine(extra = "") {
  const list = readyFlagList(houseCache.nums);
  const rent = list.filter((n) => housePhoneKind(n) === "rental").length;
  const rentPhone = list.filter((n) => housePhoneKind(n) === "rental" && houseHasPhone(n)).length;
  const biz = list.filter((n) => housePhoneKind(n) === "business").length;
  const bits = [];
  if (rent) bits.push(rentPhone && rentPhone < rent ? `${rent} for rent (${rentPhone} w/ phone)` : `${rent} for rent`);
  if (biz) bits.push(`${biz} business`);
  const ready = bits.length ? `${bits.join(" · ")} ready` : "";
  if (extra && ready) return `${extra} · ${ready}`;
  return extra || ready || "Loading flags…";
}

/** Rental / business listing scan — idle, one-at-a-time. Network misses can retry. */
async function enrichVisibleHouseInfo(nums, gen) {
  if (!phoneFlagsEnabled() || !map || !nums?.length) return;
  const c = map.getCenter?.();
  if (!c) return;
  const listingQueue = nums
    .filter((n) => {
      if (housePhoneKind(n) !== "rental") return false;
      if (houseHasPhone(n)) return false;
      const url = String(n.zillow_url || "").trim();
      if (!url) return false;
      const k = `list|@${n.lat?.toFixed?.(5)},${n.lon?.toFixed?.(5)}`;
      return !houseEnrichTried.has(k);
    })
    .map((n) => ({ n, d: haversineKm(c.lat, c.lng, n.lat, n.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, HOUSE_ENRICH_MAX)
    .map((x) => x.n);
  const addrQueue = nums
    .filter((n) => {
      if (houseHasFlag(n)) return false;
      if (n.phone_kind === "business" || n.source === "osm-business") return false;
      if (!n?.num) return false;
      const k = housePhoneKey(n) || `@${n.lat?.toFixed?.(5)},${n.lon?.toFixed?.(5)}`;
      return k && !houseEnrichTried.has(k);
    })
    .map((n) => ({ n, d: haversineKm(c.lat, c.lng, n.lat, n.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.max(4, HOUSE_ENRICH_MAX - listingQueue.length))
    .map((x) => x.n);
  const runListing = async (n) => {
    if (!map || !phoneFlagsEnabled()) return;
    if (mapBusy > 0) return "busy";
    const key = `list|@${n.lat?.toFixed?.(5)},${n.lon?.toFixed?.(5)}`;
    if (!key || houseEnrichTried.has(key)) return;
    const url = String(n.zillow_url || "").trim();
    if (!url) {
      houseEnrichTried.add(key);
      return;
    }
    try {
      const phone = await lookupListingRentPhone(url);
      houseEnrichTried.add(key);
      if (!phone) return;
      n.phone = phone;
      n.phone_kind = "rental";
      n.zillow_rent = true;
      if (!n.source) n.source = /zillow/i.test(url) ? "zillow-rent" : "rent-com";
      rememberHouseUseful(n, { phone, kind: "rental", source: n.source });
      housePaintSig = "";
      paintHouseLayer([], houseCache.nums);
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (!/timeout|abort|network|fetch/i.test(msg)) houseEnrichTried.add(key);
    }
  };
  const runOne = async (n) => {
    if (!map || !phoneFlagsEnabled()) return;
    if (mapBusy > 0) return "busy";
    const key = housePhoneKey(n) || `@${n.lat?.toFixed?.(5)},${n.lon?.toFixed?.(5)}`;
    if (!key || houseEnrichTried.has(key)) return;
    const addr = await addressForHouseNum(n);
    if (!addr || !parseStreetAddress(addr).house) {
      houseEnrichTried.add(key);
      return;
    }
    try {
      const contacts = await lookupFlagPhone(n.lat, n.lon, addr);
      houseEnrichTried.add(key);
      const phone = contacts?.owner_phone || "";
      const kind = contacts?.phone_kind || classifyFlagPhone(contacts);
      if (!phone || (kind !== "rental" && kind !== "business")) return;
      n.phone = phone;
      n.owner_name = contacts.owner_name || n.owner_name || "";
      n.email = contacts.owner_email || n.email || "";
      n.phone_kind = kind;
      n.source = contacts.source || n.source || "";
      if (contacts.zillow_url) n.zillow_url = contacts.zillow_url;
      if (contacts.zillow_rent) n.zillow_rent = true;
      rememberHouseUseful(n, {
        phone,
        name: n.owner_name,
        email: n.email,
        kind,
        source: n.source,
      });
      housePaintSig = "";
      paintHouseLayer([], houseCache.nums);
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (!/timeout|abort|network|fetch/i.test(msg)) houseEnrichTried.add(key);
    }
  };
  if (!listingQueue.length && !addrQueue.length) {
    emitPhoneFlagsStatus(flagStatusLine());
    return;
  }
  const total = listingQueue.length + addrQueue.length;
  emitPhoneFlagsStatus(flagStatusLine(`Scanning listings… 0/${total}`));
  let step = 0;
  for (const n of listingQueue) {
    if (!map || !phoneFlagsEnabled()) return;
    if (gen !== houseGen && houseCache.nums !== nums) {
      /* map moved — still finish this house, then stop starting new ones */
    }
    if (mapBusy > 0) {
      emitPhoneFlagsStatus(flagStatusLine("Paused while the map moves"));
      return;
    }
    await runListing(n);
    step += 1;
    emitPhoneFlagsStatus(flagStatusLine(`Scanning listings… ${step}/${total}`));
    await new Promise((r) => setTimeout(r, HOUSE_ENRICH_GAP_MS));
    if (gen !== houseGen) return;
  }
  for (let i = 0; i < addrQueue.length; i++) {
    if (!map || !phoneFlagsEnabled()) return;
    if (gen !== houseGen && houseCache.nums !== nums) {
      /* map moved — still finish this house, then stop starting new ones */
    }
    if (mapBusy > 0) {
      emitPhoneFlagsStatus(flagStatusLine("Paused while the map moves"));
      return;
    }
    await runOne(addrQueue[i]);
    step += 1;
    emitPhoneFlagsStatus(flagStatusLine(`Scanning listings… ${step}/${total}`));
    await new Promise((r) => setTimeout(r, HOUSE_ENRICH_GAP_MS));
    if (gen !== houseGen) return;
  }
  emitPhoneFlagsStatus(flagStatusLine());
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
    const street = String(el.tags?.["addr:street"] || "").trim();
    const phoneRaw = firstTagPhone(el.tags || {});
    const phone = phoneRaw && !isJunkPhone(phoneRaw) ? formatPhone(phoneRaw) || phoneRaw : "";
    const biz = isOsmBusinessTags(el.tags || {});
    if (phone && biz) rememberHouseUseful({ num, street, lat, lon }, { phone, name: el.tags?.name || "", kind: "business", source: "osm-business" });
    nums.push({
      num,
      lat,
      lon,
      street,
      city: String(el.tags?.["addr:city"] || "").trim(),
      zip: String(el.tags?.["addr:postcode"] || "").trim(),
      phone: phone && biz ? phone : "",
      owner_name: String(el.tags?.name || "").trim(),
      phone_kind: phone && biz ? "business" : "",
      source: phone && biz ? "osm-business" : "",
    });
  }
  return { rings, nums };
}

function pushOsmFlagNum(el, nums, seen, { requireBusinessPhone = false } = {}) {
  const tags = el.tags || {};
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const num = escHouseNum(tags["addr:housenumber"]) || "";
  const name = String(tags.name || tags.operator || "").trim();
  const street = String(tags["addr:street"] || "").trim();
  const phoneRaw = firstTagPhone(tags);
  const phone = phoneRaw && !isJunkPhone(phoneRaw) ? formatPhone(phoneRaw) || phoneRaw : "";
  const biz = isOsmBusinessTags(tags);
  if (requireBusinessPhone && !(phone && biz)) return;
  if (!num && !name && !phone) return;
  const key = `${num || name}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
  if (seen.has(key) || nums.length >= HOUSE_NUM_MAX) return;
  seen.add(key);
  if (phone && biz) {
    rememberHouseUseful(
      { num: num || name, street, lat, lon },
      { phone, name, kind: "business", source: "osm-business" },
    );
  }
  nums.push({
    num: num || name,
    lat,
    lon,
    street,
    city: String(tags["addr:city"] || "").trim(),
    zip: String(tags["addr:postcode"] || "").trim(),
    phone: phone && biz ? phone : "",
    owner_name: name,
    phone_kind: phone && biz ? "business" : "",
    source: phone && biz ? "osm-business" : "",
  });
}

function numsFromOsmElements(elements, opts) {
  const nums = [];
  const seen = new Set();
  for (const el of elements || []) {
    pushOsmFlagNum(el, nums, seen, opts);
  }
  return nums;
}

function placeFromOsmElements(elements) {
  const cities = new Map();
  const states = new Map();
  for (const el of elements || []) {
    const c = String(el.tags?.["addr:city"] || "").trim();
    const s = String(el.tags?.["addr:state"] || "").trim();
    if (c) cities.set(c, (cities.get(c) || 0) + 1);
    if (s) states.set(s, (states.get(s) || 0) + 1);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return { city: top(cities), state: top(states) };
}

function numsFromRentFlags(flags) {
  const out = [];
  for (const r of flags || []) {
    if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) continue;
    if (!r.phone && !r.listingUrl) continue;
    const addr = [r.street, r.city, r.state, r.zip].filter(Boolean).join(", ");
    const parts = parseStreetAddress(addr);
    const num = parts.house || r.name || r.street || "For rent";
    rememberHouseUseful(
      { num, street: parts.street || r.street, lat: r.lat, lon: r.lon, zillow_url: r.listingUrl, zillow_rent: true },
      { phone: r.phone || "", name: r.name || "", kind: "rental", source: r.source || "rent-com" },
    );
    out.push({
      num,
      street: parts.street || r.street || "",
      city: r.city || "",
      zip: r.zip || "",
      lat: r.lat,
      lon: r.lon,
      phone: r.phone || "",
      owner_name: r.name || "",
      phone_kind: "rental",
      source: r.source || "rent-com",
      zillow_url: r.listingUrl || "",
      zillow_rent: true,
    });
  }
  return out;
}

function loadPersistedBizFlags() {
  try {
    if (typeof localStorage === "undefined") return [];
    const j = JSON.parse(localStorage.getItem(BIZ_STORE_KEY) || "null");
    if (!j || !Array.isArray(j.flags)) return [];
    return j.flags.filter((n) => n?.phone && Number.isFinite(Number(n.lat)) && Number.isFinite(Number(n.lon)));
  } catch {
    return [];
  }
}

function persistBizFlags(nums) {
  try {
    if (typeof localStorage === "undefined") return;
    const incoming = (nums || [])
      .filter((n) => n?.phone && (n.phone_kind === "business" || n.source === "osm-business"))
      .map((n) => ({
        num: n.num || n.owner_name || "",
        street: n.street || "",
        city: n.city || "",
        zip: n.zip || "",
        lat: n.lat,
        lon: n.lon,
        phone: n.phone,
        owner_name: n.owner_name || "",
        phone_kind: "business",
        source: n.source || "osm-business",
      }));
    if (!incoming.length) return;
    const prev = loadPersistedBizFlags();
    const merged = [];
    const seen = new Set();
    const push = (n) => {
      if (!n?.phone || !Number.isFinite(Number(n.lat)) || !Number.isFinite(Number(n.lon))) return;
      const key = `${phoneDigits(n.phone)}|${Number(n.lat).toFixed(4)}|${Number(n.lon).toFixed(4)}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(n);
    };
    // Prefer freshly scanned biz near the current view, then keep older statewide pins.
    for (const n of incoming) push(n);
    for (const n of prev) push(n);
    localStorage.setItem(
      BIZ_STORE_KEY,
      JSON.stringify({ at: Date.now(), flags: merged.slice(0, BIZ_STORE_MAX) }),
    );
  } catch {
    /* quota / private mode */
  }
}

function hydratePersistedFlags() {
  if (persistHydrated) return;
  persistHydrated = true;
  const rent = loadPersistedRentFlags();
  const biz = loadPersistedBizFlags();
  if (rent.length) {
    houseCache.nums = mergeHouseNums(houseCache.nums, numsFromRentFlags(rent));
  }
  if (biz.length) {
    for (const n of biz) {
      rememberHouseUseful(n, { phone: n.phone, name: n.owner_name, kind: "business", source: n.source });
    }
    houseCache.nums = mergeHouseNums(houseCache.nums, biz);
  }
  if (!houseCache.nums.some((n) => houseHasFlag(n))) return;
  scheduleFlagLayerPaint(true);
}

function scheduleFlagLayerPaint(immediate = false) {
  const paint = () => {
    flagPaintTimer = 0;
    flagPaintQueued = false;
    if (!phoneFlagsEnabled() || !map) return;
    housePaintSig = "";
    paintHouseLayer([], houseCache.nums);
    emitPhoneFlagsStatus(flagStatusLine());
  };
  if (immediate || !flagPaintImmediateDone) {
    flagPaintImmediateDone = true;
    if (flagPaintTimer) {
      clearTimeout(flagPaintTimer);
      flagPaintTimer = 0;
    }
    paint();
    return;
  }
  if (flagPaintQueued) return;
  flagPaintQueued = true;
  const delay = isAndroid() ? 180 : 120;
  flagPaintTimer = setTimeout(paint, delay);
}

function applyRentFlagBatch(flags, gen) {
  if (gen != null && gen !== houseGen) return;
  if (!phoneFlagsEnabled() || !map || !flags?.length) return;
  const before = houseCache.nums.length;
  houseCache.nums = mergeHouseNums(houseCache.nums, numsFromRentFlags(flags));
  if (houseCache.nums.length === before) {
    scheduleFlagLayerPaint();
    return;
  }
  persistRentFlags(flags);
  scheduleFlagLayerPaint();
}

function kickRentFlags(lat, lon, place, gen, { force = false } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Promise.resolve([]);
  const now = Date.now();
  const nextCity = String(place?.city || "").trim();
  const cityKey = (c) =>
    String(c || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const cityUpgrade = Boolean(nextCity) && cityKey(nextCity) !== cityKey(lastRentSweepCity);
  const geoMoved =
    !Number.isFinite(lastRentSweepLat) ||
    !Number.isFinite(lastRentSweepLon) ||
    haversineKm(lastRentSweepLat, lastRentSweepLon, lat, lon) >= RENT_SWEEP_MOVE_KM;
  const hardForce = force || geoMoved;
  const shouldRun = hardForce || cityUpgrade || !lastRentSweepAt || now - lastRentSweepAt >= RENT_SWEEP_COOL_MS;
  if (!shouldRun) return Promise.resolve([]);
  lastRentSweepAt = now;
  lastRentSweepLat = lat;
  lastRentSweepLon = lon;
  lastRentSweepCity = nextCity || inferOkCity(lat, lon) || lastRentSweepCity || "";
  const bounds = flagViewBoundsPayload();
  if (hardForce || cityUpgrade) {
    emitPhoneFlagsStatus(
      lastRentSweepCity ? `Loading flags · map view · ${lastRentSweepCity}…` : "Loading flags · map view…",
    );
  }
  return lookupViewportRentFlags(lat, lon, {
    city: nextCity || lastRentSweepCity || "",
    state: place?.state || (isOklahomaLatLon(lat, lon) ? "OK" : ""),
    bounds,
    viewportOnly: true,
    force: hardForce,
    retarget: cityUpgrade && !hardForce,
    onBatch: (flags) => applyRentFlagBatch(flags, gen),
  })
    .then((flags) => {
      applyRentFlagBatch(flags, gen);
      return flags;
    })
    .catch(() => []);
}

function osmPoiQuery(south, west, north, east) {
  return `[out:json][timeout:10][bbox:${south},${west},${north},${east}];(
    node["phone"]["amenity"];
    node["phone"]["shop"];
    node["phone"]["office"];
    node["phone"]["craft"];
    node["phone"]["healthcare"];
    node["phone"]["tourism"];
    node["phone"]["leisure"];
    node["phone"]["company"];
    node["contact:phone"]["amenity"];
    node["contact:phone"]["shop"];
    node["contact:phone"]["office"];
    node["contact:phone"]["craft"];
    node["contact:phone"]["healthcare"];
    node["contact:phone"]["tourism"];
    way["phone"]["amenity"];
    way["phone"]["shop"];
    way["phone"]["office"];
    way["phone"]["craft"];
    way["phone"]["healthcare"];
    way["contact:phone"]["amenity"];
    way["contact:phone"]["shop"];
    way["contact:phone"]["office"];
  );out tags center;`;
}

function osmHouseQuery(south, west, north, east) {
  return `[out:json][timeout:8][bbox:${south},${west},${north},${east}];(node["addr:housenumber"];way["addr:housenumber"];);out tags center;`;
}

/** Business POIs with a public OSM phone — paint blue flags immediately. */
async function fetchOsmFlagPois(south, west, north, east) {
  const over = await overpassJson(osmPoiQuery(south, west, north, east), 9000).catch(() => null);
  if (over?.elements?.length) return numsFromOsmElements(over.elements, { requireBusinessPhone: true });
  const mapDump = await osmMapJson(south, west, north, east, 16000).catch(() => null);
  return numsFromOsmElements(mapDump?.elements, { requireBusinessPhone: true });
}

/** Address points only — skip building footprints so Overpass returns fast for Flags. */
async function fetchOsmHouseNums(south, west, north, east) {
  const over = await overpassJson(osmHouseQuery(south, west, north, east), 9000).catch(() => null);
  if (over?.elements?.length) return numsFromOsmElements(over.elements);
  const mapDump = await osmMapJson(south, west, north, east, 16000).catch(() => null);
  return numsFromOsmElements(mapDump?.elements);
}

function trimHouseCacheOutsideView() {
  if (!map) return;
  const b = map.getBounds?.();
  if (!b?.isValid?.()) return;
  const c = map.getCenter?.();
  const s = b.getSouth();
  const n = b.getNorth();
  const w = b.getWest();
  const e = b.getEast();
  const dLat = Math.max(0.08, (n - s) * 1.5);
  const dLon = Math.max(0.08, (e - w) * 1.5);
  const maxKm = Math.max(flagSearchKm() * 4.5, 32);
  houseCache.nums = (houseCache.nums || []).filter((pin) => {
    if (!Number.isFinite(pin?.lat) || !Number.isFinite(pin?.lon)) return false;
    if (
      pin.lat >= s - dLat &&
      pin.lat <= n + dLat &&
      pin.lon >= w - dLon &&
      pin.lon <= e + dLon
    ) {
      return true;
    }
    if (c && haversineKm(c.lat, c.lng, pin.lat, pin.lon) <= maxKm) return true;
    return false;
  });
}

function mergeViewportRentFlagsIntoCache() {
  if (!phoneFlagsEnabled() || !map) return;
  const bounds = flagViewBoundsPayload();
  const c = map.getCenter?.();
  if (!bounds && !c) return;
  const rows = rentFlagsForViewport(bounds, c?.lat, c?.lng, 72);
  if (!rows.length) return;
  const before = houseCache.nums.length;
  houseCache.nums = mergeHouseNums(houseCache.nums, numsFromRentFlags(rows));
  if (houseCache.nums.length !== before) scheduleFlagLayerPaint(true);
}

async function refreshHouseNumbers({ forceRent = false } = {}) {
  if (!map || !window.L) return;
  ensureHousePane();
  if (!phoneFlagsEnabled()) {
    houseLayer?.clearLayers?.();
    housePaintSig = "off";
    paintFlagDock();
    return;
  }
  // Toggle / re-tap refresh: wipe pins so the map visibly retargets this frame.
  if (forceRent) {
    houseCache = { key: "", rings: [], nums: [] };
    housePaintSig = "";
    try {
      houseLayer?.clearLayers?.();
    } catch {
      /* ignore */
    }
  } else {
    hydratePersistedFlags();
  }
  const searchB = flagSearchBounds();
  if (!searchB) {
    houseLayer.clearLayers();
    housePaintSig = "";
    return;
  }
  const z = map.getZoom?.() ?? 14;
  const key = `flag|${houseBoundsKey(searchB, z)}`;
  const center = map.getCenter?.();
  const bounds = flagViewBoundsPayload();
  const viewCity =
    (center && citiesInMapBounds(bounds, { lat: center.lat, lon: center.lng, limit: 1 })[0]) ||
    (center && isOklahomaLatLon(center.lat, center.lng) ? inferOkCity(center.lat, center.lng) : "") ||
    "";

  trimHouseCacheOutsideView();
  mergeViewportRentFlagsIntoCache();

  const frameChanged = houseCache.key !== key;
  if (!forceRent && !frameChanged && houseCache.nums.length) {
    mergeViewportRentFlagsIntoCache();
    scheduleFlagLayerPaint();
    if (center) {
      void kickRentFlags(
        center.lat,
        center.lng,
        {
          city: viewCity,
          state: isOklahomaLatLon(center.lat, center.lng) ? "OK" : "",
        },
        houseGen,
      );
    }
    if (houseEnrichTimer) clearTimeout(houseEnrichTimer);
    houseEnrichTimer = setTimeout(() => {
      houseEnrichTimer = 0;
      void enrichVisibleHouseInfo(houseCache.nums, houseGen);
    }, 60);
    return;
  }

  emitPhoneFlagsStatus(viewCity ? `Loading flags · map view · ${viewCity}…` : "Loading flags · map view…");
  const padB = searchB.pad(HOUSE_FETCH_PAD);
  const south = padB.getSouth();
  const west = padB.getWest();
  const north = padB.getNorth();
  const east = padB.getEast();
  const gen = ++houseGen;
  houseCache = { key, rings: [], nums: forceRent ? [] : houseCache.nums || [] };
  mergeViewportRentFlagsIntoCache();

  let rentWork = Promise.resolve([]);
  if (center) {
    rentWork = kickRentFlags(
      center.lat,
      center.lng,
      {
        city: viewCity,
        state: isOklahomaLatLon(center.lat, center.lng) ? "OK" : "",
      },
      gen,
      { force: true },
    );
  }

  // Business flags: Overpass first (fast), do not wait on a full OSM map dump.
  void overpassJson(osmPoiQuery(south, west, north, east), 10000)
    .then((overPois) => {
      if (gen !== houseGen || !phoneFlagsEnabled()) return;
      const pois = numsFromOsmElements(overPois?.elements, { requireBusinessPhone: true });
      if (!pois.length) return;
      houseCache.nums = mergeHouseNums(houseCache.nums, pois);
      persistBizFlags(houseCache.nums);
      scheduleFlagLayerPaint(true);
      emitPhoneFlagsStatus(flagStatusLine());
    })
    .catch(() => {});

  // Secondary OSM dump for any extra tagged phones — background only.
  void osmMapJson(south, west, north, east, 14000)
    .then((mapDump) => {
      if (gen !== houseGen || !phoneFlagsEnabled() || !mapDump?.elements?.length) return;
      const pois = numsFromOsmElements(mapDump.elements, { requireBusinessPhone: true });
      houseCache.nums = mergeHouseNums(houseCache.nums, pois);
      persistBizFlags(houseCache.nums);
      scheduleFlagLayerPaint();
      const place = placeFromOsmElements(mapDump.elements);
      const osmCity = String(place.city || "").trim();
      if (center && osmCity) {
        const slug = (n) =>
          String(n || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "");
        if (slug(osmCity) !== slug(viewCity)) {
          const inFrame = citiesInMapBounds(bounds, { lat: center.lat, lon: center.lng, limit: 8 }).some(
            (c) => slug(c) === slug(osmCity),
          );
          if (inFrame || !viewCity) {
            void kickRentFlags(
              center.lat,
              center.lng,
              {
                city: osmCity,
                state: place.state || (isOklahomaLatLon(center.lat, center.lng) ? "OK" : ""),
              },
              gen,
              { force: false },
            );
          }
        }
      }
      emitPhoneFlagsStatus(flagStatusLine());
    })
    .catch(() => {});

  scheduleFlagLayerPaint(true);
  if (houseEnrichTimer) clearTimeout(houseEnrichTimer);
  houseEnrichTimer = setTimeout(() => {
    houseEnrichTimer = 0;
    void enrichVisibleHouseInfo(houseCache.nums, gen);
  }, 80);
  return rentWork;
}

function emitPhoneFlagsStatus(msg) {
  const text = String(msg || "");
  try {
    window.dispatchEvent(new CustomEvent("hs-phone-flags", { detail: { msg: text } }));
  } catch {
    /* ignore */
  }
  emitMapStatus(text);
}

function emitMapStatus(msg) {
  try {
    window.dispatchEvent(new CustomEvent("hs-map-status", { detail: { msg: String(msg || "") } }));
  } catch {
    /* ignore */
  }
}

/** Kick off Flags scan immediately (toggle on / re-tap refresh). Hard-wipes then map-view reload. */
export function startPhoneFlagScan() {
  if (!phoneFlagsEnabled()) return;
  if (!map || !window.L) {
    emitPhoneFlagsStatus("Loading flags… open the map first");
    return;
  }
  houseHoldUntil = 0;
  housePaintSig = "";
  cancelRentFlagSweep();
  // Bypass rent cool-down and cancel any stale crawl.
  lastRentSweepAt = 0;
  lastRentSweepLat = NaN;
  lastRentSweepLon = NaN;
  lastRentSweepCity = "";
  if (houseTimer) {
    clearTimeout(houseTimer);
    houseTimer = 0;
  }
  if (houseEnrichTimer) {
    clearTimeout(houseEnrichTimer);
    houseEnrichTimer = 0;
  }

  // Blank the layer + wipe stale localStorage so toggle-on is a real re-search.
  houseCache = { key: "", rings: [], nums: [] };
  clearPersistedRentFlags();
  persistHydrated = true;
  try {
    houseLayer?.clearLayers?.();
  } catch {
    /* ignore */
  }
  paintFlagDock();

  const center = map.getCenter?.();
  const bounds = flagViewBoundsPayload();
  const viewCity =
    (center &&
      citiesInMapBounds(bounds, { lat: center.lat, lon: center.lng, limit: 1 })[0]) ||
    (center && isOklahomaLatLon(center.lat, center.lng) ? inferOkCity(center.lat, center.lng) : "") ||
    "";
  emitPhoneFlagsStatus(viewCity ? `Loading flags · map view · ${viewCity}…` : "Loading flags · map view…");
  setFlagsToggleBusy(true);
  void refreshHouseNumbers({ forceRent: true }).finally(() => {
    setFlagsToggleBusy(false);
    if (phoneFlagsEnabled()) emitPhoneFlagsStatus(flagStatusLine() || "Flags ready");
  });
}

function setFlagsToggleBusy(on) {
  try {
    const btn = document.querySelector('#hs-layers [data-ov="flags"]');
    if (!btn) return;
    btn.classList.toggle("busy", on === true);
    btn.setAttribute("aria-busy", on ? "true" : "false");
  } catch {
    /* ignore */
  }
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
  showPhoneFlags = false,
  onMark,
  onDone,
  onMarkScale,
} = {}) {
  const prevDots = fieldOverlay.showHailDots !== false;
  const prevFlags = fieldOverlay.showPhoneFlags === true;
  const nextFlags = showPhoneFlags === true;
  fieldOverlay = {
    marks,
    done,
    donePinScale,
    showMarks,
    showDone,
    showHailDots,
    showPhoneFlags: nextFlags,
    onMark,
    onMarkScale,
    onDone,
  };
  if (prevDots !== (showHailDots !== false) && (lastHailRows.length || lastWindRows.length)) {
    lastHailDrawSig = "";
    drawHailMarkers(lastHailRows, lastWindRows);
  }
  if (prevFlags !== nextFlags) {
    housePaintSig = "";
    if (nextFlags) startPhoneFlagScan();
    else {
      setFlagsToggleBusy(false);
      houseLayer?.clearLayers?.();
      emitPhoneFlagsStatus("Flags cleared");
      paintFlagDock();
    }
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
    // Dot visibility flips with zoom; geometry itself is zoom-invariant.
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
const MAP_SHELL_MS = 420;

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
 * Swipe down on the address/search strip: interactive pull → fullscreen map.
 */
function bindAddressSwipeToStormSheet(el) {
  if (!el || el.dataset.addrSwipeBound) return;
  // Desktop: mouse + page scroll — no Instagram-style swipe chrome.
  if (useDesktopChrome()) {
    el.dataset.addrSwipeBound = "desktop";
    return;
  }
  el.dataset.addrSwipeBound = "1";
  let active = false;
  let dragging = false; // upward feed
  let pulling = false; // downward fullscreen
  let startX = 0;
  let startY = 0;
  let startScroll = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0; // scroll px/ms (finger up → positive)
  let pullDy = 0;
  let coastId = 0;
  let baseShellH = 0;

  const viewEl = () => document.getElementById("view");
  const shellEl = () => document.getElementById("hs-map-shell") || document.getElementById("wx-map-shell");
  const pt = (e) => (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
  const isExpanded = () => shellEl()?.classList.contains("expanded");
  const onChrome = (t) =>
    Boolean(
      t?.closest?.(
        "#hs-search, #hs-goto, .hs-goto, .hs-pin, .hs-place, .hs-pin-ready, #hs-addr-q, #hs-bottom-panel > form",
      ),
    ) && !t?.closest?.(".hs-dates, .hs-filters, .hs-date, button, a, select, textarea");

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

  const clearPullVisual = ({ animate = true } = {}) => {
    const panel = el;
    const shell = shellEl();
    if (animate) {
      panel.style.transition = "";
      if (shell) shell.style.transition = "";
    } else {
      panel.style.transition = "none";
      if (shell) shell.style.transition = "none";
    }
    panel.classList.remove("hs-pull-expand");
    shell?.classList.remove("hs-pull-expand");
    panel.style.transform = "";
    panel.style.opacity = "";
    if (shell) {
      shell.style.height = "";
      shell.style.minHeight = "";
    }
  };

  const applyPullVisual = (dy) => {
    const shell = shellEl();
    const p = Math.min(1, dy / 110);
    el.classList.add("hs-pull-expand");
    shell?.classList.add("hs-pull-expand");
    el.style.transition = "none";
    if (shell) shell.style.transition = "none";
    el.style.transform = `translate3d(0, ${Math.round(dy * 0.62)}px, 0)`;
    el.style.opacity = String(Math.max(0.2, 1 - p * 0.75));
    if (shell && baseShellH > 0) {
      shell.style.height = `${Math.round(baseShellH + dy * 0.92)}px`;
      shell.style.minHeight = `${Math.round(baseShellH + dy * 0.92)}px`;
    }
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
    if (isExpanded()) return;
    if (hailBottomTier !== "address" && hailBottomTier !== "sheet") return;
    if (e.touches && e.touches.length !== 1) return;
    // Allow search field — vertical pull still enters fullscreen; taps keep typing.
    if (e.target.closest("button, a, select, textarea, .hs-date, .hs-dates, .hs-filters")) return;
    if (!onChrome(e.target) && !e.target.closest?.("#hs-bottom-panel")) return;
    // Feed-scroll only from address chrome when peeking; pull-down from chrome always.
    if (!onChrome(e.target) && hailBottomTier === "sheet") {
      // Still allow pull from pin/search when sheet is open
      if (!e.target.closest?.("#hs-search, .hs-pin, .hs-goto, #hs-addr-q")) return;
    }
    stopCoast();
    unlockHailTierGesture();
    const p = pt(e);
    const view = viewEl();
    const shell = shellEl();
    active = true;
    dragging = false;
    pulling = false;
    pullDy = 0;
    startX = p.clientX;
    startY = p.clientY;
    startScroll = view?.scrollTop || 0;
    lastY = startY;
    lastT = performance.now();
    vel = 0;
    baseShellH = shell?.getBoundingClientRect?.().height || 0;
  };

  const onMove = (e) => {
    if (!active) return;
    if (isExpanded()) return;
    if (hailBottomTier !== "address" && hailBottomTier !== "sheet") return;
    const p = pt(e);
    const dx = p.clientX - startX;
    const down = p.clientY - startY;
    const up = startY - p.clientY;

    if (!dragging && !pulling) {
      if (Math.abs(dx) < 6 && Math.abs(down) < 6) return;
      if (Math.abs(dx) > Math.abs(down) && Math.abs(dx) > Math.abs(up)) {
        active = false;
        return;
      }
      if (down > 10 && down > up) {
        pulling = true;
        try {
          document.activeElement?.blur?.();
        } catch {
          /* ignore */
        }
      } else if (up > 8 && hailBottomTier === "address") {
        dragging = true;
        openFeed();
      } else if (up > 8 && hailBottomTier === "sheet") {
        // Already open — just feed-scroll
        dragging = true;
      } else {
        return;
      }
    }

    if (pulling) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      pullDy = Math.max(0, p.clientY - startY);
      applyPullVisual(pullDy);
      return;
    }

    if (dragging) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      vel = (lastY - p.clientY) / dt;
      lastY = p.clientY;
      lastT = now;
      syncScroll(p.clientY);
    }
  };

  const endGesture = () => {
    if (!active) return;
    active = false;
    addressSwipeOpeningSheet = false;
    unlockHailTierGesture();
    if (pulling) {
      pulling = false;
      const commit = pullDy > 48;
      if (commit) {
        clearPullVisual({ animate: false });
        if (hailBottomTier === "hidden") {
          hailBottomTier = "address";
          syncHailBottomChrome();
        }
        setWxMapExpanded(true);
      } else {
        clearPullVisual({ animate: true });
      }
      pullDy = 0;
      dragging = false;
      return;
    }
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
  // Desktop web: always show the storm list under the map (no swipe tiers).
  if (useDesktopChrome() && hailBottomTier !== "hidden") {
    hailBottomTier = "sheet";
  }
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
  // No house yet: idle peek — storms stay off until Search storms
  if (!Number.isFinite(pinLat) && !Number.isFinite(pinLon)) {
    const sheet = document.getElementById("hs-sheet");
    if (sheet && !sheet.querySelector(".hs-pin") && !sheet.querySelector(".hs-date") && !sheet.querySelector("#hs-hail-search")) {
      const esc = window.__pipWxEsc || ((s) => String(s ?? ""));
      paintHailSearchIdle(sheet, esc);
    }
  }
  if (wasExpanded) {
    setWxMapExpanded(false, { scrollToSheet: false });
  }
  if (fromHidden) pulseBottomPanel();
  scheduleSheetScroll(scrollViewToAddressPeek, { waitForMap: wasExpanded });
}

/** Optional hook when storm sheet opens with no house pin (e.g. show idle Search storms UI). */
let stormSheetOpenHook = null;
export function bindStormSheetOpen(fn) {
  stormSheetOpenHook = typeof fn === "function" ? fn : null;
}

/** Explicit Search storms button — never auto-fires hail fetch. */
let hailSearchClickHook = null;
export function bindHailSearchClick(fn) {
  hailSearchClickHook = typeof fn === "function" ? fn : null;
}

/**
 * Map-view hail fetch is opt-in. Boot / pan / sheet open do not pull storm dates
 * until the user taps Search storms (or drops a house pin).
 */
let mapViewHailArmed = false;
export function isMapViewHailArmed() {
  return mapViewHailArmed === true;
}
export function setMapViewHailArmed(on) {
  mapViewHailArmed = on === true;
}

/** Optional hook when the map view moves and no house pin is set (refresh statewide dates). */
let mapViewStormMoveHook = null;
let mapViewStormMoveTimer = 0;
/** Last successful viewport storm search — used to decide when to re-fetch. */
let lastMapViewStormFetch = null;
/** After clearing all selected storm dates, force a fresh map-view search. */
let mapViewStormForceNext = false;

export function bindMapViewStormMove(fn) {
  mapViewStormMoveHook = typeof fn === "function" ? fn : null;
}

/** True when the visible map no longer matches the last storm-date search. */
export function mapViewStormsNeedRefresh(force = false) {
  if (force || mapViewStormForceNext) return true;
  if (wxPinSelected() || hasSelectedStormDates()) return false;
  const q = mapViewHailQuery();
  if (!q) return false;
  const needKm = mapViewFetchKm();
  if (!lastMapViewStormFetch) return true;
  if ((Number(lastMapViewStormFetch.km) || 0) < needKm * 0.88) return true;
  const moved = haversineKm(lastMapViewStormFetch.lat, lastMapViewStormFetch.lon, q.lat, q.lon);
  return moved > Math.max(6, (Number(lastMapViewStormFetch.km) || 0) * 0.32);
}

function scheduleMapViewStormMove(ms = 700) {
  // Careful loading: never auto-refresh storms on pan unless user armed Search storms.
  if (!mapViewHailArmed || wxPinSelected() || !hailScopeMode || hasSelectedStormDates()) return;
  if (mapViewStormMoveTimer) clearTimeout(mapViewStormMoveTimer);
  mapViewStormMoveTimer = setTimeout(() => {
    mapViewStormMoveTimer = 0;
    if (!mapViewHailArmed || wxPinSelected() || !hailScopeMode || hasSelectedStormDates()) return;
    const force = mapViewStormForceNext;
    mapViewStormForceNext = false;
    try {
      mapViewStormMoveHook?.(force);
    } catch {
      /* ignore */
    }
  }, ms);
}

/** Idle filters + Search storms CTA — no network until the button (or a house pin). */
export function paintHailSearchIdle(root, esc) {
  if (!root) return;
  const data = {
    hail: [],
    address: "",
    viewport: true,
    _meta: { viewport: true, idle: true },
  };
  renderHailScopeSheet(root, data, esc, { drawMap: false });
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
  const panel = document.getElementById("hs-bottom-panel");
  if (!shell) return;
  if (on === shell.classList.contains("expanded")) return;
  // Drop any in-progress pull-to-expand visuals before the real transition.
  shell.classList.remove("hs-pull-expand");
  panel?.classList.remove("hs-pull-expand");
  shell.style.height = "";
  shell.style.minHeight = "";
  shell.style.transition = "";
  if (panel) {
    panel.style.transform = "";
    panel.style.opacity = "";
    panel.style.transition = "";
  }
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
  if (useDesktopChrome()) {
    // Desktop: fixed map + scrollable sheet — no pull-to-fullscreen / tab swipes.
    hailBottomTier = "sheet";
    syncHailBottomChrome();
    setWxMapExpanded(false, { scrollToSheet: false });
    return;
  }
  // Address peek → storm sheet is feed-scroll (bindAddressSwipeToStormSheet)
  bindAddressSwipeToStormSheet(document.getElementById("hs-bottom-panel"));
  const mapBar = shell.querySelector(".hs-map-bar");
  const tabNav = tabs || document.getElementById("tabs");
  const isExpanded = () => shell.classList.contains("expanded");
  const onAddressBar = (t) =>
    Boolean(
      t?.closest?.(
        "#hs-search, #hs-goto, .hs-goto, .hs-pin, .hs-place, .hs-pin-ready, #hs-addr-q, #hs-bottom-panel > form",
      ),
    );
  const blockMapChrome = (e) =>
    e.target.closest(".leaflet-control, .hs-composer, .hs-pin-scale-pop, .hs-layers, select, textarea");
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
  let touchStartY = 0;
  let touchInBar = false;
  let touchPulling = false;
  let touchPullDy = 0;
  let touchGestureDone = false;
  let barBaseH = 0;
  const clearBarPull = ({ animate = true } = {}) => {
    const panel = document.getElementById("hs-bottom-panel");
    if (animate) {
      shell.style.transition = "";
      if (panel) panel.style.transition = "";
    } else {
      shell.style.transition = "none";
      if (panel) panel.style.transition = "none";
    }
    shell.classList.remove("hs-pull-expand");
    panel?.classList.remove("hs-pull-expand");
    shell.style.height = "";
    shell.style.minHeight = "";
    if (panel) {
      panel.style.transform = "";
      panel.style.opacity = "";
    }
  };
  const applyBarPull = (dy) => {
    const panel = document.getElementById("hs-bottom-panel");
    const p = Math.min(1, dy / 110);
    shell.classList.add("hs-pull-expand");
    panel?.classList.add("hs-pull-expand");
    shell.style.transition = "none";
    if (panel) panel.style.transition = "none";
    if (barBaseH > 0) {
      shell.style.height = `${Math.round(barBaseH + dy * 0.92)}px`;
      shell.style.minHeight = `${Math.round(barBaseH + dy * 0.92)}px`;
    }
    if (panel && !isExpanded()) {
      panel.style.transform = `translate3d(0, ${Math.round(dy * 0.55)}px, 0)`;
      panel.style.opacity = String(Math.max(0.2, 1 - p * 0.7));
    }
  };
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    unlockHailTierGesture();
    touchY = e.touches[0].clientY;
    touchStartY = touchY;
    touchInBar = Boolean(mapBar?.contains(e.target) && !e.target.closest('input[type="range"]'));
    touchPulling = false;
    touchPullDy = 0;
    touchGestureDone = false;
    barBaseH = shell.getBoundingClientRect?.().height || 0;
  };
  const onTouchMove = (e) => {
    if (touchGestureDone || e.touches.length !== 1) return;
    if (!touchInBar) return;
    if (e.target.closest?.(".leaflet-control, .hs-layers, input[type=range]")) return;
    const y = e.touches[0].clientY;
    const down = y - touchStartY;
    if (!touchPulling) {
      if (down < 12) return;
      touchPulling = true;
    }
    e.preventDefault();
    touchPullDy = Math.max(0, down);
    touchY = y;
    if (isExpanded()) {
      // Collapse: follow finger down a bit then commit on release
      applyBarPull(Math.min(touchPullDy, 90));
      return;
    }
    applyBarPull(touchPullDy);
  };
  const onTouchEnd = () => {
    if (!touchInBar || touchGestureDone) {
      touchInBar = false;
      touchPulling = false;
      return;
    }
    if (touchPulling) {
      touchGestureDone = true;
      if (isExpanded()) {
        if (touchPullDy > 40) {
          clearBarPull({ animate: false });
          tryCollapse();
        } else {
          clearBarPull({ animate: true });
        }
      } else if (touchPullDy > 48) {
        clearBarPull({ animate: false });
        tryExpandFromAddressBar();
      } else {
        clearBarPull({ animate: true });
      }
    }
    touchInBar = false;
    touchPulling = false;
    touchPullDy = 0;
  };
  view.addEventListener("touchstart", onTouchStart, { passive: true });
  view.addEventListener("touchmove", onTouchMove, { passive: false });
  view.addEventListener("touchend", onTouchEnd, { passive: true });
  view.addEventListener("touchcancel", onTouchEnd, { passive: true });
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
export async function geocodeAddress(query, opts = {}) {
  const c = map?.getCenter?.();
  const ranked = await geocodeCandidates(query, {
    city: opts.city || "",
    lat: opts.lat ?? c?.lat,
    lon: opts.lon ?? c?.lng,
  });
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

function syncHailStormDateSelection(_data) {
  // Never auto-check a storm date — pin mode only switches the filter (newest ≥1″).
  // Map view keeps biggest-storm sort. User taps dates to overlay zones.
  void _data;
}

export function clearSelectedStormDate() {
  const hadSelection = hasSelectedStormDates();
  clearStormDateSelection();
  lastHailDrawSig = "";
  if (selectedStormRedrawTimer) {
    clearTimeout(selectedStormRedrawTimer);
    selectedStormRedrawTimer = 0;
  }
  pendingSelectedStormRows = null;
  if (hadSelection) emitMapStatus("Hail zones cleared");
  // Do not auto-refetch map-view storms — user taps Search storms when they want a new pass.
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
  const filterSig = `${wxFilters.hailIn}|${wxFilters.sort}|${wxFilters.km}|${wxFilters.days}|${wxFilters.year}`;

  if (locked) {
    // Keep selection; debounce zone rebuilds so SWDI batches don't thrash the map.
    if (hailGrew || fit) scheduleSelectedStormZoneRedraw(hailRows, []);
    if (root.dataset.hsFilterSig !== filterSig || !root.querySelector(".hs-dates")) {
      root.dataset.hsFilterSig = filterSig;
      renderHailScopeSheet(root, data, esc, { onRefetch, drawMap: false });
    } else {
      softUpdateHailScopeSheet(root, data, esc, { onRefetch });
    }
  } else if (data._meta?.loading && root.querySelector(".hs-dates")) {
    // Progressive map-view / pin loads — append dates without rebuilding chrome.
    softUpdateHailScopeSheet(root, data, esc, { onRefetch });
  } else {
    if (hailGrew) lastHailDrawSig = "";
    drawHailMarkers(hailRows, [], { fit, requireDate: true, hailRows });
    root.dataset.hsFilterSig = filterSig;
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
  const idle = Boolean(data._meta?.idle);
  const pinLine = selectedStormsPinText(esc);
  if (viewport) {
    if (idle) {
      return `<p class="hs-pin hs-pin-ready">Set filters, then Search storms for this map view</p>`;
    }
    const loading = data._meta?.loading ? " · loading more…" : "";
    const line =
      pinLine ||
      `Storms in the visible map area — biggest first${loading}`;
    return `<p class="hs-pin hs-pin-ready">${line}</p>`;
  }
  const addr = data.address || "Dropped pin";
  const loading = data._meta?.loading ? " · loading radar…" : "";
  const hint = pinLine || `Filter: newest ≥1″ · tap a date to overlay${loading}`;
  return `<p class="hs-pin hs-pin-ready"><strong class="hs-addr-copy" role="button" tabindex="0" title="Tap to copy address" data-copy="${esc(addr)}">${esc(addr)}</strong>${hint}</p>`;
}

function hailScopeHtml(data, days, esc) {
  const viewport = Boolean(data.viewport || data._meta?.viewport);
  const idle = Boolean(data._meta?.idle);
  const years = [
    ...new Set((data.hail || []).map((h) => String(h.date || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y))),
  ].sort((a, b) => b.localeCompare(a));
  const q = hailSearchQ;
  const searchLab = idle || !days.length ? "Search storms" : "Search this view";
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
      ${
        viewport
          ? `<button type="button" id="hs-hail-search" class="hs-hail-search">${esc(searchLab)}</button>`
          : ""
      }
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
    const pageBtn = e.target?.closest?.("[data-hs-page]");
    if (pageBtn && box.contains(pageBtn) && !pageBtn.disabled) {
      e.preventDefault?.();
      e.stopPropagation?.();
      const live = box._hsData || data;
      const liveEsc = box._hsEsc || esc;
      const dir = pageBtn.getAttribute("data-hs-page");
      hailStormPage += dir === "next" ? 1 : -1;
      box.innerHTML = hailScopeDateRows(hailScopeDays(live), liveEsc, {
        viewport: Boolean(live.viewport || live._meta?.viewport),
        data: live,
      });
      return;
    }
    const row = e.target?.closest?.(".hs-date[data-storm-date]");
    if (!row || !box.contains(row)) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    const live = box._hsData || data;
    const liveEsc = box._hsEsc || esc;
    const date = row.getAttribute("data-storm-date");
    const hailRows = mapHailRows(live, wxFilters);
    // State overview: center the map on the storm being turned on. Zoomed in
    // (or deselecting) keep the current view.
    const turningOn = !isStormDateSelected(date);
    const zNow = map?.getZoom?.() ?? 14;
    try {
      selectStormDate(date, { fit: turningOn && zNow < 11, requireDate: true, hailRows, toggle: true });
    } catch (err) {
      console.warn("selectStormDate failed", err);
    }
    // Toggle classes in place — full list rebuild was dropping taps mid-gesture.
    paintHailScopeDateSelection(root, live, liveEsc);
  });
}

export function stormListPageSlice(days, page, pageSize = STORM_LIST_PAGE_SIZE) {
  const list = Array.isArray(days) ? days : [];
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const p = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const start = p * pageSize;
  return { page: p, pages, total, start, items: list.slice(start, start + pageSize) };
}

function hailScopeDateRows(days, esc, { viewport = false, data = null } = {}) {
  if (!days.length) {
    if (data?._meta?.idle) {
      return `<p class="hs-empty">Storm dates stay off until you tap Search storms. Flags load separately from the Flags toggle.</p>`;
    }
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
  const slice = stormListPageSlice(days, hailStormPage);
  hailStormPage = slice.page;
  const rows = slice.items
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
  const pager =
    slice.pages > 1
      ? `<nav class="hs-dates-pager" aria-label="Storm date pages">
          <button type="button" data-hs-page="prev"${slice.page <= 0 ? " disabled" : ""}>Prev</button>
          <span class="hs-dates-pager-lab">Page ${slice.page + 1} of ${slice.pages} · ${slice.total} storms</span>
          <button type="button" data-hs-page="next"${slice.page >= slice.pages - 1 ? " disabled" : ""}>Next</button>
        </nav>`
      : slice.total > STORM_LIST_PAGE_SIZE
        ? `<p class="hs-dates-pager-lab muted">${slice.total} storms</p>`
        : "";
  return `${rows}${pager}`;
}

function bindHailScopeSheet(root, data, esc, { onRefetch } = {}) {
  if (!root) return;
  const meta = data._meta || {};
  const viewport = Boolean(data.viewport || meta.viewport);
  const qEl = root.querySelector("#hs-q");
  if (qEl) {
    qEl.oninput = () => {
      hailSearchQ = String(qEl.value || "").trim().toLowerCase();
      hailStormPage = 0;
      const box = root.querySelector(".hs-dates");
      if (box) {
        box.innerHTML = hailScopeDateRows(hailScopeDays(data), esc, { viewport, data });
        bindHailScopeDates(root, data, esc, { onRefetch });
      }
    };
  }
  bindHailScopeDates(root, data, esc, { onRefetch });
  bindPlaceLinks(root);
  const searchBtn = root.querySelector("#hs-hail-search");
  if (searchBtn) {
    searchBtn.onclick = (e) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      try {
        hailSearchClickHook?.();
      } catch {
        /* ignore */
      }
    };
  }
  const bind = (id, key, cast) => {
    const el = root.querySelector(id);
    if (!el) return;
    el.onchange = async () => {
      hailStormPage = 0;
      wxFilters[key] = cast(el.value);
      if (key === "km" && wxPinSelected()) drawPinRadius();
      // Idle sheet: only remember filters — Search storms starts the fetch.
      if (meta.idle) return;
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
