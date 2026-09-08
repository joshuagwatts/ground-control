/**
 * HomeScope — Oklahoma homeowner hail report (isolated from Ground Control field UX).
 */
import { APP_VERSION } from "../version.js";
import { geocodeCandidates, biasAddressQuery, inOklahoma, suggestOklahomaAddresses, resolveAddressSuggestion } from "../geocode.js";
import { PRODUCT, CLAIM_RULES, homescopeRecommendation, hailWindowSummaries } from "./product.js";
import {
  buildHailTraceDayBands,
  hailRadarBandColor,
  hailMeshBandOpacity,
  reverseGeocode,
  fetchSwdiHailForDays,
  OK_SWDI_BBOX,
  mergeHailRows,
  isSwdiHail,
} from "../wx.js";
import { buildCrmEmailPackage, submitHomescopeLeadToCrm } from "./crm.js";
import { loadHomeStorms, filterCachedHomeStorms, clearHomeHailCache, getHomeHailCache, onHomeHailCache, deepenHomeHailForReport } from "./hail-load.js";

const LEAD_KEY = "homescope_lead_v1";
const TOP_STORM_N = 10;
const LIST_PAGE = 10;
const REPORT_LIST_N = 5;

const state = {
  lead: null,
  step: "address",
  address: "",
  lat: null,
  lon: null,
  roofMode: "idk",
  roofAgeLabel: "Not sure",
  roofReplacedOn: null,
  years: 10,
  minHailIn: 0.5,
  stormSort: "intense",
  storms: [],
  selected: new Set(),
  mapFocusDate: null,
  /** True until the homeowner taps a date — starter pack overlays all top-N together. */
  overlayCollection: true,
  listLimit: LIST_PAGE,
  map: null,
  marker: null,
  overlay: null,
  lastRec: null,
  reportText: "",
  suggestHits: [],
  suggestIdx: -1,
  suggestTimer: 0,
  suggestGen: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function setStatus(el, text, isErr = false) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("err", Boolean(isErr));
}

function readLead() {
  try {
    return JSON.parse(localStorage.getItem(LEAD_KEY) || "null");
  } catch {
    return null;
  }
}

function saveLead(lead) {
  localStorage.setItem(LEAD_KEY, JSON.stringify(lead));
}

function leadReadyForReport(lead) {
  return Boolean(
    lead?.name &&
      lead?.email &&
      lead?.phone &&
      lead?.roofCaptured &&
      (lead.roofMode === "idk" || lead.roofReplacedOn || lead.roofMode),
  );
}

function openReportGate() {
  const gate = $("#report-gate");
  if (!gate) return;
  gate.hidden = false;
  document.documentElement.classList.add("ho-gate-open");
  document.body.classList.add("ho-gate-open");
  if (state.lead) {
    if ($("#gate-name") && state.lead.name) $("#gate-name").value = state.lead.name;
    if ($("#gate-email") && state.lead.email) $("#gate-email").value = state.lead.email;
    if ($("#gate-phone") && state.lead.phone) $("#gate-phone").value = state.lead.phone;
  }
  const mode = state.roofMode || state.lead?.roofMode || "idk";
  paintGateRoofMode(mode);
  if (mode === "year" && state.lead?.roofYear && $("#gate-roof-year")) {
    $("#gate-roof-year").value = state.lead.roofYear;
  }
  setStatus($("#gate-status"), "");
  // Delay focus so iOS keyboard doesn't jump the sheet off-screen before paint.
  setTimeout(() => $("#gate-name")?.focus?.({ preventScroll: true }), 280);
}

function closeReportGate() {
  const gate = $("#report-gate");
  if (gate) gate.hidden = true;
  document.documentElement.classList.remove("ho-gate-open");
  document.body.classList.remove("ho-gate-open");
}

function paintGateRoofMode(mode) {
  state.roofMode = mode || "idk";
  const root = $("#gate-roof-mode");
  if (root) {
    $$("[data-roof]", root).forEach((b) => b.classList.toggle("on", b.getAttribute("data-roof") === state.roofMode));
  }
  const inputs = $("#gate-roof-inputs");
  if (inputs) inputs.hidden = state.roofMode !== "year";
  syncRoofFromGate();
}

function isoYearsAgo(years) {
  const d = new Date();
  d.setMonth(d.getMonth() - Math.round(Number(years) * 12));
  return d.toISOString().slice(0, 10);
}

/** Map gate roof chips → replaced-on date + label for CRM / report. */
function syncRoofFromGate() {
  const mode = state.roofMode || "idk";
  if (mode === "idk") {
    state.roofReplacedOn = null;
    state.roofAgeLabel = "Not sure";
    return true;
  }
  if (mode === "lt2") {
    state.roofReplacedOn = isoYearsAgo(1);
    state.roofAgeLabel = "Under 2 years";
    return true;
  }
  if (mode === "y2_5") {
    state.roofReplacedOn = isoYearsAgo(3.5);
    state.roofAgeLabel = "2–5 years";
    return true;
  }
  if (mode === "y5_10") {
    state.roofReplacedOn = isoYearsAgo(7.5);
    state.roofAgeLabel = "5–10 years";
    return true;
  }
  if (mode === "y10") {
    state.roofReplacedOn = isoYearsAgo(12);
    state.roofAgeLabel = "10+ years";
    return true;
  }
  if (mode === "year") {
    const y = Number($("#gate-roof-year")?.value);
    if (!Number.isFinite(y) || y < 1970 || y > 2030) {
      state.roofReplacedOn = null;
      state.roofAgeLabel = "Exact year";
      return false;
    }
    state.roofReplacedOn = `${y}-01-01`;
    state.roofAgeLabel = `Replaced ${y}`;
    return true;
  }
  state.roofReplacedOn = null;
  state.roofAgeLabel = "Not sure";
  return true;
}

function setStep(step) {
  state.step = step;
  $$("#ho-steps [data-step]").forEach((li) => li.classList.toggle("on", li.dataset.step === step));
  const order = ["address", "storms", "report"];
  const idx = order.indexOf(step);
  $$("[data-panel]").forEach((panel) => {
    const p = panel.dataset.panel;
    const pIdx = order.indexOf(p);
    // Address + map stay available while exploring hail. Hide map on the report
    // so Leaflet is not stacked on top of the document.
    if (p === "address") {
      panel.hidden = step === "report";
      return;
    }
    if (p === "map") {
      panel.hidden = step === "report";
      return;
    }
    if (step === "report") {
      panel.hidden = p !== "report";
      return;
    }
    panel.hidden = pIdx < 0 || pIdx > idx;
  });
  if (step === "address" || step === "storms") {
    requestAnimationFrame(() => {
      const map = ensureMap();
      map?.invalidateSize?.();
      if (Number.isFinite(state.lat)) pinHome(state.lat, state.lon);
      if (step === "storms" && state.selected.size) scheduleOverlayPaint({ immediate: true });
    });
  }
}

function ensureMap() {
  const el = $("#ho-map");
  if (!el || !window.L) return null;
  if (state.map) {
    state.map.invalidateSize();
    return state.map;
  }
  state.map = window.L.map(el, {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: true,
    touchZoom: true,
    doubleClickZoom: true,
    boxZoom: false,
    keyboard: false,
    preferCanvas: true,
    bounceAtZoomLimits: false,
  }).setView([35.4676, -97.5164], 11);
  // Same Google tiles as field HailScope — Carto dark tiles now require an API key.
  window.L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&hl=en&scale=2&x={x}&y={y}&z={z}", {
    attribution: "&copy; Google",
    maxZoom: 21,
    maxNativeZoom: 21,
    subdomains: "0123",
    detectRetina: true,
    updateWhenIdle: true,
    keepBuffer: 1,
  }).addTo(state.map);
  window.L.control.zoom({ position: "bottomright" }).addTo(state.map);
  state.hailSvg = window.L.svg({ padding: 0.85 });
  try {
    state.hailSvg.addTo(state.map);
  } catch {
    /* ignore */
  }
  // Canvas for hail fills — wide padding so zoomed-out statewide Trace stays visible.
  state.hailCanvas = window.L.canvas({ padding: 1.25 });
  state.overlay = window.L.layerGroup().addTo(state.map);
  state.map.on("click", (e) => {
    void selectHomeFromMap(e.latlng.lat, e.latlng.lng, { zoom: false });
  });
  return state.map;
}

function pinHome(lat, lon, { fly = false, zoom = null, invalidate = true } = {}) {
  const map = ensureMap();
  if (!map) return;
  if (state.marker) state.marker.setLatLng([lat, lon]);
  else {
    // Neutral home pin — not a hail color, so size bands stay trustworthy.
    state.marker = window.L.circleMarker([lat, lon], {
      radius: 7,
      color: "#ffffff",
      weight: 2.5,
      fillColor: "#0ea5e9",
      fillOpacity: 1,
    }).addTo(map);
  }
  if (Number.isFinite(zoom)) {
    if (fly) map.flyTo([lat, lon], zoom, { duration: 0.55 });
    else map.setView([lat, lon], zoom);
  }
  if (invalidate) requestAnimationFrame(() => map.invalidateSize());
}

