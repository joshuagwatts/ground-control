/** Scrub OSM phones + Yellow Pages lookup for phoneless commercial seed rows. */
import fs from "node:fs";
import path from "node:path";
import { OK_BIZ_FLAG_SEED } from "../www/ok-biz-flags.js";
import {
  formatPhone,
  phoneDigits,
  isJunkPhone,
  lookupCommercialFlagPhone,
  mergeBizFlagList,
} from "../www/contacts.js";

const root = path.resolve(import.meta.dirname, "..");
const outJs = path.join(root, "www/ok-biz-flags.js");
const outJson = path.join(root, "www/data/ok-biz-flags.json");

const LIMIT = Number(process.env.BIZ_PHONE_LIMIT) || 400;
const CONC = Number(process.env.BIZ_PHONE_CONC) || 6;
const DELAY_MS = Number(process.env.BIZ_PHONE_DELAY) || 180;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanPhone(raw) {
  const d = phoneDigits(raw);
  if (!d || isJunkPhone(d)) return "";
  return formatPhone(d);
}

function slimRow(r) {
  return {
    name: r.name || "",
    street: r.street || "",
    city: r.city || "",
    state: r.state || "OK",
    zip: r.zip || "",
    lat: r.lat,
    lon: r.lon,
    phone: cleanPhone(r.phone),
    source: r.source || "osm-business",
    phone_kind: "business",
  };
}

let rows = mergeBizFlagList([], OK_BIZ_FLAG_SEED).map(slimRow);
const need = rows.filter((r) => !r.phone && r.street && r.name).slice(0, LIMIT);
console.log(`Biz phone scrub · ${rows.length} pins · ${need.length} YP lookups (cap ${LIMIT})`);

let idx = 0;
let hits = 0;
const worker = async () => {
  while (idx < need.length) {
    const i = idx++;
    const row = need[i];
    const got = await lookupCommercialFlagPhone(row.lat, row.lon, {
      name: row.name,
      street: row.street,
      city: row.city,
      state: row.state,
      zip: row.zip,
    }).catch(() => null);
    const phone = cleanPhone(got?.owner_phone || "");
    if (phone) {
      row.phone = phone;
      row.source = got?.source || "yellowpages";
      hits += 1;
      if (hits % 20 === 0 || i + 1 === need.length) {
        console.log(`  YP ${i + 1}/${need.length} · ${hits} phones · last ${row.name} ${phone}`);
      }
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
};

await Promise.all(Array.from({ length: Math.min(CONC, need.length || 1) }, () => worker()));
rows = mergeBizFlagList([], rows).map(slimRow);
const withPhone = rows.filter((r) => r.phone).length;

fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, `${JSON.stringify(rows)}\n`);
fs.writeFileSync(
  outJs,
  `/** Auto-generated OK commercial POI seed — do not edit by hand. */\nexport const OK_BIZ_FLAG_SEED = ${JSON.stringify(rows)};\nexport const OK_BIZ_FLAG_SEED_AT = ${Date.now()};\n`,
);
console.log(`DONE ${rows.length} biz pins · ${withPhone} with phones (+${hits} from YP)`);
