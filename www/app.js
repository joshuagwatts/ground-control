import { load, save, uid } from "./store.js";
import { chat, pipStatus, takeLastTurn } from "./brain.js";
import { AGENT_META, agentLabel } from "./crew.js";
import {
  validateKeyed,
  providerHealth,
  hydrateHealth,
  PROVIDERS,
  keyTag,
  keyHint,
  clearHealth,
  normalizeApiKey,
  parseAgentRelay,
  agentRelayComplete,
  compareProviders,
  isSpent,
  clearSpent,
  privacyOn,
  cloudStatus,
} from "./cloud.js";
import { httpDiag } from "./net.js";
import {
  loadMapConfig,
  mountMap,
  destroyMap,
  setMapLayer,
  pinDossier,
  refetchDossier,
  filterHailRaw,
  selectStormDate,
  drawHailMarkers,
  resolveMapCenter,
  geocodeAddress,
  geoCacheOk,
  flyToPin,
  setWxPin,
  setHailScopeMode,
  syncHailScopeView,
  patchHailScopePartial,
  renderHailScopeSheet,
  baseLayerButtons,
  bindWxMapScrollExpand,
  bindSelectPinDblTap,
  clearWxPin,
  clearSelectedStormDate,
  applyDonePinScaleLive,
  revealHailAddressPeek,
  revealHailStormSheet,
  advanceHailBottomReveal,
  syncHailBottomChrome,
  setWxMapExpanded,
  setMyLocationVisible,
  wxPinSelected,
  viewportDossier,
  setWxUnits,
  reverseGeocode,
  setFieldOverlay,
  mapIsLive,
  refreshMapSize,
  defaultMapCenter,
  quickMapConfig,
  hidePinScalePopover,
  showPinScalePopover,
  updatePinScaleLive,
} from "./wx.js?v=0.2.57";
import { pickImageFiles, fileToDataUrl, identifyImage, MAX_CHAT_PHOTOS, visionProvidersReady, cloudVisionReady } from "./vision.js";
import { SHOTS, identifyShingles, formatVerdict, buildSharePrompt } from "./shingle.js";
import { shareToChatGpt } from "./share.js";
import { matchCatalog, discontinuedFor, SHINGLE_CORE, SHINGLE_EXTRA } from "./catalog.js";
import { newJob, upsertJob, jobSummary } from "./inspect.js";
import { openMarkEditor } from "./damage.js";
import { COMPOSE_KINDS, kindMeta, newMark, upsertMark, removeMark, filterMarks, marksCsv, marksPlainList, outreachDraft, isProductPing, productIdOf, productForMark, customProductId, mailerProducts, clampPinScale } from "./marks.js";
import { parseDoneList, withCity, MAX_DONE, normalizeDoneHouse } from "./done.js";
import { parseStreetAddress } from "./contacts.js";

const $ = (s) => document.querySelector(s);
let db = load();
setWxUnits(db.settings.units || "imperial");
let tab = "hailscope";
const keyCheckTimers = {};
let pendingChatImages = [];
let wxState = { lat: null, lon: null, address: "", data: null, viewport: false };
let wxWatch = null;
let chatBusy = false;
let lensBusy = false;
let lensRunTimer = null;
let lastLensSig = "";

function lensPhotoSig(L) {
  return `${L.photos.length}|${(L.photos || []).map((p) => `${p.at || 0}:${p.shot || ""}:${(p.url || "").length}`).join(";")}`;
}

function scheduleLensRun(delay = 500, { force = false } = {}) {
  if (isPhoneApp() && lensMode() === "shingle") return;
  clearTimeout(lensRunTimer);
  lensRunTimer = setTimeout(() => {
    lensRunTimer = null;
    void runLens({ force });
  }, delay);
}

function isPhoneApp() {
  const p = window.Capacitor?.getPlatform?.();
  return p === "android" || p === "ios";
}
let pendingShot = "granules_close";
let markDraft = null;
let doneBusy = false;
let selectedDoneId = null;

hydrateHealth(db.settings.brain_health || {});

