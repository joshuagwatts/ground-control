/** Shingle lens. Always names a catalog leader; the meter is what locks it. */

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
  return `You are Ground Control LENS — a field shingle identifier for roofing inspections.
You ALWAYS pick the single most likely CATALOG manufacturer + product + color. Refusing to name a line is a failure.
Uncertainty belongs in confidence, not in blank values. Low conf (0.2–0.6) is the correct way to say "leaning this way."

Rules:
- manufacturer / product / color MUST be names from CATALOG. Empty values only if the photos are not asphalt shingles.
- conf is 0..1 for how sure YOU are from THESE photos. Do not refuse a name just because you are not 95% sure.
- 0.92+ only when unique factory tells are visible (SureNail pink strip, LayerLock/HDZ, plant stamp, branded wrapper).
- Owens Corning Duration vs Oakridge: without a nailing-strip shot, still NAME the leader, but keep product conf below 0.72.
- GAF Timberline HD vs HDZ: without LayerLock/HDZ cues, name Timberline HD if the roof looks older, HDZ if it looks new. Keep conf below 0.72 if ambiguous.
- Date: only fill date_code if you can read a stamp, lot, or wrapper year. Weathering is era, not a date. Date conf 0.92+ is a 100% lock.
- Discontinued products ARE in the catalog — prefer them when the cues match an older line.
- Hail bruises / granule loss are damage notes, not product ID.
- shots_needed: the ONE next photo that would raise certainty the most.

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
  "notes": "one sentence: leading pick and what shot would raise the meter"
}
conf is 0..1. Name the leader even at 0.3.`;
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
  const out = await visionComplete(settings, prompt, urls, { maxTokens: 1400, temperature: 0.25 });
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
  else if (leader) lines.push(`${pct}% leaning ${leader}`);
  else lines.push(`${pct}% — keep shooting. Gemini names a leader; the meter locks it.`);
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
  } else {
    if (v.invented) lines.push("That name is not a unique catalog match — thrown out.");
    if (v.needed[0]) lines.push(nextShotPrompt(v.needed));
    else lines.push("Add a granule close-up, a full tab, overlay, and nailing strip.");
  }
  const tells = hit.analysis?.tells || [];
  if (tells.length) lines.push(`Tells: ${tells.slice(0, 4).join("; ")}`);
  if (hit.analysis?.damage?.value) lines.push(`Damage note: ${hit.analysis.damage.value} (not a claim decision).`);
  if (hit.provider) lines.push(`— LENS · ${String(hit.provider).toUpperCase()} · LEAKED`);
  return lines.join("\n");
}
