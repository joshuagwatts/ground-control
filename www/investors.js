/** Insurance (hearts) and real-estate (stars) investors on the HailScope map. */

import { uid } from "./store.js";
import { OK_RENT_CITY_ROWS } from "./ok-rent-cities.js";
import { formatPhone, phoneDigits } from "./contacts.js";

export const INVESTOR_KINDS = [
  {
    id: "insurance",
    label: "Insurance investor",
    short: "INS",
    symbol: "heart",
    color: "#e11d48",
    hint: "Broken heart until you have a working relationship, then a full red heart",
  },
  {
    id: "realestate",
    label: "Real estate investor",
    short: "RE",
    symbol: "star",
    color: "#fbbf24",
    hint: "Outline star until you are working together, then a filled gold star — tap to show their listings",
  },
];

export const MAX_INVESTORS = 200;
export const MAX_LISTED_INVESTORS = 400;
export const MAX_INVESTOR_LISTINGS = 40;

const KIND_IDS = new Set(INVESTOR_KINDS.map((k) => k.id));

const OK_BOX = { south: 33.55, north: 37.05, west: -103.05, east: -94.35 };
const PHOTON_URL = "https://photon.komoot.io/api/";
const SKIP_LISTING =
  /\bbail\b|\bbonding\b|\bhistoric school\b|\benrollment center\b|\b(?:car )?insurance repair\b|\btitle loans?\b|\bpawn\b/i;
const INSURANCE_NAME =
  /\b(insurance|insurors?|underwrit|claims?\s+adjust|public adjust|risk management|farmers ins|state farm|allstate|farm bureau|nationwide|liberty mutual|shelter ins|american family|progressive|aflac|aaa insurance|goosehead|brightway|hippo|lemonade insurance|travelers|usaa|erie insurance|auto-?owners|safeco|the hartford|cincinnati insurance|chubb)\b/i;
