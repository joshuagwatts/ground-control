/** Insurance (hearts) and real-estate (stars) investors on the HailScope map. */

import { uid } from "./store.js";
import { OK_RENT_CITY_ROWS } from "./ok-rent-cities.js";
import { formatPhone, phoneDigits } from "./contacts.js";

export const INVESTOR_KINDS = [
  {
    id: "insurance",
    label: "Insurance investor",
    short: "INS",
    symbol: "heart",
    color: "#e11d48",
    hint: "Broken heart until you have a working relationship, then a full red heart",
  },
  {
    id: "realestate",
    label: "Real estate investor",
    short: "RE",
    symbol: "star",
    color: "#fbbf24",
    hint: "Outline star until you are working together, then a filled gold star — tap to show their regions",
  },
];

export const MAX_INVESTORS = 200;

const KIND_IDS = new Set(INVESTOR_KINDS.map((k) => k.id));

export function investorKindMeta(id) {
  const key = String(id || "").toLowerCase();
  return INVESTOR_KINDS.find((k) => k.id === key) || INVESTOR_KINDS[0];
}

export function isPartner(inv) {
  return String(inv?.relationship || "") === "partner";
}

export function promoteRelationship(inv) {
  return isPartner(inv) ? "prospect" : "partner";
}

export function relationshipLabel(inv) {
  if (String(inv?.kind) === "realestate") {
    return isPartner(inv) ? "Working relationship" : "Stay in touch";
  }
  return isPartner(inv) ? "Working relationship" : "Stay in touch";
}

export function promoteButtonLabel(inv) {
  if (isPartner(inv)) return "Back to stay-in-touch";
  return String(inv?.kind) === "realestate" ? "Promote to gold star" : "Promote to red heart";
}

/** Metro / county boxes used when a real-estate investor is selected. */
export const OK_COUNTY_REGIONS = [
  { name: "Oklahoma", south: 35.32, north: 35.73, west: -97.68, east: -97.12 },
  { name: "Cleveland", south: 34.98, north: 35.4, west: -97.55, east: -97.12 },
  { name: "Canadian", south: 35.38, north: 35.72, west: -98.12, east: -97.58 },
  { name: "Logan", south: 35.72, north: 36.12, west: -97.72, east: -97.18 },
  { name: "McClain", south: 34.9, north: 35.3, west: -97.72, east: -97.18 },
  { name: "Pottawatomie", south: 35.12, north: 35.52, west: -97.12, east: -96.68 },
  { name: "Lincoln", south: 35.52, north: 35.9, west: -97.12, east: -96.58 },
  { name: "Grady", south: 34.82, north: 35.28, west: -98.12, east: -97.62 },
  { name: "Tulsa", south: 35.85, north: 36.45, west: -96.3, east: -95.52 },
  { name: "Creek", south: 35.7, north: 36.22, west: -96.72, east: -95.95 },
  { name: "Osage", south: 36.16, north: 36.72, west: -96.9, east: -95.97 },
  { name: "Rogers", south: 36.1, north: 36.55, west: -95.9, east: -95.3 },
  { name: "Wagoner", south: 35.75, north: 36.15, west: -95.85, east: -95.25 },
  { name: "Okmulgee", south: 35.52, north: 35.88, west: -96.18, east: -95.72 },
  { name: "Pawnee", south: 36.18, north: 36.52, west: -97.12, east: -96.48 },
  { name: "Washington", south: 36.58, north: 36.98, west: -96.12, east: -95.78 },
  { name: "Payne", south: 35.92, north: 36.22, west: -97.22, east: -96.72 },
  { name: "Garfield", south: 36.22, north: 36.52, west: -98.02, east: -97.52 },
  { name: "Comanche", south: 34.42, north: 34.82, west: -98.62, east: -98.12 },
  { name: "Kay", south: 36.62, north: 36.98, west: -97.32, east: -96.82 },
];

