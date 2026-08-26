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
import { desktopConfigured } from "./desktop.js";
import { httpDiag } from "./net.js";
import {
  loadMapConfig,
  mountMap,
  destroyMap,
  setMapLayer,
  renderWxPanels,
  layerButtons,
  researchPin,
  quickPin,
  drawHailMarkers,
  resolveMapCenter,
  renderWeatherBoot,
  renderRoofDossier,
  pinDossier,
  refetchDossier,
  startWeatherWatch,
  filterDossier,
  filterHailRaw,
  selectStormDate,
  bindWxLiveControls,
  bindWxMapExpand,
  fetchWeatherBundle,
  paintLiveWeather,
  geocodeAddress,
  flyToPin,
  wxLiveControlsHtml,
  collapseHailByDate,
  setWxPin,
} from "./wx.js";
import { pickImageFiles, fileToDataUrl, identifyImage, MAX_CHAT_PHOTOS } from "./vision.js";
import { SHOTS, identifyShingles, formatVerdict } from "./shingle.js";
import { matchCatalog, discontinuedFor } from "./catalog.js";
import { newJob, upsertJob, jobSummary } from "./inspect.js";
import { openMarkEditor } from "./damage.js";

const $ = (s) => document.querySelector(s);
let db = load();
let tab = "lens";
const keyCheckTimers = {};
let pendingChatImages = [];
let wxState = { lat: null, lon: null, address: "", data: null };
let wxWatch = null;
let chatBusy = false;
let lensBusy = false;
let pendingShot = "granules_close";

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

function leaveWx() {
  if (wxWatch && typeof wxWatch.stop === "function") {
    wxWatch.stop();
    wxWatch = null;
  }
  destroyMap();
  document.body.classList.remove("wx-tab");
}

function renderPrivacy() {
  const secure = privacyOn(db.settings);
  const tog = $("#privacy-tog");
  if (tog) {
    tog.classList.toggle("on", secure);
    tog.classList.toggle("leaky", !secure);
    tog.textContent = secure ? "SECURE" : "LEAKY";
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
  if (desktopConfigured(db.settings)) apis.push({ id: "desktop", section: "apis" });
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
    const ul = line.match(/^\s*[-*•]\s+(.+)$/);
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
            ? `GC · ${String(opts.brain).toUpperCase()}`
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
        setStatus(`RELAY · ${agentLabel(relay.to)}`);
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

function setLensMode(mode) {
  const L = lensPhotos();
  L.mode = mode === "damage" || mode === "field" ? mode : "shingle";
  persist();
  renderLens();
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
      setStatus(marks.length ? `MARKED · ${marks.length}` : "SAVED FRAME");
    },
    onCancel: () => setStatus("MARK SKIPPED"),
  });
}

