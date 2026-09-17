/** Shingle lens. Always names a catalog leader; the meter is what locks it. */

import { privacyOn } from "./cloud.js";
import { visionComplete, visionProvidersReady } from "./vision.js";
import {
  SHOTS,
  SHINGLE_CORE,
  SHINGLE_EXTRA,
  catalogBrief,
  gateVerdict,
  matchCatalog,
  nextShotPrompt,
  discontinuedFor,
  yearRange,
} from "./catalog.js";

export { SHOTS, gateVerdict, nextShotPrompt, discontinuedFor, yearRange };

const SHOT_LABEL = Object.fromEntries(SHOTS.map((s) => [s.id, s.label]));

export function orderShinglePhotos(photos) {
  const order = [...SHINGLE_CORE, ...SHINGLE_EXTRA];
  return [...(photos || [])].sort((a, b) => {
    const ia = order.indexOf(a.shot);
    const ib = order.indexOf(b.shot);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a.at || 0) - (b.at || 0);
  });
}

/** Plain-text prompt for ChatGPT / share sheet (phone Lens). */
export function buildSharePrompt(rows) {
  const sorted = orderShinglePhotos(rows);
  const lines = [
    "Identify this roofing shingle from the attached inspection photos.",
    "",
    "Each photo is labeled by angle:",
    ...sorted.map((p, i) => {
      const label = SHOT_LABEL[p.shot] || p.shot || "roof detail";
      return `- Photo ${i + 1}: ${label}`;
    }),
    "",
    "Reply with:",
    "1. Manufacturer (GAF, Owens Corning, CertainTeed, Atlas, TAMKO, etc.)",
    "2. Product line and color name",
    "3. Construction type (3-tab, architectural laminate, designer, etc.)",
    "4. Confidence (high / medium / low) and the visual tells you used",
    "5. Any extra photo needed (wrapper, back stamp, nailing strip) if not sure",
    "",
    "Do not guess install date from weathering alone — only from back stamp or bundle wrapper if visible.",
  ];
  return lines.join("\n");
}

const SHOT_IDS = [...SHINGLE_CORE, ...SHINGLE_EXTRA];

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

function normalizeShotId(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (SHOT_IDS.includes(s)) return s;
  if (/wrapper|bundle|label|brand|packaging/.test(s)) return "wrapper";
  if (/back.?stamp|date.?code|stamp/.test(s)) return "backstamp";
  if (/granule|close|macro/.test(s)) return "granules_close";
  if (/tab|pattern|cutout/.test(s)) return "tab_pattern";
  if (/overlay|shadow/.test(s)) return "overlay_shadow";
  if (/nail|strip|surenail|duragrip/.test(s)) return "nailing_strip";
  if (/edge|butt|thick/.test(s)) return "thickness_edge";
  if (/ridge|hip|cap/.test(s)) return "ridge_cap";
  if (/slope|field|context/.test(s)) return "slope_context";
  return "";
}

function confOf(x) {
  if (x == null) return { value: "", conf: 0 };
  if (typeof x === "string") return { value: x, conf: 0.4 };
  return { value: String(x.value || x.name || ""), conf: Number(x.conf || x.confidence || 0) };
}

function lensBlocked(settings) {
  return privacyOn(settings) && !visionProvidersReady(settings).length;
}

function photoRows(photos) {
  if (!Array.isArray(photos) || !photos.length) return [];
  if (photos[0]?.url) return photos.map((p) => ({ ...p }));
  return photos.filter(Boolean).map((url) => ({ url, shot: "" }));
}

function applyTagRows(rows, tagRows) {
  for (const row of tagRows || []) {
    const idx = Number(row.i ?? row.index) - 1;
    const id = normalizeShotId(row.id || row.shot);
    if (rows[idx] && id) rows[idx].shot = id;
  }
}

function boostWrapperConfidence(analysis, rows) {
  const tags = new Set([...(analysis.shots_present || []), ...rows.map((p) => p.shot).filter(Boolean)]);
  if (!tags.has("wrapper")) return analysis;
  const hit = matchCatalog({
    manufacturer: analysis.manufacturer?.value,
    product: analysis.product?.value,
    color: analysis.color?.value,
  });
  if (!hit.top) return analysis;
  const floor = (field, min) => {
    if (!field?.value) return field;
    return { ...field, conf: Math.max(Number(field.conf) || 0, min) };
  };
  return {
    ...analysis,
    manufacturer: floor(analysis.manufacturer, 0.88),
    product: floor(analysis.product, 0.86),
    color: floor(analysis.color, analysis.color?.value ? 0.8 : 0),
    shots_present: [...new Set([...(analysis.shots_present || []), "wrapper"])],
  };
}