function persist() {
  save(db);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(msg) {
  const el = $("#status");
  if (el) el.textContent = msg || "";
}

function isHailTab() {
  return tab === "hailscope" || tab === "wx";
}

function leaveWx() {
  if (wxWatch && typeof wxWatch.stop === "function") {
    wxWatch.stop();
    wxWatch = null;
  }
  hidePinScalePopover();
  setHailScopeMode(false);
  destroyMap();
  document.body.classList.remove("wx-tab", "hs-tab", "wx-map-expanded");
}

function renderPrivacy() {
  const secure = privacyOn(db.settings);
  const tog = $("#privacy-tog");
  if (tog) {
    tog.classList.toggle("on", secure);
    tog.classList.toggle("leaky", !secure);
    tog.textContent = secure ? "On-device" : "Cloud";
    tog.title = isPhoneApp()
      ? "Phone Lens shares guided photos to ChatGPT. Cloud mode is for web/API keys."
      : secure
        ? "Vision uses cloud API keys only when Cloud mode is on."
        : "Cloud vision is on for Lens.";
  }
}

function chatAgent() {
  return String(db.settings.chat_agent || "pip").toLowerCase();
}

function setChatAgent(id, silent = false) {
  const next = String(id || "pip").toLowerCase();
  db.settings.chat_agent = next;
  if (next === "pip" || next === "gc" || next === "auto") db.settings.brain_pin = "auto";
  else if (next === "compare") db.settings.brain_pin = "compare";
  else db.settings.brain_pin = next;
  persist();
  paintBrainStrip();
  if (!silent) {
    const meta = AGENT_META[next] || { label: agentLabel(next) };
    setStatus(`AGENT · ${meta.label}`);
  }
}

function agentOptions() {
  const keyed = new Set(cloudStatus(db.settings).keyed || []);
  const active = chatAgent();
  const modes = [
    { id: "pip", section: "modes" },
    { id: "auto", section: "modes" },
    { id: "compare", section: "modes" },
  ];
  const apis = [];
  for (const id of ["anthropic", "groq", "openrouter", "gemini", "cerebras", "deepseek", "openai", "mistral", "xai"]) {
    if (keyed.has(id)) apis.push({ id, section: "apis" });
  }
  return { opts: [...modes, ...apis], keyed, active, health: providerHealth() };
}

function agentStatFor(id, { keyed, health }) {
  if (id === "pip" || id === "gc" || id === "auto" || id === "compare") {
    return { cls: "mode", text: id === "compare" ? "ALL" : id === "auto" ? "FAST" : "FIELD" };
  }
  if (!keyed.has(id)) return { cls: "bad", text: "NO KEY" };
  if (isSpent(id)) return { cls: "bad", text: "MAXED" };
  const ok = health[id]?.ok;
  if (ok === true) return { cls: "live", text: "LIVE" };
  if (ok === false) return { cls: "bad", text: "FAIL" };
  return { cls: "key", text: "KEYED" };
}

function fillAgentPick() {
  const lab = $("#agent-trig-lab");
  const list = $("#agent-sheet-list");
  const { opts, keyed, active, health } = agentOptions();
  if (lab) lab.textContent = agentLabel(active);
  if (!list) return;
  const chunks = [];
  let lastSec = "";
  for (const o of opts) {
    const sec = o.section === "modes" ? "modes" : "apis";
    if (sec !== lastSec) {
      lastSec = sec;
      chunks.push(`<div class="agent-sec">${sec === "modes" ? "MODES" : "KEYED APIS"}</div>`);
    }
    const meta = AGENT_META[o.id] || { label: agentLabel(o.id), blurb: "" };
    const stat = agentStatFor(o.id, { keyed, health });
    chunks.push(`
      <button type="button" class="agent-row${o.id === active ? " on" : ""}" data-agent="${esc(o.id)}">
        <span class="agent-row-mark" aria-hidden="true"></span>
        <span class="agent-row-body">
          <span class="agent-row-name">${esc(meta.label || agentLabel(o.id))}</span>
          <span class="agent-row-blurb">${esc(meta.blurb || "")}</span>
        </span>
        <span class="agent-row-stat ${esc(stat.cls)}">${esc(stat.text)}</span>
      </button>`);
  }
  list.innerHTML = chunks.join("");
  list.querySelectorAll("[data-agent]").forEach((btn) => {
    btn.onclick = () => {
      setChatAgent(btn.dataset.agent);
      closeAgentSheet();
    };
  });
}

function openAgentSheet() {
  fillAgentPick();
  const sheet = $("#agent-sheet");
  const trig = $("#agent-trig");
  if (!sheet) return;
  sheet.hidden = false;
  void sheet.offsetWidth;
  sheet.classList.add("open");
  if (trig) {
    trig.classList.add("open");
    trig.setAttribute("aria-expanded", "true");
  }
}

function closeAgentSheet() {
  const sheet = $("#agent-sheet");
  const trig = $("#agent-trig");
  if (sheet) {
    sheet.classList.remove("open");
    sheet.hidden = true;
  }
  if (trig) {
    trig.classList.remove("open");
    trig.setAttribute("aria-expanded", "false");
  }
}

function paintBrainStrip() {
  fillAgentPick();
}

function paintKeyRows() {
  const health = providerHealth();
  for (const p of PROVIDERS) {
    const input = document.querySelector(`.key-row input[data-field="${p.field}"]`);
    const row = input?.closest(".key-row");
    if (!row) continue;
    const info = keyTag(db.settings, p, health[p.id]);
    row.className = `key-row ${info.state}`;
    const tag = row.querySelector(".key-tag");
    if (tag) {
      const hint = keyHint(db.settings, p);
      tag.textContent = hint ? `${info.tag} · ${hint}` : info.tag;
    }
  }
}

function clearProviderKey(field) {
  if (!field) return;
  clearTimeout(keyCheckTimers[field]);
  db.settings[field] = "";
  const prov = PROVIDERS.find((p) => p.field === field);
  if (prov) {
    clearHealth(prov.id);
    clearSpent(prov.id);
    if (db.settings.brain_health) delete db.settings.brain_health[prov.id];
  }
  persist();
  renderKeys();
}

function queueKeyValidate(field) {
  clearTimeout(keyCheckTimers[field]);
  keyCheckTimers[field] = setTimeout(async () => {
    const prov = PROVIDERS.find((p) => p.field === field);
    const key = normalizeApiKey(db.settings[field]);
    if (!prov || !key) return;
    clearHealth(prov.id);
    clearSpent(prov.id);
    paintKeyRows();
    try {
      db.settings[field] = key;
      await validateKeyed(db.settings, { only: prov.id });
      db.settings.brain_health = providerHealth();
      persist();
      paintBrainStrip();
      paintKeyRows();
    } catch {
      /* ignore */
    }
  }, 450);
}

function formatInlineMd(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code class=\"chat-inline\">$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

function formatMdBlocks(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null;
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      flushList();
      out.push(`<h${h[1].length} class="chat-h">${formatInlineMd(h[2])}</h${h[1].length}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*…]\s+(.+)$/);
    if (ul) {
      if (!list || list.tag !== "ul") {
        flushList();
        list = { tag: "ul", items: [] };
      }
      list.items.push(`<li>${formatInlineMd(ul[1])}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) {
      out.push("<br/>");
      continue;
    }
    out.push(`<p class="chat-p">${formatInlineMd(line)}</p>`);
  }
  flushList();
  return out.join("");
}

function formatChatBody(text) {
  const raw = String(text || "");
  const parts = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    if (m.index > last) parts.push({ type: "text", v: raw.slice(last, m.index) });
    parts.push({ type: "code", lang: m[1] || "", v: m[2] });
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push({ type: "text", v: raw.slice(last) });
  if (!parts.length) return `<div class="chat-md">${formatMdBlocks(raw)}</div>`;
  return parts
    .map((p) => {
      if (p.type === "code") {
        const lang = p.lang ? `<span class="code-lang">${esc(p.lang)}</span>` : "";
        return `<pre class="chat-code">${lang}<code>${esc(p.v.replace(/\s+$/, ""))}</code></pre>`;
      }
      return `<div class="chat-md">${formatMdBlocks(p.v)}</div>`;
    })
    .join("");
}

function routeKind(opts = {}) {
  if (opts.local || opts.provider === "lite") return "local";
  if (opts.leaked) return "leaked";
  return "secure";
}

function routePillHtml(kind) {
  if (!kind) return "";
  const label = kind === "leaked" ? "LEAKED" : kind === "local" ? "LOCAL" : "SECURE";
  return `<span class="route-pill ${kind}"><span class="route-dot" aria-hidden="true"></span>${label}</span>`;
}

function addLog(role, text, opts = {}) {
  const div = document.createElement("div");
  const route = role === "user" ? (opts.leaked ? "leaked" : "") : routeKind(opts);
  div.className = `bubble ${role}${role === "pip" ? " pip" : ""}`;
  const who =
    role === "user"
      ? "YOU"
      : opts.agent === "compare"
        ? "COMPARE"
        : opts.agent && opts.agent !== "pip" && opts.agent !== "gc" && opts.agent !== "auto"
          ? agentLabel(opts.brain || opts.provider || opts.agent)
          : opts.brain
            ? `GC  · ${String(opts.brain).toUpperCase()}`
            : "GC";
  const pill = routePillHtml(route);
  const meta = opts.tokens ? `<div class="chat-meta">~${opts.tokens} TOK</div>` : "";
  div.innerHTML = `<div class="who-row"><span class="who">${esc(who)}</span>${pill}</div><div class="body">${formatChatBody(text)}</div>${meta}`;
  $("#log").appendChild(div);
  $("#log").scrollTop = $("#log").scrollHeight;
  return div;
}

function compareOverview(compare) {
  const rows = Array.isArray(compare) ? compare : [];
  const ok = rows.filter((c) => c && c.ok && c.text);
  const bad = rows.filter((c) => c && !c.ok && !c.pending);
  const lines = [`${ok.length} answered · ${bad.length} failed · ${rows.length} keyed`];
  for (const c of ok) {
    const name = String(c.label || c.provider || "?").toUpperCase();
    const t = String(c.text).trim().split(/(?<=[.!?])\s+/)[0] || "";
    lines.push(`  ${name}: ${t.slice(0, 100)}`);
  }
  return lines.join("\n");
}

function buildCompareTabs(rows) {
  const okRows = rows.filter((r) => r.ok && r.text);
  const badRows = rows.filter((r) => !r.ok && !r.pending);
  const pendingRows = rows.filter((r) => r.pending);
  const overview = { provider: "overview", label: "OVERVIEW", text: compareOverview(rows), ok: true, overview: true };
  const tabs = [overview, ...okRows];
  for (const p of pendingRows) tabs.push({ ...p, text: "Waiting…", ok: false, pending: true });
  if (badRows.length) {
    tabs.push({
      provider: "errors",
      label: "ERRORS",
      text: badRows.map((c) => `${String(c.label || c.provider).toUpperCase()}\n${c.error || "no reply"}`).join("\n\n"),
      ok: false,
      errors: true,
    });
  }
  return { tabs, okRows, badRows, rows };
}

function paintCompareBubble(div, state) {
  const { tabs, okRows, badRows, rows } = buildCompareTabs(state.rows);
  let idx = state.idx;
  if (idx >= tabs.length) idx = 0;
  state.idx = idx;
  const row = tabs[idx] || tabs[0];
  const tabHtml = tabs
    .map((c, i) => {
      const mark = c.errors ? " fail" : c.pending ? " wait" : "";
      return `<button type="button" class="compare-tab ${i === idx ? "on" : ""}${mark}" data-ci="${i}">${esc(String(c.label || c.provider).toUpperCase())}</button>`;
    })
    .join("");
  let body = formatChatBody(row.text || row.error || "no reply");
  if (row.pending) body = `<p class="muted">Waiting for ${esc(String(row.label || "").toUpperCase())}…</p>`;
  const meta = row.overview ? `${okRows.length}/${rows.length} answered` : row.errors ? `${badRows.length} failed` : String(row.model || "");
  div.innerHTML = `<div class="who-row"><span class="who">COMPARE</span>${routePillHtml("leaked")}</div><div class="compare-tabs">${tabHtml}</div><div class="body">${body}</div><div class="chat-meta">${esc(meta)}</div>`;
  div.querySelectorAll(".compare-tab").forEach((b) => {
    b.onclick = () => {
      state.idx = Number(b.dataset.ci) || 0;
      paintCompareBubble(div, state);
    };
  });
  $("#log").scrollTop = $("#log").scrollHeight;
}

function beginCompareLog(providers) {
  const rows = (providers || []).map((p) => ({ provider: p.id, label: p.label || p.id, text: "", ok: false, pending: true }));
  const div = document.createElement("div");
  div.className = "bubble pip compare-bubble compare-live";
  const state = { rows, idx: 0, div, finalized: false };
  paintCompareBubble(div, state);
  $("#log").appendChild(div);
  return state;
}

function updateCompareLog(state, allRows) {
  if (!state || state.finalized) return;
  state.rows = (allRows || []).map((r) => ({ ...r, pending: Boolean(r.pending) }));
  paintCompareBubble(state.div, state);
}

function finalizeCompareLog(state, rows) {
  if (!state) return;
  state.finalized = true;
  state.rows = rows || state.rows;
  state.div.classList.remove("compare-live");
  paintCompareBubble(state.div, state);
}

function paintChatAttach() {
  const root = $("#chat-attach");
  if (!root) return;
  if (!pendingChatImages.length) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  root.innerHTML = `<div class="chat-attach-row">${pendingChatImages
    .map(
      (u, i) =>
        `<span class="chat-attach-item"><img src="${u}" alt=""><button type="button" class="chat-attach-x" data-i="${i}" aria-label="remove">×</button></span>`,
    )
    .join("")}<button type="button" id="chat-attach-clear">CLEAR</button></div>`;
  root.querySelectorAll(".chat-attach-x").forEach((b) => {
    b.onclick = () => {
      pendingChatImages.splice(Number(b.dataset.i), 1);
      paintChatAttach();
    };
  });
  const clr = $("#chat-attach-clear");
  if (clr) clr.onclick = () => {
    pendingChatImages = [];
    paintChatAttach();
  };
}

async function attachChatPhoto() {
  try {
    const room = MAX_CHAT_PHOTOS - pendingChatImages.length;
    if (room <= 0) {
      setStatus(`MAX ${MAX_CHAT_PHOTOS} PHOTOS`);
      return;
    }
    const files = await pickImageFiles({ capture: false, multiple: true });
    for (const file of files.slice(0, room)) pendingChatImages.push(await fileToDataUrl(file, 1280, 0.72));
    document.body.classList.add("comm");
    paintChatAttach();
    setStatus(`ATTACHED ${pendingChatImages.length}`);
  } catch (e) {
    if (!/cancelled/i.test(String(e.message || e))) setStatus(String(e.message || e).slice(0, 60).toUpperCase());
  }
}

async function sendChat() {
  const box = $("#input");
  const text = (box.value || "").trim();
  const images = pendingChatImages.slice();
  const hasPhoto = images.length > 0;
  if ((!text && !hasPhoto) || chatBusy) return;
  chatBusy = true;
  const sendBtn = $("#send");
  if (sendBtn) sendBtn.disabled = true;
  box.value = "";
  const photoLine = images.length > 1 ? `[${images.length} photos attached]` : hasPhoto ? "[photo attached]" : "";
  const userLine = hasPhoto ? (text ? `${text}\n${photoLine}` : photoLine) : text;
  db.chat.push({ role: "user", content: userLine, image: hasPhoto, photos: images.length });
  const userBubble = addLog("user", userLine);
  if (hasPhoto) {
    const row = document.createElement("div");
    row.className = "chat-thumbs";
    for (const url of images) {
      const img = document.createElement("img");
      img.src = url;
      img.className = "chat-thumb";
      img.alt = "attached";
      row.appendChild(img);
    }
    userBubble.querySelector(".body")?.appendChild(row);
  }
  pendingChatImages = [];
  paintChatAttach();
  persist();

  try {
    if (!hasPhoto) {
      const relay = parseAgentRelay(text);
      if (relay && relay.to) {
        setStatus("RELAY…");
        const out = await agentRelayComplete(db.settings, {
          fromId: relay.from || (chatAgent() !== "pip" && chatAgent() !== "auto" && chatAgent() !== "compare" ? chatAgent() : null),
          toId: relay.to,
          payload: text,
          operator: db.settings.operator || "Joshua",
          speak: Boolean(relay.speak),
        });
        db.chat.push({ role: "pip", content: out.text, brain: out.provider, leaked: true });
        persist();
        addLog("pip", out.text, { brain: out.provider, leaked: true, tokens: out.tokens, agent: out.speaker || relay.to });
        setStatus(`RELAY … ${agentLabel(relay.to)}`);
        return;
      }
    }

    const compareLive = chatAgent() === "compare" || String(db.settings.brain_pin || "") === "compare" || /^\s*(compare|ask all)/i.test(text);
    let cmpState = null;
    if (compareLive) cmpState = beginCompareLog(compareProviders(db.settings, providerHealth()));

    const out = await chat(db.settings, db.chat, text || (hasPhoto ? "Identify these roof photos. Do not guess a shingle product." : ""), (msg) => setStatus(msg), { company: db.settings.company, one_liner: db.settings.company }, db, {
      ...(hasPhoto ? { image: images[0], images } : {}),
      onComparePartial: cmpState ? (row, allRows) => updateCompareLog(cmpState, allRows) : undefined,
    });
    const turn = takeLastTurn();
    const leaked = Boolean(out.leaked || turn.leaked);
    if (out.compare) {
      if (cmpState) finalizeCompareLog(cmpState, out.compare);
      else {
        const st = beginCompareLog(out.compare);
        finalizeCompareLog(st, out.compare);
      }
    } else {
      addLog("pip", out.text, {
        brain: out.provider,
        provider: out.provider,
        agent: out.agent || chatAgent(),
        leaked,
        tokens: out.tokens,
      });
    }
    db.chat.push({ role: "pip", content: out.text, brain: out.provider, leaked, compare: out.compare || null, agent: out.agent });
    persist();
    setStatus(pipStatus());
  } catch (e) {
    addLog("pip", String(e.message || e));
    setStatus("CHAT FAIL");
  } finally {
    chatBusy = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function renderChatLog() {
  const log = $("#log");
  if (!log) return;
  log.innerHTML = "";
  if (!db.chat.length) {
    addLog("pip", "CHAT is Super Chat. Paste keys in KEYS. COMPARE tabs every keyed API. LENS IDs shingles, marks damage, or IDs whatever is in the shot.");
  }
  for (const m of db.chat.slice(-80)) {
    if (m.compare) {
      const st = beginCompareLog(m.compare);
      finalizeCompareLog(st, m.compare);
    } else {
      addLog(m.role === "user" ? "user" : "pip", m.content, {
        brain: m.brain,
        leaked: m.leaked,
        agent: m.agent,
      });
    }
  }
}

function lensPhotos() {
  if (!db.lens) db.lens = { mode: "shingle", photos: [], shots: [], last: null, field: null };
  if (!db.lens.mode) db.lens.mode = "shingle";
  if (!Array.isArray(db.lens.photos)) db.lens.photos = [];
  if (!Array.isArray(db.lens.shots)) db.lens.shots = [];
  return db.lens;
}

function lensMode() {
  return String(lensPhotos().mode || "shingle");
}

function shotSpec(id) {
  return SHOTS.find((s) => s.id === id) || SHOTS[0];
}

function haveShots(L) {
  return new Set((L.photos || []).map((p) => p.shot).filter(Boolean));
}

function nextShingleShot(L) {
  const have = haveShots(L);
  return SHINGLE_CORE.find((id) => !have.has(id)) || SHINGLE_EXTRA.find((id) => !have.has(id)) || null;
}

function cycleShot(id) {
  const order = [...SHINGLE_CORE, ...SHINGLE_EXTRA];
  const i = order.indexOf(id);
  return order[(i + 1) % order.length] || SHINGLE_CORE[0];
}

function shingleCoreDone(L) {
  const have = haveShots(L);
  return SHINGLE_CORE.every((id) => have.has(id));
}

async function shareShinglePack({ auto = false } = {}) {
  const L = lensPhotos();
  const coreHave = SHINGLE_CORE.filter((id) => haveShots(L).has(id)).length;
  if (!L.photos.length) return;
  if (!shingleCoreDone(L)) {
    setStatus(`Need ${SHINGLE_CORE.length - coreHave} more core shot${SHINGLE_CORE.length - coreHave === 1 ? "" : "s"}`);
    return;
  }
  const rows = L.photos.filter((p) => p.mode !== "damage");
  const text = buildSharePrompt(rows);
  if (!auto) setStatus("Opening share…");
  try {
    const hit = await shareToChatGpt({ text, photos: rows });
    setStatus(
      hit.ok
        ? `Share · ${hit.count} photo${hit.count === 1 ? "" : "s"} … pick ChatGPT`
        : "Share failed",
    );
  } catch (e) {
    if (/abort|cancel/i.test(String(e.message || e))) setStatus("Share cancelled");
    else setStatus(String(e.message || e).slice(0, 64));
  }
}

function setLensMode(mode, { openCamera = false } = {}) {
  const L = lensPhotos();
  L.mode = mode === "damage" ? "damage" : "shingle";
  L.session = true;
  persist();
  pendingShot = L.mode === "shingle" ? nextShingleShot(L) || SHINGLE_CORE[0] : "damage";
  renderLens();
  if (openCamera) $("#lens-snap")?.click();
}

function damageCount(photos = []) {
  return photos.reduce((n, p) => n + (Array.isArray(p.marks) ? p.marks.length : 0), 0);
}

function editDamagePhoto(index, opts = {}) {
  const L = lensPhotos();
  const photo = L.photos[index];
  if (!photo) return;
  const autoScan = opts.autoScan ?? !(photo.marks && photo.marks.length);
  openMarkEditor({
    url: photo.url,
    marks: photo.marks || [],
    settings: db.settings,
    autoScan,
    onSave: ({ url, markedUrl, marks }) => {
      L.photos[index] = { ...photo, url, markedUrl, marks, shot: "damage", mode: "damage", at: Date.now() };
      persist();
      renderLens();
      setStatus(marks.length ? `Marked · ${marks.length}` : "Saved frame");
    },
    onCancel: () => setStatus("Skipped marks"),
  });
}

function renderLens() {
  document.body.classList.remove("comm");
  const L = lensPhotos();
  const mode = lensMode();
  const last = L.last;
  const v = last?.verdict;
  const k = v?.known || {};
  const n = v?.narrowed || {};
  const marksN = damageCount(L.photos);
  const coreDone = shingleCoreDone(L);
  const nextId = mode === "shingle" ? nextShingleShot(L) : null;
  const next = nextId ? shotSpec(nextId) : null;
  pendingShot = nextId || pendingShot || SHINGLE_CORE[0];
  const have = haveShots(L);
  const coreHave = SHINGLE_CORE.filter((id) => have.has(id)).length;

  const phoneShingle = isPhoneApp() && mode === "shingle";
  const roomLine = phoneShingle
    ? "Take 4 guided roof photos, then share them into ChatGPT."
    : cloudVisionReady(db.settings).length
      ? "Cloud vision keys ready."
      : "Add a vision key in Settings, or use phone Lens → ChatGPT.";

  if (!L.session) {
    $("#view").innerHTML = `
      <div class="lens-pick">
        <h3>Lens</h3>
        <p class="muted">${roomLine}</p>
        <p class="muted">What are you shooting?</p>
        <button type="button" class="lens-pick-card" id="pick-shingle">
          <strong>Shingle identifier</strong>
          <span>${
            isPhoneApp()
              ? "App walks you through 4 required angles, then opens share — pick ChatGPT. Wrapper or back stamp optional for date."
              : "Snap photos — Lens classifies angles and identifies automatically. 95% locks the product; wrapper or back stamp hits 100% on date."
          }</span>
        </button>
        <button type="button" class="lens-pick-card" id="pick-damage">
          <strong>Damage highlighter</strong>
          <span>Circle bruises, granule loss, and lifts. We'll tighten this later.</span>
        </button>
      </div>`;
    $("#pick-shingle").onclick = () => setLensMode("shingle", { openCamera: true });
    $("#pick-damage").onclick = () => setLensMode("damage", { openCamera: true });
    return;
  }

  const status = last?.status || (L.photos.length ? "READING" : "NEED_SHOTS");
  const statusCls = status === "KNOW" || status === "ID" ? "know" : status === "NARROWED" ? "narrow" : "need";
  const needHint =
    mode === "shingle" && v?.needed?.[0] && Number(v?.pct) < 85
      ? `${shotSpec(v.needed[0].id).label} would help — or keep snapping, Lens will sort it.`
      : "";
  const guideShot = next || shotSpec(pendingShot);
  const guideHtml = phoneShingle
    ? `<div class="lens-progress">${SHINGLE_CORE.map((id) => `<i class="${have.has(id) ? "have" : id === guideShot.id ? "now" : ""}" title="${esc(shotSpec(id).label)}"></i>`).join("")}</div>
       <div class="lens-shot-card">
         <div class="lens-shot-kicker">${coreDone ? "Core set complete · optional extras" : `Required ${coreHave + 1} of ${SHINGLE_CORE.length}`}</div>
         <h3>${esc(guideShot.label)}</h3>
         <p>${esc(guideShot.how)}</p>
         <p class="muted">${esc(guideShot.why)}</p>
       </div>`
    : "";
  const cardHtml =
    mode === "damage"
      ? formatChatBody(
          marksN
            ? `${marksN} mark(s) on ${L.photos.length} frame(s). Tap a thumb to edit.`
            : "Snap the damaged area. Circles and arrows come next — we'll dial this in later.",
        )
      : phoneShingle
        ? formatChatBody(
            coreDone
              ? "Core shots ready. Share opens with all photos + a shingle ID prompt — pick ChatGPT."
              : `Snap each required angle above. ${SHINGLE_CORE.length - coreHave} more before ChatGPT share unlocks.`,
          )
        : lensBusy
          ? formatChatBody("Reading photos…")
          : last
            ? formatChatBody(formatVerdict(last))
            : formatChatBody(
                L.photos.length ? "Tap Re-run to identify, or snap another photo." : "Snap the roof to start.",
              );

  const pct = phoneShingle
    ? Math.round((coreHave / SHINGLE_CORE.length) * 100)
    : Number.isFinite(Number(v?.pct))
      ? Number(v.pct)
      : L.photos.length
        ? Math.min(40, L.photos.length * 10)
        : 0;
  const leader =
    (status === "KNOW" && k.manufacturer
      ? `${k.manufacturer} ${k.product}${k.color ? `  · ${k.color}` : ""}`
      : "") ||
    (n.manufacturer ? `${n.manufacturer}${n.product ? ` ${n.product}` : ""}${n.color ? `  · ${n.color}` : ""}` : "");
  const meterHint = phoneShingle
    ? coreDone
      ? "Tap ChatGPT to share photos + prompt."
      : `${guideShot.label}  — ${guideShot.how}`
    : pct >= 100
      ? "Locked. Date stamp read."
      : pct >= 95
        ? "Product locked. Back stamp or wrapper for 100% date."
        : needHint || (L.photos.length ? "Keep snapping — Lens re-runs after each photo." : "Snap the roof to start.");
  const meterHtml =
    mode === "shingle" && !phoneShingle
      ? `<div class="lens-meter${pct >= 95 ? " lock" : pct >= 70 ? " hot" : ""}">
          <div class="lens-meter-top"><strong>${esc(leader || "Collecting tells")}</strong><span>${pct}%</span></div>
          <div class="lens-meter-track"><i style="width:${pct}%"></i></div>
          <p class="muted">${esc(meterHint)}</p>
        </div>`
      : phoneShingle
        ? `<div class="lens-meter${coreDone ? " lock" : coreHave >= 2 ? " hot" : ""}">
          <div class="lens-meter-top"><strong>${esc(coreDone ? "Ready for ChatGPT" : guideShot.label)}</strong><span>${pct}%</span></div>
          <div class="lens-meter-track"><i style="width:${pct}%"></i></div>
          <p class="muted">${esc(meterHint)}</p>
        </div>`
        : "";

  $("#view").innerHTML = `
    <div class="lens-wrap">
      <div class="lens-session-head">
        <button type="button" id="lens-back">Back</button>
        <strong>${mode === "damage" ? "Damage highlighter" : "Shingle identifier"}</strong>
        ${phoneShingle ? `<span class="lens-room on">ChatGPT</span>` : cloudVisionReady(db.settings).length ? `<span class="lens-room on">Cloud</span>` : `<span class="lens-room">Keys</span>`}
      </div>
      ${
        mode === "shingle"
          ? `${guideHtml}${meterHtml}${!phoneShingle && needHint ? `<p class="muted lens-need-hint">${esc(needHint)}</p>` : ""}`
          : `<p class="muted">Snap the damaged area. Marking tools come after the photo.</p>`
      }
      <div class="actions">
        <button type="button" id="lens-snap" class="primary">Snap</button>
        ${mode === "shingle" ? `<button type="button" id="lens-gallery">Gallery</button>` : ""}
        ${
          phoneShingle
            ? `<button type="button" id="lens-send-chatgpt"${coreDone ? ' class="primary"' : ""}${coreDone ? "" : " disabled"}>ChatGPT</button>`
            : `<button type="button" id="lens-read"${L.photos.length ? "" : " disabled"}>${mode === "damage" ? "Mark last" : "Re-run"}</button>`
        }
        <button type="button" id="lens-clear">Start over</button>
      </div>
      <div class="lens-strip" id="lens-strip">${L.photos
        .map(
          (p, i) =>
            `<span class="lens-thumb${p.marks?.length ? " marked" : ""}" data-edit="${i}"><img src="${p.markedUrl || p.url}" alt=""><em data-retag="${i}" title="Tap to override shot tag">${esc(p.shot === "damage" ? "Damage" : p.shot ? shotSpec(p.shot).label || p.shot : "…")}${p.marks?.length ? `  · ${p.marks.length}` : ""}</em><button type="button" data-drop="${i}">…</button></span>`,
        )
        .join("")}</div>
      <div class="lens-status ${statusCls}">${esc(
        phoneShingle
          ? `${coreHave}/${SHINGLE_CORE.length} core  · ${coreDone ? "ready to share" : guideShot.label}`
          : mode === "damage"
            ? `${L.photos.length ? `${L.photos.length} frames` : "No frames"}${marksN ? `  · ${marksN} marks` : ""}`
            : `${pct}%  · ${leader || (L.photos.length ? (lensBusy ? "reading…" : status.replace("_", " ")) : "waiting for photos")}`,
      )}</div>
      <div class="lens-card" id="lens-card">${cardHtml}</div>
      ${
        mode === "shingle" && status === "KNOW" && k.discontinued
          ? `<div class="lens-disc">Discontinued · ${esc(k.manufacturer)} ${esc(k.product)}${k.replacedBy ? `  · current: ${esc(k.replacedBy)}` : ""}</div>`
          : ""
      }
      ${
        mode === "shingle" && n.candidates?.length && status !== "KNOW"
          ? `<div class="lens-cands"><h3>Also in the running</h3>${n.candidates
              .map((c) => `<p>${esc(c.maker)} ${esc(c.line)} ${esc(c.color || "")}${c.discontinued ? "  · discontinued" : ""}</p>`)
              .join("")}</div>`
          : ""
      }
      <div class="actions">
        <button type="button" id="lens-to-job">Save to job</button>
      </div>
    </div>`;
  $("#lens-back").onclick = () => {
    L.session = false;
    persist();
    renderLens();
  };
  $("#lens-strip")?.querySelectorAll("[data-drop]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.drop);
      L.photos.splice(i, 1);
      L.shots = [...new Set(L.photos.map((p) => p.shot).filter(Boolean))];
      L.last = null;
      persist();
      renderLens();
      if (mode === "shingle" && L.photos.length) {
        if (isPhoneApp()) bump();
        else scheduleLensRun(500, { force: true });
      }
    };
  });
  $("#lens-strip")?.querySelectorAll("[data-retag]").forEach((em) => {
    em.onclick = (e) => {
      e.stopPropagation();
      const i = Number(em.dataset.retag);
      const p = L.photos[i];
      if (!p || p.mode === "damage") return;
      p.shot = cycleShot(p.shot || SHINGLE_CORE[0]);
      L.shots = [...new Set(L.photos.map((x) => x.shot).filter(Boolean))];
      L.last = null;
      persist();
      renderLens();
      setStatus(`Retagged · ${shotSpec(p.shot).label}`);
      if (!isPhoneApp()) scheduleLensRun(800, { force: true });
    };
  });
  $("#lens-strip")?.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.edit);
      if (lensMode() === "damage") editDamagePhoto(i);
    };
  });
  const addFiles = async ({ capture, multiple = false }) => {
    try {
      const files = await pickImageFiles({ capture, multiple: multiple || !capture });
      const room = MAX_CHAT_PHOTOS - L.photos.length;
      const picked = files.slice(0, room);
      if (!picked.length) return;
      if (mode === "damage") {
        for (const file of picked) {
          const url = await fileToDataUrl(file, 1400, 0.78);
          await new Promise((resolve) => {
            openMarkEditor({
              url,
              marks: [],
              settings: db.settings,
              autoScan: true,
              onSave: ({ url: raw, markedUrl, marks }) => {
                L.photos.push({ url: raw, markedUrl, marks, shot: "damage", mode: "damage", at: Date.now() });
                persist();
                renderLens();
                resolve();
              },
              onCancel: () => {
                L.photos.push({ url, markedUrl: url, marks: [], shot: "damage", mode: "damage", at: Date.now() });
                persist();
                renderLens();
                resolve();
              },
            });
          });
        }
        return;
      }
      for (const file of picked) {
        const shotId = pendingShot || nextShingleShot(L) || SHINGLE_CORE[0];
        L.photos.push({
          url: await fileToDataUrl(file, 1400, 0.78),
          shot: isPhoneApp() ? shotId : "",
          mode: "shingle",
          at: Date.now(),
        });
      }
      L.shots = [...new Set(L.photos.map((p) => p.shot).filter(Boolean))];
      L.last = null;
      persist();
      renderLens();
      if (isPhoneApp()) {
        bump();
        if (shingleCoreDone(L)) setTimeout(() => shareShinglePack({ auto: true }), 700);
      } else {
        scheduleLensRun(500, { force: true });
      }
    } catch (e) {
      if (!/cancelled/i.test(String(e.message || e))) setStatus(String(e.message || e).slice(0, 50));
    }
  };
  $("#lens-snap").onclick = () => addFiles({ capture: true, multiple: false });
  $("#lens-gallery")?.addEventListener("click", () => addFiles({ capture: false, multiple: true }));
  $("#lens-clear").onclick = () => {
    db.lens = { mode: lensMode(), photos: [], shots: [], last: null, field: null, session: true };
    lastLensSig = "";
    persist();
    pendingShot = SHINGLE_CORE[0];
    renderLens();
  };
  $("#lens-read")?.addEventListener("click", () => runLens());
  $("#lens-send-chatgpt")?.addEventListener("click", () => shareShinglePack());
  $("#lens-to-job").onclick = () => {
    const job = newJob({
      address: wxState.address || db.settings.city || "",
      lat: wxState.lat || db.settings.lat,
      lon: wxState.lon || db.settings.lon,
      lens: last
        ? { status: last.status, known: last.verdict?.known, needed: last.verdict?.needed, at: new Date().toISOString() }
        : null,
      damage_marks: marksN || undefined,
      photos: L.photos.map((p) => p.shot),
    });
    upsertJob(db, job);
    persist();
    tab = "jobs";
    render();
    setStatus("Job saved");
  };
}