/** Lightweight reverse for HomeScope — don't hang the GPS path on field Nominatim/ArcGIS races. */
async function reverseHomePin(lat, lon, timeoutMs = 6000) {
  const fallback = {
    ok: false,
    address: `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`,
    lat,
    lon,
  };
  const timed = (p) =>
    Promise.race([
      p,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  try {
    const geo = await timed(reverseGeocode(lat, lon));
    if (geo && (geo.address || geo.ok)) {
      return {
        ok: Boolean(geo.ok || geo.address),
        address: hitLabel(geo) || geo.address || fallback.address,
        lat: Number(geo.lat) || lat,
        lon: Number(geo.lon) || lon,
      };
    }
  } catch {
    /* use fallback */
  }
  return fallback;
}

/** Map tap or GPS — reverse-geocode, then same search path as the Search button. */
let mapPickGen = 0;
async function selectHomeFromMap(lat, lon, { zoom = true, fly = false, zoomLevel = 17 } = {}) {
  const status = $("#addr-status");
  const go = $("#addr-go");
  const locateBtn = $("#addr-locate");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    setStatus(status, "Couldn’t read that location — try again", true);
    return;
  }
  const gen = ++mapPickGen;
  if (!inOklahoma({ lat, lon })) {
    setStatus(status, "HomeScope is Oklahoma-only — pick a home in OK", true);
    pinHome(lat, lon, { zoom: zoom ? Math.min(zoomLevel, 12) : null, fly });
    if (locateBtn) locateBtn.disabled = false;
    return;
  }
  if (go) go.disabled = true;
  if (locateBtn) locateBtn.disabled = true;
  setStatus(status, "Got your location — locking the pin…");
  // Pin + zoom immediately so something always happens on screen.
  pinHome(lat, lon, { zoom: zoom ? zoomLevel : null, fly });
  try {
    const geo = await reverseHomePin(lat, lon, 5500);
    if (gen !== mapPickGen) return;
    const label = geo.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const hit = {
      lat: Number(geo.lat) || lat,
      lon: Number(geo.lon) || lon,
      address: label,
      label,
    };
    if (!inOklahoma(hit) && !inOklahoma({ lat: hit.lat, lon: hit.lon })) {
      setStatus(status, "HomeScope is Oklahoma-only — pick a home in OK", true);
      return;
    }
    const input = $("#addr-q");
    if (input) input.value = label;
    setStatus(status, label);
    await selectAddressHit(hit, { force: true });
  } catch (err) {
    if (gen !== mapPickGen) return;
    // Still load hail on the raw GPS pin if reverse fails.
    setStatus(status, "Using GPS pin — loading hail…");
    await selectAddressHit(
      { lat, lon, address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` },
      { force: true },
    );
  } finally {
    if (gen === mapPickGen) {
      if (go) go.disabled = false;
      if (locateBtn) {
        locateBtn.disabled = false;
        locateBtn.textContent = "Use my location";
      }
    }
  }
}

function gpsFixOnce(options) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Object.assign(new Error("unsupported"), { code: 0 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function useMyLocation() {
  const status = $("#addr-status");
  const locateBtn = $("#addr-locate");
  if (!window.isSecureContext) {
    setStatus(status, "GPS needs HTTPS — open the live HomeScope link, or search / tap the map", true);
    return;
  }
  if (!navigator.geolocation) {
    setStatus(status, "Location isn’t available in this browser — search or tap the map", true);
    return;
  }
  if (locateBtn) {
    locateBtn.disabled = true;
    locateBtn.textContent = "Locating…";
  }
  setStatus(status, "Requesting GPS — allow location when your browser asks…");

  try {
    // Fast network/Wifi fix first (usually pops the permission prompt), then refine.
    let pos;
    try {
      pos = await gpsFixOnce({
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60_000,
      });
    } catch (firstErr) {
      if (firstErr?.code === 1) throw firstErr;
      setStatus(status, "Trying a more precise GPS fix…");
      pos = await gpsFixOnce({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      });
    }
    const lat = Number(pos?.coords?.latitude);
    const lon = Number(pos?.coords?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setStatus(status, "GPS returned a bad coordinate — try again or tap the map", true);
      return;
    }
    setStatus(status, `Located ${lat.toFixed(4)}, ${lon.toFixed(4)} — loading home…`);
    await selectHomeFromMap(lat, lon, { zoom: true, fly: false, zoomLevel: 17 });
  } catch (err) {
    const denied = err?.code === 1;
    const timedOut = err?.code === 3;
    setStatus(
      status,
      denied
        ? "Location blocked — in your browser site settings, allow location for this page, then try again"
        : timedOut
          ? "GPS timed out — try again outdoors, or search / tap the map"
          : "Couldn’t get GPS — try again, search, or tap the map",
      true,
    );
  } finally {
    if (locateBtn) {
      locateBtn.disabled = false;
      locateBtn.textContent = "Use my location";
    }
  }
}

function colorForHailSize(sizeIn) {
  return hailRadarBandColor(sizeIn);
}

/** Leaflet SVG hatch for HailTrace pale fringe bands (same pattern as field HailScope). */
function ensureHomeHailHatch(svgRoot) {
  if (!svgRoot || svgRoot.querySelector("#gc-hail-hatch")) return;
  const NS = "http://www.w3.org/2000/svg";
  const defs =
    svgRoot.querySelector("defs") ||
    (() => {
      const d = document.createElementNS(NS, "defs");
      svgRoot.insertBefore(d, svgRoot.firstChild);
      return d;
    })();
  const pattern = document.createElementNS(NS, "pattern");
  pattern.setAttribute("id", "gc-hail-hatch");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("width", "10");
  pattern.setAttribute("height", "10");
  pattern.setAttribute("patternTransform", "rotate(45)");
  const base = document.createElementNS(NS, "rect");
  base.setAttribute("width", "10");
  base.setAttribute("height", "10");
  base.setAttribute("fill", "rgba(255, 245, 157, 0.55)");
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", "0");
  line.setAttribute("x2", "0");
  line.setAttribute("y2", "10");
  line.setAttribute("stroke", "rgba(120, 110, 60, 0.45)");
  line.setAttribute("stroke-width", "2");
  pattern.appendChild(base);
  pattern.appendChild(line);
  defs.appendChild(pattern);
}

function rankedStorms(storms = state.storms, sort = state.stormSort) {
  const list = [...(storms || [])];
  if (sort === "recent") {
    list.sort((a, b) => b.date.localeCompare(a.date) || (b.maxSizeIn || 0) - (a.maxSizeIn || 0));
  } else {
    // Most intense at this location: size first, then closer to the roof, then newer.
    list.sort(
      (a, b) =>
        (b.maxSizeIn || 0) - (a.maxSizeIn || 0) ||
        (a.minDist || 999) - (b.minDist || 999) ||
        b.date.localeCompare(a.date),
    );
  }
  return list;
}

function autoSelectTopStorms(storms = state.storms, sort = state.stormSort, n = TOP_STORM_N) {
  const ranked = rankedStorms(storms, sort);
  if (ranked.length && !state.mapFocusDate) state.mapFocusDate = ranked[0].date;
  else if (ranked.length && !ranked.some((s) => s.date === state.mapFocusDate)) {
    state.mapFocusDate = ranked[0].date;
  }
  return new Set(ranked.slice(0, n).map((s) => s.date));
}

/** Tap a list date: toggle it on the map. Starter-pack tap on an already-on date solos it. */
function activateStormDate(date) {
  const d = String(date || "").slice(0, 10);
  if (!d) return;
  if (state.overlayCollection && state.selected.has(d) && state.selected.size > 1) {
    // Opening stack still intact — tapping one of those dates solos it.
    state.overlayCollection = false;
    state.selected = new Set([d]);
  } else {
    // Add / remove freely (including dates from Load more).
    state.overlayCollection = false;
    if (state.selected.has(d)) {
      if (state.selected.size > 1) state.selected.delete(d);
    } else {
      state.selected.add(d);
    }
  }
  state.mapFocusDate = d;
  paintStormList({ skipMap: true });
  scheduleOverlayPaint({ immediate: true });
}

/** Throttle map rebuilds while years stream — Trace bands from LSR + statewide SWDI (like field GC). */
let overlayPaintTimer = 0;
let lastOverlayPaintAt = 0;
let lastOverlaySig = "";
let lastOverlayHailN = -1;
let swdiEnrichGen = 0;
const swdiEnrichedDays = new Set();
let lastZoneRevealSig = "";
const MAP_STREAM_DAYS = 1;
const MAP_COLLECTION_DAYS = 5;
const SWDI_DAY_MIN = 8;

function overlaySelectionSig() {
  return [...state.selected].sort().join("|");
}

function hailFillRenderer() {
  ensureMap();
  if (state.map && window.L && !state.hailCanvas) {
    // Wide padding so zoomed-out statewide Trace isn't clipped.
    state.hailCanvas = window.L.canvas({ padding: 1.25 });
  }
  return state.hailCanvas || undefined;
}

function scheduleOverlayPaint({ immediate = false } = {}) {
  ensureMap();
  if (!state.overlay || !window.L) return;
  if (!state.selected.size) return;

  const run = () => {
    overlayPaintTimer = 0;
    lastOverlayPaintAt = Date.now();
    lastOverlaySig = overlaySelectionSig();
    lastOverlayHailN = getHomeHailCache().hail?.length || 0;
    void paintOverlays();
  };

  const sig = overlaySelectionSig();
  const hailN = getHomeHailCache().hail?.length || 0;
  const first = lastOverlayPaintAt === 0;
  const loading = Boolean(getHomeHailCache().loadingDeep);
  const changed = sig !== lastOverlaySig || hailN !== lastOverlayHailN;
  if (!immediate && !first && !changed) return;

  if (loading && !first && lastOverlayPaintAt && Date.now() - lastOverlayPaintAt < 2000 && sig === lastOverlaySig) {
    if (!overlayPaintTimer) overlayPaintTimer = setTimeout(run, 2000);
    return;
  }

  if (overlayPaintTimer) {
    clearTimeout(overlayPaintTimer);
    overlayPaintTimer = 0;
  }
  const delay = first ? 60 : immediate && !loading ? 40 : loading ? 1800 : 800;
  overlayPaintTimer = setTimeout(run, delay);
}

/** Pull NOAA SWDI per storm day (OK bbox) — one day at a time like field GC.
 * Do NOT request one giant date range across years (that times out / returns empty).
 */
async function ensureStatewideSwdiForDays(days) {
  if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)) return false;
  const cache = getHomeHailCache();
  const need = (days || []).filter((d) => {
    if (!d || swdiEnrichedDays.has(d)) return false;
    const n = (cache.hail || []).filter(
      (h) => String(h?.date || "").slice(0, 10) === d && isSwdiHail(h),
    ).length;
    return n < SWDI_DAY_MIN;
  });
  if (!need.length) return false;

  const gen = ++swdiEnrichGen;
  let grew = false;
  const status = $("#storm-status");
  // Newest first — map focus / recent storms get radar ASAP.
  const queue = [...need].sort((a, b) => b.localeCompare(a));

  for (let i = 0; i < queue.length; i++) {
    if (gen !== swdiEnrichGen) return grew;
    const d = queue[i];
    if (status && !status.classList.contains("err")) {
      setStatus(
        status,
        `Loading NOAA radar swath for ${d} (${i + 1}/${queue.length})…`,
      );
    }
    try {
      // Ingest from OK center so the full statewide bbox survives the 450 km cap
      // (pin-centered ingest drops far corners of Oklahoma).
      const { rows, err } = await fetchSwdiHailForDays(35.4676, -97.5164, 450, [d], {
        bbox: OK_SWDI_BBOX,
      });
      if (gen !== swdiEnrichGen) return grew;
      if (rows?.length) {
        cache.hail = mergeHailRows(cache.hail || [], rows);
        swdiEnrichedDays.add(d);
        grew = true;
      } else if (!err || err === "empty") {
        // Genuine empty radar day — don't keep retrying.
        swdiEnrichedDays.add(d);
      }
      // "filtered" / network errors: leave unmarked so a later paint can retry.
    } catch (err) {
      console.warn("[HomeScope] SWDI day enrich", d, err);
    }
  }
  return grew;
}

/** Point-in-ring for [lat, lon] Trace rings. */
function pointInHailRing(lat, lon, ring) {
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
 * If roof zoom doesn't actually show any Trace vertices (statewide bbox ≠ on-screen),
 * ease out to the nearest ring edge so homeowners see hail coverage.
 */
function revealNearestHailIfOutOfView(rings, { force = false } = {}) {
  const map = state.map;
  if (!map || !window.L) return;
  if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)) return;

  const home = window.L.latLng(state.lat, state.lon);
  const view = map.getBounds?.();
  if (!view) return;

  const list = (rings || []).filter((r) => Array.isArray(r) && r.length >= 3);
  const sig = `${Number(state.lat).toFixed(4)}|${Number(state.lon).toFixed(4)}|${overlaySelectionSig()}`;

  let anyInView = false;
  let nearest = null;
  for (const ring of list) {
    if (pointInHailRing(home.lat, home.lng, ring)) anyInView = true;
    for (const p of ring) {
      const lat = Number(p[0]);
      const lon = Number(p[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const ll = window.L.latLng(lat, lon);
      try {
        if (view.contains(ll)) anyInView = true;
      } catch {
        /* ignore */
      }
      const dist = home.distanceTo(ll);
      if (!nearest || dist < nearest.dist) nearest = { dist, ll };
    }
  }

  if (anyInView) {
    lastZoneRevealSig = sig;
    return;
  }

  // No Trace geometry yet — fall back to storm nearest-report distance.
  if (!nearest) {
    const storms = rankedStorms();
    let minKm = Infinity;
    for (const s of storms) {
      if (!state.selected.has(s.date)) continue;
      const d = Number(s.minDist);
      if (Number.isFinite(d) && d < minKm) minKm = d;
    }
    if (!(minKm < 900)) return;
    if (!force && sig === lastZoneRevealSig) return;
    lastZoneRevealSig = sig;
    const z = minKm < 2 ? 14 : minKm < 5 ? 12 : minKm < 12 ? 11 : minKm < 30 ? 10 : 9;
    try {
      map.setView(home, z, { animate: true });
    } catch {
      /* ignore */
    }
    return;
  }

  if (!force && sig === lastZoneRevealSig) return;
  lastZoneRevealSig = sig;

  try {
    // Fit home + nearest edge only (not the whole statewide swath bbox).
    const fit = window.L.latLngBounds([home, nearest.ll]);
    map.fitBounds(fit, {
      padding: [64, 64],
      maxZoom: 11,
      animate: true,
    });
  } catch {
    try {
      map.setView(home, nearest.dist < 5000 ? 12 : nearest.dist < 15000 ? 10 : 9, { animate: true });
    } catch {
      /* ignore */
    }
  }
}

async function paintOverlays() {
  ensureMap();
  if (!state.overlay || !window.L) return;
  state.overlay.clearLayers();

  const ranked = rankedStorms();
  let days = [...state.selected].filter((d) => ranked.some((s) => s.date === d));
  if (!days.length && ranked[0]) {
    days = ranked.slice(0, TOP_STORM_N).map((s) => s.date);
    state.selected = new Set(days);
    state.mapFocusDate = days[0];
    state.overlayCollection = true;
  }
  if (!days.length) return;

  if (!state.mapFocusDate || !days.includes(state.mapFocusDate)) {
    state.mapFocusDate = ranked.find((s) => days.includes(s.date))?.date || days[0];
  }

  const loading = Boolean(getHomeHailCache().loadingDeep);
  const cap = loading
    ? MAP_STREAM_DAYS
    : state.overlayCollection
      ? MAP_COLLECTION_DAYS
      : Math.min(days.length, 5);
  const preferred = ranked.filter((s) => days.includes(s.date)).map((s) => s.date);
  if (state.mapFocusDate && preferred.includes(state.mapFocusDate)) {
    days = [state.mapFocusDate, ...preferred.filter((d) => d !== state.mapFocusDate)].slice(0, cap);
  } else {
    days = preferred.slice(0, cap);
  }
  days.sort((a, b) => a.localeCompare(b));

  const paintDays = (dayList) => {
    const dayPool = getHomeHailCache().hail || [];
    const renderer = hailFillRenderer();
    const rings = [];
    state.overlay.clearLayers();
    for (const day of dayList) {
      const storm = ranked.find((s) => s.date === day);
      const dayRows = dayPool.filter((p) => String(p?.date || "").slice(0, 10) === day);
      const seed = dayRows.length ? dayRows : storm?.zone_pts || [];
      let bands = [];
      try {
        bands = buildHailTraceDayBands(day, seed) || [];
      } catch (err) {
        console.warn("[HomeScope] HailTrace bands failed", day, err);
        bands = [];
      }
      const focused = day === state.mapFocusDate;
      const multi = dayList.length > 1;
      for (const band of bands) {
        if (!band?.ring?.length) continue;
        rings.push(band.ring);
        const sz = Number(band.maxSize) || Number(storm?.maxSizeIn) || 1;
        const col = hailRadarBandColor(sz);
        const isolated = Boolean(band.isolated);
        const fillOp = isolated
          ? 0.55
          : hailMeshBandOpacity(sz) * (multi && !focused ? 0.72 : 1);
        window.L.polygon([band.ring, ...(band.holes || [])], {
          color: col.stroke,
          weight: isolated ? 0.9 : focused ? 0.75 : 0.55,
          fillColor: col.fill,
          fillOpacity: fillOp,
          opacity: isolated ? 0.55 : focused ? 0.5 : 0.35,
          stroke: true,
          smoothFactor: 1.8,
          renderer,
          className: isolated ? "wx-hail-topo wx-hail-isolated" : "wx-hail-topo",
        }).addTo(state.overlay);
      }
    }
    return rings;
  };

  const reveal = (rings, force) => {
    // Defer past pin setView / layout so we measure the real viewport.
    requestAnimationFrame(() => {
      setTimeout(() => revealNearestHailIfOutOfView(rings, { force }), 80);
    });
  };

  let rings = paintDays(days);
  reveal(rings, true);

  // Radar swaths (SWDI) — without this, Trace is spotter-only soft disks.
  const radarBefore = (getHomeHailCache().hail || []).filter(isSwdiHail).length;
  const grew = await ensureStatewideSwdiForDays(days);
  const radarAfter = (getHomeHailCache().hail || []).filter(isSwdiHail).length;
  if (grew || radarAfter > radarBefore) {
    rings = paintDays(days);
    reveal(rings, true);
    // Radar merge changes sizes/sources — refresh list/report without re-entering paint.
    refreshStormListFromCache();
    const nRadar = days.reduce((acc, d) => {
      const n = (getHomeHailCache().hail || []).filter(
        (h) => String(h?.date || "").slice(0, 10) === d && isSwdiHail(h),
      ).length;
      return acc + n;
    }, 0);
    const status = $("#storm-status");
    if (status && !status.classList.contains("err") && state.storms.length) {
      setStatus(
        status,
        `${state.storms.length} covering date(s) · map: ${days.length} day Trace · ${nRadar} radar sigs on overlay`,
      );
    }
  } else if (!rings.length) {
    reveal([], true);
  }
}

/** Re-summarize storms after SWDI merge so list sizes/sources match the map. */
function refreshStormListFromCache() {
  const result = filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn });
  state.storms = result.storms || [];
  for (const d of [...state.selected]) {
    if (!state.storms.some((s) => s.date === d)) state.selected.delete(d);
  }
  paintStormList({ loading: Boolean(result.loading), skipMap: true });
}

function hitLabel(hit) {
  return String(hit?.address || hit?.label || "").trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchSuggestions(query) {
  const q = String(query || "").trim();
  if (q.length < 3) return [];
  try {
    const hits = await suggestOklahomaAddresses(q, { max: 8 });
    if (hits.length) return hits;
  } catch {
    /* fall through to full geocode */
  }
  try {
    const ranked = await geocodeCandidates(q, { city: "Oklahoma" });
    return (ranked || []).filter((h) => inOklahoma(h)).slice(0, 6);
  } catch {
    return [];
  }
}

function clearSuggestions() {
  state.suggestHits = [];
  state.suggestIdx = -1;
  const wrap = $("#addr-suggest-wrap");
  const box = $("#addr-suggest");
  const input = $("#addr-q");
  if (box) box.innerHTML = "";
  if (wrap) wrap.hidden = true;
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
}

function paintSuggestions(hits, { emptyMsg = "" } = {}) {
  const wrap = $("#addr-suggest-wrap");
  const box = $("#addr-suggest");
  const input = $("#addr-q");
  if (!box || !wrap) return;
  state.suggestHits = hits || [];
  state.suggestIdx = state.suggestHits.length ? 0 : -1;
  box.innerHTML = "";
  if (!state.suggestHits.length) {
    if (emptyMsg) {
      wrap.hidden = false;
      box.innerHTML = `<li class="ho-suggest-empty">${escapeHtml(emptyMsg)}</li>`;
      if (input) input.setAttribute("aria-expanded", "true");
    } else {
      wrap.hidden = true;
      if (input) input.setAttribute("aria-expanded", "false");
    }
    return;
  }
  wrap.hidden = false;
  if (input) input.setAttribute("aria-expanded", "true");
  state.suggestHits.forEach((hit, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ho-suggest-item${i === state.suggestIdx ? " active" : ""}`;
    btn.id = `addr-opt-${i}`;
    const main = hitLabel(hit);
    btn.innerHTML = `<span class="ho-suggest-main">${escapeHtml(main)}</span>
      <span class="ho-suggest-meta">Tap to search this address</span>`;
    // Keep focus in the field (so the list doesn't dismiss before click lands),
    // then run the same path as the Search button.
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void submitAddressSearch({ hit });
    });
    li.appendChild(btn);
    box.appendChild(li);
  });
  if (input && state.suggestIdx >= 0) input.setAttribute("aria-activedescendant", `addr-opt-${state.suggestIdx}`);
}