export function normalizeAnalysis(raw) {
  const j = raw && typeof raw === "object" ? raw : {};
  return {
    construction: confOf(j.construction),
    manufacturer: confOf(j.manufacturer),
    product: confOf(j.product || j.line || j.product_line),
    color: confOf(j.color),
    date_code: confOf(j.date_code || j.date),
    era: confOf(j.era),
    damage: confOf(j.damage),
    shots_present: Array.isArray(j.shots_present) ? j.shots_present.map(String) : [],
    photo_tags: Array.isArray(j.photo_tags) ? j.photo_tags : Array.isArray(j.photos) ? j.photos : [],
    shots_needed: Array.isArray(j.shots_needed) ? j.shots_needed : [],
    lookalikes: Array.isArray(j.lookalikes) ? j.lookalikes.map(String) : [],
    tells: Array.isArray(j.tells) ? j.tells.map(String) : [],
    notes: String(j.notes || "").trim(),
  };
}

/** Vision-sort each photo into granules / tab / wrapper / etc. No user tagging. */
export async function classifyShinglePhotos(settings, rows) {
  const list = rows || [];
  if (!list.length || lensBlocked(settings)) return list;
  const ids = SHOT_IDS.join(", ");
  const prompt = `Classify each roofing inspection photo in order.
Pick ONE id per image from: ${ids}.
Use wrapper when bundle branding, printed product name, color, or lot label is visible.
Use backstamp for loose shingle back stamp / date mold.
Reply JSON only: {"photos":[{"i":1,"id":"granules_close"}, {"i":2,"id":"wrapper"}]}`;
  try {
    const out = await visionComplete(settings, prompt, list.map((p) => p.url), {
      maxTokens: 500,
      temperature: 0.05,
      mode: "classify",
    });
    const parsed = extractJson(out.text);
    applyTagRows(list, parsed?.photos || parsed?.photo_tags);
  } catch {
    /* keep sequential / prior tags */
  }
  return list;
}

function buildPrompt(rows, taggedShots) {
  const tags = (taggedShots || []).map((s, i) => `Photo ${i + 1}: ${s || "unspecified"}`).join("\n");
  return `You are Ground Control LENS — a field shingle identifier for roofing inspections.
You ALWAYS pick the single most likely CATALOG manufacturer + product + color. Refusing to name a line is a failure.
Uncertainty belongs in confidence, not in blank values.

Rules:
- manufacturer / product / color MUST be names from CATALOG.
- If ANY photo shows bundle wrapper branding, read manufacturer/product/color from it and set conf 0.88+ for those fields.
- 0.92+ only when unique factory tells are visible (SureNail, LayerLock/HDZ, plant stamp, branded wrapper).
- Date: only fill date_code from stamp, lot, or wrapper year — not weathering alone.
- photo_tags: for EACH photo, {"i":1,"id":"wrapper"} using ids: ${SHOT_IDS.join(", ")}.
- shots_present: every shot type visible across the set (include wrapper when branding shows).

Photos:
${tags || rows.map((_, i) => `Photo ${i + 1}: auto`).join("\n")}

CATALOG:
${catalogBrief()}

Reply JSON only:
{
  "construction": {"value":"", "conf":0},
  "manufacturer": {"value":"", "conf":0},
  "product": {"value":"", "conf":0},
  "color": {"value":"", "conf":0},
  "date_code": {"value":"", "conf":0},
  "era": {"value":"", "conf":0},
  "damage": {"value":"", "conf":0},
  "photo_tags": [{"i":1,"id":""}],
  "shots_present": [],
  "shots_needed": [{"id":"granules_close","why":""}],
  "lookalikes": [],
  "tells": [],
  "notes": ""
}`;
}

