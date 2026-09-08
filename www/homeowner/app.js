/**
 * HomeScope — Oklahoma homeowner hail report (isolated from Ground Control field UX).
 */
import { APP_VERSION } from "../version.js";
import { geocodeCandidates, biasAddressQuery, inOklahoma, suggestOklahomaAddresses, resolveAddressSuggestion } from "../geocode.js";
import { PRODUCT, CLAIM_RULES, homescopeRecommendation } from "./product.js";
import {
  buildHailTraceDayBands,
  hailRadarBandColor,
  hailMeshBandOpacity,
  reverseGeocode,
} from "../wx.js";
import { buildCrmEmailPackage, submitHomescopeLeadToCrm } from "./crm.js";
import { loadHomeStorms, filterCachedHomeStorms, clearHomeHailCache, getHomeHailCache, onHomeHailCache } from "./hail-load.js";

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
  minHailIn: 1,
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
  $("#gate-name")?.focus?.();
}

function closeReportGate() {
  const gate = $("#report-gate");
  if (gate) gate.hidden = true;
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
      if (step === "storms") paintOverlays();
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
  }).setView([35.4676, -97.5164], 11);
  // Same Google tiles as field HailScope — Carto dark tiles now require an API key.
  window.L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&hl=en&scale=2&x={x}&y={y}&z={z}", {
    attribution: "&copy; Google",
    maxZoom: 21,
    maxNativeZoom: 21,
    subdomains: "0123",
  }).addTo(state.map);
  window.L.control.zoom({ position: "bottomright" }).addTo(state.map);
  state.hailSvg = window.L.svg({ padding: 0.85 });
  state.overlay = window.L.layerGroup().addTo(state.map);
  state.map.on("click", (e) => {
    void selectHomeFromMap(e.latlng.lat, e.latlng.lng, { zoom: false });
  });
  return state.map;
}

function pinHome(lat, lon, { fly = false, zoom = null } = {}) {
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
    if (fly) map.flyTo([lat, lon], zoom, { duration: 0.85 });
    else map.setView([lat, lon], zoom);
  }
  requestAnimationFrame(() => map.invalidateSize());
}