function highlightSuggest(idx) {
  state.suggestIdx = idx;
  $$(".ho-suggest-item").forEach((el, i) => el.classList.toggle("active", i === idx));
  const input = $("#addr-q");
  if (input && idx >= 0) input.setAttribute("aria-activedescendant", `addr-opt-${idx}`);
}

async function selectAddressHit(hit, { force = true } = {}) {
  const status = $("#addr-status");
  setStatus(status, "Locking address…");
  clearSuggestions();
  try {
    let resolved = hit;
    // Suggest stubs need magicKey resolve; full geocode hits already have coords.
    if (!Number.isFinite(Number(hit?.lat)) || !Number.isFinite(Number(hit?.lon)) || hit?.magicKey) {
      resolved = await resolveAddressSuggestion(hit);
    }
    const lat = Number(resolved?.lat);
    const lon = Number(resolved?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setStatus(status, "Couldn’t pin that address — try another suggestion", true);
      return;
    }
    if (!inOklahoma(resolved) && !inOklahoma({ lat, lon })) {
      setStatus(status, "HomeScope is Oklahoma-only — pick an OK address", true);
      return;
    }
    const label = hitLabel(resolved) || hitLabel(hit) || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const input = $("#addr-q");
    if (input) input.value = label;
    const moved =
      !Number.isFinite(state.lat) ||
      Math.abs(state.lat - lat) > 1e-5 ||
      Math.abs(state.lon - lon) > 1e-5;
    if (moved || force) {
      clearHomeHailCache();
      state.mapFocusDate = null;
      state.overlayCollection = true;
      state.listLimit = LIST_PAGE;
      if (overlayPaintTimer) {
        clearTimeout(overlayPaintTimer);
        overlayPaintTimer = 0;
      }
      lastOverlayPaintAt = 0;
      lastOverlaySig = "";
      lastOverlayHailN = -1;
      swdiEnrichGen += 1;
      swdiEnrichedDays.clear();
      lastZoneRevealSig = "";
    }
    state.address = label;
    state.lat = lat;
    state.lon = lon;
    state.storms = [];
    state.selected.clear();
    setStatus(status, label);
    setStep("storms");
    pinHome(lat, lon, { fly: true, zoom: 17 });
    paintStormList({ loading: true });
    await refreshStorms({ force: moved || force });
  } catch (err) {
    setStatus(status, err?.message || "Address lookup failed", true);
  }
}

