/** Statewide commercial seed via OSM map API (works when Overpass is down). */
import fs from "node:fs";
import path from "node:path";
import { OK_RENT_CITY_ROWS } from "../www/ok-rent-cities.js";
import { parseOsmXmlNodes } from "../www/net.js";

const root = path.resolve(import.meta.dirname, "..");
const outJs = path.join(root, "www/ok-biz-flags.js");
const outJson = path.join(root, "www/data/ok-biz-flags.json");
const progressPath = path.join(root, "www/data/ok-biz-osm-map-progress.json");

const DELAY_MS = 2200;
const BOX = 0.036;
const UA = "GroundControl/1.0 (ok-biz-osm-map; hail-flags seed)";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstPhone(tags = {}) {
  return (
    String(tags.phone || tags["contact:phone"] || tags["contact:mobile"] || "")
      .split(/[;,/|]/)
      .map((s) => s.trim())
      .find(Boolean) || ""
  );
}

function isBizTags(tags = {}) {
  if (tags.shop || tags.office || tags.craft || tags.healthcare) return true;
  const a = String(tags.amenity || "");
  return /^(restaurant|fast_food|cafe|bar|pub|fuel|bank|pharmacy|doctors|dentist|clinic|car_wash|car_repair|veterinary)$/i.test(
    a,
  );
}

function slimRow(el, cityHint = "") {
  const tags = el.tags || {};
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!isBizTags(tags)) return null;
  const name = String(tags.name || tags.operator || "").trim();
  const street = String(tags["addr:street"] || "").trim();
  const house = String(tags["addr:housenumber"] || "").trim();
  if (!name && !house) return null;
  return {
    name: name || [house, street].filter(Boolean).join(" "),
    street: [house, street].filter(Boolean).join(" "),
    city: String(tags["addr:city"] || cityHint || "").trim(),
    state: String(tags["addr:state"] || "OK").trim() || "OK",
    zip: String(tags["addr:postcode"] || "").trim(),
    lat,
    lon,
    phone: firstPhone(tags),
    source: "osm-business",
    phone_kind: "business",
  };
}

function mergeBiz(a, b) {
  const out = [];
  const seen = new Map();
  const push = (r) => {
    if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return;
    const key = `${String(r.name || "").toLowerCase()}|${r.lat.toFixed(4)}|${r.lon.toFixed(4)}`;
    const prev = seen.get(key);
    if (prev == null) {
      seen.set(key, out.length);
      out.push(r);
      return;
    }
    if (!out[prev].phone && r.phone) out[prev] = { ...out[prev], ...r, phone: r.phone };
    else if (!out[prev].street && r.street) out[prev] = { ...out[prev], street: r.street };
  };
  for (const r of a || []) push(r);
  for (const r of b || []) push(r);
  return out;
}

function loadExistingSeed() {
  try {
    const flags = JSON.parse(fs.readFileSync(outJson, "utf8"));
    return Array.isArray(flags) ? flags : [];
  } catch {
    return [];
  }
}

function writeSeed(flags) {
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  const tmpJson = `${outJson}.tmp`;
  const tmpJs = `${outJs}.tmp`;
  const body = JSON.stringify(flags);
  fs.writeFileSync(tmpJson, `${body}\n`);
  fs.writeFileSync(
    tmpJs,
    `/** Auto-generated OK commercial POI seed — do not edit by hand. */\nexport const OK_BIZ_FLAG_SEED = ${body};\nexport const OK_BIZ_FLAG_SEED_AT = ${Date.now()};\n`,
  );
  fs.renameSync(tmpJson, outJson);
  fs.renameSync(tmpJs, outJs);
}

function loadProgress() {
  try {
    const j = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    return {
      done: new Set(Array.isArray(j.done) ? j.done : []),
      flags: Array.isArray(j.flags) ? j.flags : loadExistingSeed(),
    };
  } catch {
    return { done: new Set(), flags: loadExistingSeed() };
  }
}

function saveProgress(done, flags) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, JSON.stringify({ done: [...done], flags, at: Date.now(), mode: "osm-map" }));
  writeSeed(flags);
}

function cityTiles(row) {
  const pop = Number(row.pop) || 0;
  const ring = pop >= 80000 ? [-BOX, 0, BOX] : [0];
  const tiles = [];
  for (const dLat of ring) {
    for (const dLon of ring) {
      const lat = row.lat + dLat;
      const lon = row.lon + dLon;
      tiles.push({
        id: `${String(row.name).toLowerCase()}|${dLat.toFixed(3)}|${dLon.toFixed(3)}`,
        city: row.name,
        south: lat - BOX / 2,
        north: lat + BOX / 2,
        west: lon - BOX / 2,
        east: lon + BOX / 2,
      });
    }
  }
  return tiles;
}

async function fetchMap(tile) {
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${tile.west},${tile.south},${tile.east},${tile.north}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 22000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/xml", "User-Agent": UA },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const xml = await res.text();
    return parseOsmXmlNodes(xml);
  } finally {
    clearTimeout(t);
  }
}

const { done, flags: startFlags } = loadProgress();
let flags = startFlags;
const tiles = OK_RENT_CITY_ROWS.flatMap(cityTiles);
console.log(`OSM map commercial · ${tiles.length} tiles · ${flags.length} pins · ${done.size} done`);

for (const tile of tiles) {
  if (done.has(tile.id)) continue;
  process.stdout.write(`… ${tile.id} `);
  try {
    const els = await fetchMap(tile);
    const rows = els.map((el) => slimRow(el, tile.city)).filter(Boolean);
    flags = mergeBiz(flags, rows);
    done.add(tile.id);
    saveProgress(done, flags);
    console.log(`+${rows.length} (${rows.filter((r) => r.phone).length} ph) → ${flags.length}`);
    await sleep(DELAY_MS);
  } catch (e) {
    const msg = String(e.message || e);
    console.log(`FAIL ${msg}`);
    if (/509|429|rate/i.test(msg)) await sleep(8000);
    else await sleep(DELAY_MS);
  }
}

writeSeed(flags);
console.log(`done · ${flags.length} pins · ${flags.filter((r) => r.phone).length} OSM phones`);