/** Map tap or GPS — reverse-geocode, then same search path as the Search button. */
let mapPickGen = 0;
async function selectHomeFromMap(lat, lon, { zoom = true, fly = false, zoomLevel = 18 } = {}) {
  const status = $("#addr-status");
  const go = $("#addr-go");
  const locateBtn = $("#addr-locate");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const gen = ++mapPickGen;
  if (!inOklahoma({ lat, lon })) {
    setStatus(status, "HomeScope is Oklahoma-only — pick a home in OK", true);
    pinHome(lat, lon, { zoom: zoom ? Math.min(zoomLevel, 12) : null, fly });
    return;
  }
  if (go) go.disabled = true;
  if (locateBtn) locateBtn.disabled = true;
  setStatus(status, "Finding address for that pin…");
  pinHome(lat, lon, { zoom: zoom ? zoomLevel : null, fly });
  try {
    const geo = await reverseGeocode(lat, lon);
    if (gen !== mapPickGen) return;
    const label =
      hitLabel(geo) ||
      (geo?.ok && geo.address) ||
      `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const hit = {
      lat: Number(geo?.lat) || lat,
      lon: Number(geo?.lon) || lon,
      address: label,
      label,
    };
    if (!inOklahoma(hit) && !inOklahoma({ lat: hit.lat, lon: hit.lon })) {
      setStatus(status, "HomeScope is Oklahoma-only — pick a home in OK", true);
      return;
    }
    await selectAddressHit(hit, { force: true });
  } catch (err) {
    if (gen !== mapPickGen) return;
    setStatus(status, err?.message || "Couldn’t read that map pin", true);
  } finally {
    if (gen === mapPickGen) {
      if (go) go.disabled = false;
      if (locateBtn) locateBtn.disabled = false;
    }
  }
}

function useMyLocation() {
  const status = $("#addr-status");
  const locateBtn = $("#addr-locate");
  if (!navigator.geolocation) {
    setStatus(status, "Location isn’t available in this browser — search or tap the map", true);
    return;
  }
  if (locateBtn) locateBtn.disabled = true;
  setStatus(status, "Asking for your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = Number(pos?.coords?.latitude);
      const lon = Number(pos?.coords?.longitude);
      void selectHomeFromMap(lat, lon, { zoom: true, fly: true, zoomLevel: 18 });
    },
    (err) => {
      if (locateBtn) locateBtn.disabled = false;
      const denied = err?.code === 1;
      setStatus(
        status,
        denied
          ? "Location blocked — allow GPS for this site, or search / tap the map"
          : "Couldn’t get GPS — try again, search, or tap the map",
        true,
      );
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30_000 },
  );
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
  paintStormList();
}

function paintOverlays() {
  if (!state.overlay || !window.L) return;
  state.overlay.clearLayers();
  if (state.map && !state.hailSvg) state.hailSvg = window.L.svg({ padding: 0.85 });
  const homeLat = state.lat;
  const homeLon = state.lon;
  const bounds = [];
  if (Number.isFinite(homeLat) && Number.isFinite(homeLon)) bounds.push([homeLat, homeLon]);

  const ranked = rankedStorms();
  let days = [...state.selected].filter((d) => ranked.some((s) => s.date === d));
  if (!days.length && ranked[0]) {
    days = [ranked[0].date];
    state.selected = new Set(days);
    state.mapFocusDate = days[0];
  }
  if (!days.length) {
    if (Number.isFinite(homeLat) && state.map) state.map.setView([homeLat, homeLon], 14);
    return;
  }
  // Oldest first so newer / focused swaths paint on top.
  days.sort((a, b) => a.localeCompare(b));
  if (!state.mapFocusDate || !days.includes(state.mapFocusDate)) {
    state.mapFocusDate = days[days.length - 1];
  }

  const dayPool = getHomeHailCache().hail || [];
  let needHatch = false;

  for (const day of days) {
    const dayRows = dayPool.filter((p) => String(p?.date || "").slice(0, 10) === day);
    let bands = [];
    try {
      bands = buildHailTraceDayBands(day, dayRows) || [];
    } catch (err) {
      console.warn("[HomeScope] HailTrace bands failed", day, err);
      bands = [];
    }

    const focused = day === state.mapFocusDate;
    const multi = days.length > 1;
    for (const band of bands) {
      if (!band?.ring?.length) continue;
      const sz = Number(band.maxSize) || 1;
      const col = hailRadarBandColor(sz);
      const isolated = Boolean(band.isolated);
      if (isolated) needHatch = true;
      const fillOp = isolated
        ? 0.72
        : hailMeshBandOpacity(sz) * (multi && !focused ? 0.72 : 1);
      const latLngs = [band.ring, ...(band.holes || [])];
      window.L.polygon(latLngs, {
        color: col.stroke,
        weight: isolated ? 0.9 : focused ? 0.75 : 0.55,
        fillColor: isolated ? "url(#gc-hail-hatch)" : col.fill,
        fillOpacity: fillOp,
        opacity: isolated ? 0.65 : focused ? 0.5 : 0.35,
        stroke: true,
        smoothFactor: 1.8,
        renderer: state.hailSvg || undefined,
        className: isolated ? "wx-hail-topo wx-hail-isolated" : "wx-hail-topo",
      }).addTo(state.overlay);
      for (const ll of band.ring) {
        if (Number.isFinite(ll[0]) && Number.isFinite(ll[1])) bounds.push(ll);
      }
    }
  }

  if (needHatch && state.hailSvg?._container) ensureHomeHailHatch(state.hailSvg._container);

  if (state.map && bounds.length >= 2) {
    try {
      state.map.fitBounds(bounds, { padding: [48, 48], maxZoom: 13 });
    } catch {
      if (Number.isFinite(homeLat)) state.map.setView([homeLat, homeLon], 12);
    }
  } else if (Number.isFinite(homeLat) && state.map) {
    state.map.setView([homeLat, homeLon], 13);
  }
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

function paintStormList({ loading = false } = {}) {
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
      : `<span class="sz">—</span><span>No storms with verified cover yet<br/><span class="meta">Near-roof (≤2.5 km) or HailTrace zone over this pin</span></span><span></span>`;
    list.appendChild(li);
    if (btn) btn.disabled = true;
    paintOverlays();
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
    const how = [s.coversNear ? "near roof" : null, s.coversPolygon ? "zone over home" : null]
      .filter(Boolean)
      .join(" · ");
    li.innerHTML = `<span class="sz" style="color:${col.fill}">${Number(s.maxSizeIn).toFixed(2)}″</span>
      <span>${s.pretty || s.date}<br/><span class="meta">${s.sources} · ${how || "verified cover"} · nearest ${Number(s.minDist).toFixed(1)} km</span></span>
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
  paintOverlays();
}

function applyStormResult(result, { loading = false, reseatSelection = true } = {}) {
  state.storms = result.storms || [];
  if (reseatSelection) {
    state.listLimit = LIST_PAGE;
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
  paintStormList({ loading: loading || Boolean(result.loading) });
  ensureMap();
  if (Number.isFinite(state.lat)) pinHome(state.lat, state.lon);
  paintOverlays();
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
  const still = loading || result.loading;
  const overlayN = state.selected.size;
  const mapLabel = state.overlayCollection
    ? `${overlayN} dates overlaid (tap one to solo · tap others to add)`
    : overlayN > 1
      ? `${overlayN} dates overlaid · last: ${focus || "—"}`
      : `map: ${focus || "—"}`;
  setStatus(
    status,
    still
      ? `Loading… ${state.storms.length} covering date(s) so far · ${result.hailRowCount || 0} reports.${note}`
      : state.storms.length
        ? `${state.storms.length} verified covering · ${mapLabel} (${sortLabel}) · NOAA SWDI / SPC / IEM.${note}`
        : `No storms ≥${state.minHailIn}″ with verified cover in ~${state.years} years.${note}`,
  );
}

async function refreshStorms({ force = false } = {}) {
  if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)) return;
  const status = $("#storm-status");
  const gen = ++refreshStorms._gen;
  setStatus(status, `Loading ~${state.years}y of hail (≥${state.minHailIn}″)…`);
  $("#make-report").disabled = true;

  const applyIfCurrent = (result, opts) => {
    if (gen !== refreshStorms._gen) return;
    applyStormResult(result, opts);
  };

  const cache = getHomeHailCache();
  const needDays = Math.min(Math.max(Math.round(state.years * 365.25), 30), 3650);
  const canFilterOnly =
    !force &&
    cache.key &&
    cache.hail?.length &&
    (cache.fetchedDays || 0) >= Math.min(needDays, 730);

  if (canFilterOnly && needDays <= (cache.fetchedDays || 0) && !cache.loadingDeep) {
    applyIfCurrent(filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn }), {
      loading: false,
      reseatSelection: true,
    });
    return;
  }

  if (canFilterOnly) {
    applyIfCurrent(filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn }), {
      loading: true,
      reseatSelection: true,
    });
  } else {
    state.storms = [];
    state.mapFocusDate = null;
    paintStormList({ loading: true });
  }

  try {
    const result = await loadHomeStorms(state.lat, state.lon, {
      address: state.address,
      years: state.years,
      minHailIn: state.minHailIn,
      force,
      onPartial: (part) =>
        applyIfCurrent(part, {
          loading: Boolean(part.loading),
          reseatSelection: state.overlayCollection,
        }),
    });
    applyIfCurrent(result, {
      loading: Boolean(result.loading),
      reseatSelection: state.overlayCollection,
    });
  } catch (err) {
    if (gen !== refreshStorms._gen) return;
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
  const extreme = rankedStorms(state.storms, "intense").slice(0, REPORT_LIST_N);
  const recent = rankedStorms(state.storms, "recent").slice(0, REPORT_LIST_N);
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
    `History window: ${state.years} years · ≥ ${state.minHailIn}″ · ${state.storms.length} verified covering date(s)`,
    "",
    `Top ${REPORT_LIST_N} most extreme:`,
  ].filter((x) => x !== "");
  if (extreme.length) {
    for (const s of extreme) {
      lines.push(`• ${s.pretty || s.date} — ${Number(s.maxSizeIn).toFixed(2)}″ — ${s.sources}`);
    }
  } else {
    lines.push("• None in the selected filters");
  }
  lines.push("", `Top ${REPORT_LIST_N} most recent:`);
  if (recent.length) {
    for (const s of recent) {
      lines.push(`• ${s.pretty || s.date} — ${Number(s.maxSizeIn).toFixed(2)}″ — ${s.sources}`);
    }
  } else {
    lines.push("• None in the selected filters");
  }
  lines.push("", PRODUCT.disclaimer);
  return lines.join("\n");
}