/** Generic trade words first, then brokerage brands that do not always say "realty". */
const REALESTATE_NAME =
  /\b(real\s*e-?state|realtors?|realty|estate agents?|land (?:&|and) home|property manage(?:ment|rs?)|propert(?:y|ies) group|home ?sellers?|home ?buyers?|house ?buyers?|we buy (?:houses|homes)|cash for (?:houses|homes)|sell my house|home ?place|homestead group|investment propert|properties (?:llc|inc|group|co)|holdings (?:llc|group))\b|\b(keller williams|re\/?max|coldwell banker|century ?21|berkshire hathaway home|exp realty|epique|fathom realty|lpt realty|real broker|compass real ?estate|sotheby'?s international|weichert|crye-?leike|howard hanna|united country|better homes and gardens real estate|opendoor|offerpad|redfin|chinowth|mcgraw realtors|metro first|verbode|whittington)\b|\bpropert(?:y|ies)(?:\s*,?\s*(?:l\.?l\.?c\.?|inc\.?|co\.?))?\s*$/i;

/** OSM tag values that mean "this is an insurance office" / "this is a real-estate office". */
const INSURANCE_TAGS = /\b(insurance|insurance_agency|insurance_broker)\b/;
const REALESTATE_TAGS =
  /\b(estate_agent|estate_agency|realtor|realty|real_estate|real_estate_agent|property_management|property_manager|letting_agent|housing_association)\b/;
/** Tag context that rules a place out no matter how its name reads ("Homeplace Diner"). */
const SKIP_TAGS =
  /\b(restaurant|fast_food|cafe|pub|\bbar\b|biergarten|fuel|hotel|motel|hostel|place_of_worship|school|college|kindergarten|hospital|clinic|doctors|dentist|pharmacy|veterinary|supermarket|convenience|hairdresser|beauty|car_repair|car_wash|funeral_directors|bank|atm|fitness_centre|childcare|library|museum)\b/;
/**
 * Names that name a different trade. OSM around Oklahoma City carries
 * `office=estate_agent` on a bottled-water plant, a self-storage yard and a home
 * designer; the sign on the door beats a tag nobody has revisited since the import.
 * These veto outright — "Naifco Realty Central Storage" is a storage yard whatever
 * the first word says.
 */
const NOT_AGENT_NAME =
  /\b(storage|bottling|church|chapel|ministries|cathedral|synagogue|mosque|funeral|mortuary|crematory|cemetery|car ?wash|laundromat|dry clean\w*|day ?care|diner|caf[eé]|coffee|espresso|grill|pizza|pizzeria|taqueria|bbq|barbecue|steakhouse|buffet|bakery|brewery|brewing|taproom|tavern|saloon|barbershop|tattoo|liquor|smoke shop|vape|dispensary|towing|muffler|transmission|auto repair|body shop|machine shop|welding|lumber|hardware|animal hospital|urgent care|orthodont\w*|architect\w*|(?:home|interior) design|drafting)\b|\bwater(?: (?:co|company|works|supply))?\s*$/i;

/**
 * Worth spending office lookups on? A map that has not been laid out yet reports a
 * frame a few metres wide — sweeping that burns a round trip per search term and can
 * only return places nowhere near the crew.
 */
export function officeSweepWorthIt(bounds, minSpan = 0.002) {
  const s = Number(bounds?.south);
  const w = Number(bounds?.west);
  const n = Number(bounds?.north);
  const e = Number(bounds?.east);
  if (![s, w, n, e].every(Number.isFinite) || n <= s || e <= w) return false;
  if (n - s < minSpan || e - w < minSpan) return false;
  return s <= OK_BOX.north && n >= OK_BOX.south && w <= OK_BOX.east && e >= OK_BOX.west;
}

export function inOklahoma(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && la >= OK_BOX.south && la <= OK_BOX.north && lo >= OK_BOX.west && lo <= OK_BOX.east;
}

/**
 * Public business listing → insurance heart or real-estate star. Empty if neither.
 * `extra` is free-form tag context (`office=estate_agent`, `shop=insurance`, brand, operator…).
 * A real-estate tag always wins over an insurance tag: brokerages often sell insurance too,
 * but a tagged estate agent is never an insurance agency.
 */
export function classifyInvestorKind(name, extra = "") {
  const s = `${name || ""} ${extra || ""}`;
  if (SKIP_LISTING.test(s)) return "";
  if (NOT_AGENT_NAME.test(String(name || ""))) return "";
  const tags = String(extra || "").toLowerCase();
  // A surveyed amenity beats a stale office tag: nobody runs a brokerage out of the
  // dining room, so `amenity=restaurant` wins over `office=estate_agent`.
  if (SKIP_TAGS.test(tags)) return "";
  if (REALESTATE_TAGS.test(tags)) return "realestate";
  if (INSURANCE_TAGS.test(tags)) return "insurance";
  if (REALESTATE_NAME.test(s)) return "realestate";
  if (INSURANCE_NAME.test(s)) return "insurance";
  return "";
}

/** Free-form tag context for classification — everything that hints at what an OSM place is. */
export function osmTagContext(input = {}) {
  // Takes a tag bag or the whole element; handing it an element used to silently
  // classify every office as "neither".
  const tags = input?.tags && typeof input.tags === "object" ? input.tags : input || {};
  return [
    tags.office ? `office=${tags.office}` : "",
    tags.shop ? `shop=${tags.shop}` : "",
    tags.amenity ? `amenity=${tags.amenity}` : "",
    tags.craft ? `craft=${tags.craft}` : "",
    tags.leisure ? `leisure=${tags.leisure}` : "",
    tags.tourism ? `tourism=${tags.tourism}` : "",
    tags.healthcare ? `healthcare=${tags.healthcare}` : "",
    tags["office:type"] || "",
    tags.brand || "",
    tags.operator || "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Does the name itself say "agency", rather than only a tag saying so? */
export function nameReadsLikeInvestor(name) {
  const s = String(name || "");
  return REALESTATE_NAME.test(s) || INSURANCE_NAME.test(s);
}

/**
 * A `landuse=` polygon is a parcel of ground, not a business, and around Oklahoma
 * City plenty of them carry an office tag from an old import — that is how a water
 * plant and an office block ended up as agents. Ground with no door number and no
 * phone has to earn its pin on the name alone.
 */
export function osmParcelOnly(tags = {}) {
  if (!tags.landuse) return false;
  const door = tags["addr:housenumber"] || tags["addr:street"];
  const reach = tags.phone || tags["contact:phone"] || tags.website || tags["contact:website"] || tags.email;
  return !door && !reach;
}

/** Insurance / real-estate kind for an OSM element, or "" when it is neither. */
export function osmInvestorKind(el) {
  const tags = el?.tags || {};
  const name = String(tags.name || tags.brand || tags.operator || "").trim();
  if (!name) return "";
  const kind = classifyInvestorKind(name, osmTagContext(tags));
  if (!kind) return "";
  if (osmParcelOnly(tags) && !nameReadsLikeInvestor(name)) return "";
  return kind;
}

export function listedInvestorId(kind, lat, lon, name) {
  const slug = String(name || "x")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
  return `list:${kind}:${Number(lat).toFixed(4)}:${Number(lon).toFixed(4)}:${slug}`;
}

export function countyNameAt(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return "";
  const hit = OK_COUNTY_REGIONS.find((c) => la >= c.south && la <= c.north && lo >= c.west && lo <= c.east);
  return hit ? `${hit.name} County` : "";
}

export function defaultRegionsForListing(_kind, _city, _lat, _lon) {
  return [];
}

export function investorKindMeta(id) {
  const key = String(id || "").toLowerCase();
  return INVESTOR_KINDS.find((k) => k.id === key) || INVESTOR_KINDS[0];
}

export function isPartner(inv) {
  return String(inv?.relationship || "") === "partner";
}

export function promoteRelationship(inv) {
  return isPartner(inv) ? "prospect" : "partner";
}

export function relationshipLabel(inv) {
  if (String(inv?.kind) === "realestate") {
    return isPartner(inv) ? "Working relationship" : "Stay in touch";
  }
  return isPartner(inv) ? "Working relationship" : "Stay in touch";
}

export function promoteButtonLabel(inv) {
  if (isPartner(inv)) return "Back to stay-in-touch";
  return String(inv?.kind) === "realestate" ? "Promote to gold star" : "Promote to red heart";
}

/** Metro / county boxes used when a real-estate investor is selected. */
export const OK_COUNTY_REGIONS = [
  { name: "Oklahoma", south: 35.32, north: 35.73, west: -97.68, east: -97.12 },
  { name: "Cleveland", south: 34.98, north: 35.4, west: -97.55, east: -97.12 },
  { name: "Canadian", south: 35.38, north: 35.72, west: -98.12, east: -97.58 },
  { name: "Logan", south: 35.72, north: 36.12, west: -97.72, east: -97.18 },
  { name: "McClain", south: 34.9, north: 35.3, west: -97.72, east: -97.18 },
  { name: "Pottawatomie", south: 35.12, north: 35.52, west: -97.12, east: -96.68 },
  { name: "Lincoln", south: 35.52, north: 35.9, west: -97.12, east: -96.58 },
  { name: "Grady", south: 34.82, north: 35.28, west: -98.12, east: -97.62 },
  { name: "Tulsa", south: 35.85, north: 36.45, west: -96.3, east: -95.52 },
  { name: "Creek", south: 35.7, north: 36.22, west: -96.72, east: -95.95 },
  { name: "Osage", south: 36.16, north: 36.72, west: -96.9, east: -95.97 },
  { name: "Rogers", south: 36.1, north: 36.55, west: -95.9, east: -95.3 },
  { name: "Wagoner", south: 35.75, north: 36.15, west: -95.85, east: -95.25 },
  { name: "Okmulgee", south: 35.52, north: 35.88, west: -96.18, east: -95.72 },
  { name: "Pawnee", south: 36.18, north: 36.52, west: -97.12, east: -96.48 },
  { name: "Washington", south: 36.58, north: 36.98, west: -96.12, east: -95.78 },
  { name: "Payne", south: 35.92, north: 36.22, west: -97.22, east: -96.72 },
  { name: "Garfield", south: 36.22, north: 36.52, west: -98.02, east: -97.52 },
  { name: "Comanche", south: 34.42, north: 34.82, west: -98.62, east: -98.12 },
  { name: "Kay", south: 36.62, north: 36.98, west: -97.32, east: -96.82 },
];

const METRO_ALIASES = {
  okc: ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain"],
  "oklahoma city": ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain"],
  "okc metro": ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain", "Pottawatomie", "Lincoln", "Grady"],
  "oklahoma city metro": ["Oklahoma", "Cleveland", "Canadian", "Logan", "McClain", "Pottawatomie", "Lincoln", "Grady"],
  tulsa: ["Tulsa"],
  "tulsa metro": ["Tulsa", "Creek", "Rogers", "Wagoner", "Osage"],
};

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\bcounty\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bboxRing(b) {
  return [
    [b.south, b.west],
    [b.south, b.east],
    [b.north, b.east],
    [b.north, b.west],
    [b.south, b.west],
  ];
}

function cityRadiusM(pop) {
  const n = Number(pop) || 0;
  if (n > 400000) return 18000;
  if (n > 80000) return 9000;
  if (n > 20000) return 5200;
  if (n > 5000) return 3200;
  return 2200;
}

export function matchCountyRegion(name) {
  const key = normName(name);
  if (!key) return null;
  return OK_COUNTY_REGIONS.find((c) => normName(c.name) === key) || null;
}

export function matchCityRegion(name) {
  const key = normName(name);
  if (!key) return null;
  return (OK_RENT_CITY_ROWS || []).find((c) => normName(c.name) === key) || null;
}

export function parseRegionNames(raw) {
  return String(raw || "")
    .split(/[\n,;]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 24);
}

export function resolveInvestorRegions(inv) {
  const names = Array.isArray(inv?.regions)
    ? inv.regions.map((r) => (typeof r === "string" ? r : r?.name || "")).filter(Boolean)
    : parseRegionNames(inv?.regionText);
  const out = [];
  const seen = new Set();
  const addCounty = (countyName, label = "") => {
    const c = matchCountyRegion(countyName);
    if (!c) return;
    const key = `county:${c.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: label || `${c.name} County`,
      type: "county",
      ring: bboxRing(c),
      color: "#fbbf24",
    });
  };
  const addCity = (cityName) => {
    const c = matchCityRegion(cityName);
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return;
    const key = `city:${normName(c.name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: c.name,
      type: "city",
      lat: c.lat,
      lon: c.lon,
      radiusM: cityRadiusM(c.pop),
      color: "#f59e0b",
    });
  };
  for (const raw of names) {
    const key = normName(raw);
    const metro = METRO_ALIASES[key];
    if (metro) {
      for (const county of metro) addCounty(county, /metro/i.test(raw) ? raw : `${county} County`);
      continue;
    }
    if (matchCountyRegion(raw)) {
      addCounty(raw);
      continue;
    }
    if (matchCityRegion(raw)) {
      addCity(raw);
      continue;
    }
    out.push({ name: raw, type: "label", color: "#fbbf24" });
  }
  return out;
}

export function regionSummary(inv) {
  const shapes = resolveInvestorRegions(inv);
  if (!shapes.length) return "";
  return shapes.map((s) => s.name).join(" · ");
}

/** South/west/north/east box covering city circles and county rings, or null. */
export function investorRegionBounds(inv) {
  const shapes = resolveInvestorRegions(inv);
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  let n = 0;
  for (const s of shapes) {
    if (Array.isArray(s.ring)) {
      for (const pt of s.ring) {
        const lat = Number(pt?.[0]);
        const lon = Number(pt?.[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        south = Math.min(south, lat);
        north = Math.max(north, lat);
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        n += 1;
      }
      continue;
    }
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number(s.radiusM) > 0) {
      const dLat = Number(s.radiusM) / 111320;
      const cos = Math.cos((Number(s.lat) * Math.PI) / 180) || 1;
      const dLon = Number(s.radiusM) / (111320 * cos);
      south = Math.min(south, Number(s.lat) - dLat);
      north = Math.max(north, Number(s.lat) + dLat);
      west = Math.min(west, Number(s.lon) - dLon);
      east = Math.max(east, Number(s.lon) + dLon);
      n += 1;
    }
  }
  if (!n || south >= north || west >= east) return null;
  return { south, north, west, east };
}

function clip(s, n) {
  return String(s || "").trim().slice(0, n);
}

export function validInvestorCoord(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
}

/** True when the office pin sits in the current map frame (optional degree pad). */
export function investorInBounds(inv, bounds, padDeg = 0) {
  if (!validInvestorCoord(inv?.lat, inv?.lon) || !bounds) return false;
  const pad = Number(padDeg) || 0;
  return (
    inv.lat >= Number(bounds.south) - pad &&
    inv.lat <= Number(bounds.north) + pad &&
    inv.lon >= Number(bounds.west) - pad &&
    inv.lon <= Number(bounds.east) + pad
  );
}

function listingAddress(row = {}) {
  return [row.street || row.address, row.city, row.state || "OK", row.zip]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(", ");
}

export function listingFromBizRow(row, kindHint = "") {
  const name = String(row?.name || "").trim();
  const kind = kindHint || classifyInvestorKind(name, `${row?.office || ""} ${row?.shop || ""}`);
  if (!kind || !validInvestorCoord(row?.lat, row?.lon) || !inOklahoma(row.lat, row.lon)) return null;
  if (!name) return null;
  return normalizeInvestor({
    id: listedInvestorId(kind, row.lat, row.lon, name),
    kind,
    relationship: "prospect",
    name,
    company: name,
    phone: row.phone || "",
    email: row.email || "",
    website: row.website || "",
    address: listingAddress(row),
    note: "",
    regionText: "",
    listings: row.listings || [],
    lat: row.lat,
    lon: row.lon,
    source: row.source || "osm",
  });
}

export function listingFromPhotonFeature(feat) {
  const p = feat?.properties || {};
  const coords = feat?.geometry?.coordinates;
  const lon = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  const name = String(p.name || p.osm_value || "").trim();
  const extra = `${p.osm_key || ""}=${p.osm_value || ""} ${p.type || ""}`;
  const kind = classifyInvestorKind(name, extra);
  if (!kind || !name || !inOklahoma(lat, lon)) return null;
  const state = String(p.state || "").toLowerCase();
  if (state && !/^(ok|oklahoma)$/.test(state)) return null;
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  return listingFromBizRow(
    {
      name,
      street,
      city: p.city || p.county || "",
      state: p.state || "OK",
      zip: p.postcode || "",
      lat,
      lon,
      phone: p.phone || "",
      email: p.email || "",
      source: "osm",
      office: p.osm_value || "",
    },
    kind,
  );
}

export function mergeInvestorListings(lists) {
  const out = [];
  const seen = new Map();
  const keyOf = (n) => {
    const slug = String(n.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 28);
    return `${n.kind}:${slug}:${Number(n.lat).toFixed(3)}:${Number(n.lon).toFixed(3)}`;
  };
  const push = (inv) => {
    if (!inv || !validInvestorCoord(inv.lat, inv.lon)) return;
    const n = normalizeInvestor(inv);
    const key = keyOf(n);
    const prevI = seen.get(key) ?? seen.get(n.id);
    if (prevI == null) {
      seen.set(key, out.length);
      seen.set(n.id, out.length);
      out.push(n);
      return;
    }
    const prev = out[prevI];
    out[prevI] = normalizeInvestor({
      ...prev,
      phone: prev.phone || n.phone,
      email: prev.email || n.email,
      website: prev.website || n.website,
      address: (prev.address || "").length >= (n.address || "").length ? prev.address : n.address,
      regionText: prev.regionText || n.regionText,
      listings: (prev.listings || []).length >= (n.listings || []).length ? prev.listings : n.listings,
    });
  };
  for (const list of lists || []) {
    for (const inv of list || []) push(inv);
  }
  return out.slice(0, MAX_LISTED_INVESTORS);
}

/** Saved edits (promote / notes) win over public listings with the same id. */
export function mergeListedAndSaved(listed, saved, hiddenIds = []) {
  const hide = new Set((hiddenIds || []).map(String));
  const byId = new Map();
  for (const inv of listed || []) {
    const n = normalizeInvestor(inv);
    if (hide.has(n.id)) continue;
    byId.set(n.id, n);
  }
  for (const inv of saved || []) {
    const n = normalizeInvestor(inv);
    if (hide.has(n.id)) continue;
    const prev = byId.get(n.id);
    byId.set(
      n.id,
      prev
        ? normalizeInvestor({
            ...prev,
            ...n,
            phone: n.phone || prev.phone,
            email: n.email || prev.email,
            website: n.website || prev.website,
            listings: (n.listings || []).length ? n.listings : prev.listings,
            lat: n.lat,
            lon: n.lon,
          })
        : n,
    );
  }
  return [...byId.values()];
}

export function photonBboxParam(bounds) {
  const s = Number(bounds?.south);
  const w = Number(bounds?.west);
  const n = Number(bounds?.north);
  const e = Number(bounds?.east);
  if (![s, w, n, e].every(Number.isFinite) || n <= s || e <= w) return "";
  return `${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`;
}

/** A frame-sized box around a point, for the one-shot hunt that only knows a centre. */
export function boundsAround(lat, lon, deg = 0.06) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  const d = Math.max(0.01, Number(deg) || 0.06);
  return { south: la - d, west: lo - d, north: la + d, east: lo + d };
}

export async function photonInvestorSearch({ q, lat, lon, limit = 30, osmTag = "", bounds = null } = {}) {
  const u = new URL(PHOTON_URL);
  u.searchParams.set("q", String(q || "").trim() || "oklahoma");
  u.searchParams.set("limit", String(limit));
  if (Number.isFinite(Number(lat))) u.searchParams.set("lat", String(lat));
  if (Number.isFinite(Number(lon))) u.searchParams.set("lon", String(lon));
  // lat/lon only nudges the ranking — without a bbox "realtor" returns Port Harcourt
  // and Southern Minnesota, and the whole frame gets thrown away by the state filter.
  const bbox = photonBboxParam(bounds);
  if (bbox) u.searchParams.set("bbox", bbox);
  if (osmTag) u.searchParams.set("osm_tag", osmTag);
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const data = await res.json();
  return (data?.features || []).map(listingFromPhotonFeature).filter(Boolean);
}

/**
 * Terms worth one Photon request each. Trimmed against an Overpass sweep of the same
 * frame — brand names ("keller williams", "re/max") never added an office the generic
 * trade words had not already found, so they are not worth the round trip.
 */
export const PHOTON_REALESTATE_TERMS = ["realty", "real estate", "realtors", "property management", "properties"];
export const PHOTON_INSURANCE_TERMS = ["insurance", "insurance agency"];

/**
 * Discover offices inside the current frame using Photon. Overpass is the richer
 * source but it rejects browser User-Agents outright, so on the web build this is
 * the one office sweep that can actually run.
 */
export async function fetchPhotonInvestorsInBounds(bounds, { insurance = true, realestate = true } = {}) {
  if (!photonBboxParam(bounds)) return [];
  const terms = [
    ...(realestate ? PHOTON_REALESTATE_TERMS : []),
    ...(insurance ? PHOTON_INSURANCE_TERMS : []),
  ];
  if (!terms.length) return [];
  const chunks = await Promise.all(
    terms.map((q) => photonInvestorSearch({ q, bounds, limit: 40 }).catch(() => [])),
  );
  return mergeInvestorListings(chunks);
}

export async function fetchPhotonInvestorsNear(lat, lon, { insurance = true, realestate = true } = {}) {
  const box = boundsAround(lat, lon);
  if (!box) return [];
  return fetchPhotonInvestorsInBounds(box, { insurance, realestate });
}

/**
 * How well a listing coordinate is pinned down:
 * rooftop — the house number itself resolved; parcel — the building/plot;
 * approx — somewhere in the right block; street — a road centreline (never a house).
 */
export const LISTING_PRECISION = ["rooftop", "parcel", "approx", "street", "area"];
const EXACT_PRECISION = new Set(["rooftop", "parcel"]);
/** A road centreline or a city centroid is the "pin in the middle of the street" bug — never draw it. */
const UNDRAWABLE_PRECISION = new Set(["street", "area"]);

export function normalizeListingPrecision(raw) {
  const p = String(raw || "").toLowerCase();
  return LISTING_PRECISION.includes(p) ? p : "approx";
}

export function listingIsMappable(row) {
  return validInvestorCoord(row?.lat, row?.lon) && !UNDRAWABLE_PRECISION.has(normalizeListingPrecision(row?.precision));
}

/** True when the coordinate came back pinned to the house itself, not just the right block. */
export function listingIsExact(row) {
  return validInvestorCoord(row?.lat, row?.lon) && EXACT_PRECISION.has(normalizeListingPrecision(row?.precision));
}

/** True when the home is this office's listing — not a nearby MLS leftover. */
export function listingIsOfficeOwned(row) {
  return String(row?.attribution || "office").toLowerCase() !== "nearby";
}

export function normalizeListing(raw = {}) {
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  return {
    address: clip(raw.address, 160),
    price: clip(raw.price, 24),
    url: clip(raw.url, 240),
    source: clip(raw.source, 40) || "listing",
    attribution: String(raw.attribution || "").toLowerCase() === "nearby" ? "nearby" : "office",
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    precision: normalizeListingPrecision(raw.precision),
    geoSource: clip(raw.geoSource, 24),
  };
}

export function investorListings(inv) {
  return (Array.isArray(inv?.listings) ? inv.listings : []).filter((row) => validInvestorCoord(row.lat, row.lon));
}

/** Listings we are willing to draw a gold dot for. */
export function mappedInvestorListings(inv) {
  return (Array.isArray(inv?.listings) ? inv.listings : []).filter(listingIsMappable);
}

/** Gold dots / hunt: this office's mapped homes only — unmatched MLS leftovers do not count. */
export function officeOwnedMappedCount(inv) {
  return mappedInvestorListings(inv).filter(listingIsOfficeOwned).length;
}

function listingKm(aLat, aLon, bLat, bLon) {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

/** Stable map key so a gold dot is not rebuilt when the camera moves. */
export function listingDotKey(home) {
  if (!listingIsMappable(home)) return "";
  return `${Number(home.lat).toFixed(5)}:${Number(home.lon).toFixed(5)}`;
}

/** True while a star is selected: other real-estate stars hide; hearts stay. */
export function shouldShowInvestorPin(inv, selected) {
  if (!inv) return false;
  if (String(inv.id) === String(selected?.id || "")) return true;
  if (selected && String(selected.kind) === "realestate" && String(inv.kind) === "realestate") return false;
  return true;
}

/** Gold dots for the selected star: this office's homes, nearest first. Unmatched MLS never draws. */
export function listingsForSelectedOffice(inv, { maxKm = 12, limit = 36 } = {}) {
  const homes = mappedInvestorListings(inv).filter(listingIsOfficeOwned);
  if (!homes.length) return [];
  const lat = Number(inv?.lat);
  const lon = Number(inv?.lon);
  if (!validInvestorCoord(lat, lon)) return homes.slice(0, limit);
  const ranked = homes
    .map((h) => ({ h, km: listingKm(lat, lon, Number(h.lat), Number(h.lon)) }))
    .sort((a, b) => a.km - b.km);
  const near = ranked.filter((x) => x.km <= maxKm);
  return (near.length ? near : ranked).slice(0, limit).map((x) => x.h);
}

/** Listings we know the address of but refuse to place on the map. */
export function unmappedInvestorListings(inv) {
  return (Array.isArray(inv?.listings) ? inv.listings : []).filter(
    (row) => Boolean(String(row?.address || "").trim()) && !listingIsMappable(row),
  );
}

/** South/west/north/east box covering this agent's actual sale homes. */
export function investorListingBounds(inv) {
  const homes = mappedInvestorListings(inv).filter(listingIsOfficeOwned);
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  let n = 0;
  for (const h of homes) {
    south = Math.min(south, Number(h.lat));
    north = Math.max(north, Number(h.lat));
    west = Math.min(west, Number(h.lon));
    east = Math.max(east, Number(h.lon));
    n += 1;
  }
  if (validInvestorCoord(inv?.lat, inv?.lon)) {
    south = Math.min(south, Number(inv.lat));
    north = Math.max(north, Number(inv.lat));
    west = Math.min(west, Number(inv.lon));
    east = Math.max(east, Number(inv.lon));
    n += 1;
  }
  if (!n || south >= north || west >= east) return null;
  const pad = 0.008;
  return { south: south - pad, north: north + pad, west: west - pad, east: east + pad };
}

export function normalizeInvestor(raw = {}) {
  const kind = KIND_IDS.has(String(raw.kind || "").toLowerCase()) ? String(raw.kind).toLowerCase() : "insurance";
  const relationship = String(raw.relationship || "").toLowerCase() === "partner" ? "partner" : "prospect";
  const names = parseRegionNames(raw.regionText || (Array.isArray(raw.regions) ? raw.regions.map((r) => r?.name || r).join(", ") : ""));
  const phone = formatPhone(raw.phone || "") || clip(raw.phone, 40);
  const listings = (Array.isArray(raw.listings) ? raw.listings : []).map(normalizeListing).slice(0, MAX_INVESTOR_LISTINGS);
  return {
    id: String(raw.id || uid()),
    kind,
    relationship,
    name: clip(raw.name || raw.label, 80),
    company: clip(raw.company, 80),
    phone,
    email: clip(raw.email, 120),
    website: clip(raw.website, 200),
    address: clip(raw.address, 200),
    note: clip(raw.note, 800),
    regions: names,
    regionText: names.join(", "),
    listings,
    lat: Number(raw.lat),
    lon: Number(raw.lon),
    created: String(raw.created || new Date().toISOString()),
    updated: String(raw.updated || raw.created || new Date().toISOString()),
    source: String(raw.source || "hold"),
  };
}

export function newInvestor(partial = {}) {
  return normalizeInvestor({
    id: uid(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    source: "hold",
    relationship: "prospect",
    ...partial,
  });
}

export function upsertInvestor(list, inv) {
  const next = normalizeInvestor({ ...inv, updated: new Date().toISOString() });
  const out = Array.isArray(list) ? [...list] : [];
  const i = out.findIndex((m) => m.id === next.id);
  if (i >= 0) out[i] = next;
  else out.unshift(next);
  return { list: out.slice(0, MAX_INVESTORS), investor: next };
}

export function removeInvestor(list, id) {
  const key = String(id || "");
  return (list || []).filter((m) => m.id !== key);
}

export function setInvestorRelationship(list, id, relationship) {
  const key = String(id || "");
  const rel = relationship === "partner" ? "partner" : "prospect";
  return (list || []).map((m) => (m.id === key ? normalizeInvestor({ ...m, relationship: rel }) : m));
}

export function investorsOfKind(list, kind) {
  const k = String(kind || "");
  return (list || []).filter((m) => m.kind === k);
}

export function investorDisplayName(inv) {
  return String(inv?.name || inv?.company || investorKindMeta(inv?.kind).label).trim();
}

/** How many sale homes this office has, mapped or address-only. Nearby MLS leftovers do not count. */
export function investorPropertyCount(inv) {
  if (String(inv?.kind) !== "realestate") return 0;
  const rows = Array.isArray(inv?.listings) ? inv.listings : [];
  let n = 0;
  for (const row of rows) {
    if (!listingIsOfficeOwned(row)) continue;
    if (String(row?.address || "").trim() || listingIsMappable(row)) n += 1;
  }
  return n;
}

export function investorPropertyCountLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  return n === 1 ? "1 property" : `${n} properties`;
}

export function investorContactLine(inv) {
  const bits = [inv?.company, formatPhone(inv?.phone || "") || inv?.phone, inv?.email].map((s) => String(s || "").trim()).filter(Boolean);
  return bits.join(" · ");
}

export function investorHasContact(inv) {
  return Boolean(phoneDigits(inv?.phone || "") || String(inv?.email || "").includes("@"));
}

/** Map glyph — broken/full heart or outline/filled star (viewBox 0 0 32 32). */
export function investorGlyphSvg(inv, { size = 28 } = {}) {
  const partner = isPartner(inv);
  const kind = String(inv?.kind || "insurance");
  if (kind === "realestate") {
    const star =
      '<path d="M16 4.2l3.1 6.4 7.1.8-5.2 4.8 1.4 7-6.4-3.6-6.4 3.6 1.4-7-5.2-4.8 7.1-.8z"/>';
    if (partner) {
      return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph star partner"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><g fill="#fbbf24">${star}</g></svg>`;
    }
    return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph star prospect"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><g fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linejoin="round">${star}</g></svg>`;
  }
  const left = '<path d="M16 8.2C14.6 6 12.8 5 11 5 7.6 5 5 7.6 5 11.2c0 2.4 1.3 4.6 3.2 6.6L16 26"/>';
  const right = '<path d="M16 8.2C17.4 6 19.2 5 21 5c3.4 0 6 2.6 6 6.2 0 2.4-1.3 4.6-3.2 6.6L16 26"/>';
  if (partner) {
    return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph heart partner"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><path fill="#e11d48" d="M16 26S5 17.4 5 11.2C5 7.6 7.6 5 11 5c2.2 0 4 1.4 5 3.4C17 6.4 18.8 5 21 5c3.4 0 6 2.6 6 6.2C27 17.4 16 26 16 26z"/></svg>`;
  }
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="hs-inv-glyph heart prospect"><path fill="#0b0b0d" d="M16 1.2a14.8 14.8 0 1 1 0 29.6 14.8 14.8 0 0 1 0-29.6z"/><g fill="none" stroke="#fb7185" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${left}${right}<path d="M16 8.4l-1.2 3.2 2.2 2.2-2.4 2.6 1.4 3.4"/></g></svg>`;
}

export { formatPhone, phoneDigits };
