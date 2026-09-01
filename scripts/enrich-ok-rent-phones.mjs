/** Bake Zillow / listing phones into OK rent flag seed (run after seed-zillow-metros). */
import fs from "node:fs";
import path from "node:path";
import { OK_RENT_FLAG_SEED } from "../www/ok-rent-flags.js";
import { enrichRentFlagPhones, mergeRentFlagList } from "../www/contacts.js";

const root = path.resolve(import.meta.dirname, "..");
const outJs = path.join(root, "www/ok-rent-flags.js");
const outJson = path.join(root, "www/data/ok-rent-flags.json");

function slimRow(r) {
  return {
    name: r.name || "",
    street: r.street || "",
    city: r.city || "",
    state: r.state || "OK",
    zip: r.zip || "",
    lat: r.lat,
    lon: r.lon,
    phone: r.phone || "",
    listingUrl: r.listingUrl || "",
    source: r.source || "zillow-rent",
    phone_kind: "rental",
  };
}

const start = OK_RENT_FLAG_SEED.length;
const need = OK_RENT_FLAG_SEED.filter((r) => !r.phone && r.listingUrl).length;
console.log(`Enriching ${need} phoneless pins (${start} total)…`);

const enriched = await enrichRentFlagPhones(OK_RENT_FLAG_SEED, {
  concurrency: 16,
  delayMs: 60,
  onHit: (row, hits, total) => {
    if (hits % 25 === 0 || hits === total) {
      console.log(`  phones ${hits}/${total} — last ${row.name || row.street} ${row.phone}`);
    }
  },
});

const slim = mergeRentFlagList([], enriched).map(slimRow);
const withPhone = slim.filter((r) => r.phone).length;

fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(slim));
fs.writeFileSync(
  outJs,
  `/** Generated — Zillow rent pins + scraped leasing phones for Flags. */
export const OK_RENT_FLAG_SEED = ${JSON.stringify(slim)};
export const OK_RENT_FLAG_SEED_AT = ${Date.now()};
`,
);

console.log(`DONE ${slim.length} pins · ${withPhone} with phones (was ${OK_RENT_FLAG_SEED.filter((r) => r.phone).length})`);