export async function identifyShingles(settings, photos, taggedShots = []) {
  if (lensBlocked(settings)) {
    throw new Error("Lens needs a vision key in Settings (Gemini, OpenAI, etc.) or use phone Lens → ChatGPT");
  }
  let rows = photoRows(photos);
  if (!rows.length) {
    return {
      status: "NEED_SHOTS",
      analysis: normalizeAnalysis({}),
      verdict: gateVerdict({}, 0, []),
      provider: "",
      leaked: false,
      photos: [],
    };
  }
  if (rows.some((p) => !p.shot)) {
    rows = await classifyShinglePhotos(settings, rows);
  }
  const urls = rows.map((p) => p.url);
  const tags = rows.map((p) => p.shot).filter(Boolean);
  const prompt = buildPrompt(rows, tags.length ? tags : taggedShots);
  const out = await visionComplete(settings, prompt, urls, { maxTokens: 1600, temperature: 0.2, mode: "shingle" });
  let analysis = normalizeAnalysis(extractJson(out.text) || {});
  applyTagRows(rows, analysis.photo_tags);
  analysis = boostWrapperConfidence(analysis, rows);
  const shotIds = [...new Set([...rows.map((p) => p.shot).filter(Boolean), ...(analysis.shots_present || []), ...taggedShots])];
  let verdict = gateVerdict(analysis, urls.length, shotIds);
  if (Array.isArray(analysis.shots_needed)) {
    for (const s of analysis.shots_needed) {
      const id = String(s.id || s || "");
      const spec = SHOTS.find((x) => x.id === id);
      if (spec && !verdict.needed.some((n) => n.id === spec.id) && verdict.status !== "KNOW") {
        verdict.needed.push({ id: spec.id, label: spec.label, why: s.why || spec.why });
      }
    }
  }
  return {
    status: verdict.status,
    analysis,
    verdict,
    provider: out.provider,
    model: out.model,
    leaked: out.provider !== "desktop",
    raw: out.text,
    photos: rows,
  };
}

export function formatVerdict(hit) {
  const v = hit.verdict || gateVerdict({}, 0, []);
  const pct = Number.isFinite(Number(v.pct)) ? Number(v.pct) : 0;
  const lines = [];
  const leader =
    (v.status === "KNOW" && v.known?.manufacturer
      ? `${v.known.manufacturer} ${v.known.product}${v.known.color ? ` · ${v.known.color}` : ""}`
      : null) ||
    (v.narrowed?.manufacturer
      ? `${v.narrowed.manufacturer}${v.narrowed.product ? ` ${v.narrowed.product}` : ""}${v.narrowed.color ? ` · ${v.narrowed.color}` : ""}`
      : "");
  if (pct >= 100) lines.push(`100% · ${leader || "date locked"}`);
  else if (pct >= 95) lines.push(`95% · ${leader}`);
  else if (leader) lines.push(`${pct}% · ${leader}`);
  else lines.push(`${pct}% — reading photos…`);
  if (v.status === "KNOW") {
    const k = v.known;
    if (k.discontinued) lines.push(`DISCONTINUED${k.replacedBy ? ` · current equivalent ${k.replacedBy}` : ""}`);
    if (k.years) lines.push(`Production window: ${k.years}`);
    if (k.date) lines.push(`DATE CODE: ${k.date}`);
    else lines.push("Product locked at 95%. Back stamp or bundle wrapper for 100% date.");
    if (k.construction) lines.push(`Construction: ${k.construction}`);
  } else if (v.status === "NARROWED") {
    const n = v.narrowed;
    if (n.candidates?.length) {
      lines.push("Also in the running:");
      for (const c of n.candidates.slice(0, 4)) {
        lines.push(`  · ${c.maker} ${c.line}${c.color ? ` ${c.color}` : ""}${c.discontinued ? " [DISCONTINUED]" : ""} ${c.years || ""}`);
      }
    }
    if (v.needed[0]) lines.push(nextShotPrompt(v.needed));
  } else if (v.needed[0]) {
    lines.push(nextShotPrompt(v.needed[0]));
  }
  const tells = hit.analysis?.tells || [];
  if (tells.length) lines.push(`Tells: ${tells.slice(0, 4).join("; ")}`);
  if (hit.analysis?.damage?.value) lines.push(`Damage note: ${hit.analysis.damage.value} (not a claim decision).`);
  if (hit.provider) {
    const via = hit.provider === "desktop" ? "CONTROL ROOM · LOCAL GPU" : `${String(hit.provider).toUpperCase()} · CLOUD`;
    lines.push(`— LENS · ${via}`);
  }
  return lines.join("\n");
}
