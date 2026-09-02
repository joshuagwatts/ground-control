/** Drive-by field marks — hold the map, label a house or a finished neighborhood. */

import { uid } from "./store.js";
import { mailerProduct, mailerProducts } from "./catalog.js";

export const MARK_KINDS = [
  { id: "work", label: "Work done", short: "WORK", color: "#22c55e", hint: "We finished this house" },
  { id: "zone", label: "Work zone", short: "ZONE", color: "#86efac", hint: "Neighborhood we already built" },
  { id: "ping", label: "Product", short: "PING", color: "#fb923c", hint: "Mailer ping — Atlas, GAF, Belmont, anything" },
  { id: "atlas", label: "Atlas", short: "ATLAS", color: "#c4b5fd", hint: "Discontinued Atlas" },
  { id: "disc", label: "Discontinued", short: "DISC", color: "#fb923c", hint: "Other discontinued product" },
  { id: "asbestos", label: "Asbestos", short: "ASB", color: "#a855f7", hint: "Suspected or confirmed asbestos" },
  { id: "note", label: "Note", short: "NOTE", color: "#ffcc00", hint: "Comment pin" },
];

export const COMPOSE_KINDS = MARK_KINDS.filter(
  (k) => k.id === "work" || k.id === "zone" || k.id === "ping" || k.id === "asbestos" || k.id === "note",
);

export const MAX_MARKS = 500;

const KIND_IDS = new Set(MARK_KINDS.map((k) => k.id));

export function kindMeta(id) {
  const key = String(id || "").toLowerCase();
  return MARK_KINDS.find((k) => k.id === key) || MARK_KINDS.find((k) => k.id === "note");
}

export function isProductPing(mark) {
  const k = String(mark?.kind || "");
  return k === "ping" || k === "atlas" || k === "disc";
}

export function productIdOf(mark) {
  if (mark?.productId) return String(mark.productId);
  if (mark?.kind === "atlas") return "atlas-glassmaster";
  return "";
}

export function productForMark(mark) {
  const id = productIdOf(mark);
  if (id.startsWith("custom:")) {
    return {
      id,
      short: String(mark?.label || "OTHER").slice(0, 8).toUpperCase(),
      label: mark?.label || "Other",
      color: "#fb923c",
      makerId: "custom",
    };
  }
  return mailerProduct(id);
}

export function markBadge(mark) {
  const prod = productForMark(mark);
  const text = prod?.short || kindMeta(mark?.kind).short || "PIN";
  return String(text).replace(/[<>&]/g, "").slice(0, 10);
}

export function markTint(mark) {
  const prod = productForMark(mark);
  if (prod?.color) return prod.color;
  return kindMeta(mark?.kind).color;
}

/** Inner glyph for map pin icons (viewBox 0 0 32 32, centered on pin head). */
export function markKindGlyph(kind, mark = null) {
  const k = String(kind || "note").toLowerCase();
  if (k === "work") {
    return '<path fill="#0b0b0d" d="M10 15.5l3.2 3.2 8.8-8.8 2.2 2.2-11 11-5.4-5.4z"/>';
  }
  if (k === "zone") {
    return '<circle cx="16" cy="15" r="6" fill="none" stroke="#0b0b0d" stroke-width="2"/><circle cx="16" cy="15" r="2.2" fill="#0b0b0d"/>';
  }
  if (k === "asbestos") {
    return '<path fill="#0b0b0d" d="M16 9l7 12H9l7-12z"/><path fill="none" stroke="#ffcc00" stroke-width="1.6" stroke-linecap="round" d="M16 13v3.5M16 18v2"/>';
  }
  if (k === "note") {
    return '<rect x="11" y="10" width="10" height="9" rx="1.2" fill="#0b0b0d"/><path d="M13 17h6" stroke="#ffcc00" stroke-width="1.5" stroke-linecap="round"/>';
  }
  if (isProductPing({ kind: k, productId: mark?.productId })) {
    return '<path fill="#0b0b0d" d="M16 10l5 3v7l-5 3-5-3v-7l5-3z"/><circle cx="16" cy="15.5" r="2" fill="#ffcc00"/>';
  }
  return '<circle cx="16" cy="15" r="4.5" fill="#0b0b0d"/>';
}

