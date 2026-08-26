/** Damage circles and arrows on a LENS photo. Coords are 0–1 of the image. */

import { uid } from "./store.js";
import { privacyOn } from "./cloud.js";
import { visionComplete } from "./vision.js";

export const DAMAGE_KINDS = [
  "bruise",
  "granule_loss",
  "crack",
  "puncture",
  "lift",
  "missing",
  "stain",
  "other",
];

export function clamp01(n, lo = 0, hi = 1) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

export function normalizeMark(raw = {}) {
  const type = String(raw.type || "circle").toLowerCase() === "arrow" ? "arrow" : "circle";
  const kind = DAMAGE_KINDS.includes(String(raw.kind || "").toLowerCase())
    ? String(raw.kind).toLowerCase()
    : "other";
  const mark = {
    id: raw.id || uid(),
    type,
    x: clamp01(raw.x, 0, 1),
    y: clamp01(raw.y, 0, 1),
    kind,
    label: String(raw.label || "").slice(0, 48),
    auto: Boolean(raw.auto),
  };
  if (type === "arrow") {
    mark.dx = clamp01(Number(raw.dx) || 0.08, -0.6, 0.6);
    mark.dy = clamp01(Number(raw.dy) || -0.08, -0.6, 0.6);
    if (Math.hypot(mark.dx, mark.dy) < 0.03) {
      mark.dx = 0.08;
      mark.dy = -0.08;
    }
  } else {
    mark.r = clamp01(raw.r == null ? 0.055 : raw.r, 0.012, 0.35);
  }
  return mark;
}

export function newCircle(x, y, r = 0.06, extra = {}) {
  return normalizeMark({ type: "circle", x, y, r, ...extra });
}

export function newArrow(x, y, dx = 0.09, dy = -0.07, extra = {}) {
  return normalizeMark({ type: "arrow", x, y, dx, dy, ...extra });
}

export function hitTest(mark, x, y) {
  if (!mark) return null;
  if (mark.type === "arrow") {
    const tx = mark.x + (mark.dx || 0);
    const ty = mark.y + (mark.dy || 0);
    const dTail = Math.hypot(x - mark.x, y - mark.y);
    const dTip = Math.hypot(x - tx, y - ty);
    if (dTip < 0.045) return "tip";
    if (dTail < 0.04) return "move";
    return null;
  }
  const d = Math.hypot(x - mark.x, y - mark.y);
  const r = mark.r || 0.05;
  if (d <= r * 0.55) return "move";
  if (d <= r + 0.03) return "scale";
  return null;
}