function reportStormRowsHtml(storms, flag) {
  if (!storms.length) {
    return `<li class="hg-storm empty"><div class="hg-storm-body"><strong>No verified covering storms in this filter</strong>
        <span class="hg-storm-meta">Listed only when near-roof (≤2.5 km) or a zone polygon covers this pin.</span></div></li>`;
  }
  return storms
    .map((s, idx) => {
      const cover = [s.coversNear ? "Near roof" : null, s.coversPolygon ? "Zone over home" : null]
        .filter(Boolean)
        .join(" · ");
      return `<li class="hg-storm">
            <div class="hg-storm-size">${escHtml(Number(s.maxSizeIn).toFixed(2))}<span>″</span></div>
            <div class="hg-storm-body">
              <strong>${escHtml(s.pretty || s.date)}</strong>
              <span class="hg-storm-meta">${escHtml(s.sources)}${cover ? " · " + escHtml(cover) : ""} · ${escHtml(Number(s.minDist).toFixed(1))} km</span>
            </div>
            <div class="hg-storm-flag">${escHtml(flag || "#" + (idx + 1))}</div>
          </li>`;
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
  const tone = rec.considerClaim ? "claim" : rec.talkToRoofer ? "roofer" : "ok";
  const allCovering = state.storms || [];
  const extreme = rankedStorms(allCovering, "intense").slice(0, REPORT_LIST_N);
  const recent = rankedStorms(allCovering, "recent").slice(0, REPORT_LIST_N);
  const yearsLabel = `${state.years} year${state.years === 1 ? "" : "s"}`;

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

    <p class="hg-doc-lede">Stronger proof for claims. Clear storm history for your Oklahoma roof.</p>

    <section class="hg-card hg-property">
      <h2 class="hg-section-label">Property</h2>
      <p class="hg-addr">${escHtml(state.address)}</p>
      <dl class="hg-meta-grid">
        <div><dt>Prepared for</dt><dd>${escHtml(prepared)}</dd></div>
        <div><dt>Roof age</dt><dd>${escHtml(roofLabel)}</dd></div>
        <div><dt>Roof estimate</dt><dd>${escHtml(quality.label || "—")}</dd></div>
        <div><dt>History window</dt><dd>${escHtml(String(state.years))} years · ≥ ${escHtml(String(state.minHailIn))}″</dd></div>
        <div><dt>Review period</dt><dd>${escHtml(rec.windowStart)} → ${escHtml(rec.windowEnd)}</dd></div>
        <div><dt>Generated</dt><dd>${escHtml(new Date().toLocaleString())}</dd></div>
        <div><dt>Sources</dt><dd>NOAA SWDI · SPC · IEM LSR</dd></div>
      </dl>
      ${quality.detail ? `<p class="hg-roof-quality">${escHtml(quality.detail)}</p>` : ""}
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
        <h2 class="hg-section-label">Storms over this home</h2>
        <span class="hg-count">${allCovering.length} verified in ${escHtml(yearsLabel)}</span>
      </div>
      <p class="hg-storm-blurb">Highlights from your selected history window (≥ ${escHtml(String(state.minHailIn))}″, verified cover only).</p>
      <h3 class="hg-storm-group">Top ${REPORT_LIST_N} most extreme</h3>
      <ul class="hg-storm-list">${reportStormRowsHtml(extreme, "Extreme")}</ul>
      <h3 class="hg-storm-group">Top ${REPORT_LIST_N} most recent</h3>
      <ul class="hg-storm-list">${reportStormRowsHtml(recent, "Recent")}</ul>
    </section>

    <section class="hg-card hg-trust">
      <h2 class="hg-section-label">Why this matters</h2>
      <p>Oklahoma hail regularly totals roofs. High Ground uses drone and AI documentation to strengthen your position — and we stand with you when insurance is involved.</p>
      <p class="hg-trust-line">Family-run · Edmond &amp; surrounding · Honesty over scare tactics</p>
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
        years: state.years,
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
      storms: state.storms.map((s) => ({
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
  }

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
    state.minHailIn = Number(v) || 1;
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

  // Keep UI honest if the pin cache grows after a refresh gen advanced (filter flip mid-load).
  onHomeHailCache(() => {
    if (!Number.isFinite(state.lat)) return;
    const cache = getHomeHailCache();
    if (!cache.hail?.length) return;
    const result = filterCachedHomeStorms({ years: state.years, minHailIn: state.minHailIn });
    // While history is still filling, keep reseating the starter pack — but never after the
    // homeowner has tapped a date (isolate / multi-overlay mode).
    applyStormResult(result, {
      loading: Boolean(result.loading),
      reseatSelection: Boolean(result.loading || cache.loadingDeep) && state.overlayCollection,
    });
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
  requestAnimationFrame(() => {
    ensureMap()?.invalidateSize?.();
  });
}

boot();
