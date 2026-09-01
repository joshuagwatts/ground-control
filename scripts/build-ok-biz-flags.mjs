/** Build www/ok-biz-flags.js — statewide OSM shop/office seed for commercial Flags. */
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

const CITY_LIMIT = Number(process.env.BIZ_CITY_LIMIT) || 40;
const KM = 7.5;
const DELAY_MS = 2500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function citySlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function firstPhone(tags = {}) {
  return String(tags.phone || tags["contact:phone"] || tags["contact:mobile"] || "")
    .split(/[;,/|]/)
    .map((s) => s.trim())
    .find(Boolean) || "";
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
  const seen = new Set();
  const push = (r) => {
    if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return;
    const key = `${String(r.name || "").toLowerCase()}|${r.lat.toFixed(4)}|${r.lon.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  for (const r of a || []) push(r);
  for (const r of b || []) push(r);
  return out;
}

function writeSeed(flags) {
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(flags)}\n`);
  fs.writeFileSync(
    outJs,
    `/** Auto-generated OK commercial POI seed — do not edit by hand. */\nexport const OK_BIZ_FLAG_SEED = ${JSON.stringify(flags)};\nexport const OK_BIZ_FLAG_SEED_AT = ${Date.now()};\n`,
  );
}

function loadProgress() {
  try {
    const j = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    return {
      done: new Set(Array.isArray(j.done) ? j.done : []),
      flags: Array.isArray(j.flags) ? j.flags : [],
    };
  } catch {
    try {
      const flags = JSON.parse(fs.readFileSync(outJson, "utf8"));
      return { done: new Set(), flags: Array.isArray(flags) ? flags : [] };
    } catch {
      return { done: new Set(), flags: [] };
    }
  }
}

function saveProgress(done, flags) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, JSON.stringify({ done: [...done], flags, at: Date.now() }));
  writeSeed(flags);
}

function cityQuery(lat, lon, km = KM) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const south = lat - dLat;
  const north = lat + dLat;
  const west = lon - dLon;
  const east = lon + dLon;
  return `[out:json][timeout:25][bbox:${south},${west},${north},${east}];(
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

async function overpassOnce(query, endpoint, timeoutMs = 22000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "GroundControl/1.0 (ok-biz-seed)",
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

async function overpassCity(lat, lon) {
  const q = cityQuery(lat, lon);
  let last = "overpass failed";
  for (const endpoint of ENDPOINTS) {
    try {
      return await overpassOnce(q, endpoint);
    } catch (e) {
      last = String(e?.message || e || "overpass failed");
      await sleep(800);
    }
  }
  throw new Error(last);
}

const { done, flags: startFlags } = loadProgress();
let flags = startFlags;
const cities = OK_RENT_CITY_ROWS.slice(0, CITY_LIMIT);

console.log(`OK commercial seed · ${cities.length} cities · ${flags.length} pins so far`);

for (const city of cities) {
  const slug = citySlug(city.name);
  if (done.has(slug)) {
    console.log(`skip ${city.name}`);
    continue;
  }
  process.stdout.write(`… ${city.name} `);
  try {
    const els = await overpassCity(city.lat, city.lon);
    const rows = els.map((el) => slimRow(el, city.name)).filter(Boolean);
    flags = mergeBiz(flags, rows);
    done.add(slug);
    saveProgress(done, flags);
    console.log(`+${rows.length} → ${flags.length} total`);
  } catch (e) {
    console.log(`FAIL ${e.message || e}`);
  }
  await sleep(DELAY_MS);
}

writeSeed(flags);
console.log(`done · ${flags.length} commercial pins → ${outJs}`);