function renderLens() {
  leaveWx();
  document.body.classList.remove("comm");
  const L = lensPhotos();
  const mode = lensMode();
  const last = L.last;
  const v = last?.verdict;
  const needed = v?.needed || SHOTS.slice(0, 3).map((s) => ({ id: s.id, label: s.label, why: s.why }));
  const status = last?.status || (L.photos.length ? "READY" : "NEED_SHOTS");
  const statusCls = status === "KNOW" || status === "ID" ? "know" : status === "NARROWED" ? "narrow" : "need";
  const k = v?.known || {};
  const n = v?.narrowed || {};
  const marksN = damageCount(L.photos);
  const blurb =
    mode === "damage"
      ? "Damage circle mode. Snap a roof, then tap-and-scale red circles or arrows. SCAN auto-marks bruises, granule loss, lifts. Does not decide a claim."
      : mode === "field"
        ? "Field ID — flashing, vents, penetrations, plants, hardware, whatever is in the shot. Honest when unsure."
        : "Certain-only shingle ID. Will not name a product until the catalog match is unique and the shots exist. Date stays blank without a back stamp or wrapper.";
  const statusLine =
    mode === "damage"
      ? `${L.photos.length ? `${L.photos.length} FRAMES` : "NO FRAMES"}${marksN ? ` · ${marksN} MARKS` : ""}`
      : mode === "field"
        ? L.field?.id
          ? `ID · ${L.field.id}`
          : L.photos.length
            ? `${L.photos.length} FRAMES`
            : "NEED A SHOT"
        : `${status.replace("_", " ")}${L.photos.length ? ` · ${L.photos.length} SHOTS` : ""}`;
  const cardHtml =
    mode === "damage"
      ? formatChatBody(
          marksN
            ? `${marksN} damage mark(s) on ${L.photos.length} frame(s). Tap a thumb to edit. Red circles = impacts / granule loss. Arrows = lifts / missing / direction.`
            : "NO MARKS yet. Snap the damaged area, then tap to drop a circle and drag to scale. SCAN will auto-ring hail bruises if a vision key is in KEYS.",
        )
      : mode === "field"
        ? formatChatBody(L.field?.text || "Snap anything on the roof or job site. LENS IDs the subject — not just shingles.")
        : last
          ? formatChatBody(formatVerdict(last))
          : formatChatBody("NO ID yet. Snap granule close-up, full tab, overlay. LENS stays silent until it knows.");
  $("#view").innerHTML = `
    <div class="lens-wrap">
      <div class="lens-modes" id="lens-modes">
        <button type="button" data-lmode="shingle" class="${mode === "shingle" ? "on" : ""}">SHINGLE</button>
        <button type="button" data-lmode="damage" class="${mode === "damage" ? "on" : ""}">DAMAGE</button>
        <button type="button" data-lmode="field" class="${mode === "field" ? "on" : ""}">FIELD</button>
      </div>
      <p class="muted">${esc(blurb)}</p>
      <div class="lens-status ${statusCls}">${esc(statusLine)}</div>
      ${
        mode === "shingle"
          ? `<div class="shot-chips" id="shot-chips">
        ${SHOTS.map((s) => `<button type="button" class="shot-chip${pendingShot === s.id ? " on" : ""}${L.shots.includes(s.id) ? " have" : ""}" data-shot="${s.id}">${esc(s.label)}</button>`).join("")}
      </div>
      <p class="muted" id="shot-why">${esc((SHOTS.find((s) => s.id === pendingShot) || SHOTS[0]).why)}</p>`
          : `<p class="muted">${mode === "damage" ? "After SNAP the photo opens for marking. Tap a saved thumb to re-edit." : "One clear shot is enough for FIELD ID."}</p>`
      }
      <div class="actions">
        <button type="button" id="lens-snap" class="primary">SNAP</button>
        <button type="button" id="lens-gallery">GALLERY</button>
        <button type="button" id="lens-read" ${L.photos.length ? 'class="primary"' : "disabled"}>${mode === "damage" ? "RE-SCAN LAST" : "READ LENS"}</button>
        <button type="button" id="lens-clear">CLEAR</button>
      </div>
      <div class="lens-strip" id="lens-strip">${L.photos
        .map(
          (p, i) =>
            `<span class="lens-thumb${p.marks?.length ? " marked" : ""}" data-edit="${i}"><img src="${p.markedUrl || p.url}" alt=""><em>${esc(p.shot || p.mode || "?")}${p.marks?.length ? ` · ${p.marks.length}` : ""}</em><button type="button" data-drop="${i}">×</button></span>`,
        )
        .join("")}</div>
      <div class="lens-card" id="lens-card">${cardHtml}</div>
      ${
        mode === "shingle" && status === "KNOW" && k.discontinued
          ? `<div class="lens-disc">DISCONTINUED · ${esc(k.manufacturer)} ${esc(k.product)}${k.replacedBy ? ` · current: ${esc(k.replacedBy)}` : ""}</div>`
          : ""
      }
      ${
        mode === "shingle" && needed.length && status !== "KNOW"
          ? `<div class="lens-need"><h3>STILL NEED</h3>${needed
              .map((s) => `<p><strong>${esc(s.label)}</strong> — ${esc(s.why)}</p>`)
              .join("")}</div>`
          : ""
      }
      ${
        mode === "shingle" && n.candidates?.length && status !== "KNOW"
          ? `<div class="lens-cands"><h3>CANDIDATES (NOT CLAIMED)</h3>${n.candidates
              .map((c) => `<p>${esc(c.maker)} ${esc(c.line)} ${esc(c.color || "")}${c.discontinued ? " · DISCONTINUED" : ""}</p>`)
              .join("")}</div>`
          : ""
      }
      <div class="actions">
        <button type="button" id="lens-to-job">SAVE TO JOB</button>
      </div>
    </div>`;
  $("#lens-modes")?.querySelectorAll("[data-lmode]").forEach((b) => {
    b.onclick = () => setLensMode(b.dataset.lmode);
  });
  $("#shot-chips")?.querySelectorAll("[data-shot]").forEach((b) => {
    b.onclick = () => {
      pendingShot = b.dataset.shot;
      renderLens();
    };
  });
  $("#lens-strip")?.querySelectorAll("[data-drop]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.drop);
      L.photos.splice(i, 1);
      L.shots = [...new Set(L.photos.map((p) => p.shot).filter(Boolean))];
      persist();
      renderLens();
    };
  });
  $("#lens-strip")?.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.edit);
      if (lensMode() === "damage") editDamagePhoto(i);
    };
  });
  const addFiles = async ({ capture }) => {
    try {
      const files = await pickImageFiles({ capture, multiple: !capture });
      const room = MAX_CHAT_PHOTOS - L.photos.length;
      const picked = files.slice(0, room);
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
                setStatus(marks.length ? `LENS · ${marks.length} MARKS` : `LENS · ${L.photos.length} FRAMES`);
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
      const shot = mode === "field" ? "field" : pendingShot;
      for (const file of picked) {
        L.photos.push({ url: await fileToDataUrl(file, 1400, 0.78), shot, mode, at: Date.now() });
      }
      L.shots = [...new Set(L.photos.map((p) => p.shot).filter(Boolean))];
      persist();
      renderLens();
      setStatus(`LENS · ${L.photos.length} FRAMES`);
    } catch (e) {
      if (!/cancelled/i.test(String(e.message || e))) setStatus(String(e.message || e).slice(0, 50).toUpperCase());
    }
  };
  $("#lens-snap").onclick = () => addFiles({ capture: true });
  $("#lens-gallery").onclick = () => addFiles({ capture: false });
  $("#lens-clear").onclick = () => {
    const keepMode = lensMode();
    db.lens = { mode: keepMode, photos: [], shots: [], last: null, field: null };
    persist();
    renderLens();
    setStatus("LENS CLEARED");
  };
  $("#lens-read").onclick = () => runLens();
  $("#lens-to-job").onclick = () => {
    const job = newJob({
      address: wxState.address || db.settings.city || "",
      lat: wxState.lat || db.settings.lat,
      lon: wxState.lon || db.settings.lon,
      lens:
        mode === "field" && L.field
          ? { status: "ID", id: L.field.id, text: L.field.text, at: new Date().toISOString() }
          : last
            ? { status: last.status, known: last.verdict?.known, needed: last.verdict?.needed, at: new Date().toISOString() }
            : null,
      damage_marks: marksN || undefined,
      photos: L.photos.map((p) => p.shot),
    });
    upsertJob(db, job);
    persist();
    tab = "jobs";
    render();
    setStatus("JOB SAVED");
  };
}