/** Same path for Search button, Enter, and tapping a suggestion. */
async function submitAddressSearch({ hit = null } = {}) {
  const status = $("#addr-status");
  const go = $("#addr-go");
  const q = $("#addr-q")?.value || "";
  if (go) go.disabled = true;
  try {
    if (hit) {
      setStatus(status, "Looking up Oklahoma address…");
      await selectAddressHit(hit, { force: true });
      return;
    }
    if (state.suggestHits.length && state.suggestIdx >= 0) {
      setStatus(status, "Looking up Oklahoma address…");
      await selectAddressHit(state.suggestHits[state.suggestIdx], { force: true });
      return;
    }
    setStatus(status, "Looking up Oklahoma address…");
    const found = await lookupAddress(q);
    await selectAddressHit(found.hit || found, { force: true });
  } catch (err) {
    setStatus(status, err?.message || "Lookup failed", true);
  } finally {
    if (go) go.disabled = false;
  }
}

async function lookupAddress(query) {
  const q = biasAddressQuery(String(query || "").trim());
  if (!q) throw new Error("Enter a street address");
  const hits = await geocodeCandidates(q, { city: "Oklahoma" });
  const okHits = (hits || []).filter((h) => inOklahoma(h));
  if (okHits.length > 1) {
    paintSuggestions(okHits.slice(0, 6));
    throw new Error("Pick an address from the suggestions");
  }
  const hit = okHits[0] || hits?.[0];
  if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) {
    throw new Error("Couldn’t find that address — try city + OK");
  }
  if (!inOklahoma(hit)) {
    throw new Error("HomeScope is Oklahoma-only for now — enter an OK address");
  }
  return {
    lat: hit.lat,
    lon: hit.lon,
    label: hitLabel(hit) || q,
    hit,
  };
}

function scheduleSuggest(raw) {
  clearTimeout(state.suggestTimer);
  const q = String(raw || "").trim();
  if (q.length < 3) {
    clearSuggestions();
    setStatus($("#addr-status"), q ? "Keep typing — suggestions appear after 3 letters" : "");
    return;
  }
  const gen = ++state.suggestGen;
  // Show dropdown shell immediately so it feels instant.
  paintSuggestions([], { emptyMsg: "Finding addresses…" });
  setStatus($("#addr-status"), "Finding addresses…");
  state.suggestTimer = setTimeout(async () => {
    const hits = await fetchSuggestions(q);
    if (gen !== state.suggestGen) return;
    if (!hits.length) {
      paintSuggestions([], { emptyMsg: "No matches yet — keep typing street + city" });
      setStatus($("#addr-status"), "No suggestions yet");
      return;
    }
    paintSuggestions(hits);
    setStatus($("#addr-status"), "Tap a suggestion below");
  }, 180);
}

function paintStormList({ loading = false, skipMap = false } = {}) {
  const list = $("#storm-list");
  const moreWrap = $("#storm-more-wrap");
  const moreBtn = $("#storm-more");
  const moreMeta = $("#storm-more-meta");
  const btn = $("#make-report");
  if (!list) return;
  list.innerHTML = "";
  const ranked = rankedStorms();
  if (!ranked.length) {
    if (moreWrap) moreWrap.hidden = true;
    const li = document.createElement("li");
    li.style.cursor = "default";
    li.style.opacity = "0.75";
    li.innerHTML = loading
      ? `<span class="sz">…</span><span>Loading verified hail cover…<br/><span class="meta">NOAA SWDI radar + SPC / IEM — keep this tab open</span></span><span></span>`
      : `<span class="sz">—</span><span>No storms with verified cover yet<br/><span class="meta">Near-roof (≤1.6 km) or storm footprint over this pin</span></span><span></span>`;
    list.appendChild(li);
    if (btn) btn.disabled = true;
    if (!skipMap) paintOverlays();
    return;
  }

  const limit = Math.min(Math.max(state.listLimit || LIST_PAGE, LIST_PAGE), ranked.length);
  state.listLimit = limit;
  const visible = ranked.slice(0, limit);
  const remaining = ranked.length - visible.length;

  visible.forEach((s, idx) => {
    const on = state.selected.has(s.date);
    const focused = s.date === state.mapFocusDate;
    const li = document.createElement("li");
    li.className = `${on ? "on" : ""}${focused ? " map-focus" : ""}`.trim();
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    const col = colorForHailSize(s.maxSizeIn);
    const how = [
      s.coversNear ? "near roof" : null,
      s.coversPolygon ? "zone over home" : null,
      s.coversNearby ? "nearby report" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const distMeta =
      Number.isFinite(s.minDist) && s.minDist < 900
        ? ` · nearest ${Number(s.minDist).toFixed(1)} km`
        : "";
    li.innerHTML = `<span class="sz" style="color:${col.fill}">${Number(s.maxSizeIn).toFixed(2)}″</span>
      <span>${s.pretty || s.date}<br/><span class="meta">${s.sources} · ${how || "verified cover"}${distMeta}</span></span>
      <span class="meta">${on ? (state.selected.size > 1 ? "On map" : "Solo") : "Tap to add"}</span>`;
    const activate = () => activateStormDate(s.date);
    li.addEventListener("click", activate);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    list.appendChild(li);
  });

  if (moreWrap && moreBtn) {
    if (remaining > 0) {
      moreWrap.hidden = false;
      moreBtn.disabled = false;
      const next = Math.min(LIST_PAGE, remaining);
      moreBtn.textContent = `Load ${next} more storm${next === 1 ? "" : "s"}`;
      if (moreMeta) {
        moreMeta.textContent = `Showing ${visible.length} of ${ranked.length} · OK roofs often see this kind of depth in ~3–5 years`;
      }
    } else {
      moreWrap.hidden = true;
      moreBtn.disabled = false;
    }
  }

  if (btn) btn.disabled = false;
  if (!skipMap) paintOverlays();
}

/** Background SWDI for all selected covering dates (beyond map paint cap). */
function scheduleRadarEnrichForSelection() {
  if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)) return;
  const ranked = rankedStorms();
  const days = [...state.selected]
    .filter((d) => ranked.some((s) => s.date === d))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, TOP_STORM_N);
  if (!days.length) return;
  void (async () => {
    const grew = await ensureStatewideSwdiForDays(days);
    if (grew) scheduleOverlayPaint({ immediate: true });
  })();
}

