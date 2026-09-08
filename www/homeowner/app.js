/**
 * HomeScope — Oklahoma homeowner hail report (isolated from Ground Control field UX).
 */
import { APP_VERSION } from "../version.js";
import { geocodeCandidates, biasAddressQuery, inOklahoma } from "../geocode.js";
import { PRODUCT, CLAIM_RULES, homescopeRecommendation } from "./product.js";
import { loadHomeStorms } from "./hail-load.js";
import { buildHailSwathRings } from "../wx.js";

const LEAD_KEY = "homescope_lead_v1";

const state = {
  unlocked: false,
  lead: null,
  step: "gate",
  address: "",
  lat: null,
  lon: null,
  roofMode: "idk",
  roofReplacedOn: null,
  years: 2,
  minHailIn: 1,
  storms: [],
  selected: new Set(),
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
  // CRM hook — replace with your endpoint later.
  window.dispatchEvent(new CustomEvent("homescope:lead", { detail: lead }));
  console.info("[HomeScope] lead captured (CRM stub)", lead);
}

function setStep(step) {
  state.step = step;
  const gated = !state.unlocked;
  $("#panel-gate").hidden = !gated;
  $("#ho-hero").hidden = gated;
  if (gated) return;

  $$("#ho-steps [data-step]").forEach((li) => li.classList.toggle("on", li.dataset.step === step));
  const order = ["address", "roof", "storms", "report"];
  const idx = order.indexOf(step);
  $$("[data-panel]").forEach((panel) => {
    if (panel.id === "panel-gate") return;
    const p = panel.dataset.panel;
    const pIdx = order.indexOf(p);
    panel.hidden = pIdx < 0 || pIdx > idx;
  });
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
  state.overlay = window.L.layerGroup().addTo(state.map);
  return state.map;
}

function pinHome(lat, lon) {
  const map = ensureMap();
  if (!map) return;
  map.setView([lat, lon], 15);
  if (state.marker) state.marker.setLatLng([lat, lon]);
  else {
    state.marker = window.L.circleMarker([lat, lon], {
      radius: 8,
      color: "#ffcc00",
      weight: 2,
      fillColor: "#ffcc00",
      fillOpacity: 0.9,
    }).addTo(map);
  }
  requestAnimationFrame(() => map.invalidateSize());
}

function paintOverlays() {
  if (!state.overlay || !window.L) return;
  state.overlay.clearLayers();
  for (const s of state.storms) {
    if (!state.selected.has(s.date)) continue;
    const pts = s.zone_pts || s.raw?.zone_pts || [];
    let rings = [];
    try {
      rings = buildHailSwathRings(pts, s.raw || s, { includeSpotters: true }) || [];
    } catch {
      rings = [];
    }
    if (rings.length) {
      for (const band of rings) {
        if (!band?.ring?.length) continue;
        window.L.polygon(band.ring, {
          color: "#ffcc00",
          weight: 1.5,
          fillColor: "#ffcc00",
          fillOpacity: 0.2,
        }).addTo(state.overlay);
      }
    } else {
      for (const p of pts) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
        window.L.circle([p.lat, p.lon], {
          radius: Math.max(400, (Number(p.size_in) || 1) * 350),
          color: "#ffcc00",
          weight: 1,
          fillOpacity: 0.12,
        }).addTo(state.overlay);
      }
    }
  }
}

function hitLabel(hit) {
  return String(hit?.address || hit?.label || "").trim();
}

