/**
 * Live check of the two things field crews complained about:
 *   1. offices in frame that never became a heart or a star, and
 *   2. listing dots that land on the road instead of the house.
 *
 * Talks to the real Overpass / Photon / Census endpoints, so this is a field tool,
 * not a unit test — run it when the map looks wrong in a town and you need to know
 * whether the data or the code is at fault.
 *
 *   node tools/verify-agent-map.mjs            # both checks
 *   node tools/verify-agent-map.mjs offices    # who becomes a pin
 *   node tools/verify-agent-map.mjs dots       # where a listing pins
 */
import {
  classifyInvestorKind,
  osmTagContext,
  photonBboxParam,
  listingFromPhotonFeature,
  PHOTON_REALESTATE_TERMS,
  PHOTON_INSURANCE_TERMS,
} from "../www/investors.js";
import {
  isOfficeOsmElement,
  officeOverpassQuery,
  listingAddressParts,
  parseCensusMatch,
  scoreListingGeoHit,
} from "../www/investor-public.js";

/** Overpass answers 406 to any browser UA — off-browser callers must identify themselves. */
const UA = "GroundControl/1.0 (agent map verification)";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

const only = process.argv[2] || "";
const runOffices = !only || only === "offices";
const runDots = !only || only === "dots";

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

async function photonSweep(box) {
  const bbox = photonBboxParam(box);
  const terms = [...PHOTON_REALESTATE_TERMS, ...PHOTON_INSURANCE_TERMS];
  const out = new Map();
  for (const q of terms) {
    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", q);
    u.searchParams.set("limit", "40");
    u.searchParams.set("bbox", bbox);
    try {
      const res = await fetch(u, { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      const data = await res.json();
      for (const f of data?.features || []) {
        const row = listingFromPhotonFeature(f);
        if (row) out.set(row.name.toLowerCase(), row);
      }
    } catch (e) {
      process.stderr.write(`  photon "${q}" → ${e.message}\n`);
    }
  }
  return out;
}

const FRAMES = [
  { label: "Oklahoma City — midtown / Western Ave", south: 35.46, west: -97.56, north: 35.54, east: -97.48 },
  { label: "Norman — Main St / Campus Corner", south: 35.18, west: -97.5, north: 35.25, east: -97.4 },
  { label: "Edmond — Broadway / 2nd", south: 35.63, west: -97.52, north: 35.69, east: -97.44 },
];

if (runOffices) {
  console.log("=".repeat(78));
  console.log("1. WHO BECOMES A PIN — the two sources that feed the office sweep");
  console.log("=".repeat(78));

  for (const f of FRAMES) {
    process.stderr.write(`\nquerying ${f.label}…\n`);
    const overpassHits = new Map();
    try {
      const { data } = await overpass(officeOverpassQuery(f.south, f.west, f.north, f.east));
      for (const el of (data.elements || []).filter(isOfficeOsmElement)) {
        const t = el.tags || {};
        const name = (t.name || t.brand || t.operator || "").trim();
        overpassHits.set(name.toLowerCase(), { name, kind: classifyInvestorKind(name, osmTagContext(t)) });
      }
    } catch (e) {
      process.stderr.write(`  overpass unavailable: ${e.message}\n`);
    }
    const photonHits = await photonSweep(f);

    const union = new Map([...overpassHits, ...photonHits]);
    const stars = [...union.values()].filter((v) => v.kind === "realestate");
    const hearts = [...union.values()].filter((v) => v.kind === "insurance");
    const photonOnly = [...photonHits.keys()].filter((k) => !overpassHits.has(k));
    const overpassOnly = [...overpassHits.keys()].filter((k) => !photonHits.has(k));

    console.log(`\n${f.label}`);
    console.log(`  overpass found ${overpassHits.size}   photon found ${photonHits.size}   together ${union.size}`);
    console.log(`  ★ ${stars.length} real-estate offices   ♥ ${hearts.length} insurance agencies`);
    console.log(`  only photon saw (${photonOnly.length}): ${photonOnly.slice(0, 8).join(", ") || "—"}`);
    console.log(`  only overpass saw (${overpassOnly.length}): ${overpassOnly.slice(0, 8).join(", ") || "—"}`);
    console.log(`  stars: ${stars.map((s) => s.name).slice(0, 16).join(" | ")}`);
  }
}

if (runDots) {
  console.log(`\n${"=".repeat(78)}`);
  console.log("2. WHERE A LISTING PINS — the house, or no dot at all");
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

  async function photonFirstHit(text, near) {
    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", text);
    u.searchParams.set("limit", "8");
    u.searchParams.set("lat", String(near.lat));
    u.searchParams.set("lon", String(near.lon));
    const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    const f = (data?.features || [])[0];
    if (!f) return null;
    return { lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], props: f.properties || {} };
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
     stretch where the misplaced dot in the middle of the road turned up. */
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
  let looseFirstHits = 0;
  let placed = 0;
  let refused = 0;

  for (const address of SAMPLE) {
    const parts = listingAddressParts(address);
    if (!parts) {
      console.log(`\n${address}\n  could not parse`);
      continue;
    }

    // What a single unranked Photon query would have pinned.
    let raw = null;
    let rawLine = "no result";
    try {
      raw = await photonFirstHit(address, near);
      if (raw && Number.isFinite(raw.lat)) {
        const hn = raw.props.housenumber;
        if (!hn) looseFirstHits += 1;
        rawLine = `${hn ? `house ${hn}` : "NO HOUSE NUMBER"} · ${raw.props.type || "?"}/${raw.props.osm_key || "?"} → ${raw.lat.toFixed(5)},${raw.lon.toFixed(5)}`;
      }
    } catch (e) {
      rawLine = `failed (${e.message})`;
    }

    let hit = null;
    try {
      hit = await censusGeocode(parts);
    } catch (e) {
      process.stderr.write(`  census ${address} → ${e.message}\n`);
    }
    const score = hit ? scoreListingGeoHit(hit, parts, near) : -1;
    const accepted = Boolean(hit) && score > 0;
    if (accepted) placed += 1;
    else refused += 1;

    console.log(`\n${address}`);
    console.log(`  first photon hit : ${rawLine}`);
    console.log(
      `  what we draw     : ${
        accepted
          ? `${hit.precision}/${hit.geoSource} house ${hit.housenumber} → ${hit.lat.toFixed(5)},${hit.lon.toFixed(5)} (score ${score.toFixed(1)})`
          : "no dot — listed as address-only"
      }`,
    );
    if (accepted && raw) console.log(`  the loose hit sat ${Math.round(metres(raw, hit))} m from the verified house`);
  }

  console.log(`\n${"-".repeat(78)}`);
  console.log(`${looseFirstHits}/${SAMPLE.length} first-hit geocodes had no house number (street or POI centroid)`);
  console.log(`${placed}/${SAMPLE.length} verified to a house, ${refused} refused rather than guessed`);
}