function applyStormResult(result, { loading = false, reseatSelection = true, skipMap = false } = {}) {
  const still = loading || Boolean(result.loading);
  const prevCount = state.storms.length;
  state.storms = result.storms || [];
  if (reseatSelection) {
    // Don't reset pagination while streaming — only grow the list under the user.
    if (!still) state.listLimit = LIST_PAGE;
    state.selected = autoSelectTopStorms(state.storms, state.stormSort, TOP_STORM_N);
    state.overlayCollection = true;
  } else {
    for (const d of [...state.selected]) {
      if (!state.storms.some((s) => s.date === d)) state.selected.delete(d);
    }
    if (!state.selected.size && state.storms.length) {
      state.selected = autoSelectTopStorms(state.storms, state.stormSort, TOP_STORM_N);
      state.overlayCollection = true;
    } else {
      autoSelectTopStorms(state.storms, state.stormSort, TOP_STORM_N);
    }
  }
  // List always; map shows cover without thrashing Trace on every archive chunk.
  paintStormList({ loading: still, skipMap: true });
  ensureMap();
  if (Number.isFinite(state.lat)) {
    if (!state.marker) pinHome(state.lat, state.lon, { invalidate: false });
    else state.marker.setLatLng([state.lat, state.lon]);
  }
  if (state.selected.size) {
    const firstBatch = prevCount === 0 && state.storms.length > 0;
    scheduleOverlayPaint({ immediate: firstBatch || !still });
    // After archive settles, pull radar for every selected date (not just the 1–5 painted).
    if (!still) scheduleRadarEnrichForSelection();
  }

  const status = $("#storm-status");
  const note = result.note ? ` ${result.note}` : "";
  const focus = state.mapFocusDate
    ? state.storms.find((s) => s.date === state.mapFocusDate)?.pretty || state.mapFocusDate
    : "";
  const sortLabel = state.stormSort === "recent" ? "most recent" : "most intense";
  if (result.error) {
    setStatus(status, result.note || "Hail load failed", true);
    return;
  }
  const overlayN = state.selected.size;
  const grew = state.storms.length > prevCount;
  const mapLabel = state.overlayCollection
    ? `${overlayN} dates overlaid (tap one to solo · tap others to add)`
    : overlayN > 1
      ? `${overlayN} dates overlaid · last: ${focus || "—"}`
      : `map: ${focus || "—"}`;
  setStatus(
    status,
    still
      ? `Loading… ${state.storms.length} covering date(s) so far${grew ? " (+)" : ""} · ${result.hailRowCount || 0} reports.${note}`
      : state.storms.length
        ? `${state.storms.length} verified covering · ${mapLabel} (${sortLabel}) · NOAA SWDI / SPC / IEM.${note}`
        : `No storms ≥${state.minHailIn}″ with verified cover in ~${state.years} years.${note}`,
  );
}

async function refreshStorms({ force = false } = {}) {
  if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)) return;
  const status = $("#storm-status");
  const gen = ++refreshStorms._gen;
  const pinLat = state.lat;
  const pinLon = state.lon;
  setStatus(status, `Loading ~${state.years}y of hail (≥${state.minHailIn}″)…`);
  $("#make-report").disabled = true;

  const stillThisPin = () =>
    Number.isFinite(state.lat) &&
    Math.abs(state.lat - pinLat) < 1e-4 &&
    Math.abs(state.lon - pinLon) < 1e-4;

  const applyIfCurrent = (result, opts) => {
    // Accept progressive updates for this pin even if a newer refresh gen started
    // for the same coordinates (map tap / search retries). Drop only if pin moved.
    if (!stillThisPin()) return;
    applyStormResult(result, opts);
  };

  const cache = getHomeHailCache();
  const needDays = Math.min(Math.max(Math.round(state.years * 365.25), 30), 3650);
  const canFilterOnly =
    !force &&
    cache.key &&
    cache.hail?.length &&
    (cache.fetchedDays || 0) >= Math.min(needDays, 730);

  if (canFilterOnly && needDays <= (cache.fetchedDays || 0) && !cache.loadingDeep && !cache.deepenPromise) {
    applyIfCurrent(filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn }), {
      loading: false,
      reseatSelection: true,
    });
    return;
  }

  if (canFilterOnly) {
    applyIfCurrent(filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn }), {
      loading: true,
      reseatSelection: state.overlayCollection,
      skipMap: true,
    });
  } else {
    state.storms = [];
    state.mapFocusDate = null;
    paintStormList({ loading: true, skipMap: true });
  }

  try {
    const result = await loadHomeStorms(state.lat, state.lon, {
      address: state.address,
      years: state.years,
      minHailIn: state.minHailIn,
      force,
      onPartial: (part) =>
        applyIfCurrent(part, {
          loading: true,
          reseatSelection: state.overlayCollection,
          skipMap: true,
        }),
    });
    // Final pass after deepen + cover drain — always paint the map.
    applyIfCurrent(
      result?.error ? result : filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn }),
      {
        loading: false,
        reseatSelection: state.overlayCollection,
        skipMap: false,
      },
    );
  } catch (err) {
    if (!stillThisPin()) return;
    paintStormList({ loading: false });
    setStatus(status, err?.message || "Hail load failed", true);
  }
}
refreshStorms._gen = 0;

function applyFiltersFromChips({ reseatSelection = true } = {}) {
  if (!Number.isFinite(state.lat)) return;
  const cache = getHomeHailCache();
  const needDays = Math.min(Math.max(Math.round(state.years * 365.25), 30), 3650);
  const result = filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn });
  applyStormResult(result, { loading: Boolean(result.loading), reseatSelection });
  // Only kick a new fetch when history is incomplete AND nothing is already streaming.
  // Re-entering refresh while loadingDeep used to abort the deepen (needed a filter flip).
  if (needDays > (cache.fetchedDays || 0) && !cache.loadingDeep && !cache.deepenPromise) {
    void refreshStorms({ force: false });
  }
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildReportText(rec) {
  // Plain-text fallback for share / clipboard — not shown in the UI.
  const b = PRODUCT.brand;
  const inReview = (state.storms || []).filter((s) => {
    const d = String(s?.date || "");
    return d >= rec.windowStart && d <= rec.windowEnd;
  });
  const earlier = (state.storms || []).filter((s) => String(s?.date || "") < rec.windowStart);
  const extreme = rankedStorms(inReview, "intense").slice(0, REPORT_LIST_N);
  const recent = rankedStorms(inReview, "recent").slice(0, REPORT_LIST_N);
  const historyExtreme = rankedStorms(earlier, "intense").slice(0, REPORT_LIST_N);
  const lines = [
    `${b.company} · ${PRODUCT.name}`,
    `Hail Report — ${state.address}`,
    `Generated ${new Date().toLocaleString()}`,
    "",
    rec.headline,
    rec.reason,
    "",
    `Next step: ${rec.primaryCta}`,
    rec.secondaryCta ? `Also: ${rec.secondaryCta}` : "",
    `Call ${b.phone} · ${b.webLabel}`,
    "",
    `Review period: ${rec.windowStart} → ${rec.windowEnd} · ${inReview.length} covering (≥ ${state.minHailIn}″)`,
    `Full history loaded: ${state.years} years · ${state.storms.length} covering total`,
    "",
    "Hail summary (2 / 5 / 10 years):",
  ].filter((x) => x !== "");
  const windowSummaries = hailWindowSummaries(state.storms, {
    loadedYears: state.years,
    windows: [2, 5, 10],
  });
  for (const w of windowSummaries) {
    const maxLabel = w.maxSize > 0 ? `${Number(w.maxSize).toFixed(2)}″` : "—";
    const partial = w.partial ? ` (loaded ${w.loadedYears}y)` : "";
    lines.push(
      `• ${w.years}y${partial}: ${w.count} covering ≥${state.minHailIn}″ · ${w.inchPlus} at ${CLAIM_RULES.minHailInches}″+ · largest ${maxLabel} · latest ${w.latestPretty || "—"}`,
    );
  }
  lines.push("", `Top ${REPORT_LIST_N} most extreme (review period):`);
  if (extreme.length) {
    for (const s of extreme) {
      lines.push(`• ${s.pretty || s.date} — ${Number(s.maxSizeIn).toFixed(2)}″ — ${s.sources}`);
    }
  } else {
    lines.push("• None in the review period");
  }
  lines.push("", `Top ${REPORT_LIST_N} most recent (review period):`);
  if (recent.length) {
    for (const s of recent) {
      lines.push(`• ${s.pretty || s.date} — ${Number(s.maxSizeIn).toFixed(2)}″ — ${s.sources}`);
    }
  } else {
    lines.push("• None in the review period");
  }
  if (historyExtreme.length) {
    lines.push("", `Earlier history (before review window):`);
    for (const s of historyExtreme) {
      lines.push(`• ${s.pretty || s.date} — ${Number(s.maxSizeIn).toFixed(2)}″ — ${s.sources}`);
    }
  }
  lines.push("", PRODUCT.disclaimer);
  return lines.join("\n");
}

