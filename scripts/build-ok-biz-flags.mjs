/** Statewide OK commercial seed via Overpass grid tiles (full state, resumable). */
import fs from "node:fs";
import path from "node:path";
import { OK_RENT_CITY_ROWS } from "../www/ok-rent-cities.js";

const root = path.resolve(import.meta.dirname, "..");
const outJs = path.join(root, "www/ok-biz-flags.js");
const outJson = path.join(root, "www/data/ok-biz-flags.json");
const progressPath = path.join(root, "www/data/ok-biz-flags-progress.json");

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

// Whole Oklahoma, ~0.4° tiles (~45km) — dense enough for shops, few enough to finish.
const SOUTH = 33.55;
const NORTH = 37.05;
const WEST = -103.05;
const EAST = -94.35;
const STEP = Number(process.env.BIZ_GRID_STEP) || 0.4;
const DELAY_MS = Number(process.env.BIZ_DELAY_MS) || 1600;
const HARD_MS = 28000;

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

function nearestCity(lat, lon) {
  let best = "";
  let bestD = Infinity;
  for (const c of OK_RENT_CITY_ROWS) {
    const d = (c.lat - lat) ** 2 + (c.lon - lon) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c.name;
    }
  }
  return best;
}

function slimRow(el) {
  const tags = el.tags || {};
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < SOUTH || lat > NORTH || lon < WEST || lon > EAST) return null;
  if (!isBizTags(tags)) return null;
  const name = String(tags.name || tags.operator || "").trim();
  const street = String(tags["addr:street"] || "").trim();
  const house = String(tags["addr:housenumber"] || "").trim();
  if (!name && !house) return null;
  return {
    name: name || [house, street].filter(Boolean).join(" "),
    street: [house, street].filter(Boolean).join(" "),
    city: String(tags["addr:city"] || nearestCity(lat, lon) || "").trim(),
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
      failed: new Set(Array.isArray(j.failed) ? j.failed : []),
      flags: Array.isArray(j.flags) ? j.flags : [],
    };
  } catch {
    try {
      const flags = JSON.parse(fs.readFileSync(outJson, "utf8"));
      return { done: new Set(), failed: new Set(), flags: Array.isArray(flags) ? flags : [] };
    } catch {
      return { done: new Set(), failed: new Set(), flags: [] };
    }
  }
}

function saveProgress(done, failed, flags) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(
    progressPath,
    JSON.stringify({ done: [...done], failed: [...failed], flags, at: Date.now(), mode: "grid" }),
  );
  writeSeed(flags);
}

function tiles() {
  const out = [];
  for (let lat = SOUTH; lat < NORTH - 1e-9; lat += STEP) {
    for (let lon = WEST; lon < EAST - 1e-9; lon += STEP) {
      const south = lat;
      const north = Math.min(NORTH, lat + STEP);
      const west = lon;
      const east = Math.min(EAST, lon + STEP);
      const id = `${south.toFixed(2)}_${west.toFixed(2)}`;
      out.push({ id, south, west, north, east });
    }
  }
  return out;
}

function tileQuery(t) {
  return `[out:json][timeout:18][bbox:${t.south},${t.west},${t.north},${t.east}];(
  node["shop"];
  node["office"];
  node["craft"];
  node["healthcare"];
  node["amenity"~"^(restaurant|fast_food|cafe|bar|pub|fuel|bank|pharmacy|doctors|dentist|clinic|car_wash|car_repair|veterinary)$"];
  way["shop"];
  way["office"];
  way["amenity"~"^(restaurant|fast_food|cafe|bar|pub|fuel|bank|pharmacy)$"];
);out tags center;`;
}

async function overpassOnce(query, endpoint) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HARD_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "GroundControl/1.0 (ok-biz-grid)",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.elements)) throw new Error("bad payload");
    return data.elements;
  } finally {
    clearTimeout(t);
  }
}

async function overpassTile(t) {
  const q = tileQuery(t);
  let last = "overpass failed";
  for (const endpoint of ENDPOINTS) {
    try {
      return await overpassOnce(q, endpoint);
    } catch (e) {
      last = String(e?.message || e || "overpass failed");
      await sleep(400);
    }
  }
  throw new Error(last);
}

const { done, failed, flags: startFlags } = loadProgress();
let flags = startFlags;
const all = tiles();
console.log(`OK commercial GRID · ${all.length} tiles · step ${STEP}° · ${flags.length} pins · ${done.size} done`);

for (const t of all) {
  if (done.has(t.id)) continue;
  process.stdout.write(`… ${t.id} `);
  try {
    const els = await overpassTile(t);
    const rows = els.map(slimRow).filter(Boolean);
    flags = mergeBiz(flags, rows);
    done.add(t.id);
    failed.delete(t.id);
    saveProgress(done, failed, flags);
    console.log(`+${rows.length} (${rows.filter((r) => r.phone).length} ph) → ${flags.length}`);
  } catch (e) {
    failed.add(t.id);
    saveProgress(done, failed, flags);
    console.log(`FAIL ${e.message || e}`);
  }
  await sleep(DELAY_MS);
}

if (failed.size) {
  console.log(`retry ${failed.size} failed tiles…`);
  for (const t of all.filter((x) => failed.has(x.id))) {
    done.delete(t.id);
    process.stdout.write(`… retry ${t.id} `);
    try {
      const els = await overpassTile(t);
      const rows = els.map(slimRow).filter(Boolean);
      flags = mergeBiz(flags, rows);
      done.add(t.id);
      failed.delete(t.id);
      saveProgress(done, failed, flags);
      console.log(`+${rows.length} → ${flags.length}`);
    } catch (e) {
      console.log(`FAIL ${e.message || e}`);
    }
    await sleep(DELAY_MS + 700);
  }
}

writeSeed(flags);
console.log(
  `done · ${flags.length} commercial pins · ${flags.filter((r) => r.phone).length} with OSM phones → ${outJs}`,
);
