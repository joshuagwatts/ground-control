/** Drive-by field marks — hold the map, label a house or a finished neighborhood. */

import { uid } from "./store.js";
import { mailerProduct, mailerProducts } from "./catalog.js";

export const MARK_KINDS = [
  { id: "work", label: "Work done", short: "WORK", color: "#22c55e", hint: "We finished this house" },
  { id: "zone", label: "Work zone", short: "ZONE", color: "#86efac", hint: "Neighborhood we already built" },
  { id: "ping", label: "Product", short: "PING", color: "#fb923c", hint: "Mailer ping — Atlas, GAF, Belmont, anything" },
  { id: "atlas", label: "Atlas", short: "ATLAS", color: "#c4b5fd", hint: "Discontinued Atlas" },
  { id: "disc", label: "Discontinued", short: "DISC", color: "#fb923c", hint: "Other discontinued product" },
  { id: "note", label: "Note", short: "NOTE", color: "#ffcc00", hint: "Comment pin" },
];

export const COMPOSE_KINDS = MARK_KINDS.filter((k) => k.id === "work" || k.id === "zone" || k.id === "ping" || k.id === "note");

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

/** Map pin scale — 50%–250%, default 100%. */
export function clampPinScale(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2.5, Math.max(0.5, n));
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