/** Map pin SVG — teardrop + kind glyph (not text badges). */
export function markPinSvgHtml(mark, w = 25, h = 41) {
  const tint = markTint(mark);
  const glyph = markKindGlyph(mark?.kind, mark);
  return `<svg viewBox="0 0 32 48" style="width:${w}px;height:${h}px" width="${w}" height="${h}" aria-hidden="true" class="hs-mark-pin-svg"><path fill="${tint}" fill-rule="evenodd" d="M16 0C7.16 0 0 7.16 0 16c0 11.2 16 32 16 32s16-20.8 16-32C32 7.16 24.84 0 16 0z"/>${glyph}</svg>`;
}

/** Small list-row icon. */
export function markListIconHtml(mark, size = 18) {
  const tint = markTint(mark);
  const glyph = markKindGlyph(mark?.kind, mark);
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-mark-list-ico"><circle cx="16" cy="16" r="15" fill="${tint}"/>${glyph}</svg>`;
}

function markMergeKey(m) {
  const id = String(m?.id || "").trim();
  if (id) return `id:${id}`;
  const la = Number(m?.lat);
  const lo = Number(m?.lon);
  if (Number.isFinite(la) && Number.isFinite(lo)) {
    return `pt:${la.toFixed(4)}|${lo.toFixed(4)}|${m.kind}|${String(m.label || "").slice(0, 24).toLowerCase()}`;
  }
  const addr = String(m?.address || m?.label || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return addr ? `addr:${addr}` : `id:${id || uid()}`;
}

export function mergeMarksPack(local = [], pack = []) {
  const byKey = new Map();
  for (const raw of [...(Array.isArray(pack) ? pack : []), ...(Array.isArray(local) ? local : [])]) {
    const m = normalizeMark(raw);
    if (!validMarkCoord(m.lat, m.lon)) continue;
    const key = markMergeKey(m);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, m);
      continue;
    }
    byKey.set(
      key,
      normalizeMark({
        ...prev,
        ...m,
        id: prev.id || m.id,
        created: prev.created || m.created,
        updated: m.updated || prev.updated,
      }),
    );
  }
  return [...byKey.values()].slice(0, MAX_MARKS);
}

export function serializeTeamMarksPack(marks = []) {
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    marks: (Array.isArray(marks) ? marks : []).map((m) => normalizeMark(m)).slice(0, MAX_MARKS),
  };
}

export function customProductId(label) {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `custom:${slug}` : "other";
}

export { mailerProducts, mailerProduct };

export function validMarkCoord(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
}

/** Map pin scale — 25%–250%, default 100%. */
export function clampPinScale(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2.5, Math.max(0.25, n));
}

export function normalizeMark(raw = {}) {
  const kind = KIND_IDS.has(String(raw.kind || "").toLowerCase()) ? String(raw.kind).toLowerCase() : "note";
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  const radiusM = kind === "zone" ? Math.min(800, Math.max(40, Number(raw.radiusM) || 160)) : 0;
  let productId = String(raw.productId || "").trim().slice(0, 80);
  if (!productId && kind === "atlas") productId = "atlas-glassmaster";
  const prod = productId ? mailerProduct(productId) : null;
  const label = String(raw.label || prod?.label || kindMeta(kind).label).trim().slice(0, 80);
  return {
    id: String(raw.id || uid()),
    kind,
    productId,
    label,
    note: String(raw.note || "").trim().slice(0, 800),
    address: String(raw.address || "").trim().slice(0, 200),
    lat,
    lon,
    radiusM,
    iconScale: clampPinScale(raw.iconScale),
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
  if (kind === "ping") return rows.filter(isProductPing);
  if (String(kind).startsWith("p:")) {
    const pid = String(kind).slice(2);
    return rows.filter((m) => productIdOf(m) === pid);
  }
  return rows.filter((m) => m.kind === kind);
}

export function marksCsv(list) {
  const rows = [["kind", "product", "label", "address", "lat", "lon", "note", "radius_m", "created"]];
  for (const m of list || []) {
    rows.push(
      [m.kind, productIdOf(m), m.label, m.address, m.lat, m.lon, m.note, m.radiusM || "", m.created]
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