function extractJson(raw) {
  const t = String(raw || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseDamageMarks(raw) {
  const j = extractJson(raw) || (raw && typeof raw === "object" ? raw : null);
  const list = Array.isArray(j?.marks) ? j.marks : Array.isArray(j) ? j : [];
  return list.slice(0, 12).map((m) => normalizeMark({ ...m, auto: true }));
}

const SCAN_PROMPT = `You mark visible roof / exterior damage on this field photo for an inspector.
Return JSON only:
{"marks":[{"type":"circle","x":0.42,"y":0.51,"r":0.05,"kind":"bruise","label":"hail bruise"}]}

Rules:
- x,y are 0–1 fractions of image width/height (center of the mark).
- For circles, r is radius as a fraction of the shorter image side (typical 0.03–0.10).
- Use type "arrow" only for directional callouts (lifted tab, missing shingle, drip edge): {"type":"arrow","x":0.2,"y":0.4,"dx":0.08,"dy":-0.05,"kind":"lift","label":"lifted tab"}
- kind is one of: bruise, granule_loss, crack, puncture, lift, missing, stain, other
- Only mark damage you can see. If none, {"marks":[]}
- Max 12 marks. Do not name shingle brand or guess a claim.`;

export async function detectDamage(settings, dataUrl) {
  if (privacyOn(settings)) {
    throw new Error("SECURE blocks damage scan — flip LEAKY");
  }
  const out = await visionComplete(settings, SCAN_PROMPT, [dataUrl], { maxTokens: 900, temperature: 0.05 });
  return { marks: parseDamageMarks(out.text), provider: out.provider, leaked: true };
}

export function drawMarks(ctx, w, h, marks, selectedId) {
  const short = Math.min(w, h);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const m of marks || []) {
    const on = m.id === selectedId;
    const color = on ? "#ff6b6b" : "#ff3a3a";
    ctx.strokeStyle = color;
    ctx.fillStyle = "rgba(255,58,58,0.16)";
    ctx.lineWidth = on ? Math.max(3, short * 0.008) : Math.max(2, short * 0.006);
    if (m.type === "arrow") {
      const x0 = m.x * w;
      const y0 = m.y * h;
      const x1 = (m.x + m.dx) * w;
      const y1 = (m.y + m.dy) * h;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const ah = Math.max(10, short * 0.028);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ah * Math.cos(ang - 0.45), y1 - ah * Math.sin(ang - 0.45));
      ctx.lineTo(x1 - ah * Math.cos(ang + 0.45), y1 - ah * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x0, y0, Math.max(3, short * 0.008), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const r = (m.r || 0.05) * short;
      ctx.beginPath();
      ctx.arc(m.x * w, m.y * h, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (m.label) {
      ctx.font = `${Math.max(11, Math.round(short * 0.028))}px Cascadia Mono, Consolas, monospace`;
      ctx.fillStyle = "#ffd0d0";
      ctx.fillText(m.label, m.x * w + 6, m.y * h - 8);
    }
  }
  ctx.restore();
}

export function compositeMarked(dataUrl, marks) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        drawMarks(ctx, canvas.width, canvas.height, marks, null);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("mark bake failed"));
    img.src = dataUrl;
  });
}

let session = null;

function $(id) {
  return document.getElementById(id);
}

function paintSession() {
  if (!session) return;
  const { canvas, img, marks, selectedId } = session;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  drawMarks(ctx, canvas.width, canvas.height, marks, selectedId);
  const hint = $("mark-hint");
  if (hint) {
    hint.textContent =
      session.tool === "arrow"
        ? "Tap tail, drag the tip. SCAN auto-marks bruises."
        : "Tap to drop a red circle. Drag to scale. SCAN auto-marks damage.";
  }
  $("mark-editor")
    ?.querySelectorAll("[data-tool]")
    .forEach((b) => b.classList.toggle("on", b.dataset.tool === session.tool));
}

function canvasNorm(ev) {
  const canvas = session?.canvas;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  const src = ev.touches ? ev.touches[0] : ev;
  return {
    x: clamp01((src.clientX - rect.left) / rect.width),
    y: clamp01((src.clientY - rect.top) / rect.height),
  };
}

