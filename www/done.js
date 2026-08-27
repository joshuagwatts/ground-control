/** Completed-job addresses → yellow map dots and 6-pack clusters. */

import { parseStreetAddress } from "./contacts.js";
import { validMarkCoord } from "./marks.js";

export const PACK_SIZE = 6;
export const MAX_DONE = 400;
/** Link two finished houses into the same 6-pack if they are this close (meters). */
export const PACK_LINK_M = 110;

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** Distance in meters. */
export function distM(a, b) {
  if (!a || !b) return Infinity;
  return haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
}

export function parseDoneList(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    let line = String(raw || "").trim();
    if (!line) continue;
    if (/^(address|street|addresses|job address)$/i.test(line.replace(/["']/g, ""))) continue;
    const quoted = line.match(/^"([^"]+)"/);
    if (quoted) line = quoted[1].trim();
    else line = line.replace(/^["']|["']$/g, "").trim();
    if (line.length < 5 || !/\d/.test(line)) continue;
    const key = line.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function withCity(address, city) {
  const addr = String(address || "").trim();
  const place = String(city || "").trim();
  if (!addr || !place) return addr;
  if (new RegExp(place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(addr)) return addr;
  if (/,/.test(addr)) return addr;
  return `${addr}, ${place}`;
}

export function streetLabel(address) {
  const p = parseStreetAddress(address);
  const st = String(p.street || "").trim();
  if (st) return st.replace(/\b\w/g, (c) => c.toUpperCase());
  return String(address || "").split(",")[0].trim() || "Pack";
}

function modeLabel(houses) {
  const counts = new Map();
  for (const h of houses) {
    const lab = streetLabel(h.address);
    counts.set(lab, (counts.get(lab) || 0) + 1);
  }
  let best = "Pack";
  let n = 0;
  for (const [lab, c] of counts) {
    if (c > n) {
      best = lab;
      n = c;
    }
  }
  return best;
}

export function clusterSixPacks(houses, { packSize = PACK_SIZE, linkM = PACK_LINK_M } = {}) {
  const pts = (houses || []).filter((h) => validMarkCoord(h.lat, h.lon));
  const n = pts.length;
  const parent = pts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distM(pts[i], pts[j]) <= linkM) unite(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(pts[i]);
  }
  const packs = [];
  let idx = 0;
  for (const members of groups.values()) {
    const lat = members.reduce((s, h) => s + Number(h.lat), 0) / members.length;
    const lon = members.reduce((s, h) => s + Number(h.lon), 0) / members.length;
    const reach = Math.max(...members.map((h) => distM(h, { lat, lon })), 28);
    const count = members.length;
    packs.push({
      id: `pack-${idx++}`,
      label: modeLabel(members),
      count,
      packSize,
      fullPacks: Math.floor(count / packSize),
      need: count >= packSize ? 0 : packSize - count,
      full: count >= packSize,
      warm: count > 0 && count < packSize,
      lat,
      lon,
      radiusM: Math.min(240, reach + 32),
      houses: members,
    });
  }
  packs.sort((a, b) => Number(a.full) - Number(b.full) || a.count - b.count || a.label.localeCompare(b.label));
  return packs;
}

export function packLine(pack) {
  if (!pack) return "";
  if (pack.full) return `${pack.count} done · 6-pack complete`;
  return `${pack.count}/${pack.packSize} done · ${pack.need} still open · warm`;
}
