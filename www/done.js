/** Completed-job addresses → yellow map dots. */

import { clampPinScale } from "./marks.js";

export const MAX_DONE = 400;

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

export function normalizeDoneHouse(raw = {}, idFallback = "") {
  return {
    id: String(raw.id || idFallback || "").trim(),
    address: String(raw.address || "").trim().slice(0, 200),
    lat: Number(raw.lat),
    lon: Number(raw.lon),
    iconScale: clampPinScale(raw.iconScale),
  };
}

function addressKey(address) {
  return String(address || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Merge local + shared team pack. Prefer rows that already have map coords. */
export function mergeDonePack(local = {}, pack = {}) {
  const textLines = [];
  const seenText = new Set();
  for (const line of [...parseDoneList(local?.text), ...parseDoneList(pack?.text)]) {
    const key = addressKey(line);
    if (!key || seenText.has(key)) continue;
    seenText.add(key);
    textLines.push(line);
  }

  const geo = {
    ...(local?.geo && typeof local.geo === "object" ? local.geo : {}),
    ...(pack?.geo && typeof pack.geo === "object" ? pack.geo : {}),
  };

  const byKey = new Map();
  const rows = [...(Array.isArray(pack?.houses) ? pack.houses : []), ...(Array.isArray(local?.houses) ? local.houses : [])];
  for (const raw of rows) {
    const h = normalizeDoneHouse(raw);
    if (!h.address) continue;
    const key = addressKey(h.address);
    if (!key) continue;
    if (!seenText.has(key)) {
      seenText.add(key);
      textLines.push(h.address);
    }
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, h);
      continue;
    }
    const prevOk = Number.isFinite(Number(prev.lat)) && Number.isFinite(Number(prev.lon));
    const nextOk = Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lon));
    if (nextOk && !prevOk) byKey.set(key, { ...prev, ...h, id: prev.id || h.id });
    else byKey.set(key, { ...h, ...prev, id: prev.id || h.id });
  }

  const houses = [...byKey.values()].slice(0, MAX_DONE).map((h, i) => normalizeDoneHouse(h, h.id || `done-${i}`));
  return {
    text: textLines.slice(0, MAX_DONE).join("\n"),
    houses,
    geo,
  };
}

export function serializeTeamDonePack(done = {}) {
  const houses = (Array.isArray(done.houses) ? done.houses : []).map((h, i) => normalizeDoneHouse(h, h.id || `done-${i}`));
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    text: String(done.text || ""),
    houses,
    geo: done.geo && typeof done.geo === "object" ? done.geo : {},
  };
}