function reportStormRowsHtml(storms, flag) {
  if (!storms.length) {
    return `<li class="hg-storm empty"><div class="hg-storm-body"><strong>No verified covering storms in this filter</strong>
        <span class="hg-storm-meta">Listed only when near-roof (≤1.6 km) or a storm footprint covers this pin.</span></div></li>`;
  }
  return storms
    .map((s, idx) => {
      const cover = [
        s.coversNear ? "Near roof" : null,
        s.coversPolygon ? "Zone over home" : null,
        s.coversNearby ? "Nearby report" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const dist =
        Number.isFinite(s.minDist) && s.minDist < 900
          ? ` · ${Number(s.minDist).toFixed(1)} km`
          : "";
      return `<li class="hg-storm">
            <div class="hg-storm-size">${escHtml(Number(s.maxSizeIn).toFixed(2))}<span>″</span></div>
            <div class="hg-storm-body">
              <strong>${escHtml(s.pretty || s.date)}</strong>
              <span class="hg-storm-meta">${escHtml(s.sources)}${cover ? " · " + escHtml(cover) : ""}${escHtml(dist)}</span>
            </div>
            <div class="hg-storm-flag">${escHtml(flag || "#" + (idx + 1))}</div>
          </li>`;
    })
    .join("");
}

function hailSummaryRowsHtml(summaries, minHailIn) {
  if (!summaries?.length) return "";
  return summaries
    .map((w) => {
      const maxLabel = w.maxSize > 0 ? `${Number(w.maxSize).toFixed(2)}″` : "—";
      const latest = w.latestPretty || "—";
      const partial = w.partial ? ` · loaded ${w.loadedYears}y` : "";
      return `<div class="hg-hail-window">
        <p class="hg-hail-window-years">${escHtml(String(w.years))} year${w.years === 1 ? "" : "s"}</p>
        <p class="hg-hail-window-stat"><strong>${escHtml(String(w.count))}</strong> covering ≥ ${escHtml(String(minHailIn))}″</p>
        <p class="hg-hail-window-stat"><strong>${escHtml(String(w.inchPlus))}</strong> at ${escHtml(String(CLAIM_RULES.minHailInches))}″+</p>
        <p class="hg-hail-window-meta">Largest ${escHtml(maxLabel)} · Latest ${escHtml(latest)}${escHtml(partial)}</p>
      </div>`;
    })
    .join("");
}

function renderReportDocument(rec) {
  const b = PRODUCT.brand;
  const roofLabel =
    state.roofAgeLabel && state.roofAgeLabel !== "Exact year"
      ? state.roofAgeLabel
      : state.roofReplacedOn
        ? state.roofReplacedOn.slice(0, 7)
        : `Unknown (last ${CLAIM_RULES.defaultLookbackYearsIfRoofUnknown} years)`;
  const quality = rec.roofQuality || {};
  const prepared = state.lead?.name || state.lead?.email || "Homeowner";
  const tone = rec.talkToRoofer ? "roofer" : rec.considerClaim ? "review" : "ok";
  const allCovering = state.storms || [];
  const windowSummaries = hailWindowSummaries(allCovering, {
    loadedYears: state.years,
    windows: [2, 5, 10],
  });
  const inReview = allCovering.filter((s) => {
    const d = String(s?.date || "");
    return d >= rec.windowStart && d <= rec.windowEnd;
  });
  const earlierHistory = allCovering.filter((s) => String(s?.date || "") < rec.windowStart);
  const extreme = rankedStorms(inReview, "intense").slice(0, REPORT_LIST_N);
  const recent = rankedStorms(inReview, "recent").slice(0, REPORT_LIST_N);
  const historyExtreme = rankedStorms(earlierHistory, "intense").slice(0, REPORT_LIST_N);
  const yearsLabel = `${state.years} year${state.years === 1 ? "" : "s"}`;
  const reviewBlurb = `Recommendation review period: ${rec.windowStart} → ${rec.windowEnd} (${inReview.length} covering date${inReview.length === 1 ? "" : "s"}).`;

  return `<header class="hg-doc-top">
      <div class="hg-logo" aria-label="${escHtml(b.company)}">
        <span class="hg-logo-high">High</span>
        <span class="hg-logo-ground">Ground</span>
        <span class="hg-logo-rule" aria-hidden="true"></span>
        <span class="hg-logo-sub">${escHtml(b.tagline)}</span>
      </div>
      <div class="hg-doc-mark">
        <span class="hg-doc-kicker">HomeScope</span>
        <span class="hg-doc-title">Hail Report</span>
      </div>
    </header>

    <p class="hg-doc-lede">Clear storm history for your Oklahoma roof — from public NOAA / SPC / IEM records.</p>

    <section class="hg-card hg-property">
      <h2 class="hg-section-label">Property</h2>
      <p class="hg-addr">${escHtml(state.address)}</p>
      <dl class="hg-meta-grid">
        <div><dt>Prepared for</dt><dd>${escHtml(prepared)}</dd></div>
        <div><dt>Roof age</dt><dd>${escHtml(roofLabel)}</dd></div>
        <div><dt>Roof estimate</dt><dd>${escHtml(quality.label || "—")}</dd></div>
        <div><dt>History loaded</dt><dd>${escHtml(String(state.years))} years · ≥ ${escHtml(String(state.minHailIn))}″ · ${allCovering.length} covering</dd></div>
        <div><dt>Review period</dt><dd>${escHtml(rec.windowStart)} → ${escHtml(rec.windowEnd)} · ${inReview.length} covering</dd></div>
        <div><dt>Generated</dt><dd>${escHtml(new Date().toLocaleString())}</dd></div>
        <div><dt>Sources</dt><dd>NOAA SWDI · SPC · IEM LSR</dd></div>
      </dl>
      ${quality.detail ? `<p class="hg-roof-quality">${escHtml(quality.detail)}</p>` : ""}
    </section>

    <section class="hg-card">
      <div class="hg-section-head">
        <h2 class="hg-section-label">Hail summary</h2>
        <span class="hg-count">2 · 5 · 10 years</span>
      </div>
      <p class="hg-storm-blurb">Covering dates at this pin (near-roof or zone) for the common lookbacks — same filter as the list (≥ ${escHtml(String(state.minHailIn))}″).</p>
      <div class="hg-hail-windows">${hailSummaryRowsHtml(windowSummaries, state.minHailIn)}</div>
    </section>

    <section class="hg-verdict hg-verdict-${tone}">
      <p class="hg-section-label">Recommendation</p>
      <h3 class="hg-verdict-title">${escHtml(rec.headline)}</h3>
      <p class="hg-verdict-body">${escHtml(rec.reason)}</p>
      <div class="hg-cta-row">
        <a class="hg-cta-primary" href="${escHtml(b.ctaUrl)}" target="_blank" rel="noopener">${escHtml(b.cta)}</a>
        <a class="hg-cta-call" href="tel:${escHtml(b.phoneTel)}">Call ${escHtml(b.phone)}</a>
      </div>
      ${rec.secondaryCta ? `<p class="hg-secondary-cta">${escHtml(rec.secondaryCta)} — High Ground can walk you through next steps.</p>` : ""}
    </section>

    <section class="hg-card">
      <div class="hg-section-head">
        <h2 class="hg-section-label">Storms in review period</h2>
        <span class="hg-count">${inReview.length} verified</span>
      </div>
      <p class="hg-storm-blurb">${escHtml(reviewBlurb)} Highlights below use that same window (≥ ${escHtml(String(state.minHailIn))}″, near-roof or zone cover).</p>
      <h3 class="hg-storm-group">Top ${REPORT_LIST_N} most extreme</h3>
      <ul class="hg-storm-list">${reportStormRowsHtml(extreme, "Extreme")}</ul>
      <h3 class="hg-storm-group">Top ${REPORT_LIST_N} most recent</h3>
      <ul class="hg-storm-list">${reportStormRowsHtml(recent, "Recent")}</ul>
    </section>

    ${
      historyExtreme.length
        ? `<section class="hg-card">
      <div class="hg-section-head">
        <h2 class="hg-section-label">Earlier history (${escHtml(yearsLabel)} lookback)</h2>
        <span class="hg-count">${earlierHistory.length} before review window</span>
      </div>
      <p class="hg-storm-blurb">Loaded for context — not used in the recommendation above.</p>
      <h3 class="hg-storm-group">Top ${REPORT_LIST_N} most extreme (earlier)</h3>
      <ul class="hg-storm-list">${reportStormRowsHtml(historyExtreme, "History")}</ul>
    </section>`
        : ""
    }

    <section class="hg-card hg-trust">
      <h2 class="hg-section-label">About High Ground</h2>
      <p>Oklahoma weather is hard on roofs. High Ground uses drone and AI documentation for clear, honest inspections — family-run, serving Edmond and surrounding communities.</p>
      <p class="hg-trust-line">Honesty over scare tactics · Free inspections</p>
    </section>

    <footer class="hg-doc-foot">
      <div>
        <strong>${escHtml(b.company)} Roofing &amp; Construction</strong><br/>
        <a href="${escHtml(b.web)}" target="_blank" rel="noopener">${escHtml(b.webLabel)}</a>
        · <a href="tel:${escHtml(b.phoneTel)}">${escHtml(b.phone)}</a><br/>
        <span>${escHtml(b.address)}</span>
      </div>
      <p class="hg-disclaimer">${escHtml(PRODUCT.disclaimer)}</p>
    </footer>`;
}

async function generateReport({ emailViaCrm = true } = {}) {
  syncRoofFromGate();
  const statusEl = $("#storm-status") || $("#share-status");
  const btn = $("#make-report");
  const prevBtn = btn?.textContent || "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Deep searching hail…";
  }
  setStatus(statusEl, "Deep searching hail for your report (spotter archive + NOAA radar)…");

  try {
    if (Number.isFinite(state.lat) && Number.isFinite(state.lon)) {
      const reportYears = Math.max(Number(state.years) || 10, CLAIM_RULES.maxHistoryYears || 10);
      const deep = await deepenHomeHailForReport(state.lat, state.lon, {
        address: state.address,
        years: reportYears,
        minHailIn: state.minHailIn,
        onPartial: (result) => {
          // Keep the on-screen list on the homeowner's selected years while cache deepens to 10y.
          const filtered = filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn });
          applyStormResult(
            { ...filtered, loading: Boolean(result.loading), note: result.note },
            { loading: Boolean(result.loading), reseatSelection: false, skipMap: true },
          );
          if (result.note) setStatus(statusEl, result.note);
        },
      });
      // List stays on selected years; report uses full 10y pack from cache.
      applyStormResult(
        filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn }),
        { loading: false, reseatSelection: false, skipMap: true },
      );
      const reportStorms =
        filterCachedHomeStorms({ years: reportYears, minHailIn: state.minHailIn }).storms || deep.storms || [];

      const reportDays = rankedStorms(reportStorms, "intense")
        .map((s) => s.date)
        .slice(0, 30);
      for (const d of reportDays) {
        const n = (getHomeHailCache().hail || []).filter(
          (h) => String(h?.date || "").slice(0, 10) === d && isSwdiHail(h),
        ).length;
        if (n < SWDI_DAY_MIN) swdiEnrichedDays.delete(d);
      }
      if (reportDays.length) {
        setStatus(statusEl, `Pulling statewide radar swaths for ${reportDays.length} storm date(s)…`);
        const grew = await ensureStatewideSwdiForDays(reportDays);
        if (grew) {
          refreshStormListFromCache();
        }
      }

      const finalReportStorms =
        filterCachedHomeStorms({ years: reportYears, minHailIn: state.minHailIn }).storms || reportStorms;

      const rec = homescopeRecommendation({
        storms: finalReportStorms,
        roofReplacedOn: state.roofReplacedOn,
      });
      state.lastRec = rec;
      const listStorms = state.storms;
      const prevYears = state.years;
      state.storms = finalReportStorms;
      state.years = reportYears;
      state.reportText = buildReportText(rec);
      const doc = $("#hg-doc");
      if (doc) doc.innerHTML = renderReportDocument(rec);
      state.years = prevYears;
      state.storms = filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn }).storms || listStorms;
      paintStormList({ loading: false, skipMap: true });

      setStep("report");
      closeReportGate();

      const html = reportHtmlDoc();
      if (emailViaCrm && state.lead?.email) {
        const email = buildCrmEmailPackage({
          lead: {
            ...state.lead,
            roofLabel: state.roofAgeLabel,
            address: state.address,
          },
          reportHtml: html,
          reportText: state.reportText,
          rec,
        });
        const crmResult = await submitHomescopeLeadToCrm({
          type: "homescope_report_lead",
          action: "create_contact_and_email_report",
          lead: {
            ...state.lead,
            lat: state.lat,
            lon: state.lon,
            address: state.address,
            roofMode: state.roofMode,
            roofReplacedOn: state.roofReplacedOn,
            roofAgeLabel: state.roofAgeLabel,
            years: reportYears,
            minHailIn: state.minHailIn,
          },
          recommendation: {
            headline: rec.headline,
            reason: rec.reason,
            considerClaim: rec.considerClaim,
            talkToRoofer: rec.talkToRoofer,
            roofQuality: rec.roofQuality,
            windowStart: rec.windowStart,
            windowEnd: rec.windowEnd,
          },
          storms: finalReportStorms.map((s) => ({
            date: s.date,
            maxSizeIn: s.maxSizeIn,
            sources: s.sources,
            coversNear: s.coversNear,
            coversPolygon: s.coversPolygon,
          })),
          email,
        });
        if (state.lead) {
          state.lead.crm = crmResult.status;
          state.lead.crmAt = new Date().toISOString();
          saveLead(state.lead);
        }
        setStatus(
          $("#share-status"),
          crmResult.status === "sent"
            ? `Report emailed to ${state.lead.email} via High Ground CRM`
            : `Report ready — High Ground CRM will email ${state.lead.email}`,
        );
      } else {
        setStatus($("#share-status"), "Report ready — deep hail search complete");
      }

      requestAnimationFrame(() => doc?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
      return;
    }
  } catch (err) {
    console.warn("[HomeScope] report deep search", err);
    setStatus(statusEl, "Deep search hit a snag — building report with what we have.", true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevBtn || "Get free hail report";
    }
  }

  // Fallback if pin missing / deep path returned early.
  const rec = homescopeRecommendation({
    storms: state.storms,
    roofReplacedOn: state.roofReplacedOn,
  });
  state.lastRec = rec;
  state.reportText = buildReportText(rec);
  const doc = $("#hg-doc");
  if (doc) doc.innerHTML = renderReportDocument(rec);
  setStep("report");
  closeReportGate();
  requestAnimationFrame(() => doc?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
}