function hitMeta(hit) {
  const bits = [];
  if (hit?.addrType) bits.push(String(hit.addrType).replace(/([a-z])([A-Z])/g, "$1 $2"));
  if (hit?.source) bits.push(String(hit.source));
  return bits.join(" · ");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchSuggestions(query) {
  const q = biasAddressQuery(String(query || "").trim());
  if (q.length < 4) return [];
  try {
    const hits = await geocodeCandidates(q, { city: "Oklahoma" });
    return (hits || []).filter((h) => inOklahoma(h)).slice(0, 6);
  } catch {
    return [];
  }
}

function clearSuggestions() {
  state.suggestHits = [];
  state.suggestIdx = -1;
  const box = $("#addr-suggest");
  const input = $("#addr-q");
  if (box) {
    box.innerHTML = "";
    box.hidden = true;
  }
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
}

function paintSuggestions(hits, { emptyMsg = "" } = {}) {
  const box = $("#addr-suggest");
  const input = $("#addr-q");
  if (!box) return;
  state.suggestHits = hits || [];
  state.suggestIdx = state.suggestHits.length ? 0 : -1;
  box.innerHTML = "";
  if (!state.suggestHits.length) {
    if (emptyMsg) {
      box.hidden = false;
      box.innerHTML = `<li class="ho-suggest-empty">${escapeHtml(emptyMsg)}</li>`;
      if (input) input.setAttribute("aria-expanded", "true");
    } else {
      box.hidden = true;
      if (input) input.setAttribute("aria-expanded", "false");
    }
    return;
  }
  box.hidden = false;
  if (input) input.setAttribute("aria-expanded", "true");
  state.suggestHits.forEach((hit, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ho-suggest-item${i === state.suggestIdx ? " active" : ""}`;
    btn.id = `addr-opt-${i}`;
    btn.innerHTML = `<span class="ho-suggest-main">${escapeHtml(hitLabel(hit))}</span>
      <span class="ho-suggest-meta">${escapeHtml(hitMeta(hit) || "Oklahoma")}</span>`;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      void selectAddressHit(hit);
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

async function selectAddressHit(hit) {
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    setStatus($("#addr-status"), "Pick a suggested address", true);
    return;
  }
  if (!inOklahoma(hit)) {
    setStatus($("#addr-status"), "HomeScope is Oklahoma-only — pick an OK address", true);
    return;
  }
  const label = hitLabel(hit) || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const input = $("#addr-q");
  if (input) input.value = label;
  clearSuggestions();
  state.address = label;
  state.lat = lat;
  state.lon = lon;
  state.storms = [];
  state.selected.clear();
  setStatus($("#addr-status"), label);
  setStep("roof");
  pinHome(lat, lon);
  paintStormList();
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
  if (q.length < 4) {
    clearSuggestions();
    setStatus($("#addr-status"), q ? "Keep typing for suggestions…" : "");
    return;
  }
  const gen = ++state.suggestGen;
  state.suggestTimer = setTimeout(async () => {
    setStatus($("#addr-status"), "Finding addresses…");
    const hits = await fetchSuggestions(q);
    if (gen !== state.suggestGen) return;
    if (!hits.length) {
      paintSuggestions([], { emptyMsg: "No Oklahoma matches yet — try street, city, OK" });
      setStatus($("#addr-status"), "No suggestions yet");
      return;
    }
    paintSuggestions(hits);
    setStatus($("#addr-status"), `${hits.length} suggestion${hits.length === 1 ? "" : "s"} — tap one`);
  }, 280);
}

function roofDateFromInputs() {
  if (state.roofMode === "idk") return null;
  if (state.roofMode === "month") {
    const m = $("#roof-month")?.value;
    return m ? `${m}-01` : null;
  }
  const y = Number($("#roof-year")?.value);
  if (!Number.isFinite(y) || y < 1970 || y > 2030) return null;
  return `${y}-01-01`;
}

function paintStormList({ loading = false } = {}) {
  const list = $("#storm-list");
  const btn = $("#make-report");
  if (!list) return;
  list.innerHTML = "";
  if (!state.storms.length) {
    const li = document.createElement("li");
    li.style.cursor = "default";
    li.style.opacity = "0.75";
    li.innerHTML = loading
      ? `<span class="sz">…</span><span>Loading hail zones…<br/><span class="meta">NOAA radar + spotter reports</span></span><span></span>`
      : `<span class="sz">—</span><span>No covering storms yet<br/><span class="meta">Try a wider year window or lower hail size</span></span><span></span>`;
    list.appendChild(li);
    if (btn) btn.disabled = true;
    paintOverlays();
    return;
  }
  for (const s of state.storms) {
    const on = state.selected.has(s.date);
    const li = document.createElement("li");
    li.className = on ? "on" : "";
    const how = [s.coversNear ? "near roof" : null, s.coversPolygon ? "zone over home" : null]
      .filter(Boolean)
      .join(" · ");
    li.innerHTML = `<span class="sz">${Number(s.maxSizeIn).toFixed(2)}″</span>
      <span>${s.pretty || s.date}<br/><span class="meta">${s.sources} · ${how || "covers home"}</span></span>
      <span class="meta">${on ? "On map" : "Tap"}</span>`;
    li.addEventListener("click", () => {
      if (state.selected.has(s.date)) state.selected.delete(s.date);
      else state.selected.add(s.date);
      paintStormList();
    });
    list.appendChild(li);
  }
  if (btn) btn.disabled = false;
  paintOverlays();
}

async function refreshStorms() {
  if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)) return;
  const status = $("#storm-status");
  const gen = ++refreshStorms._gen;
  setStatus(status, `Loading ~${state.years}y of hail (≥${state.minHailIn}″)…`);
  $("#make-report").disabled = true;
  state.storms = [];
  state.selected.clear();
  paintStormList({ loading: true });
  try {
    const result = await loadHomeStorms(state.lat, state.lon, {
      address: state.address,
      years: state.years,
      minHailIn: state.minHailIn,
      onPartial: (part) => {
        if (gen !== refreshStorms._gen) return;
        state.storms = part.storms || [];
        if (state.selected.size === 0 && state.storms.length) {
          state.selected = new Set(state.storms.slice(0, Math.min(4, state.storms.length)).map((s) => s.date));
        } else {
          for (const s of state.storms) {
            if (state.selected.size >= 4) break;
            state.selected.add(s.date);
          }
        }
        // Drop selections that vanished after a filter refresh.
        for (const d of [...state.selected]) {
          if (!state.storms.some((s) => s.date === d)) state.selected.delete(d);
        }
        paintStormList({ loading: Boolean(part.loading) });
        const n = state.storms.length;
        const rows = part.hailRowCount || 0;
        setStatus(
          status,
          part.loading
            ? `Loading… ${n} covering storm(s) · ${rows} hail reports`
            : n
              ? `${n} storm date(s) covering this home`
              : part.note || "Still searching…",
        );
      },
    });
    if (gen !== refreshStorms._gen) return;
    state.storms = result.storms || [];
    if (!state.selected.size && state.storms.length) {
      state.selected = new Set(state.storms.slice(0, Math.min(4, state.storms.length)).map((s) => s.date));
    }
    for (const d of [...state.selected]) {
      if (!state.storms.some((s) => s.date === d)) state.selected.delete(d);
    }
    paintStormList({ loading: false });
    ensureMap();
    if (Number.isFinite(state.lat)) pinHome(state.lat, state.lon);
    paintOverlays();
    const note = result.note ? ` ${result.note}` : "";
    if (result.error) {
      setStatus(status, result.note || "Hail load failed", true);
      return;
    }
    setStatus(
      status,
      state.storms.length
        ? `${state.storms.length} storm date(s) covering this home · sources: NOAA / SPC / IEM.${note}`
        : `No storms ≥${state.minHailIn}″ covering this home in ~${state.years} years.${note}`,
    );
  } catch (err) {
    if (gen !== refreshStorms._gen) return;
    paintStormList({ loading: false });
    setStatus(status, err?.message || "Hail load failed", true);
  }
}
refreshStorms._gen = 0;

function buildReportText(rec) {
  const lines = [];
  lines.push(`${PRODUCT.name} — Oklahoma Hail Report`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  if (state.lead?.email) lines.push(`Prepared for: ${state.lead.name || ""} <${state.lead.email}>`.trim());
  lines.push(`Address: ${state.address}`);
  lines.push(`Coordinates: ${state.lat?.toFixed(5)}, ${state.lon?.toFixed(5)}`);
  lines.push(
    `Roof last replaced: ${
      state.roofReplacedOn ||
      `Unknown (using ${CLAIM_RULES.defaultLookbackYearsIfRoofUnknown}-year window)`
    }`,
  );
  lines.push(`History filter: ${state.years} years · Min hail: ${state.minHailIn}″`);
  lines.push(`Review window: ${rec.windowStart} → ${rec.windowEnd}`);
  lines.push("");
  lines.push("Storms covering this home:");
  if (!state.storms.length) lines.push("  (none)");
  else {
    for (const s of state.storms) {
      const mark = state.selected.has(s.date) ? "[x]" : "[ ]";
      const how = [s.coversNear ? "near" : null, s.coversPolygon ? "polygon" : null].filter(Boolean).join("+");
      lines.push(`  ${mark} ${s.date} · max ${Number(s.maxSizeIn).toFixed(2)}″ · ${s.sources} · ${how}`);
    }
  }
  lines.push("");
  lines.push(`Recommendation: ${rec.headline}`);
  lines.push(`  ${rec.reason}`);
  lines.push(`Primary next step: ${rec.primaryCta}`);
  if (rec.secondaryCta) lines.push(`Also: ${rec.secondaryCta}`);
  lines.push("");
  lines.push("Sources: NOAA SWDI radar, NOAA SPC / IEM LSR spotter reports.");
  lines.push("");
  lines.push(PRODUCT.disclaimer);
  return lines.join("\n");
}

function generateReport() {
  const rec = homescopeRecommendation({
    storms: state.storms,
    roofReplacedOn: state.roofReplacedOn,
  });
  state.lastRec = rec;
  state.reportText = buildReportText(rec);

  const box = $("#ho-rec");
  const title = $("#ho-rec-title");
  const body = $("#ho-rec-body");
  const cta = $("#ho-cta");
  if (box && title && body) {
    box.hidden = false;
    box.classList.toggle("claim", rec.considerClaim || rec.talkToRoofer);
    box.classList.toggle("ok", !rec.considerClaim && !rec.talkToRoofer);
    title.textContent = rec.headline;
    body.textContent = rec.reason;
  }
  if (cta) {
    cta.textContent = rec.secondaryCta
      ? `${rec.primaryCta} · ${rec.secondaryCta}`
      : rec.primaryCta;
  }
  const report = $("#ho-report");
  if (report) report.textContent = state.reportText;
  const disc = $("#ho-disclaimer");
  if (disc) disc.textContent = PRODUCT.disclaimer;
  setStep("report");
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
  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(PRODUCT.name)} Report</title>
  <style>body{font:14px/1.45 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#111}
  h1{font-size:1.4rem} pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem;border-radius:8px}</style></head>
  <body><h1>${esc(PRODUCT.name)} — Hail Report</h1>
  <p><strong>${esc(state.lastRec?.headline || "")}</strong></p>
  <p>${esc(state.lastRec?.reason || "")}</p>
  <p><strong>${esc(state.lastRec?.primaryCta || "Get a free inspection")}</strong>
  ${state.lastRec?.secondaryCta ? " · " + esc(state.lastRec.secondaryCta) : ""}</p>
  <pre>${esc(state.reportText)}</pre>
  <p style="font-size:12px;color:#555">${esc(PRODUCT.disclaimer)}</p>
  </body></html>`;
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

function unlockFromLead(lead) {
  state.lead = lead;
  state.unlocked = true;
  setStep("address");
}

function boot() {
  $("#ho-brand").textContent = PRODUCT.name;
  document.title = PRODUCT.name;
  // version label set in boot.js; keep in sync if boot skipped
  if ($("#ho-ver") && !$("#ho-ver").textContent) $("#ho-ver").textContent = `v${APP_VERSION}`;
  $("#ho-disclaimer").textContent = PRODUCT.disclaimer;
  $("#ho-disclaimer-gate").textContent = PRODUCT.disclaimer;

  const existing = readLead();
  if (existing?.email) unlockFromLead(existing);

  $("#gate-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#gate-name")?.value?.trim() || "";
    const email = $("#gate-email")?.value?.trim() || "";
    const phone = $("#gate-phone")?.value?.trim() || "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus($("#gate-status"), "Enter a valid email to continue", true);
      return;
    }
    const lead = {
      name,
      email,
      phone,
      capturedAt: new Date().toISOString(),
      source: "homescope_gate",
      crm: "pending",
    };
    saveLead(lead);
    setStatus($("#gate-status"), "You’re in — loading HomeScope…");
    unlockFromLead(lead);
  });

  $("#addr-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("#addr-status");
    const go = $("#addr-go");
    const q = $("#addr-q")?.value || "";
    // If a suggestion is highlighted, take that.
    if (state.suggestHits.length && state.suggestIdx >= 0) {
      await selectAddressHit(state.suggestHits[state.suggestIdx]);
      return;
    }
    if (go) go.disabled = true;
    setStatus(status, "Looking up Oklahoma address…");
    try {
      const hit = await lookupAddress(q);
      await selectAddressHit(hit.hit || hit);
    } catch (err) {
      setStatus(status, err?.message || "Lookup failed", true);
    } finally {
      if (go) go.disabled = false;
    }
  });

  $("#addr-q")?.addEventListener("input", (e) => {
    scheduleSuggest(e.target.value);
  });
  $("#addr-q")?.addEventListener("keydown", (e) => {
    if (!state.suggestHits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightSuggest(Math.min(state.suggestHits.length - 1, state.suggestIdx + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightSuggest(Math.max(0, state.suggestIdx - 1));
    } else if (e.key === "Escape") {
      clearSuggestions();
    }
  });
  $("#addr-q")?.addEventListener("blur", () => {
    // Delay so suggestion click can fire first.
    setTimeout(() => {
      if (!document.activeElement?.closest?.("#addr-suggest")) clearSuggestions();
    }, 180);
  });

  bindChips("#roof-mode", "roof", (mode) => {
    state.roofMode = mode;
    const inputs = $("#roof-inputs");
    const year = $("#roof-year");
    const month = $("#roof-month");
    if (inputs) inputs.hidden = mode === "idk";
    if (year) year.hidden = mode !== "year";
    if (month) month.hidden = mode !== "month";
  });

  $("#roof-continue")?.addEventListener("click", async () => {
    if (state.roofMode !== "idk") {
      const d = roofDateFromInputs();
      if (!d) {
        setStatus($("#storm-status"), "Enter a valid roof date, or pick “I don’t know”.", true);
        return;
      }
      state.roofReplacedOn = d;
    } else {
      state.roofReplacedOn = null;
    }
    setStep("storms");
    ensureMap();
    if (Number.isFinite(state.lat) && Number.isFinite(state.lon)) pinHome(state.lat, state.lon);
    await refreshStorms();
  });

  bindChips("#filter-years", "years", async (v) => {
    state.years = Number(v) || 2;
    if (state.step === "storms" || state.step === "report") await refreshStorms();
  });
  bindChips("#filter-hail", "hail", async (v) => {
    state.minHailIn = Number(v) || 1;
    if (state.step === "storms" || state.step === "report") await refreshStorms();
  });

  $("#make-report")?.addEventListener("click", generateReport);
  $("#print-report")?.addEventListener("click", () => window.print());
  $("#dl-html")?.addEventListener("click", () => {
    downloadBlob("homescope-report.html", "text/html;charset=utf-8", reportHtmlDoc());
  });
  $("#dl-doc")?.addEventListener("click", () => {
    // Word opens HTML-as-.doc reliably for simple reports.
    downloadBlob("homescope-report.doc", "application/msword", reportHtmlDoc());
  });
  $("#dl-txt")?.addEventListener("click", () => {
    downloadBlob("homescope-report.txt", "text/plain;charset=utf-8", state.reportText || "");
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

  if (!state.unlocked) setStep("gate");
}

boot();