async function runLens({ force = false } = {}) {
  const L = lensPhotos();
  const mode = lensMode();
  if (!L.photos.length || lensBusy) return;
  if (isPhoneApp() && mode === "shingle") {
    return shareShinglePack();
  }
  const sig = lensPhotoSig(L);
  if (!force && sig === lastLensSig && L.last) return;
  lensBusy = true;
  setStatus("Reading shots…");
  try {
    if (mode === "damage") {
      editDamagePhoto(L.photos.length - 1, { autoScan: true });
      setStatus("MARK LAST FRAME");
      return;
    }
    if (mode === "field") {
      const hit = await identifyImage(db.settings, L.photos[L.photos.length - 1].url, "lens");
      const idLine = String(hit.text || "").match(/^ID:\s*(.+)$/im);
      L.field = { id: (idLine && idLine[1].trim()) || "subject", text: hit.text, provider: hit.provider };
      persist();
      renderLens();
      setStatus(`LENS · ${String(hit.provider || "ID").toUpperCase()}`);
      lastLensSig = sig;
      return;
    }
    setStatus("Reading shots…");
    const hit = await identifyShingles(db.settings, L.photos, L.photos.map((p) => p.shot));
    if (hit.photos?.length) {
      L.photos = hit.photos;
      L.shots = [...new Set(L.photos.map((p) => p.shot).filter(Boolean))];
    }
    L.last = hit;
    lastLensSig = sig;
    persist();
    renderLens();
    setStatus(
      hit.verdict?.pct >= 100
        ? "LENS · 100%"
        : hit.verdict?.pct >= 95
          ? "LENS · 95%"
          : `LENS · ${Number(hit.verdict?.pct) || 0}%`,
    );
  } catch (e) {
    setStatus(String(e.message || e).slice(0, 70).toUpperCase());
    const card = $("#lens-card");
    if (card) card.innerHTML = formatChatBody(String(e.message || e));
  } finally {
    lensBusy = false;
  }
}