function downloadBlob(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function reportHtmlDoc() {
  const inner = $("#hg-doc")?.innerHTML || "";
  const b = PRODUCT.brand;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(b.company)} · HomeScope Hail Report</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  :root{--bg:#0b0b0d;--panel:#141416;--inset:#1c1c1e;--line:rgba(255,204,0,.22);--phos:#ffcc00;--text:#f5f5f7;--muted:#8e8e93}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Outfit,system-ui,sans-serif}
  .hg-doc{max-width:720px;margin:0 auto;padding:1.5rem 1.1rem 2.5rem}
  .hg-logo{display:flex;flex-direction:column;align-items:flex-start;line-height:1}
  .hg-logo-high,.hg-logo-ground{font-family:Cormorant Garamond,Georgia,serif;font-weight:700;font-size:1.85rem;letter-spacing:.04em;text-transform:uppercase}
  .hg-logo-rule{display:block;width:100%;height:2px;background:var(--phos);margin:.35rem 0 .3rem}
  .hg-logo-sub{font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;color:var(--phos);font-weight:600}
  .hg-doc-top{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:1.1rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
  .hg-doc-kicker{display:block;font-size:.65rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
  .hg-doc-title{font-size:1.35rem;font-weight:700;letter-spacing:-.02em}
  .hg-doc-lede{color:var(--phos);font-size:1.05rem;font-weight:600;margin:0 0 1.25rem}
  .hg-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1rem 1.05rem;margin:0 0 1rem}
  .hg-section-label{margin:0 0 .45rem;font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600}
  .hg-addr{margin:0 0 .75rem;font-size:1.15rem;font-weight:650;letter-spacing:-.02em}
  .hg-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:.65rem .85rem;margin:0}
  .hg-meta-grid dt{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .hg-meta-grid dd{margin:.15rem 0 0;font-size:.92rem}
  .hg-roof-quality{margin:.85rem 0 0;color:var(--muted);font-size:.9rem}
  .hg-verdict{border-radius:14px;padding:1.15rem 1.1rem;margin:0 0 1rem;border:1px solid var(--line);background:linear-gradient(160deg,rgba(255,204,0,.12),rgba(20,20,22,.95))}
  .hg-verdict-title{margin:.2rem 0 .45rem;font-size:1.35rem;letter-spacing:-.02em;line-height:1.2}
  .hg-verdict-body{margin:0 0 .9rem;color:var(--muted);font-size:.95rem}
  .hg-cta-row{display:flex;flex-wrap:wrap;gap:.5rem}
  .hg-cta-primary{display:inline-block;background:var(--phos);color:#1c1400;font-weight:700;text-decoration:none;padding:.75rem 1.1rem;border-radius:10px;letter-spacing:.02em}
  .hg-cta-call{display:inline-block;border:1px solid rgba(255,255,255,.35);color:var(--text);text-decoration:none;padding:.75rem 1rem;border-radius:10px;font-weight:600}
  .hg-secondary-cta{margin:.75rem 0 0;font-size:.9rem;color:var(--phos)}
  .hg-section-head{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}
  .hg-count{font-size:.75rem;color:var(--muted)}
  .hg-storm-blurb{margin:.35rem 0 0;font-size:.85rem;color:var(--muted);line-height:1.4}
  .hg-storm-group{margin:1rem 0 .35rem;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--phos);font-weight:650}
  .hg-storm-list{list-style:none;margin:.45rem 0 0;padding:0;display:flex;flex-direction:column;gap:.4rem}
  .hg-storm{display:grid;grid-template-columns:auto 1fr auto;gap:.55rem .75rem;align-items:center;padding:.65rem .75rem;background:var(--inset);border-radius:12px;border:1px solid transparent}
  .hg-storm.on{border-color:rgba(255,204,0,.35)}
  .hg-storm-size{font-weight:700;color:var(--phos);font-variant-numeric:tabular-nums;font-size:1.05rem}
  .hg-storm-size span{font-size:.8rem}
  .hg-storm-body strong{display:block;font-size:.95rem}
  .hg-storm-meta{display:block;font-size:.78rem;color:var(--muted);margin-top:.1rem}
  .hg-storm-flag{font-size:.7rem;color:var(--phos)}
  .hg-trust p{margin:0 0 .5rem;color:var(--muted);font-size:.92rem}
  .hg-trust-line{color:var(--phos)!important;font-weight:600;font-size:.85rem!important}
  .hg-doc-foot{margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.85rem;color:var(--muted)}
  .hg-doc-foot a{color:var(--phos)}
  .hg-disclaimer{margin:.85rem 0 0;font-size:.72rem;line-height:1.4;opacity:.85}
  @media print{body{background:#0b0b0d;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head><body><article class="hg-doc">${inner}</article></body></html>`;
}

function shareableLink() {
  const payload = {
    v: 1,
    a: state.address,
    lat: state.lat,
    lon: state.lon,
    roof: state.roofReplacedOn,
    years: state.years,
    min: state.minHailIn,
    storms: state.storms.map((s) => ({
      d: s.date,
      sz: s.maxSizeIn,
      src: s.sources,
      n: s.coversNear,
      p: s.coversPolygon,
    })),
    headline: state.lastRec?.headline,
  };
  const hash = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return `${location.origin}${location.pathname}#r=${hash}`;
}

function bindChips(rootSel, attr, onPick) {
  const root = $(rootSel);
  if (!root) return;
  root.addEventListener("click", (e) => {
    const btn = e.target.closest(`[data-${attr}]`);
    if (!btn) return;
    $$(`[data-${attr}]`, root).forEach((b) => b.classList.toggle("on", b === btn));
    onPick(btn.getAttribute(`data-${attr}`));
  });
}

function boot() {
  $("#ho-brand").textContent = PRODUCT.name;
  document.title = `${PRODUCT.brand.company} · ${PRODUCT.name}`;
  if ($("#ho-ver") && !$("#ho-ver").textContent) $("#ho-ver").textContent = `v${APP_VERSION}`;
  const gateDisc = $("#ho-disclaimer-gate");
  if (gateDisc) gateDisc.textContent = PRODUCT.disclaimer;

  const existing = readLead();
  if (existing?.email) {
    state.lead = existing;
    if (existing.roofMode) {
      state.roofMode = existing.roofMode;
      state.roofReplacedOn = existing.roofReplacedOn || null;
      state.roofAgeLabel = existing.roofAgeLabel || state.roofAgeLabel;
    }
  }

  bindChips("#gate-roof-mode", "roof", (mode) => {
    paintGateRoofMode(mode);
  });
  $("#gate-roof-year")?.addEventListener("input", () => syncRoofFromGate());

  $("#gate-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#gate-name")?.value?.trim() || "";
    const email = $("#gate-email")?.value?.trim() || "";
    const phone = $("#gate-phone")?.value?.trim() || "";
    if (!syncRoofFromGate() && state.roofMode === "year") {
      setStatus($("#gate-status"), "Enter the year your roof was last replaced", true);
      $("#gate-roof-year")?.focus?.();
      return;
    }
    if (!name) {
      setStatus($("#gate-status"), "Enter your name", true);
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus($("#gate-status"), "Enter a valid email", true);
      return;
    }
    if (!phone || phone.replace(/\D/g, "").length < 10) {
      setStatus($("#gate-status"), "Enter a phone number", true);
      return;
    }
    const lead = {
      name,
      email,
      phone,
      capturedAt: new Date().toISOString(),
      source: "homescope_report_gate",
      crm: "pending",
      address: state.address,
      lat: state.lat,
      lon: state.lon,
      roofCaptured: true,
      roofMode: state.roofMode,
      roofReplacedOn: state.roofReplacedOn,
      roofAgeLabel: state.roofAgeLabel,
      roofYear: state.roofMode === "year" ? Number($("#gate-roof-year")?.value) || null : null,
      emailReport: true,
    };
    saveLead(lead);
    state.lead = lead;
    setStatus($("#gate-status"), "Building your report and queuing CRM email…");
    await generateReport({ emailViaCrm: true });
  });
  $("#gate-scrim")?.addEventListener("click", closeReportGate);

  $("#addr-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submitAddressSearch();
  });
  $("#addr-locate")?.addEventListener("click", () => useMyLocation());

  $("#addr-q")?.addEventListener("input", (e) => {
    scheduleSuggest(e.target.value);
  });
  $("#addr-q")?.addEventListener("focus", (e) => {
    const q = String(e.target.value || "").trim();
    if (q.length >= 3 && !state.suggestHits.length) scheduleSuggest(q);
  });
  $("#addr-q")?.addEventListener("keydown", (e) => {
    if (!state.suggestHits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightSuggest(Math.min(state.suggestHits.length - 1, state.suggestIdx + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightSuggest(Math.max(0, state.suggestIdx - 1));
    } else if (e.key === "Enter" && state.suggestIdx >= 0) {
      e.preventDefault();
      void submitAddressSearch({ hit: state.suggestHits[state.suggestIdx] });
    } else if (e.key === "Escape") {
      clearSuggestions();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#addr-form")) return;
    clearSuggestions();
  });

  bindChips("#filter-years", "years", (v) => {
    state.years = Number(v) || 10;
    if (Number.isFinite(state.lat)) applyFiltersFromChips({ reseatSelection: true });
  });
  bindChips("#filter-hail", "hail", (v) => {
    state.minHailIn = Number(v) || 0.5;
    if (Number.isFinite(state.lat)) applyFiltersFromChips({ reseatSelection: true });
  });
  bindChips("#filter-sort", "sort", (v) => {
    state.stormSort = v === "recent" ? "recent" : "intense";
    if (!state.storms.length) return;
    state.mapFocusDate = null;
    applyStormResult(
      { storms: state.storms, hailRowCount: getHomeHailCache().hail?.length || 0, loading: false, note: null },
      { loading: false, reseatSelection: true },
    );
  });

  $("#storm-more")?.addEventListener("click", () => {
    const total = rankedStorms().length;
    if (!total) return;
    state.listLimit = Math.min(total, (state.listLimit || LIST_PAGE) + LIST_PAGE);
    paintStormList();
    // Keep the new rows in view on phone without jumping the whole page.
    requestAnimationFrame(() => {
      const wrap = $("#storm-more-wrap");
      wrap?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    });
  });

  // Progressive list updates as the pin cache grows — always paint the latest snapshot.
  let hailUiFlush = 0;
  let hailUiDirty = false;
  onHomeHailCache(() => {
    if (!Number.isFinite(state.lat)) return;
    const cache = getHomeHailCache();
    if (!cache.key) return;
    const key = `${Number(state.lat).toFixed(4)}|${Number(state.lon).toFixed(4)}`;
    if (cache.key !== key) return;
    hailUiDirty = true;
    if (hailUiFlush) return;
    const flush = () => {
      hailUiFlush = 0;
      if (!hailUiDirty) return;
      hailUiDirty = false;
      const c = getHomeHailCache();
      if (!c.hail?.length && !c.loadingDeep) return;
      const result = filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn });
      const loading = Boolean(result.loading || c.loadingDeep);
      applyStormResult(result, {
        loading,
        reseatSelection: state.overlayCollection,
        skipMap: loading,
      });
      if (hailUiDirty) hailUiFlush = requestAnimationFrame(flush);
    };
    hailUiFlush = requestAnimationFrame(flush);
  });

  $("#make-report")?.addEventListener("click", () => {
    if (!state.storms.length && !getHomeHailCache().hail?.length) {
      setStatus($("#storm-status"), "Load hail for an address first", true);
      return;
    }
    if (leadReadyForReport(state.lead)) {
      if (state.lead.roofMode) {
        state.roofMode = state.lead.roofMode;
        state.roofReplacedOn = state.lead.roofReplacedOn || null;
        state.roofAgeLabel = state.lead.roofAgeLabel || state.roofAgeLabel;
      }
      void generateReport({ emailViaCrm: true });
      return;
    }
    openReportGate();
  });
  $("#print-report")?.addEventListener("click", () => window.print());
  $("#dl-html")?.addEventListener("click", () => {
    downloadBlob("highground-homescope-hail-report.html", "text/html;charset=utf-8", reportHtmlDoc());
  });
  $("#share-report")?.addEventListener("click", async () => {
    const url = shareableLink();
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${PRODUCT.name} hail report`,
          text: state.lastRec?.headline || PRODUCT.name,
          url,
        });
        setStatus($("#share-status"), "Shared");
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus($("#share-status"), "Share link copied to clipboard");
    } catch {
      setStatus($("#share-status"), url);
    }
  });

  setStep("address");
  const refreshMapSize = () => {
    try {
      state.map?.invalidateSize?.({ animate: false });
    } catch {
      /* ignore */
    }
  };
  requestAnimationFrame(refreshMapSize);
  window.addEventListener("orientationchange", () => setTimeout(refreshMapSize, 280));
  window.addEventListener("resize", refreshMapSize);
  window.visualViewport?.addEventListener?.("resize", refreshMapSize);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") setTimeout(refreshMapSize, 120);
  });
}

boot();
