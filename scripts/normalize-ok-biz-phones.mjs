/** Normalize / validate phones already present on commercial seed rows (OSM tags). */
import fs from "node:fs";
import path from "node:path";
import { OK_BIZ_FLAG_SEED } from "../www/ok-biz-flags.js";
import { formatPhone, phoneDigits, isJunkPhone } from "../www/contacts.js";

const root = path.resolve(import.meta.dirname, "..");
const outJs = path.join(root, "www/ok-biz-flags.js");
const outJson = path.join(root, "www/data/ok-biz-flags.json");

function cleanPhone(raw) {
  const d = phoneDigits(raw);
  if (!d || isJunkPhone(d)) return "";
  return formatPhone(d);
}

const slim = (OK_BIZ_FLAG_SEED || []).map((r) => ({
  ...r,
  phone: cleanPhone(r.phone),
  phone_kind: "business",
  source: r.source || "osm-business",
  state: r.state || "OK",
}));

const withPhone = slim.filter((r) => r.phone).length;
fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, `${JSON.stringify(slim)}\n`);
fs.writeFileSync(
  outJs,
  `/** Auto-generated OK commercial POI seed — do not edit by hand. */\nexport const OK_BIZ_FLAG_SEED = ${JSON.stringify(slim)};\nexport const OK_BIZ_FLAG_SEED_AT = ${Date.now()};\n`,
);
console.log(`normalized ${slim.length} biz pins · ${withPhone} valid phones`);
