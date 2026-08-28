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