function bindOnce() {
  const root = $("mark-editor");
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "1";
  const canvas = $("mark-canvas");
  root.querySelectorAll("[data-tool]").forEach((b) => {
    b.onclick = () => {
      if (!session) return;
      session.tool = b.dataset.tool;
      paintSession();
    };
  });
  $("mark-undo").onclick = () => {
    if (!session?.marks.length) return;
    session.marks.pop();
    session.selectedId = session.marks.at(-1)?.id || null;
    paintSession();
  };
  $("mark-clear").onclick = () => {
    if (!session) return;
    session.marks = [];
    session.selectedId = null;
    paintSession();
  };
  $("mark-scan").onclick = () => runScan();
  $("mark-done").onclick = () => finish(true);
  $("mark-cancel").onclick = () => finish(false);

  const onDown = (ev) => {
    if (!session) return;
    ev.preventDefault();
    const p = canvasNorm(ev);
    session.drag = null;
    for (let i = session.marks.length - 1; i >= 0; i -= 1) {
      const mode = hitTest(session.marks[i], p.x, p.y);
      if (mode) {
        session.selectedId = session.marks[i].id;
        session.drag = { mode, id: session.marks[i].id, ox: p.x, oy: p.y };
        paintSession();
        return;
      }
    }
    const mark =
      session.tool === "arrow"
        ? newArrow(p.x, p.y, 0.02, -0.02)
        : newCircle(p.x, p.y, 0.02);
    session.marks.push(mark);
    session.selectedId = mark.id;
    session.drag = { mode: mark.type === "arrow" ? "tip" : "scale", id: mark.id, ox: p.x, oy: p.y, fresh: true };
    paintSession();
  };
  const onMove = (ev) => {
    if (!session?.drag) return;
    ev.preventDefault();
    const p = canvasNorm(ev);
    const mark = session.marks.find((m) => m.id === session.drag.id);
    if (!mark) return;
    if (session.drag.mode === "move") {
      const dx = p.x - session.drag.ox;
      const dy = p.y - session.drag.oy;
      mark.x = clamp01(mark.x + dx);
      mark.y = clamp01(mark.y + dy);
      session.drag.ox = p.x;
      session.drag.oy = p.y;
    } else if (mark.type === "arrow") {
      mark.dx = clamp01(p.x - mark.x, -0.6, 0.6);
      mark.dy = clamp01(p.y - mark.y, -0.6, 0.6);
    } else {
      const short = 1;
      mark.r = clamp01(Math.hypot(p.x - mark.x, p.y - mark.y) / short, 0.012, 0.35);
    }
    paintSession();
  };
  const onUp = (ev) => {
    if (!session?.drag) return;
    if (ev) ev.preventDefault();
    const mark = session.marks.find((m) => m.id === session.drag.id);
    if (mark?.type === "circle" && mark.r < 0.016 && session.drag.fresh) {
      session.marks = session.marks.filter((m) => m.id !== mark.id);
      session.selectedId = null;
    }
    session.drag = null;
    paintSession();
  };
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

async function runScan() {
  if (!session) return;
  const btn = $("mark-scan");
  if (btn) btn.disabled = true;
  const status = document.getElementById("status");
  if (status) status.textContent = "SCANNING DAMAGE…";
  try {
    const out = await detectDamage(session.settings, session.url);
    const keep = session.marks.filter((m) => !m.auto);
    session.marks = [...keep, ...out.marks];
    session.selectedId = session.marks.at(-1)?.id || null;
    paintSession();
    if (status) status.textContent = out.marks.length ? `SCAN · ${out.marks.length} MARKS` : "SCAN · NO DAMAGE SEEN";
  } catch (e) {
    if (status) status.textContent = String(e.message || e).slice(0, 70).toUpperCase();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function finish(save) {
  if (!session) return;
  const { onSave, onCancel, url, marks } = session;
  const root = $("mark-editor");
  if (save) {
    const markedUrl = marks.length ? await compositeMarked(url, marks) : url;
    onSave?.({ url, markedUrl, marks });
  } else {
    onCancel?.();
  }
  session = null;
  if (root) root.hidden = true;
  document.body.classList.remove("marking");
}

export function openMarkEditor({ url, marks = [], settings, onSave, onCancel, autoScan = true }) {
  bindOnce();
  const root = $("mark-editor");
  const canvas = $("mark-canvas");
  if (!root || !canvas) {
    onSave?.({ url, markedUrl: url, marks: [] });
    return;
  }
  const img = new Image();
  img.onload = () => {
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    session = {
      url,
      img,
      canvas,
      marks: (marks || []).map(normalizeMark),
      selectedId: null,
      tool: "circle",
      settings,
      onSave,
      onCancel,
      drag: null,
    };
    root.hidden = false;
    document.body.classList.add("marking");
    paintSession();
    if (autoScan && settings && !privacyOn(settings)) runScan();
  };
  img.onerror = () => onSave?.({ url, markedUrl: url, marks: [] });
  img.src = url;
}
