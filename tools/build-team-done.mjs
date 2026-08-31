/** Build www/data/team-done.json from a newline address list (ArcGIS geocode). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDoneList, normalizeDoneHouse, serializeTeamDonePack } from "../www/done.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listPath = process.argv[2] || path.join(root, ".tmp-done-addrs.txt");
const outPath = path.join(root, "www/data/team-done.json");

const text = fs.readFileSync(listPath, "utf8");
const lines = parseDoneList(text);
console.log(`geocoding ${lines.length} addresses…`);

async function geocodeOne(q) {
  const url =
    `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json` +
    `&singleLine=${encodeURIComponent(q)}&maxLocations=1&outFields=Addr_type,PlaceName,Match_addr` +
    `&countryCode=USA`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const c = (data.candidates || [])[0];
  if (!c?.location || !Number.isFinite(c.location.y) || !Number.isFinite(c.location.x)) {
    return null;
  }
  return {
    lat: c.location.y,
    lon: c.location.x,
    address: c.address || c.attributes?.Match_addr || q,
    v: 2,
    houseOk: /PointAddress|StreetAddress/i.test(String(c.attributes?.Addr_type || "")),
    source: "arcgis",
  };
}

const geo = {};
const houses = [];
let miss = 0;
for (let i = 0; i < lines.length; i++) {
  const addr = lines[i];
  const key = addr.toLowerCase();
  process.stdout.write(`  ${i + 1}/${lines.length} ${addr.slice(0, 48)}… `);
  try {
    const hit = await geocodeOne(addr);
    if (!hit) {
      miss++;
      console.log("MISS");
      houses.push(normalizeDoneHouse({ id: `done-${i}`, address: addr, lat: NaN, lon: NaN }, `done-${i}`));
    } else {
      geo[key] = hit;
      houses.push(
        normalizeDoneHouse(
          { id: `done-${i}`, address: hit.address || addr, lat: hit.lat, lon: hit.lon },
          `done-${i}`,
        ),
      );
      console.log(`${hit.lat.toFixed(4)},${hit.lon.toFixed(4)}`);
    }
  } catch (e) {
    miss++;
    console.log(`ERR ${e.message || e}`);
    houses.push(normalizeDoneHouse({ id: `done-${i}`, address: addr, lat: NaN, lon: NaN }, `done-${i}`));
  }
  await new Promise((r) => setTimeout(r, 120));
}

const placed = houses.filter((h) => Number.isFinite(Number(h.lat))).length;
const pack = serializeTeamDonePack({ text: lines.join("\n"), houses, geo });
fs.writeFileSync(outPath, JSON.stringify(pack, null, 2) + "\n");
console.log(`wrote ${outPath} — ${placed} placed · ${miss} missed`);