const METRO_ALIASES = {
  okc: ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain"],
  "oklahoma city": ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain"],
  "okc metro": ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain", "Pottawatomie", "Lincoln", "Grady"],
  "oklahoma city metro": ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain", "Pottawatomie", "Lincoln", "Grady"],
  tulsa: ["Tulsa"],
  "tulsa metro": ["Tulsa", "Creek", "Rogers", "Wagoner", "Osage"],
};

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\bcounty\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bboxRing(b) {
  return [
    [b.south, b.west],
    [b.south, b.east],
    [b.north, b.east],
    [b.north, b.west],
    [b.south, b.west],
  ];
}

function cityRadiusM(pop) {
  const n = Number(pop) || 0;
  if (n > 400000) return 18000;
  if (n > 80000) return 9000;
  if (n > 20000) return 5200;
  if (n > 5000) return 3200;
  return 2200;
}

export function matchCountyRegion(name) {
  const key = normName(name);
  if (!key) return null;
  return OK_COUNTY_REGIONS.find((c) => normName(c.name) === key) || null;
}

export function matchCityRegion(name) {
  const key = normName(name);
  if (!key) return null;
  return (OK_RENT_CITY_ROWS || []).find((c) => normName(c.name) === key) || null;
}

export function parseRegionNames(raw) {
  return String(raw || "")
    .split(/[\n,;]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 24);
}

export function resolveInvestorRegions(inv) {
  const names = Array.isArray(inv?.regions)
    ? inv.regions.map((r) => (typeof r === "string" ? r : r?.name || "")).filter(Boolean)
    : parseRegionNames(inv?.regionText);
  const out = [];
  const seen = new Set();
  const addCounty = (countyName, label = "") => {
    const c = matchCountyRegion(countyName);
    if (!c) return;
    const key = `county:${c.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: label || `${c.name} County`,
      type: "county",
      ring: bboxRing(c),
      color: "#fbbf24",
    });
  };
  const addCity = (cityName) => {
    const c = matchCityRegion(cityName);
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return;
    const key = `city:${normName(c.name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: c.name,
      type: "city",
      lat: c.lat,
      lon: c.lon,
      radiusM: cityRadiusM(c.pop),
      color: "#f59e0b",
    });
  };
  for (const raw of names) {
    const key = normName(raw);
    const metro = METRO_ALIASES[key];
    if (metro) {
      for (const county of metro) addCounty(county, /metro/i.test(raw) ? raw : `${county} County`);
      continue;
    }
    if (matchCountyRegion(raw)) {
      addCounty(raw);
      continue;
    }
    if (matchCityRegion(raw)) {
      addCity(raw);
      continue;
    }
    out.push({ name: raw, type: "label", color: "#fbbf24" });
  }
  return out;
}

export function regionSummary(inv) {
  const shapes = resolveInvestorRegions(inv);
  if (!shapes.length) return "";
  return shapes.map((s) => s.name).join(" · ");
}