async function runLens() {
  const L = lensPhotos();
  const mode = lensMode();
  if (!L.photos.length || lensBusy) return;
  lensBusy = true;
  setStatus("LENS READING…");
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
      return;
    }
    const hit = await identifyShingles(
      db.settings,
      L.photos.map((p) => p.url),
      L.photos.map((p) => p.shot),
    );
    L.last = hit;
    persist();
    renderLens();
    setStatus(hit.status === "KNOW" ? "LENS · KNOW" : hit.status === "NARROWED" ? "LENS · NARROWED" : "LENS · NEED SHOTS");
  } catch (e) {
    setStatus(String(e.message || e).slice(0, 70).toUpperCase());
    const card = $("#lens-card");
    if (card) card.innerHTML = formatChatBody(String(e.message || e));
  } finally {
    lensBusy = false;
  }
}

async function renderWx() {
  document.body.classList.remove("comm");
  document.body.classList.add("wx-tab");
  leaveWx();
  document.body.classList.add("wx-tab");
  setStatus("");
  $("#view").innerHTML = `
    <div class="wx-wrap">
      <form class="wx-search" id="wx-search" autocomplete="off">
        <input type="search" id="wx-addr-q" placeholder="Job address or place…" enterkeyhint="search" />
        <button type="submit" class="primary">GO</button>
      </form>
      <div class="wx-layers" id="wx-layers"></div>
      <div id="wx-panel" class="wx-panel"><p class="muted">Locating…</p></div>
      <div class="wx-map-shell" id="wx-map-shell">
        <div id="wx-map-hud" class="wx-map-hud" hidden></div>
        <span class="wx-map-hint">NOW = live radar · HAIL = storm trace · DOUBLE-TAP EXPAND</span>
        <div id="wx-map"></div>
      </div>
      <div id="wx-roof-panel" class="wx-roof-panel"></div>
    </div>`;
  const refreshLayers = (cfg) => {
    const el = $("#wx-layers");
    if (!el || !cfg) return;
    el.innerHTML = layerButtons(cfg, esc) + wxLiveControlsHtml();
    bindWxLiveControls(document);
  };
  try {
    const center = await resolveMapCenter(db.settings);
    if (tab !== "wx") return;
    persist();
    const cfg = await loadMapConfig(db.settings);
    if (tab !== "wx") return;
    cfg.center = { ...cfg.center, ...center };
    refreshLayers(cfg);
    $("#wx-layers").onclick = (e) => {
      const b = e.target.closest("button[data-layer]");
      if (!b) return;
      const id = b.dataset.layer;
      const isWx = b.classList.contains("wx-product") || b.classList.contains("overlay");
      setMapLayer(id);
      if (isWx) {
        $("#wx-layers").querySelectorAll("button.wx-product, button.overlay").forEach((x) => x.classList.toggle("on", x === b));
        refreshLayers(cfg);
      } else {
        $("#wx-layers").querySelectorAll("button[data-layer]:not(.wx-product):not(.overlay)").forEach((x) => x.classList.toggle("on", x === b));
      }
    };
    mountMap($("#wx-map"), cfg, { center, onTap: onWxTap });
    bindWxMapExpand($("#wx-map-shell"));
    bindWxLiveControls(document);
    const searchForm = $("#wx-search");
    if (searchForm) {
      searchForm.onsubmit = async (e) => {
        e.preventDefault();
        const q = ($("#wx-addr-q")?.value || "").trim();
        if (!q) return;
        setStatus("GEOCODING…");
        try {
          const hits = await geocodeAddress(q);
          const hit = hits[0];
          if (!hit || !Number.isFinite(hit.lat)) throw new Error("no match");
          flyToPin(hit.lat, hit.lon, 14);
          setStatus(`PINNED · ${String(hit.city || hit.address || q).slice(0, 40)}`);
          await onWxTap(hit.lat, hit.lon);
        } catch (err) {
          setStatus(String(err.message || err).slice(0, 48).toUpperCase());
        }
      };
    }
    wxWatch = startWeatherWatch(
      () => (tab === "wx" ? resolveMapCenter(db.settings) : Promise.resolve(null)),
      (live) => {
        if (tab !== "wx") return;
        const line = (live.outlook && live.outlook.line) || "";
        if (!line) return;
        window.__pipWxLine = line;
        setStatus("WX ALERT");
      },
    );
    quickPin(db.settings, center.lat, center.lon)
      .then(async (hit) => {
        if (tab !== "wx") return;
        selectStormDate(null, { fit: false });
        const data = { ...hit, lat: hit.lat ?? center.lat, lon: hit.lon ?? center.lon, address: hit.address || hit.geo?.address || "" };
        renderWeatherBoot($("#wx-panel"), hit.geo, hit.weather || cfg.weather, hit.hail, esc);
        renderRoofDossier($("#wx-roof-panel"), data, esc, null, null);
        try {
          const bundle = await fetchWeatherBundle(center.lat, center.lon);
          paintLiveWeather($("#wx-panel"), bundle, collapseHailByDate(hit.hail || []), esc);
        } catch {
          /* optional */
        }
      })
      .catch(() => {
        if (tab !== "wx") return;
        $("#wx-panel").innerHTML = `<p class="muted">Search an address or tap the map for hail zones.</p>`;
      });
  } catch (e) {
    if (tab !== "wx") return;
    $("#view").innerHTML = `<p class="muted">${esc(String(e.message || e))}</p>`;
  }
}