function bump() {
  try {
    window.Capacitor?.Plugins?.Haptics?.impact?.({ style: "MEDIUM" });
  } catch {
    /* web preview */
  }
}

async function copyText(text) {
  const s = String(text || "");
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function fieldMarks() {
  return Array.isArray(db.marks) ? db.marks : [];
}

function doneHouses() {
  return Array.isArray(db.done?.houses) ? db.done.houses : [];
}

function setMarkScale(mark, scale, { live = false } = {}) {
  const next = { ...mark, iconScale: scale };
  const { list } = upsertMark(fieldMarks(), next);
  db.marks = list;
  if (live) {
    updatePinScaleLive("mark", mark.id, { ...next, iconScale: scale });
    return;
  }
  persist();
  paintFieldMap();
}

function selectedDoneHouse() {
  if (!selectedDoneId) return null;
  return doneHouses().find((h) => h.id === selectedDoneId) || null;
}

function donePinScaleUi() {
  return clampPinScale(db.settings.done_pin_scale ?? 1);
}

function setAllDonePinScale(scale, { live = false } = {}) {
  const next = clampPinScale(scale);
  db.settings.done_pin_scale = next;
  if (live) {
    applyDonePinScaleLive(next);
    wirePinSizeSlider();
    return;
  }
  persist();
  paintFieldMap();
  paintFieldSheet();
}

function applyDonePinScale(scale, { live = false } = {}) {
  setAllDonePinScale(scale, { live });
}

function wirePinSizeSlider() {
  const wrap = $("#hs-map-pin-size");
  const placed = doneHouses().filter((h) => Number.isFinite(Number(h.lat))).length;
  if (wrap) wrap.hidden = !placed;
  const pct = Math.round(donePinScaleUi() * 100);
  const slider = $("#hs-done-pin-scale");
  const lab = $("#hs-done-pin-scale-lab");
  if (slider && document.activeElement !== slider) slider.value = String(pct);
  if (lab) lab.textContent = `${pct}%`;
  if (slider && !slider.dataset.wired) {
    slider.dataset.wired = "1";
    slider.oninput = () => {
      const scale = clampPinScale(Number(slider.value) / 100);
      if (lab) lab.textContent = `${Math.round(scale * 100)}%`;
      applyDonePinScale(scale, { live: true });
    };
    slider.onchange = () => {
      applyDonePinScale(clampPinScale(Number(slider.value) / 100), { live: false });
    };
  }
}

function paintFieldMap() {
  setFieldOverlay({
    marks: fieldMarks(),
    done: doneHouses(),
    donePinScale: donePinScaleUi(),
    showMarks: db.settings.showMarks !== false,
    showDone: db.settings.showDone !== false,
    onMark: (m) => openMarkComposer(m),
    onMarkScale: (m, scale, opts) => setMarkScale(m, scale, opts),
    onDone: (h) => {
      if (!h || !Number.isFinite(Number(h.lat))) return;
      selectedDoneId = h.id;
      const box = $("#hs-addr-q");
      if (box && h.address) box.value = h.address;
      paintFieldSheet();
      void onHailTap(Number(h.lat), Number(h.lon), { address: h.address || "" });
    },
  });
}

function closeComposer() {
  markDraft = null;
  const el = $("#hs-composer");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
}

function composerKindButtons(kind) {
  const k = kind === "atlas" || kind === "disc" ? "ping" : kind;
  return COMPOSE_KINDS.map(
    (x) =>
      `<button type="button" class="hs-kind${x.id === k ? " on" : ""}" data-kind="${esc(x.id)}" style="--k:${x.color}">${esc(x.label)}</button>`,
  ).join("");
}

function composerProductButtons(d) {
  const pid = productIdOf(d) || db.settings.marksLastProduct || "";
  const chips = mailerProducts()
    .map(
      (p) =>
        `<button type="button" class="hs-prod${pid === p.id ? " on" : ""}" data-product="${esc(p.id)}" style="--k:${p.color}">${esc(p.short)}${p.discontinued ? "" : ""}</button>`,
    )
    .join("");
  const otherOn = pid.startsWith("custom:") || pid === "other";
  return `${chips}<button type="button" class="hs-prod${otherOn ? " on" : ""}" data-product="other">Other</button>`;
}

function applyProductToDraft(productId) {
  if (!markDraft) return;
  markDraft.kind = "ping";
  if (productId === "other") {
    markDraft.productId = markDraft.productId?.startsWith("custom:") ? markDraft.productId : "other";
    if (!markDraft.label || mailerProducts().some((p) => p.label === markDraft.label)) markDraft.label = "";
    return;
  }
  const prod = mailerProducts().find((p) => p.id === productId);
  markDraft.productId = productId;
  if (prod) markDraft.label = prod.label;
}

function fillComposer() {
  const el = $("#hs-composer");
  if (!el || !markDraft) return;
  const d = markDraft;
  const meta = kindMeta(d.kind);
  const zone = d.kind === "zone";
  const ping = isProductPing(d);
  const prod = productForMark(d);
  el.hidden = false;
  el.innerHTML = `
    <div class="hs-composer-card">
      <header>
        <strong>${d.id && fieldMarks().some((m) => m.id === d.id) ? "Edit pin" : "Drop a pin"}</strong>
        <button type="button" id="hs-comp-x">Close</button>
      </header>
      <div class="hs-kinds">${composerKindButtons(d.kind)}</div>
      ${ping ? `<div class="hs-prods">${composerProductButtons(d)}</div>` : ""}
      <label>${ping ? "Product" : "Label"}<input id="hs-comp-label" maxlength="80" value="${esc(d.label || prod?.label || meta.label)}" placeholder="GAF Timberline HD, Belmont, GlassMaster…" /></label>
      <label>Address<input id="hs-comp-addr" value="${esc(d.address || "")}" placeholder="Looking up address…" /></label>
      <label>Comment<textarea id="hs-comp-note" rows="3" maxlength="800" placeholder="We finished this neighborhood. Discontinued Atlas 3-tab…">${esc(d.note || "")}</textarea></label>
      ${
        zone
          ? `<label>Zone size <span id="hs-comp-rad-lab">${Math.round(Number(d.radiusM) || 160)} m</span>
              <input id="hs-comp-rad" type="range" min="40" max="800" step="10" value="${esc(String(d.radiusM || 160))}" />
            </label>`
          : ""
      }
      <div class="hs-composer-actions">
        <button type="button" class="primary" id="hs-comp-save">Save pin</button>
        ${fieldMarks().some((m) => m.id === d.id) ? `<button type="button" id="hs-comp-del">Delete</button>` : ""}
      </div>
    </div>`;
  el.querySelectorAll(".hs-kind").forEach((b) => {
    b.onclick = () => {
      markDraft.kind = b.dataset.kind;
      if (markDraft.kind === "ping") {
        applyProductToDraft(db.settings.marksLastProduct || "atlas-glassmaster");
      } else {
        markDraft.productId = "";
        markDraft.label = kindMeta(markDraft.kind).label;
      }
      if (markDraft.kind === "zone" && !markDraft.radiusM) markDraft.radiusM = 160;
      db.settings.marksLastKind = markDraft.kind;
      persist();
      fillComposer();
    };
  });
  el.querySelectorAll(".hs-prod").forEach((b) => {
    b.onclick = () => {
      applyProductToDraft(b.dataset.product);
      db.settings.marksLastKind = "ping";
      db.settings.marksLastProduct = markDraft.productId || b.dataset.product;
      persist();
      fillComposer();
    };
  });
  const lab = $("#hs-comp-label");
  if (lab) lab.oninput = () => {
    markDraft.label = lab.value;
  };
  const addr = $("#hs-comp-addr");
  if (addr) addr.oninput = () => {
    markDraft.address = addr.value;
  };
  const note = $("#hs-comp-note");
  if (note) note.oninput = () => {
    markDraft.note = note.value;
  };
  const rad = $("#hs-comp-rad");
  if (rad) {
    rad.oninput = () => {
      markDraft.radiusM = Number(rad.value);
      const rl = $("#hs-comp-rad-lab");
      if (rl) rl.textContent = `${Math.round(markDraft.radiusM)} m`;
    };
  }
  $("#hs-comp-x").onclick = () => closeComposer();
  $("#hs-comp-save").onclick = () => saveMarkDraft();
  const del = $("#hs-comp-del");
  if (del) del.onclick = () => {
    db.marks = removeMark(fieldMarks(), markDraft.id);
    persist();
    closeComposer();
    paintFieldMap();
    paintFieldSheet();
    setStatus("Pin removed");
  };
}

async function openMarkComposer(seed) {
  const lat = Number(seed.lat);
  const lon = Number(seed.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  bump();
  const existing = seed.id ? fieldMarks().find((m) => m.id === seed.id) : null;
  let kind = existing?.kind || db.settings.marksLastKind || "ping";
  if (kind === "atlas" || kind === "disc") kind = "ping";
  const productId = existing?.productId || (kind === "ping" ? db.settings.marksLastProduct || "atlas-glassmaster" : "");
  const prod = productId ? mailerProducts().find((p) => p.id === productId) : null;
  markDraft = existing
    ? { ...existing }
    : newMark({
        lat,
        lon,
        kind,
        productId,
        label: prod?.label || kindMeta(kind).label,
        address: seed.address || "",
        note: seed.note || "",
      });
  fillComposer();
  if (!markDraft.address) {
    try {
      const geo = await reverseGeocode(lat, lon);
      if (markDraft && !markDraft.address && geo?.address) {
        markDraft.address = geo.address;
        const inp = $("#hs-comp-addr");
        if (inp && !inp.value) inp.value = geo.address;
      }
    } catch {
      /* address optional */
    }
  }
}

function saveMarkDraft() {
  if (!markDraft) return;
  if (isProductPing(markDraft)) {
    markDraft.kind = "ping";
    if (!markDraft.productId || markDraft.productId === "other") {
      markDraft.productId = customProductId(markDraft.label || "other");
    }
  }
  const next = newMark({
    ...markDraft,
    label: String(markDraft.label || productForMark(markDraft)?.label || kindMeta(markDraft.kind).label).trim(),
    note: String(markDraft.note || "").trim(),
    address: String(markDraft.address || "").trim(),
  });
  const hit = upsertMark(fieldMarks(), next);
  db.marks = hit.list;
  db.settings.marksLastKind = next.kind;
  if (next.productId) db.settings.marksLastProduct = next.productId;
  persist();
  closeComposer();
  paintFieldMap();
  paintFieldSheet();
  setStatus(`${kindMeta(next.kind).label} saved`);
}

function selectedMarkKind() {
  return $("#hs-mark-filter")?.value || "all";
}

function paintFieldSheet() {
  const root = $("#hs-field");
  if (!root) return;
  const marks = fieldMarks();
  const kind = selectedMarkKind();
  const shown = filterMarks(marks, kind);
  const houses = doneHouses();
  const placed = houses.filter((h) => Number.isFinite(Number(h.lat)));
  const rawText = String(db.done?.text || "");
  const selHouse = selectedDoneHouse();
  root.innerHTML = `
    <div class="hs-field-head">
      <strong>Completed jobs</strong>
      <span class="muted">${placed.length ? `${placed.length} yellow pin${placed.length === 1 ? "" : "s"} on map` : "Paste the houses you already built"}</span>
    </div>
    <p class="muted">One address per line. Load them to drop a yellow pin on each finished house. Tap a pin to load storm dates for that house. Pin size slider is on the map. Lines without a city use Settings city.</p>
    <textarea id="hs-done-text" rows="5" placeholder="400 S Bryant, Edmond, OK&#10;2521 Tredington Way, Edmond, OK">${esc(rawText)}</textarea>
    <div class="hs-mark-tools">
      <button type="button" class="primary" id="hs-done-load"${doneBusy ? " disabled" : ""}>${doneBusy ? "Placing…" : "Load on map"}</button>
      <button type="button" id="hs-done-clear"${houses.length ? "" : " disabled"}>Clear</button>
      ${selHouse ? `<button type="button" id="hs-done-all-pins">Clear selection</button>` : ""}
    </div>
    <div class="hs-field-head">
      <strong>Field marks</strong>
      <span class="muted">${marks.length ? `${marks.length} dropped` : "Hold the map to drop a pin"} — hold any pin to resize</span>
    </div>
    <div class="hs-mark-tools">
      <select id="hs-mark-filter" aria-label="Filter marks">
        <option value="all"${kind === "all" ? " selected" : ""}>All marks</option>
        <option value="work"${kind === "work" ? " selected" : ""}>Work done</option>
        <option value="zone"${kind === "zone" ? " selected" : ""}>Work zone</option>
        <option value="note"${kind === "note" ? " selected" : ""}>Notes</option>
        <option value="ping"${kind === "ping" ? " selected" : ""}>All product pings</option>
        ${mailerProducts()
          .map((p) => `<option value="p:${esc(p.id)}"${kind === `p:${p.id}` ? " selected" : ""}>${esc(p.label)}</option>`)
          .join("")}
      </select>
      <button type="button" id="hs-mark-copy"${shown.length ? "" : " disabled"}>Copy list</button>
      <button type="button" id="hs-mark-csv"${shown.length ? "" : " disabled"}>CSV</button>
      <button type="button" id="hs-mark-letter"${shown.length ? "" : " disabled"}>Draft letter</button>
    </div>
    <div class="hs-mark-list">${
      shown.length
        ? shown
            .map(
              (m) =>
                `<button type="button" class="hs-mark-row" data-id="${esc(m.id)}"><i class="hs-dot" style="background:${kindMeta(m.kind).color}"></i><span><strong>${esc(m.label || kindMeta(m.kind).label)}</strong>${esc(m.address || `${Number(m.lat).toFixed(5)}, ${Number(m.lon).toFixed(5)}`)}${m.note ? `<em>${esc(m.note)}</em>` : ""}</span></button>`,
            )
            .join("")
        : `<p class="muted">Hold a house to ping Atlas, GAF HD, Belmont, Independence, or type any other product.</p>`
    }</div>`;
  const filter = $("#hs-mark-filter");
  if (filter) filter.onchange = () => paintFieldSheet();
  const doneBox = $("#hs-done-text");
  if (doneBox) {
    doneBox.oninput = () => {
      if (!db.done) db.done = { text: "", houses: [], geo: {} };
      db.done.text = doneBox.value;
      persist();
    };
  }
  const loadBtn = $("#hs-done-load");
  if (loadBtn) loadBtn.onclick = () => loadDoneAddresses();
  const allPins = $("#hs-done-all-pins");
  if (allPins) {
    allPins.onclick = () => {
      selectedDoneId = null;
      hidePinScalePopover();
      paintFieldSheet();
    };
  }
  wirePinSizeSlider();
  const clr = $("#hs-done-clear");
  if (clr) {
    clr.onclick = () => {
      selectedDoneId = null;
      hidePinScalePopover();
      db.done = { text: db.done?.text || "", houses: [], geo: db.done?.geo || {} };
      persist();
      paintFieldMap();
      paintFieldSheet();
      setStatus("Completed markers cleared");
    };
  }
  $("#hs-mark-copy").onclick = async () => {
    const ok = await copyText(marksPlainList(shown));
    setStatus(ok ? `Copied ${shown.length} marks` : "Copy failed");
  };
  $("#hs-mark-csv").onclick = async () => {
    const ok = await copyText(marksCsv(shown));
    setStatus(ok ? "CSV copied" : "Copy failed");
  };
  $("#hs-mark-letter").onclick = async () => {
    const targets = shown.filter(isProductPing);
    const pack = outreachDraft(targets.length ? targets : shown, {
      company: db.settings.company || "Ground Control",
      operator: db.settings.operator || "",
    });
    const ok = await copyText(`${pack.subject}\n\n${pack.body}`);
    setStatus(ok ? `Letter drafted for ${pack.count} homes` : "Copy failed");
  };
  root.querySelectorAll(".hs-mark-row").forEach((b) => {
    b.onclick = () => {
      const m = fieldMarks().find((x) => x.id === b.dataset.id);
      if (!m) return;
      flyToPin(m.lat, m.lon, 20);
      openMarkComposer(m);
    };
  });
}

function paintLayerToggles() {
  const el = $("#hs-layers");
  if (!el) return;
  const doneOn = db.settings.showDone !== false;
  const marksOn = db.settings.showMarks !== false;
  const meOn = db.settings.showMyLocation !== false;
  el.innerHTML = `
    <button type="button" data-ov="me" class="hs-me-toggle ${meOn ? "on" : ""}" aria-label="My location" title="Show my location"><span class="hs-me-dot" aria-hidden="true"></span></button>
    <button type="button" data-ov="done" class="${doneOn ? "on" : ""}">Done</button>
    <button type="button" data-ov="marks" class="${marksOn ? "on" : ""}">Marks</button>`;
  el.onclick = (e) => {
    const b = e.target.closest("button[data-ov]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    if (b.dataset.ov === "me") {
      db.settings.showMyLocation = !meOn;
      setMyLocationVisible(db.settings.showMyLocation);
    }
    if (b.dataset.ov === "done") db.settings.showDone = !doneOn;
    if (b.dataset.ov === "marks") db.settings.showMarks = !marksOn;
    persist();
    paintLayerToggles();
    paintFieldMap();
  };
}


async function ensureDoneHousesPlaced() {
  const text = (db.done?.text || "").trim();
  const lines = parseDoneList(text);
  if (!lines.length) {
    paintFieldMap();
    return;
  }
  const houses = doneHouses();
  const placed = houses.filter((h) => Number.isFinite(Number(h.lat))).length;
  if (placed >= lines.length && houses.length >= lines.length) {
    paintFieldMap();
    return;
  }
  if (!doneBusy) await loadDoneAddresses();
}

async function loadDoneAddresses() {
  if (doneBusy) return;
  const text = $("#hs-done-text")?.value ?? db.done?.text ?? "";
  const parsed = parseDoneList(text);
  if (!parsed.length) {
    setStatus("Paste completed addresses first");
    return;
  }
  const lines = parsed.slice(0, MAX_DONE);
  if (!db.done) db.done = { text: "", houses: [], geo: {} };
  db.done.text = text;
  persist();
  doneBusy = true;
  paintFieldSheet();
  const cityHint = db.settings.city || "Edmond, OK";
  const geo = { ...(db.done.geo || {}) };
  const houses = [];
  let miss = 0;
  try {
    for (let i = 0; i < lines.length; i++) {
      const addr = lines[i];
      const q = withCity(addr, cityHint);
      const cacheKey = q.toLowerCase();
      setStatus(`Placing ${i + 1} of ${lines.length}…`);
      let hit = geo[cacheKey];
      if (!geoCacheOk(hit, q)) {
        try {
          const found = await geocodeAddress(q);
          const top = found[0];
          hit = {
            lat: top.lat,
            lon: top.lon,
            address: top.address || addr,
            v: 2,
            houseOk: Boolean(top.houseOk),
            source: top.source || "",
          };
          geo[cacheKey] = hit;
        } catch {
          hit = { lat: null, lon: null, address: addr, v: 2, houseOk: false };
          miss += 1;
        }
        await new Promise((r) => setTimeout(r, 900));
      }
      houses.push(
        normalizeDoneHouse(
          {
            id: `done-${i}`,
            address: hit.address || addr,
            lat: hit.lat,
            lon: hit.lon,
          },
          `done-${i}`,
        ),
      );
    }
    db.done = { text, houses, geo };
    persist();
    paintFieldMap();
    paintFieldSheet();
    const n = houses.filter((h) => Number.isFinite(Number(h.lat))).length;
    const capped = parsed.length > MAX_DONE ? `  — first ${MAX_DONE}` : "";
    setStatus(`${n} yellow marker${n === 1 ? "" : "s"}${miss ? `  — ${miss} not found` : ""}${capped}`);
  } catch (e) {
    setStatus(String(e.message || e).slice(0, 64));
  } finally {
    doneBusy = false;
    paintFieldSheet();
  }
}

function onMapHold(lat, lon) {
  openMarkComposer({ lat, lon });
}

let wxRenderGen = 0;
let hailTapGen = 0;

function wireHsShell(cfg) {
  const styles = $("#hs-styles");
  if (styles && cfg) {
    styles.innerHTML = baseLayerButtons(cfg, esc);
    styles.onclick = (e) => {
      const b = e.target.closest("button[data-layer]");
      if (!b) return;
      setMapLayer(b.dataset.layer);
      styles.querySelectorAll("button[data-layer]").forEach((x) => x.classList.toggle("on", x === b));
    };
  }
  const searchForm = $("#hs-search");
  if (searchForm) {
    searchForm.onsubmit = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const q = ($("#hs-addr-q")?.value || "").trim();
      if (!q) return;
      setStatus("Finding place…");
      try {
        const hits = await geocodeAddress(q);
        const hit = hits[0];
        if (!hit || !Number.isFinite(hit.lat)) throw new Error("no match");
        flyToPin(hit.lat, hit.lon, 20);
        await onHailTap(hit.lat, hit.lon, { address: hit.address || q });
      } catch (err) {
        setStatus(String(err.message || err).slice(0, 48));
      }
    };
    searchForm.addEventListener("click", (e) => e.stopPropagation());
    searchForm.addEventListener("mousedown", (e) => e.stopPropagation());
    searchForm.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  }
  for (const id of ["hs-layers", "hs-composer"]) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  }
}

