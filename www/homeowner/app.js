/**
 * HomeScope — Oklahoma homeowner hail report (isolated from Ground Control field UX).
 */
import { APP_VERSION } from "../version.js";
import { geocodeCandidates, biasAddressQuery, inOklahoma, suggestOklahomaAddresses, resolveAddressSuggestion } from "../geocode.js";
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
      <span class="ho-suggest-meta">Tap to use this address</span>`;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
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
    state.address = label;
    state.lat = lat;
    state.lon = lon;
    state.storms = [];
    state.selected.clear();
    setStatus(status, label);
    setStep("roof");
    pinHome(lat, lon);
    paintStormList();
  } catch (err) {
    setStatus(status, err?.message || "Address lookup failed", true);
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
    "Storms covering this home:",
  ].filter((x) => x !== "");
  for (const s of state.storms) {
    lines.push(`• ${s.pretty || s.date} — ${Number(s.maxSizeIn).toFixed(2)}″ — ${s.sources}`);
  }
  if (!state.storms.length) lines.push("• None in the selected filters");
  lines.push("", PRODUCT.disclaimer);
  return lines.join("\n");
}

function renderReportDocument(rec) {
  const b = PRODUCT.brand;
  const roofLabel = state.roofReplacedOn
    ? state.roofReplacedOn.slice(0, 7)
    : `Unknown (last ${CLAIM_RULES.defaultLookbackYearsIfRoofUnknown} years)`;
  const prepared = state.lead?.name || state.lead?.email || "Homeowner";
  const tone = rec.considerClaim ? "claim" : rec.talkToRoofer ? "roofer" : "ok";

  const stormRows = state.storms.length
    ? state.storms
        .map((s) => {
          const on = state.selected.has(s.date);
          const cover = [s.coversNear ? "Near roof" : null, s.coversPolygon ? "Zone over home" : null]
            .filter(Boolean)
            .join(" · ");
          return `<li class="hg-storm${on ? " on" : ""}">
            <div class="hg-storm-size">${escHtml(Number(s.maxSizeIn).toFixed(2))}<span>″</span></div>
            <div class="hg-storm-body">
              <strong>${escHtml(s.pretty || s.date)}</strong>
              <span class="hg-storm-meta">${escHtml(s.sources)}${cover ? " · " + escHtml(cover) : ""}</span>
            </div>
            <div class="hg-storm-flag">${on ? "On map" : ""}</div>
          </li>`;
        })
        .join("")
    : `<li class="hg-storm empty"><div class="hg-storm-body"><strong>No covering storms in this filter</strong>
        <span class="hg-storm-meta">Widen the year window or lower the hail size, then regenerate.</span></div></li>`;

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
        <div><dt>Roof last replaced</dt><dd>${escHtml(roofLabel)}</dd></div>
        <div><dt>History window</dt><dd>${escHtml(String(state.years))} years · ≥ ${escHtml(String(state.minHailIn))}″</dd></div>
        <div><dt>Review period</dt><dd>${escHtml(rec.windowStart)} → ${escHtml(rec.windowEnd)}</dd></div>
        <div><dt>Generated</dt><dd>${escHtml(new Date().toLocaleString())}</dd></div>
        <div><dt>Sources</dt><dd>NOAA SWDI · SPC · IEM LSR</dd></div>
      </dl>
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
        <span class="hg-count">${state.storms.length} date${state.storms.length === 1 ? "" : "s"}</span>
      </div>
      <ul class="hg-storm-list">${stormRows}</ul>
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

function generateReport() {
  const rec = homescopeRecommendation({
    storms: state.storms,
    roofReplacedOn: state.roofReplacedOn,
  });
  state.lastRec = rec;
  state.reportText = buildReportText(rec);
  const doc = $("#hg-doc");
  if (doc) doc.innerHTML = renderReportDocument(rec);
  setStep("report");
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
  .hg-verdict{border-radius:14px;padding:1.15rem 1.1rem;margin:0 0 1rem;border:1px solid var(--line);background:linear-gradient(160deg,rgba(255,204,0,.12),rgba(20,20,22,.95))}
  .hg-verdict-title{margin:.2rem 0 .45rem;font-size:1.35rem;letter-spacing:-.02em;line-height:1.2}
  .hg-verdict-body{margin:0 0 .9rem;color:var(--muted);font-size:.95rem}
  .hg-cta-row{display:flex;flex-wrap:wrap;gap:.5rem}
  .hg-cta-primary{display:inline-block;background:var(--phos);color:#1c1400;font-weight:700;text-decoration:none;padding:.75rem 1.1rem;border-radius:10px;letter-spacing:.02em}
  .hg-cta-call{display:inline-block;border:1px solid rgba(255,255,255,.35);color:var(--text);text-decoration:none;padding:.75rem 1rem;border-radius:10px;font-weight:600}
  .hg-secondary-cta{margin:.75rem 0 0;font-size:.9rem;color:var(--phos)}
  .hg-section-head{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}
  .hg-count{font-size:.75rem;color:var(--muted)}
  .hg-storm-list{list-style:none;margin:.65rem 0 0;padding:0;display:flex;flex-direction:column;gap:.4rem}
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

function unlockFromLead(lead) {
  state.lead = lead;
  state.unlocked = true;
  setStep("address");
}

function boot() {
  $("#ho-brand").textContent = PRODUCT.name;
  document.title = `${PRODUCT.brand.company} · ${PRODUCT.name}`;
  if ($("#ho-ver") && !$("#ho-ver").textContent) $("#ho-ver").textContent = `v${APP_VERSION}`;
  const gateDisc = $("#ho-disclaimer-gate");
  if (gateDisc) gateDisc.textContent = PRODUCT.disclaimer;

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
    } else if (e.key === "Escape") {
      clearSuggestions();
    }
  });
  // Don't clear on blur immediately — mobile taps need the dropdown to stay.
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#addr-form")) return;
    clearSuggestions();
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

  if (!state.unlocked) setStep("gate");
}

boot();