async function onWxTap(lat, lon) {
  wxState.lat = lat;
  wxState.lon = lon;
  setWxPin(lat, lon);
  selectStormDate(null, { fit: false });
  setStatus("PINNED · ADDRESS…");
  const panel = $("#wx-panel");
  const roofPanel = $("#wx-roof-panel");
  const paintHail = (data) => {
    const f = filterDossier(data);
    drawHailMarkers(filterHailRaw(data), f.wind, { fit: false });
  };
  const onDeep = async () => {
    setStatus("DEEP RESEARCH…");
    try {
      const deep = await researchPin(db.settings, lat, lon, wxState.address, true);
      wxState.data = deep;
      paintHail(deep);
      renderWxPanels(deep, esc, onDeep, onRefetch);
      setStatus("DOSSIER UPDATED");
    } catch (e) {
      if (panel) panel.innerHTML = `<p class="muted">${esc(String(e.message || e))}</p>`;
      setStatus("WX ERROR");
    }
  };
  const onRefetch = async (filters) => {
    const fresh = await refetchDossier(db.settings, lat, lon, wxState.address, filters);
    wxState.data = fresh;
    return fresh;
  };
  try {
    const data = await pinDossier(db.settings, lat, lon, {
      onPartial: (partial) => {
        wxState.address = partial.address || "";
        renderWxPanels(partial, esc, onDeep, onRefetch);
        setStatus("PINNED · HAIL NEARBY…");
      },
    });
    wxState.address = data.address || "";
    wxState.data = data;
    paintHail(data);
    renderWxPanels(data, esc, onDeep, onRefetch);
    void roofPanel;
    setStatus("WX DOSSIER");
  } catch (e) {
    if (panel) panel.innerHTML = `<p class="muted">${esc(String(e.message || e))}. Check network.</p>`;
    setStatus("WX ERROR");
  }
}

