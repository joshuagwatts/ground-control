/**
 * Live check of the two things field crews complained about:
 *   1. offices in frame that never became a star, and
 *   2. listing dots that land on the road instead of the house.
 *
 * Talks to the real OSM + Census endpoints, so it is a tool, not a unit test.
 *   node tools/verify-agent-map.mjs
 */
import { classifyInvestorKind as classifyNew, osmTagContext } from "../www/investors.js";
import { classifyInvestorKind as classifyOld } from "/tmp/oldalpha/www/investors.js";
import { officeOverpassQuery as overpassQueryOld } from "/tmp/oldalpha/www/investor-public.js";
import {
  isOfficeOsmElement,
  officeOverpassQuery,
  listingAddressParts,
  parseCensusMatch,
  scoreListingGeoHit,
} from "../www/investor-public.js";

const UA = "GroundControl/1.0 (agent map verification)";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

async function overpass(query) {
  for (const url of OVERPASS) {
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(90000),
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data.elements)) return { data, url };
      } catch (e) {
        process.stderr.write(`  overpass ${new URL(url).host} → ${e.message}\n`);
      }
    }
  }
  throw new Error("every overpass mirror refused");
}

/* The old build only ever looked at office= / shop= on a couple of values. */
function oldIsOffice(el) {
  const t = el?.tags || {};
  const name = t.name || t.brand || t.operator || "";
  if (!name) return false;
  const tag = [t.office ? `office=${t.office}` : "", t.shop ? `shop=${t.shop}` : ""].filter(Boolean).join(" ");
  return Boolean(classifyOld(name, tag));
}

function newIsOffice(el) {
  return isOfficeOsmElement(el);
}

const only = process.argv[2] || "";
const runOffices = !only || only === "offices";
const runDots = !only || only === "dots";

const FRAMES = [
  { label: "Oklahoma City — midtown / Western Ave", s: 35.46, w: -97.56, n: 35.54, e: -97.48 },
  { label: "Norman — Main St / Campus Corner", s: 35.18, w: -97.5, n: 35.25, e: -97.4 },
  { label: "Edmond — Broadway / 2nd", s: 35.63, w: -97.52, n: 35.69, e: -97.44 },
];

console.log("=".repeat(78));
console.log("1. OFFICES IN FRAME — how many became a dot before vs after");
console.log("=".repeat(78));

let totalOld = 0;
let totalNew = 0;
const newlyFound = [];

for (const f of runOffices ? FRAMES : []) {
  process.stderr.write(`\nquerying ${f.label}…\n`);
  let oldEls = [];
  let newEls = [];
  try {
    // The whole pipeline changed, so replay both: the old query read by the old
    // classifier, and the new query read by the new one.
    const before = await overpass(overpassQueryOld(f.s, f.w, f.n, f.e));
    oldEls = before.data.elements || [];
    const after = await overpass(officeOverpassQuery(f.s, f.w, f.n, f.e));
    newEls = after.data.elements || [];
    process.stderr.write(`  raw elements  before ${oldEls.length}  after ${newEls.length}\n`);
  } catch (e) {
    console.log(`\n${f.label}: SKIPPED (${e.message})`);
    continue;
  }
  const oldHits = oldEls.filter(oldIsOffice);
  const newHits = newEls.filter(newIsOffice);
  totalOld += oldHits.length;
  totalNew += newHits.length;
  const oldNames = new Set(oldHits.map((el) => String(el.tags?.name || "").toLowerCase()));
  const gained = newHits.filter((el) => !oldNames.has(String(el.tags?.name || "").toLowerCase()));
  const gainedStars = gained.filter((el) => classifyNew(el.tags?.name || el.tags?.brand, osmTagContext(el.tags || {})) === "realestate");
  console.log(`\n${f.label}`);
  console.log(
    `  before: ${oldHits.length} agents drawn (${oldHits.filter((el) => classifyOld(el.tags?.name, el.tags?.office ? `office=${el.tags.office}` : "") === "realestate").length} stars)`,
  );
  console.log(`  after:  ${newHits.length} agents drawn (${newHits.filter((el) => classifyNew(el.tags?.name || el.tags?.brand, osmTagContext(el.tags || {})) === "realestate").length} stars)`);
  console.log(`  newly drawn real-estate offices (${gainedStars.length}):`);
  for (const el of gainedStars.slice(0, 14)) {
    const t = el.tags || {};
    const name = t.name || t.brand || t.operator;
    newlyFound.push(name);
    console.log(`    + ★ ${name}  [${osmTagContext(el.tags || {}).trim()}]`);
  }
  if (gainedStars.length > 14) console.log(`    … and ${gainedStars.length - 14} more`);
}

