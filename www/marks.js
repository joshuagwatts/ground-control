/** Drive-by field marks — hold the map, label a house or a finished neighborhood. */

import { uid } from "./store.js";

export const MARK_KINDS = [
  { id: "work", label: "Work done", short: "WORK", color: "#22c55e", hint: "We finished this house" },
  { id: "zone", label: "Work zone", short: "ZONE", color: "#86efac", hint: "Neighborhood we already built" },
  { id: "atlas", label: "Atlas", short: "ATLAS", color: "#c4b5fd", hint: "Discontinued Atlas roof" },
  { id: "disc", label: "Discontinued", short: "DISC", color: "#fb923c", hint: "Other discontinued product" },
  { id: "note", label: "Note", short: "NOTE", color: "#ffcc00", hint: "Comment pin" },
];

const KIND_IDS = new Set(MARK_KINDS.map((k) => k.id));

export function kindMeta(id) {
  const key = String(id || "").toLowerCase();
  return MARK_KINDS.find((k) => k.id === key) || MARK_KINDS[MARK_KINDS.length - 1];
}

export function validMarkCoord(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
}

export function normalizeMark(raw = {}) {
  const kind = KIND_IDS.has(String(raw.kind || "").toLowerCase()) ? String(raw.kind).toLowerCase() : "note";
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  const radiusM = kind === "zone" ? Math.min(800, Math.max(40, Number(raw.radiusM) || 160)) : 0;
  return {
    id: String(raw.id || uid()),
    kind,
    label: String(raw.label || kindMeta(kind).label).trim().slice(0, 80),
    note: String(raw.note || "").trim().slice(0, 800),
    address: String(raw.address || "").trim().slice(0, 200),
    lat,
    lon,
    radiusM,
    created: String(raw.created || new Date().toISOString()),
    updated: String(raw.updated || raw.created || new Date().toISOString()),
    source: String(raw.source || "hold"),
  };
}

export function newMark(partial = {}) {
  return normalizeMark({
    id: uid(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    source: "hold",
    ...partial,
  });
}

export function upsertMark(list, mark) {
  const next = normalizeMark({ ...mark, updated: new Date().toISOString() });
  const out = Array.isArray(list) ? [...list] : [];
  const i = out.findIndex((m) => m.id === next.id);
  if (i >= 0) out[i] = next;
  else out.unshift(next);
  return { list: out, mark: next };
}

export function removeMark(list, id) {
  const key = String(id || "");
  return (list || []).filter((m) => m.id !== key);
}

export function filterMarks(list, kind) {
  const rows = Array.isArray(list) ? list : [];
  if (!kind || kind === "all") return rows;
  return rows.filter((m) => m.kind === kind);
}

export function marksCsv(list) {
  const rows = [["kind", "label", "address", "lat", "lon", "note", "radius_m", "created"]];
  for (const m of list || []) {
    rows.push(
      [m.kind, m.label, m.address, m.lat, m.lon, m.note, m.radiusM || "", m.created]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(","),
    );
  }
  rows[0] = rows[0].join(",");
  return rows.join("\n");
}

export function marksPlainList(list) {
  return (list || [])
    .map((m) => {
      const head = [m.label || kindMeta(m.kind).label, m.address].filter(Boolean).join(" — ");
      const note = m.note ? `\n${m.note}` : "";
      return `${head}${note}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

export function outreachDraft(list, { company = "Ground Control", operator = "" } = {}) {
  const rows = list || [];
  const who = operator ? `${operator} at ${company}` : company;
  const addrs = rows.map((m) => m.address || m.label).filter(Boolean);
  const body = [
    `Hello,`,
    ``,
    `This is ${who}. We were in your neighborhood and noticed the roofing product on this home looks like a discontinued line. Matching shingles for a patch are often no longer made, which can leave storm damage unrepairable to manufacturer spec.`,
    ``,
    `If you would like a no-pressure look at repair vs. reroof options, reply to this note or call us and we will put you on the list.`,
    ``,
    `Addresses on this list:`,
    ...addrs.map((a) => `• ${a}`),
    ``,
    `Thank you,`,
    who,
  ].join("\n");
  return { subject: `${company}: discontinued roofing on your home`, body, addresses: addrs, count: rows.length };
}
