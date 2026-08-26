/** Certain-only shingle lens. Guesses never become answers. */

import { privacyOn } from "./cloud.js";
import { visionComplete } from "./vision.js";
import {
  SHOTS,
  catalogBrief,
  gateVerdict,
  nextShotPrompt,
  discontinuedFor,
  yearRange,
} from "./catalog.js";

export { SHOTS, gateVerdict, nextShotPrompt, discontinuedFor, yearRange };

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

function confOf(x) {
  if (x == null) return { value: "", conf: 0 };
  if (typeof x === "string") return { value: x, conf: 0.4 };
  return { value: String(x.value || x.name || ""), conf: Number(x.conf || x.confidence || 0) };
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
    shots_needed: Array.isArray(j.shots_needed) ? j.shots_needed : [],
    lookalikes: Array.isArray(j.lookalikes) ? j.lookalikes.map(String) : [],
    tells: Array.isArray(j.tells) ? j.tells.map(String) : [],
    notes: String(j.notes || "").trim(),
  };
}

function buildPrompt(photos, taggedShots) {
  const tags = (taggedShots || []).map((s, i) => `Photo ${i + 1}: ${s || "unspecified angle"}`).join("\n");
  return `You are Ground Control LENS — a roofing-company shingle identifier for field inspections.
You do NOT guess. You do NOT name a product unless the photos uniquely match the CATALOG below.
If you are not certain, set confidence below 0.72 and list the next shot you need.

Rules:
- Only use manufacturer / product line / color names from CATALOG. If it is not in the catalog, value="" conf=0.
- 3-tab vs architectural vs designer must be visible (cutouts, overlay, thickness). If not, construction conf=0.
- Owens Corning Duration is identified by the pink/coral SureNail strip — without that shot, do not assert Duration vs Oakridge.
- GAF Timberline HD vs HDZ: do not assert HDZ unless LayerLock/HDZ cues are visible; otherwise NARROW to Timberline family.
- Date: only fill date_code if you can read a stamp, lot, or wrapper year. Weathering is era, not a date.
- Discontinued products ARE in the catalog — prefer them when the cues match an older line.
- Hail bruises / granule loss are damage notes, not product ID.

Photos tagged:
${tags || "(untagged sequence)"}

CATALOG:
${catalogBrief()}

Reply with JSON only, this shape:
{
  "construction": {"value":"", "conf":0},
  "manufacturer": {"value":"", "conf":0},
  "product": {"value":"", "conf":0},
  "color": {"value":"", "conf":0},
  "date_code": {"value":"", "conf":0},
  "era": {"value":"", "conf":0},
  "damage": {"value":"", "conf":0},
  "shots_present": [],
  "shots_needed": [{"id":"granules_close","why":""}],
  "lookalikes": [],
  "tells": [],
  "notes": "one sentence, no product name unless conf>=0.92"
}
conf is 0..1. Use 0.92+ only when you would stake a claim on it.`;
}

export async function identifyShingles(settings, photos, taggedShots = []) {
  if (privacyOn(settings)) {
    throw new Error("SECURE blocks lens — flip LEAKY so vision can leave the device");
  }
  const urls = (photos || []).filter(Boolean);
  if (!urls.length) {
    return {
      status: "NEED_SHOTS",
      analysis: normalizeAnalysis({}),
      verdict: gateVerdict({}, 0, []),
      provider: "",
      leaked: false,
    };
  }
  const prompt = buildPrompt(urls, taggedShots);
  const out = await visionComplete(settings, prompt, urls, { maxTokens: 1400, temperature: 0.05 });
  const parsed = extractJson(out.text);
  const analysis = normalizeAnalysis(parsed || {});
  const shotIds = [...new Set([...(taggedShots || []).filter(Boolean), ...(analysis.shots_present || [])])];
  const verdict = gateVerdict(analysis, urls.length, shotIds);
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
    leaked: true,
    raw: out.text,
  };
}

export function formatVerdict(hit) {
  const v = hit.verdict || gateVerdict({}, 0, []);
  const lines = [];
  if (v.status === "KNOW") {
    const k = v.known;
    lines.push(`KNOW · ${k.manufacturer} ${k.product}${k.color ? ` · ${k.color}` : ""}`);
    if (k.discontinued) lines.push(`DISCONTINUED${k.replacedBy ? ` · current equivalent ${k.replacedBy}` : ""}`);
    if (k.years) lines.push(`Production window: ${k.years}`);
    if (k.date) lines.push(`DATE CODE: ${k.date}`);
    else lines.push("DATE: not proven — still need a back stamp or bundle wrapper for an exact date.");
    if (k.construction) lines.push(`Construction: ${k.construction}`);
  } else if (v.status === "NARROWED") {
    const n = v.narrowed;
    lines.push("NARROWED — not an ID yet.");
    if (n.manufacturer) lines.push(`Family: ${n.manufacturer}${n.product ? ` / ${n.product}` : ""}`);
    if (n.color) lines.push(`Color leaning: ${n.color} (not locked)`);
    if (n.candidates?.length) {
      lines.push("Catalog candidates (not claimed):");
      for (const c of n.candidates.slice(0, 4)) {
        lines.push(`  · ${c.maker} ${c.line}${c.color ? ` ${c.color}` : ""}${c.discontinued ? " [DISCONTINUED]" : ""} ${c.years || ""}`);
      }
    }
    if (v.needed[0]) lines.push(nextShotPrompt(v.needed));
  } else {
    lines.push("NO ID. Ground Control does not guess shingles.");
    if (v.invented) lines.push("Model tried a name that is not a unique catalog match — thrown out.");
    if (v.needed[0]) lines.push(nextShotPrompt(v.needed));
    else lines.push("Add a granule close-up, a full tab, and an overlay/shadow shot.");
  }
  const tells = hit.analysis?.tells || [];
  if (tells.length) lines.push(`Tells: ${tells.slice(0, 4).join("; ")}`);
  if (hit.analysis?.damage?.value) lines.push(`Damage note: ${hit.analysis.damage.value} (not a claim decision).`);
  if (hit.provider) lines.push(`— LENS · ${String(hit.provider).toUpperCase()} · LEAKED`);
  return lines.join("\n");
}