async function finishWxBoot(gen) {
  void ensureDoneHousesPlaced();
  try {
    const center = await resolveMapCenter(db.settings);
    if (gen !== wxRenderGen || !isHailTab() || !mapIsLive()) return;
    persist();
    const cfg = await loadMapConfig(db.settings);
    if (gen !== wxRenderGen || !isHailTab() || !mapIsLive()) return;
    cfg.center = { ...cfg.center, ...center };
    wireHsShell(cfg);
    refreshMapSize();
    if (Number.isFinite(center.lat) && Number.isFinite(center.lon)) {
      flyToPin(center.lat, center.lon, undefined, { stay: true });
    }
  } catch (e) {
    if (isHailTab()) setStatus(String(e.message || e).slice(0, 48));
  }
}

async function renderWx() {
  document.body.classList.remove("comm");
  setHailScopeMode(true);
  document.body.classList.add("hs-tab", "wx-tab");

  if (mapIsLive()) {
    refreshMapSize();
    paintLayerToggles();
    paintFieldMap();
    paintFieldSheet();
    wirePinSizeSlider();
    syncHailBottomChrome();
    setWxMapExpanded(true); void ensureDoneHousesPlaced();
    setStatus("");
    return;
  }

  leaveWx();
  setHailScopeMode(true);
  document.body.classList.add("hs-tab", "wx-tab");
  setStatus("");

  wxRenderGen += 1;
  const gen = wxRenderGen;

  $("#view").innerHTML = `
    <div class="hs-wrap">
      <div class="hs-map-shell" id="hs-map-shell">
        <div class="hs-layers" id="hs-layers"></div>
        <div class="hs-map-bar" id="hs-map-bar">
          <div class="hs-map-pin-size" id="hs-map-pin-size" hidden aria-label="Yellow pin size">
            <span class="hs-map-pin-size-lab">Pins</span>
            <span class="hs-pin-size-val" id="hs-done-pin-scale-lab">100%</span>
            <input type="range" id="hs-done-pin-scale" min="25" max="250" step="5" value="100" aria-label="Yellow pin size" />
          </div>
          <div class="hs-styles" id="hs-styles"></div>
        </div>
        <div id="wx-map"></div>
        <div class="hs-composer" id="hs-composer" hidden></div>
      </div>
      <div class="hs-bottom-panel" id="hs-bottom-panel">
        <form class="hs-goto" id="hs-search" autocomplete="off">
          <input type="search" id="hs-addr-q" placeholder="Go to an address" enterkeyhint="search" />
        </form>
        <div class="hs-sheet" id="hs-sheet">
          <p class="hs-empty">Tap the map or type an address above. Storm dates show up here.</p>
        </div>
      </div>
      <div class="hs-field" id="hs-field"></div>
    </div>`;

  try {
    const center = defaultMapCenter(db.settings);
    const cfg = quickMapConfig(db.settings);
    wireHsShell(cfg);
    mountMap($("#wx-map"), cfg, { center, onTap: onHailTap, onHold: onMapHold, product: "hail", base: "sat", initialPin: false });
    clearWxPin();
    wxState.lat = null;
    wxState.lon = null;
    wxState.address = "";
    wxState.data = null;
    wxState.viewport = false;
    bindWxMapScrollExpand($("#view"), $("#hs-map-shell"), $("#hs-sheet"), $("#tabs"));
    bindSelectPinDblTap(onHailViewport);
    paintLayerToggles();
    setMyLocationVisible(db.settings.showMyLocation !== false);
    paintFieldMap();
    paintFieldSheet();
    wirePinSizeSlider();
    syncHailBottomChrome();
    setWxMapExpanded(true);
    refreshMapSize();
    void finishWxBoot(gen);
  } catch (e) {
    if (!isHailTab()) return;
    $("#view").innerHTML = `<p class="muted">${esc(String(e.message || e))}</p>`;
  }
}