console.log(`\nTOTAL  before: ${totalOld} agents   after: ${totalNew} agents   (+${totalNew - totalOld})`);

/* ────────────────────────────────────────────────────────────────────────── */

console.log(`\n${"=".repeat(78)}`);
console.log("2. LISTING DOTS — does the dot land on the house?");
console.log("=".repeat(78));

async function censusGeocode(parts) {
  const u = new URL("https://geocoding.geo.census.gov/geocoder/locations/address");
  u.searchParams.set("street", `${parts.house || ""} ${parts.street || ""}`.trim());
  if (parts.city) u.searchParams.set("city", parts.city);
  if (parts.state) u.searchParams.set("state", parts.state);
  if (parts.zip) u.searchParams.set("zip", parts.zip);
  u.searchParams.set("benchmark", "Public_AR_Current");
  u.searchParams.set("format", "json");
  const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  const match = data?.result?.addressMatches?.[0];
  return match ? parseCensusMatch(match) : null;
}

async function photonGeocode(text, near) {
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", text);
  u.searchParams.set("limit", "8");
  if (near) {
    u.searchParams.set("lat", String(near.lat));
    u.searchParams.set("lon", String(near.lon));
  }
  const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  return (data?.features || []).map((f) => ({
    lat: f.geometry?.coordinates?.[1],
    lon: f.geometry?.coordinates?.[0],
    props: f.properties || {},
  }));
}

function metres(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Real addresses on real Oklahoma listing streets, including the commercial
   stretch where the misplaced Allison dot turned up. */
const SAMPLE = [
  "1417 NW 34th St, Oklahoma City, OK 73118",
  "3400 N Western Ave, Oklahoma City, OK 73118",
  "925 NW 43rd St, Oklahoma City, OK 73118",
  "2200 Westheimer Dr, Norman, OK 73069",
  "1601 Rambling Rd, Norman, OK 73072",
  "500 S Broadway Ave, Edmond, OK 73034",
  "1200 E 15th St, Edmond, OK 73013",
  "6301 N Pennsylvania Ave, Nichols Hills, OK 73116",
  "9300 N May Ave, Oklahoma City, OK 73120",
  "4100 Perimeter Center, Oklahoma City, OK 73112",
];

const near = { lat: 35.47, lon: -97.52 };
let oldOnRoad = 0;
let newOnHouse = 0;
let newRefused = 0;

for (const address of runDots ? SAMPLE : []) {
  const parts = listingAddressParts(address);
  if (!parts) {
    console.log(`\n${address}\n  could not parse`);
    continue;
  }

  // Old build: one Photon query, take the first feature, pin it, whatever it is.
  let oldLine = "no result";
  let oldPt = null;
  let oldStreety = false;
  try {
    const hits = await photonGeocode(address, near);
    const first = hits[0];
    if (first && Number.isFinite(first.lat)) {
      oldPt = { lat: first.lat, lon: first.lon };
      oldStreety = !first.props.housenumber;
      oldLine = `${first.props.housenumber ? "house " + first.props.housenumber : "NO HOUSE NUMBER"} · ${first.props.type || "?"}/${first.props.osm_key || "?"} → ${first.lat.toFixed(5)},${first.lon.toFixed(5)}`;
    }
  } catch (e) {
    oldLine = `failed (${e.message})`;
  }
  if (oldStreety) oldOnRoad += 1;

  // New build: Census parcel match is the reference truth for a US street address.
  let censusHit = null;
  try {
    censusHit = await censusGeocode(parts);
  } catch (e) {
    process.stderr.write(`  census ${address} → ${e.message}\n`);
  }

  const score = censusHit ? scoreListingGeoHit(censusHit, parts, near) : -1;
  const accepted = Boolean(censusHit) && score > 0;
  if (accepted) newOnHouse += 1;
  else newRefused += 1;

  const drift = censusHit && oldPt ? metres(oldPt, censusHit) : null;
  console.log(`\n${address}`);
  console.log(`  before  ${oldLine}`);
  console.log(
    `  after   ${
      accepted
        ? `${censusHit.precision}/${censusHit.geoSource} house ${censusHit.housenumber} → ${censusHit.lat.toFixed(5)},${censusHit.lon.toFixed(5)} (score ${score.toFixed(1)})`
        : "refused — listed as address-only, no dot on the map"
    }`,
  );
  if (drift != null) console.log(`  the old dot sat ${Math.round(drift)} m from the verified house`);
}

console.log(`\n${"-".repeat(78)}`);
console.log(`before: ${oldOnRoad}/${SAMPLE.length} dots had no house number (street or POI centroid)`);
console.log(`after:  ${newOnHouse}/${SAMPLE.length} verified to a house, ${newRefused} refused rather than guessed`);