function renderJobs() {
  leaveWx();
  document.body.classList.remove("comm");
  const jobs = db.jobs || [];
  $("#view").innerHTML = `
    <h3>JOBS</h3>
    <p class="muted">Roof inspections. Save a LENS read or hail pin onto a job.</p>
    <div class="actions"><button type="button" id="job-new" class="primary">NEW JOB</button></div>
    <div class="job-list">${
      jobs.length
        ? jobs
            .map(
              (j) =>
                `<article class="job-card" data-id="${esc(j.id)}"><strong>${esc(j.address || "Unpinned")}</strong><p class="muted">${esc(jobSummary(j))}</p><p class="muted">${esc(String(j.created || "").slice(0, 10))}</p></article>`,
            )
            .join("")
        : `<p class="muted">No jobs yet. LENS a shingle, mark damage, or pin hail — then SAVE TO JOB.</p>`
    }</div>`;
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
    const get = p.keyUrl ? `<a class="key-get" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">GET KEY</a>` : "";
    return `<div class="key-row ${esc(info.state)}">
      <div class="key-meta"><span class="key-name">${esc(p.label.toUpperCase())}</span><span class="key-tag">${esc(info.tag)}${hint ? ` · ${esc(hint)}` : ""}</span></div>
      <p class="muted key-tip">${esc(p.tip || "")} ${get}${has ? ` · <button type="button" class="key-clear" data-field="${esc(p.field)}">CLEAR</button>` : ""}</p>
      <input id="set-${esc(p.field)}" type="text" autocomplete="off" spellcheck="false" value="" placeholder="${esc(has ? "paste to replace" : "paste key — saves as you type")}" data-field="${esc(p.field)}" />
    </div>`;
  }).join("");
  $("#view").innerHTML = `
    <h3>GROUND CONTROL</h3>
    <div class="field"><span>NAME</span><input id="set-op" value="${esc(s.operator || "")}" /></div>
    <div class="field"><span>COMPANY</span><input id="set-co" value="${esc(s.company || "")}" /></div>
    <p class="muted">HTTP: ${diag.nativeHttp ? "NATIVE OK" : "WEB FETCH"} · ${esc(diag.platform)}</p>
    <p class="muted">${keyedNow.length ? `IN MEMORY: ${esc(keyedNow.join(" · "))}` : "NO KEYS — paste Gemini or OpenAI for LENS"}</p>
    <h3>BRAIN KEYS</h3>
    <p class="muted">Super Chat uses every keyed API. LENS needs a vision key (Gemini / OpenAI / Anthropic / OpenRouter). SECURE blocks LENS.</p>
    <div class="key-list">${keyRows}</div>
    <div class="actions"><button type="button" id="keys-test">TEST KEYS</button></div>
    <h3>DISCONTINUED LOOKUP</h3>
    <p class="muted">Catalog includes GAF Timberline HD, CT Independence/Hatteras, OC Duration COOL, Atlas GlassMaster, and more. LENS will only claim a discontinued line when the match is unique.</p>
    <p class="muted">${esc(String(discontinuedFor().length))} discontinued color/line rows on device.</p>`;
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
    setStatus("CHECKING KEYS…");
    try {
      await validateKeyed(db.settings);
      db.settings.brain_health = providerHealth();
      persist();
      renderKeys();
      setStatus("KEYS CHECKED");
    } catch (e) {
      setStatus(String(e.message || e).slice(0, 50).toUpperCase());
    }
  };
}

function render() {
  document.body.classList.toggle("wx-tab", tab === "wx");
  $("#tabs").querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (tab !== "wx") leaveWx();
  if (tab === "lens") renderLens();
  else if (tab === "wx") renderWx();
  else if (tab === "jobs") renderJobs();
  else if (tab === "keys") renderKeys();
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
    setStatus(privacyOn(db.settings) ? "SECURE · LENS BLOCKED" : "LEAKY · CLOUD ON");
  };
  $("#comm-tog").onclick = () => {
    document.body.classList.add("comm");
    renderChatLog();
    $("#input")?.focus();
  };
  $("#comm-close").onclick = () => document.body.classList.remove("comm");
  $("#tabs").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
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
  setStatus("GROUND CONTROL");
}

void matchCatalog;
void uid;
boot();