async function onHailViewport() {
  const gen = ++hailTapGen;
  clearSelectedStormDate();
  clearWxPin();
  wxState.lat = null;
  wxState.lon = null;
  wxState.address = "Map view";
  wxState.viewport = true;
  wxState.data = null;
  const sheet = $("#hs-sheet");
  if (sheet) {
    sheet.innerHTML = '<p class="hs-pin"><strong>Map view</strong>Searching visible area…</p><p class="hs-empty">Loading storm history…</p>';
  }
  setStatus("Searching map view…");
  const onRefetch = async (filters) => {
    if (gen !== hailTapGen) return null;
    const fresh = await viewportDossier(db.settings, filters);
    if (gen !== hailTapGen) return null;
    wxState.data = fresh;
    return fresh;
  };
  try {
    const data = await viewportDossier(db.settings);
    if (gen !== hailTapGen || !isHailTab()) return;
    if (!data) {
      if (sheet) sheet.innerHTML = '<p class="hs-empty">Could not load storms for this map view.</p>';
      setStatus("");
      return;
    }
    wxState.data = data;
    syncHailScopeView(sheet, data, esc, { onRefetch, fit: false, revealSheet: false });
    setStatus("");
  } catch (e) {
    if (gen !== hailTapGen) return;
    if (sheet) sheet.innerHTML = `<p class="hs-empty">${esc(String(e.message || e))}. Check the network and try again.</p>`;
    setStatus("");
  }
}