/** South/west/north/east box covering city circles and county rings, or null. */
export function investorRegionBounds(inv) {
  const shapes = resolveInvestorRegions(inv);
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  let n = 0;
  for (const s of shapes) {
    if (Array.isArray(s.ring)) {
      for (const pt of s.ring) {
        const lat = Number(pt?.[0]);
        const lon = Number(pt?.[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        south = Math.min(south, lat);
        north = Math.max(north, lat);
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        n += 1;
      }
      continue;
    }
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number(s.radiusM) > 0) {
      const dLat = Number(s.radiusM) / 111320;
      const cos = Math.cos((Number(s.lat) * Math.PI) / 180) || 1;
      const dLon = Number(s.radiusM) / (111320 * cos);
      south = Math.min(south, Number(s.lat) - dLat);
      north = Math.max(north, Number(s.lat) + dLat);
      west = Math.min(west, Number(s.lon) - dLon);
      east = Math.max(east, Number(s.lon) + dLon);
      n += 1;
    }
  }
  if (!n || south >= north || west >= east) return null;
  return { south, north, west, east };
}

function clip(s, n) {
  return String(s || "").trim().slice(0, n);
}

export function validInvestorCoord(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
}

export function normalizeInvestor(raw = {}) {
  const kind = KIND_IDS.has(String(raw.kind || "").toLowerCase()) ? String(raw.kind).toLowerCase() : "insurance";
  const relationship = String(raw.relationship || "").toLowerCase() === "partner" ? "partner" : "prospect";
  const names = parseRegionNames(raw.regionText || (Array.isArray(raw.regions) ? raw.regions.map((r) => r?.name || r).join(", ") : ""));
  const phone = formatPhone(raw.phone || "") || clip(raw.phone, 40);
  return {
    id: String(raw.id || uid()),
    kind,
    relationship,
    name: clip(raw.name || raw.label, 80),
    company: clip(raw.company, 80),
    phone,
    email: clip(raw.email, 120),
    address: clip(raw.address, 200),
    note: clip(raw.note, 800),
    regions: names,
    regionText: names.join(", "),
    lat: Number(raw.lat),
    lon: Number(raw.lon),
    created: String(raw.created || new Date().toISOString()),
    updated: String(raw.updated || raw.created || new Date().toISOString()),
    source: String(raw.source || "hold"),
  };
}

export function newInvestor(partial = {}) {
  return normalizeInvestor({
    id: uid(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    source: "hold",
    relationship: "prospect",
    ...partial,
  });
}

export function upsertInvestor(list, inv) {
  const next = normalizeInvestor({ ...inv, updated: new Date().toISOString() });
  const out = Array.isArray(list) ? [...list] : [];
  const i = out.findIndex((m) => m.id === next.id);
  if (i >= 0) out[i] = next;
  else out.unshift(next);
  return { list: out.slice(0, MAX_INVESTORS), investor: next };
}

export function removeInvestor(list, id) {
  const key = String(id || "");
  return (list || []).filter((m) => m.id !== key);
}

export function setInvestorRelationship(list, id, relationship) {
  const key = String(id || "");
  const rel = relationship === "partner" ? "partner" : "prospect";
  return (list || []).map((m) => (m.id === key ? normalizeInvestor({ ...m, relationship: rel }) : m));
}

export function investorsOfKind(list, kind) {
  const k = String(kind || "");
  return (list || []).filter((m) => m.kind === k);
}

export function investorDisplayName(inv) {
  return String(inv?.name || inv?.company || investorKindMeta(inv?.kind).label).trim();
}

export function investorContactLine(inv) {
  const bits = [inv?.company, formatPhone(inv?.phone || "") || inv?.phone, inv?.email].map((s) => String(s || "").trim()).filter(Boolean);
  return bits.join(" · ");
}

export function investorHasContact(inv) {
  return Boolean(phoneDigits(inv?.phone || "") || String(inv?.email || "").includes("@"));
}

/** Map glyph — broken/full heart or outline/filled star (viewBox 0 0 32 32). */
export function investorGlyphSvg(inv, { size = 28 } = {}) {
  const partner = isPartner(inv);
  const kind = String(inv?.kind || "insurance");
  if (kind === "realestate") {
    const star =
      '<path d="M16 4.2l3.1 6.4 7.1.8-5.2 4.8 1.4 7-6.4-3.6-6.4 3.6 1.4-7-5.2-4.8 7.1-.8z"/>';
    if (partner) {
      return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph star partner"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><g fill="#fbbf24">${star}</g></svg>`;
    }
    return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph star prospect"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><g fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linejoin="round">${star}</g></svg>`;
  }
  const left = '<path d="M16 8.2C14.6 6 12.8 5 11 5 7.6 5 5 7.6 5 11.2c0 2.4 1.3 4.6 3.2 6.6L16 26"/>';
  const right = '<path d="M16 8.2C17.4 6 19.2 5 21 5c3.4 0 6 2.6 6 6.2 0 2.4-1.3 4.6-3.2 6.6L16 26"/>';
  if (partner) {
    return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph heart partner"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><path fill="#e11d48" d="M16 26S5 17.4 5 11.2C5 7.6 7.6 5 11 5c2.2 0 4 1.4 5 3.4C17 6.4 18.8 5 21 5c3.4 0 6 2.6 6 6.2C27 17.4 16 26 16 26z"/></svg>`;
  }
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph heart prospect"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><g fill="none" stroke="#fb7185" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${left}${right}<path d="M16 8.4l-1.2 3.2 2.2 2.2-2.4 2.6 1.4 3.4"/></g></svg>`;
}

export { formatPhone, phoneDigits };
