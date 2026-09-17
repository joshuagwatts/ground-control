/** Build public-listing hearts/stars from OSM biz seed + Photon (Oklahoma only). */
import fs from "node:fs";
import path from "node:path";
import { OK_BIZ_FLAG_SEED } from "../www/ok-biz-flags.js";
import { OK_RENT_CITY_ROWS } from "../www/ok-rent-cities.js";
import {
  listingFromBizRow,
  photonInvestorSearch,
  mergeInvestorListings,
} from "../www/investors.js";

const root = path.resolve(import.meta.dirname, "..");
const outJs = path.join(root, "www/ok-investors.js");
const DELAY_MS = Number(process.env.INVESTOR_DELAY_MS) || 220;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fromBizSeed() {
  return (OK_BIZ_FLAG_SEED || []).map((row) => listingFromBizRow(row)).filter(Boolean);
}

const CITY_QUERIES = [
  { q: "insurance agency", osmTag: "office:insurance", kind: "insurance" },
  { q: "realtor", osmTag: "office:estate_agent", kind: "realestate" },
  { q: "real estate investor", osmTag: "", kind: "realestate" },
];

const BRAND_QUERIES = [
  { q: "State Farm", osmTag: "office:insurance", lat: 35.47, lon: -97.52 },
  { q: "Farmers Insurance", osmTag: "office:insurance", lat: 35.47, lon: -97.52 },
  { q: "Farm Bureau Insurance", osmTag: "office:insurance", lat: 35.47, lon: -97.52 },
  { q: "Keller Williams", osmTag: "office:estate_agent", lat: 35.47, lon: -97.52 },
  { q: "State Farm", osmTag: "office:insurance", lat: 36.15, lon: -95.99 },
  { q: "Keller Williams", osmTag: "office:estate_agent", lat: 36.15, lon: -95.99 },
  { q: "REMAX", osmTag: "office:estate_agent", lat: 36.15, lon: -95.99 },
];

async function fromPhoton() {
  const out = [];
  const cities = (OK_RENT_CITY_ROWS || []).slice(0, 16);
  for (const city of cities) {
    for (const job of CITY_QUERIES) {
      try {
        const rows = await photonInvestorSearch({
          q: `${job.q} ${city.name} Oklahoma`,
          lat: city.lat,
          lon: city.lon,
          limit: 25,
          osmTag: job.osmTag,
        });
        out.push(rows);
        process.stdout.write(`.`);
      } catch (e) {
        process.stdout.write(`x`);
      }
      await sleep(DELAY_MS);
    }
  }
  for (const job of BRAND_QUERIES) {
    try {
      const rows = await photonInvestorSearch({
        q: `${job.q} Oklahoma`,
        lat: job.lat,
        lon: job.lon,
        limit: 30,
        osmTag: job.osmTag,
      });
      out.push(rows);
      process.stdout.write(`+`);
    } catch {
      process.stdout.write(`x`);
    }
    await sleep(DELAY_MS);
  }
  process.stdout.write("\n");
  return mergeInvestorListings(out);
}

function slim(inv) {
  return {
    id: inv.id,
    kind: inv.kind,
    name: inv.name,
    company: inv.company,
    phone: inv.phone,
    email: inv.email,
    address: inv.address,
    regionText: inv.regionText,
    lat: inv.lat,
    lon: inv.lon,
    source: inv.source || "osm",
  };
}

const seedBiz = fromBizSeed();
console.log(`biz seed listings ${seedBiz.length}`);
const photon = await fromPhoton();
console.log(`photon listings ${photon.length}`);
const merged = mergeInvestorListings([seedBiz, photon]).map(slim);
const ins = merged.filter((x) => x.kind === "insurance").length;
const re = merged.filter((x) => x.kind === "realestate").length;
const body = JSON.stringify(merged);
fs.writeFileSync(
  outJs,
  `/** Auto-generated OK insurance / real-estate public listings — do not edit by hand. */\nexport const OK_INVESTOR_SEED = ${body};\nexport const OK_INVESTOR_SEED_AT = ${Date.now()};\n`,
);
console.log(`wrote ${merged.length} listings (${ins} insurance, ${re} real estate) → www/ok-investors.js`);