async function onHailTap(lat, lon, { address: prefAddr } = {}) {
  const gen = ++hailTapGen;
  clearSelectedStormDate();
  wxState.lat = lat;
  wxState.lon = lon;
  wxState.viewport = false;
  if (prefAddr) wxState.address = prefAddr;
  setWxPin(lat, lon);
  const sheet = $("#hs-sheet");
  const addr0 = prefAddr || wxState.address || "Dropped pin";
  if (sheet) {
    sheet.innerHTML = `<p class="hs-pin"><strong>${esc(addr0)}</strong>Finding storms…</p><p class="hs-empty">Loading storm history…</p>`;
  }
  revealHailAddressPeek();
  setStatus("Finding storms…");
  const onRefetch = async (filters) => {
    if (gen !== hailTapGen) return null;
    const fresh = await refetchDossier(db.settings, lat, lon, wxState.address, filters);
    if (gen !== hailTapGen) return null;
    wxState.data = fresh;
    return fresh;
  };
  try {
    const data = await pinDossier(db.settings, lat, lon, {
      address: prefAddr || wxState.address || "",
      onPartial: (partial) => {
        if (gen !== hailTapGen || !isHailTab()) return;
        const nextAddr = partial.address || "";
        if (!prefAddr || parseStreetAddress(nextAddr).house) wxState.address = nextAddr;
        wxState.data = partial;
        patchHailScopePartial($("#hs-sheet"), partial, esc);
      },
    });
    if (gen !== hailTapGen || !isHailTab()) return;
    if (!data) {
      if (sheet) sheet.innerHTML = `<p class="hs-empty">Could not load storm data. Try another pin.</p>`;
      setStatus("");
      return;
    }
    wxState.address = data.address || "";
    wxState.data = data;
    syncHailScopeView($("#hs-sheet"), data, esc, { onRefetch, revealSheet: false });
    if (!(data.hail || []).length) {
      if (sheet) {
        const loading = sheet.querySelector(".hs-empty");
        if (loading) loading.textContent = "Searching a longer hail window…";
      }
      const full = await onRefetch({ days: 730 });
      if (gen !== hailTapGen || !isHailTab()) return;
      if (full) {
        wxState.data = full;
        syncHailScopeView($("#hs-sheet"), full, esc, { onRefetch, revealSheet: false });
      }
    }
    setStatus("");
  } catch (e) {
    if (gen !== hailTapGen) return;
    if (sheet) sheet.innerHTML = `<p class="hs-empty">${esc(String(e.message || e))}. Check the network and try another pin.</p>`;
    setStatus("");
  }
}

async function onWxTap(lat, lon) {
  return onHailTap(lat, lon);
}

function renderJobs() {
  leaveWx();
  document.body.classList.remove("comm");
  const jobs = db.jobs || [];
  const marks = fieldMarks();
  const houses = doneHouses();
  const placed = houses.filter((h) => Number.isFinite(Number(h.lat)));
  $("#view").innerHTML = `
    <h3>Jobs</h3>
    <p class="muted">Roof inspections on this phone, completed houses, and drive-by field marks.</p>
    <div class="actions"><button type="button" id="job-new" class="primary">New job</button></div>
    <div class="job-list">${
      jobs.length
        ? jobs
            .map(
              (j) =>
                `<article class="job-card" data-id="${esc(j.id)}"><strong>${esc(j.address || "Unpinned")}</strong><p class="muted">${esc(jobSummary(j))}</p><p class="muted">${esc(String(j.created || "").slice(0, 10))}</p></article>`,
            )
            .join("")
        : `<p class="muted">No local jobs yet. Identify a shingle, mark damage, or pin hail — then save to a job.</p>`
    }</div>
    <h3>Completed jobs</h3>
    <p class="muted">${placed.length ? `${placed.length} yellow markers on HailScope. Paste more addresses there to add houses.` : "Paste finished house addresses on HailScope to plot yellow markers."}</p>
    ${placed
      .slice(0, 20)
      .map((h) => `<article class="job-card"><strong>${esc(h.address || "House")}</strong></article>`)
      .join("")}
    <h3>Field marks</h3>
    <p class="muted">${marks.length ? `${marks.length} pins. Hold the HailScope map to add Atlas / work / zone labels.` : "Hold a house on HailScope to drop a custom pin."}</p>
    ${marks
      .slice(0, 30)
      .map(
        (m) =>
          `<article class="job-card"><strong>${esc(m.label || kindMeta(m.kind).label)}</strong><p class="muted">${esc(m.address || "")}</p>${m.note ? `<p class="muted">${esc(m.note)}</p>` : ""}</article>`,
      )
      .join("")}`;
  $("#job-new").onclick = () => {
    const job = newJob({ address: wxState.address || "", lat: wxState.lat, lon: wxState.lon });
    upsertJob(db, job);
    persist();
    renderJobs();
  };
}

function renderKeys() {
  leaveWx();
  document.body.classList.remove("comm");
  const s = db.settings;
  const health = providerHealth();
  const keyedNow = PROVIDERS.filter((p) => normalizeApiKey(s[p.field])).map((p) => p.label.toUpperCase());
  const diag = httpDiag();
  const keyRows = PROVIDERS.map((p) => {
    const info = keyTag(s, p, health[p.id]);
    const hint = keyHint(s, p);
    const has = Boolean(normalizeApiKey(s[p.field]));
    const get = p.keyUrl ? `<a class="key-get" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">Get key</a>` : "";
    return `<div class="key-row ${esc(info.state)}">
      <div class="key-meta"><span class="key-name">${esc(p.label)}</span><span class="key-tag">${esc(info.tag)}${hint ? `  · ${esc(hint)}` : ""}</span></div>
      <p class="muted key-tip">${esc(p.tip || "")} ${get}${has ? ` … <button type="button" class="key-clear" data-field="${esc(p.field)}">Clear</button>` : ""}</p>
      <input id="set-${esc(p.field)}" type="text" autocomplete="off" spellcheck="false" value="" placeholder="${esc(has ? "Paste to replace" : "Paste key — saves as you type")}" data-field="${esc(p.field)}" />
    </div>`;
  }).join("");
  const phone = isPhoneApp();
  const roomBlock = phone
    ? `<p class="muted">Phone Lens shares guided photos to ChatGPT — no API keys needed for shingle ID. Keys below are optional for chat.</p>`
    : "";
  $("#view").innerHTML = `
    <h3>Settings</h3>
    <div class="field"><span>Name</span><input id="set-op" value="${esc(s.operator || "")}" /></div>
    <div class="field"><span>Company</span><input id="set-co" value="${esc(s.company || "")}" /></div>
    <div class="field"><span>City</span><input id="set-city" value="${esc(s.city || "")}" placeholder="Edmond, OK" /></div>
    <div class="field"><span>Units</span>
      <select id="set-units">
        <option value="imperial"${(s.units || "imperial") === "imperial" ? " selected" : ""}>Imperial — miles</option>
        <option value="metric"${s.units === "metric" ? " selected" : ""}>Metric — kilometers</option>
      </select>
    </div>
    ${roomBlock}
    <p class="muted">Network: ${diag.nativeHttp ? "native" : "web fetch"} · ${esc(diag.platform)}</p>
    <p class="muted">${phone ? "Chat keys optional on phone." : keyedNow.length ? `Saved: ${esc(keyedNow.join(" · "))}` : "Paste keys for web Lens or chat."}</p>
    <h3>API keys</h3>
    <p class="muted">${phone ? "Optional — for Super Chat if you want cloud replies on the phone." : "Chat and web Lens. Gemini, OpenAI, Anthropic, or OpenRouter."}</p>
    <div class="key-list">${keyRows}</div>
    <div class="actions"><button type="button" id="keys-test">Test keys</button></div>
    <h3>Discontinued lookup</h3>
    <p class="muted">Catalog includes GAF Timberline HD, CertainTeed Independence/Hatteras, OC Duration COOL, Atlas GlassMaster, and more. Lens only claims a discontinued line when the match is unique.</p>
    <p class="muted">${esc(String(discontinuedFor().length))} discontinued color/line rows on this device.</p>`;
  const op = $("#set-op");
  if (op) op.oninput = () => {
    db.settings.operator = op.value;
    persist();
  };
  const co = $("#set-co");
  if (co) co.oninput = () => {
    db.settings.company = co.value;
    persist();
  };
  const cityInp = $("#set-city");
  if (cityInp) cityInp.oninput = () => {
    db.settings.city = cityInp.value;
    persist();
  };
  const units = $("#set-units");
  if (units) {
    units.onchange = () => {
      db.settings.units = units.value === "metric" ? "metric" : "imperial";
      setWxUnits(db.settings.units);
      persist();
    };
  }
  document.querySelectorAll(".key-row input[data-field]").forEach((inp) => {
    inp.oninput = () => {
      const field = inp.dataset.field;
      db.settings[field] = inp.value;
      persist();
      queueKeyValidate(field);
    };
  });
  document.querySelectorAll(".key-clear").forEach((b) => {
    b.onclick = () => clearProviderKey(b.dataset.field);
  });
  $("#keys-test").onclick = async () => {
    setStatus("Checking keys…");
    try {
      await validateKeyed(db.settings);
      db.settings.brain_health = providerHealth();
      persist();
      renderKeys();
      setStatus("Keys checked");
    } catch (e) {
      setStatus(String(e.message || e).slice(0, 50).toUpperCase());
    }
  };
}

function render() {
  document.body.classList.toggle("wx-tab", isHailTab());
  document.body.classList.toggle("hs-tab", isHailTab());
  $("#tabs").querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab || (isHailTab() && b.dataset.tab === "hailscope" && tab === "wx")));
  if (tab === "lens") {
    leaveWx();
    renderLens();
  } else if (isHailTab()) {
    renderWx();
  } else {
    leaveWx();
    if (tab === "jobs") renderJobs();
    else if (tab === "keys") renderKeys();
  }
  renderPrivacy();
  paintBrainStrip();
}

function boot() {
  renderPrivacy();
  $("#privacy-tog").onclick = () => {
    const secure = privacyOn(db.settings);
    db.settings.privacy_mode = secure ? "leaky" : "secure";
    persist();
    renderPrivacy();
    setStatus(privacyOn(db.settings) ? "On-device — Lens blocked" : "Cloud — Lens on");
  };
  const commTog = $("#comm-tog");
  if (commTog) {
    commTog.onclick = () => {
      document.body.classList.add("comm");
      renderChatLog();
      $("#input")?.focus();
    };
  }
  $("#comm-close").onclick = () => document.body.classList.remove("comm");
  $("#tabs").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    const next = b.dataset.tab;
    if ((next === "hailscope" || next === "wx") && (tab === "hailscope" || tab === "wx") && mapIsLive()) {
      advanceHailBottomReveal();
      return;
    }
    tab = next;
    if (tab === "chat" || tab === "radio") {
      $("#tabs").querySelectorAll("[data-tab]").forEach((btn) => btn.classList.toggle("on", btn.dataset.tab === "chat"));
      document.body.classList.add("comm");
      renderChatLog();
      return;
    }
    document.body.classList.remove("comm");
    render();
  };
  $("#send").onclick = () => sendChat();
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  $("#attach-btn").onclick = () => attachChatPhoto();
  $("#lens-btn").onclick = () => {
    document.body.classList.remove("comm");
    tab = "lens";
    render();
  };
  $("#agent-trig").onclick = () => openAgentSheet();
  $("#agent-sheet-bg").onclick = () => closeAgentSheet();
  $("#agent-sheet-close").onclick = () => closeAgentSheet();
  $("#input").addEventListener("paste", async (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
    if (!items.length) return;
    e.preventDefault();
    for (const it of items.slice(0, MAX_CHAT_PHOTOS - pendingChatImages.length)) {
      const file = it.getAsFile();
      if (file) pendingChatImages.push(await fileToDataUrl(file, 1280, 0.72));
    }
    document.body.classList.add("comm");
    paintChatAttach();
  });
  render();
  setStatus("");
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isHailTab()) refreshMapSize();
  });
  window.addEventListener("resize", () => {
    if (isHailTab()) refreshMapSize();
  });
  void import("@capacitor/app")
    .then(({ App }) => {
      App.addListener("appStateChange", ({ isActive }) => {
        if (isActive && isHailTab()) refreshMapSize();
      });
    })
    .catch(() => {});
}

void matchCatalog;
void uid;
boot();
