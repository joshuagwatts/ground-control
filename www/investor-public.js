/** Public office contacts + an agent's actual for-sale homes (not county boxes). */

import { httpDiag, httpGet, osmMapJson, overpassJson } from "./net.js";
import { listingBrowserHeaders } from "./device.js";
import {
  extractContactsFromHtml,
  extractEmails,
  extractPhones,
  extractSearchResultUrls,
  formatPhone,
  formatYellowPagesBizNameUrl,
  isJunkPhone,
  mergeContacts,
  parseStreetAddress,
  phoneDigits,
} from "./contacts.js";
import {
  inOklahoma,
  investorHasContact,
  investorInBounds,
  investorListings,
  listingFromBizRow,
  listingIsExact,
  listingIsMappable,
  listingIsOfficeOwned,
  mappedInvestorListings,
  officeOwnedMappedCount,
  OFFICE_LISTING_HUNT_BELOW,
  normalizeInvestor,
  normalizeListing,
  osmInvestorKind,
  osmTagContext,
  validInvestorCoord,
} from "./investors.js";

const OSM_API = "https://api.openstreetmap.org/api/0.6";
const PHOTON_URL = "https://photon.komoot.io/api/";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const ARCGIS_GEOCODER_URL = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";
const OK_EXTENT = { west: -103.05, south: 33.55, east: -94.35, north: 37.05 };
const DDG_HTML = "https://html.duckduckgo.com/html/?q=";
const DDG_LITE = "https://lite.duckduckgo.com/lite/?q=";
const MAX_LISTINGS = 40;
const MAX_FETCH_LISTINGS = 24;
const MAX_LISTING_GEOCODE = 16;
const MAX_LISTING_KM = 48;

const PEOPLE_SEARCH =
  /facebook\.com|instagram\.com|linkedin\.com|truepeoplesearch|beenverified|spokeo|fastpeoplesearch|thatsthem|intelius|radaris|cyberbackground|whitepages\.com\/name|411\.com\/people|anywho\.com\/people/i;
const JUNK_MAIL =
  /example\.com$|noreply|no-reply|privacy@|support@duckduckgo|sentry\.io$|wixpress|godaddy|wordpress\.com$|png$|jpg$|gif$|keen\.io$|cloudflare|schema\.org|placeholder|sentry|wix\.com$|thebbb\.org$|bbb\.org$|yellowpages\.com$|yelp\.com$|facebook\.com$|google\.com$|interactiveblue\.com$|squarespace\.com$|hubspot\.com$|mailchimp\.com$|constantcontact\.com$/i;
const DIRECTORY_HOST =
  /yellowpages\.com|bbb\.org|thebbb\.org|yelp\.com|facebook\.com|duckduckgo|realtor\.com|zillow\.com|redfin\.com|homes\.com|chamberofcommerce\.com|superpages\.com|manta\.com|mapquest\.com|bizapedia\.com|allbiz\.com|citysquares\.com|us-info\.com|ratemyagent\.com|rocketreach\.co|pages24\.com|directionus\.com|yellowbot\.com|birdeye\.com|prospectb2b\.com|erealestatepro\.com|opendi\.|homestars\.com|realty\.com|homesandland\.com|bing\.com/i;
/** City-wide portals — never treat these as this office's listing site. */
const LISTING_PORTAL_HOST =
  /trulia\.com|crexi\.com|showcase\.com|loopnet\.com|land\.com|landsearch\.com|mls\.com|apartments\.com|hotpads|zumper|movoto|homesnap|cortera|findglocal|locations\.kw\.com|okchomesellers\.com/i;
const GENERIC_NAME =
  /^(the|and|llc|inc|co|corp|agency|insurance|ins|realty|real|estate|realtor|realtors|group|company|associates|office|agent|agents|farm|state|farmers|allstate|nationwide)$/i;
const FRANCHISE_TOKEN =
  /^(keller|williams|century|coldwell|banker|remax|exp|compass|berkshire|hathaway|sotheby|fathom|weichert|epique|better|homes|gardens)$/i;

function clip(s, n) {
  return String(s || "").trim().slice(0, n);
}

function nameKey(s) {
  return String(s || "")
    .replace(/&amp;/gi, "&")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(s) {
  return nameKey(s)
    .split(" ")
    .filter((w) => w.length > 2 && !GENERIC_NAME.test(w));
}

export function namesLikelySame(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.length || !B.length) return nameKey(a) && nameKey(a) === nameKey(b);
  const setB = new Set(B);
  const hit = A.filter((t) => setB.has(t)).length;
  return hit >= Math.min(2, A.length, B.length) || (A.length === 1 && setB.has(A[0]));
}

/** Tokens that distinguish this office from a franchise brand (Mulinix, Seabrooke, McGraw). */
export function officeUniqueTokens(name) {
  return nameTokens(name).filter((t) => !FRANCHISE_TOKEN.test(t));
}

export function officeBrandKey(s) {
  const k = nameKey(s);
  if (/state\s*farm/.test(k)) return "statefarm";
  if (/farm\s*bureau/.test(k)) return "farmbureau";
  if (/\bfarmers\b/.test(k)) return "farmers";
  if (/\ballstate\b/.test(k)) return "allstate";
  if (/\bnationwide\b/.test(k)) return "nationwide";
  return "";
}

export function sameOfficeBrand(a, b) {
  const key = officeBrandKey(a);
  return Boolean(key && key === officeBrandKey(b));
}

export function officesLikelySame(a, b) {
  return namesLikelySame(a, b) || sameOfficeBrand(a, b);
}

export function osmElementLatLon(el) {
  const lat = Number(el?.lat ?? el?.center?.lat);
  const lon = Number(el?.lon ?? el?.center?.lon);
  return validInvestorCoord(lat, lon) ? { lat, lon } : null;
}

/** Any OSM place we can call an insurance or real-estate office — tags first, then the name. */
export function isOfficeOsmElement(el) {
  return Boolean(osmInvestorKind(el));
}

/**
 * Offices in the frame. Asking for every `office=*` and then classifying locally catches the
 * brokerages OSM tags as `property_management`, `shop=estate_agent`, or plain `office=company`
 * with "Realty" in the name — the ones a two-value query silently drops.
 */
const OFFICE_BRAND_RE =
  "State Farm|Farmers Insurance|Allstate|Nationwide|Farm Bureau|Goosehead|Keller Williams|RE/?MAX|Coldwell Banker|Century ?21|Berkshire Hathaway|eXp Realty|Sotheby|Realty|Realtors|Real Estate|Property Management";

export function officeOverpassQuery(south, west, north, east) {
  const s = Number(south).toFixed(5);
  const w = Number(west).toFixed(5);
  const n = Number(north).toFixed(5);
  const e = Number(east).toFixed(5);
  return `[out:json][timeout:20][bbox:${s},${w},${n},${e}];(
    nwr["office"];
    nwr["shop"="estate_agent"];
    nwr["shop"="insurance"];
    nwr["name"~"${OFFICE_BRAND_RE}",i];
  );out tags center;`;
}

/** Narrow fallback for when the broad office sweep times out on a busy Overpass mirror. */
export function officeOverpassQueryNarrow(south, west, north, east) {
  const s = Number(south).toFixed(5);
  const w = Number(west).toFixed(5);
  const n = Number(north).toFixed(5);
  const e = Number(east).toFixed(5);
  return `[out:json][timeout:12][bbox:${s},${w},${n},${e}];(
    nwr["office"="insurance"];
    nwr["office"="estate_agent"];
    nwr["office"="property_management"];
    nwr["shop"="estate_agent"];
  );out tags center;`;
}

export function clampOfficeBounds(bounds, maxDeg = 0.22) {
  const south = Number(bounds?.south);
  const west = Number(bounds?.west);
  const north = Number(bounds?.north);
  const east = Number(bounds?.east);
  if (![south, west, north, east].every(Number.isFinite) || north <= south || east <= west) return null;
  let s = south;
  let n = north;
  let w = west;
  let e = east;
  if (n - s > maxDeg) {
    const mid = (s + n) / 2;
    s = mid - maxDeg / 2;
    n = mid + maxDeg / 2;
  }
  if (e - w > maxDeg) {
    const mid = (w + e) / 2;
    w = mid - maxDeg / 2;
    e = mid + maxDeg / 2;
  }
  return { south: s, west: w, north: n, east: e };
}

export function scoreOsmOfficeMatch(inv, el) {
  const ll = osmElementLatLon(el);
  if (!ll || !validInvestorCoord(inv?.lat, inv?.lon)) return 0;
  const dist = metersBetween({ lat: Number(inv.lat), lon: Number(inv.lon) }, ll);
  if (dist > 380) return 0;
  const name = el.tags?.name || "";
  const invName = inv.name || inv.company;
  let s = 0;
  if (nameKey(name) === nameKey(invName)) s += 5;
  else if (officesLikelySame(invName, name)) s += 4;
  else if (dist > 90) return 0;
  if (dist < 60) s += 3;
  else if (dist < 140) s += 2;
  else if (dist < 240) s += 1;
  const houseA = houseFromAddress(inv.address);
  const houseB = houseFromAddress(
    [el.tags?.["addr:housenumber"], el.tags?.["addr:street"]].filter(Boolean).join(" "),
  );
  if (houseA && houseA === houseB) s += 5;
  if (el.tags?.phone || el.tags?.["contact:phone"]) s += 1;
  return s;
}

export function pickOsmOfficeForInvestor(inv, elements) {
  let best = null;
  let score = 0;
  for (const el of elements || []) {
    const s = scoreOsmOfficeMatch(inv, el);
    if (s > score) {
      score = s;
      best = el;
    }
  }
  return score >= 4 ? best : null;
}

export function listedInvestorsFromOsmElements(elements) {
  const out = [];
  for (const el of elements || []) {
    const kind = osmInvestorKind(el);
    if (!kind) continue;
    const ll = osmElementLatLon(el);
    const tags = el.tags || {};
    const name = String(tags.name || tags.brand || tags.operator || "").trim();
    if (!ll || !name) continue;
    const row = listingFromBizRow(
      {
        name,
        street: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
        city: tags["addr:city"] || "",
        state: tags["addr:state"] || "OK",
        zip: tags["addr:postcode"] || "",
        lat: ll.lat,
        lon: ll.lon,
        phone: tags.phone || tags["contact:phone"] || "",
        email: tags.email || tags["contact:email"] || "",
        website: tags.website || tags["contact:website"] || "",
        source: "osm",
        office: osmTagContext(tags),
      },
      kind,
    );
    if (row) out.push(row);
  }
  return out;
}

export function applyOsmOfficesToInvestors(investors, elements) {
  return (investors || []).map((inv) => {
    const el = pickOsmOfficeForInvestor(inv, elements);
    if (!el) return inv;
    return mergeInvestorPublic(inv, tagsToContacts(el.tags || {}));
  });
}

function houseFromAddress(addr) {
  const p = parseStreetAddress(addr);
  return String(p.house || "").replace(/^0+/, "");
}

export function investorCity(inv) {
  const raw = String(inv?.address || "");
  const named = raw.match(
    /\b(Oklahoma City|Tulsa|Edmond|Norman|Broken Arrow|Moore|Midwest City|Lawton|Stillwater|Enid|Muskogee|Bartlesville|Shawnee|Owasso|Yukon|Bethany|Del City|Jenks|Bixby|Sapulpa|Ponca City|Ardmore|Altus|Guymon|Woodward|McAlester|Ada|Durant|Claremore|Tahlequah|Coweta)\b/i,
  );
  if (named) return named[1];
  const p = parseStreetAddress(raw);
  if (p.city && !/^(ok|oklahoma)$/i.test(p.city)) return p.city;
  return "Oklahoma City";
}

function citySlug(city) {
  return String(city || "oklahoma-city")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isPeopleSearchUrl(url) {
  return PEOPLE_SEARCH.test(String(url || ""));
}

export function isOfficeWebsite(url) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href) || /[?&](q|search_terms|find_text)=/i.test(href)) return false;
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (DIRECTORY_HOST.test(host) || PEOPLE_SEARCH.test(href)) return false;
    return true;
  } catch {
    return false;
  }
}

export function cleanBizEmail(raw, website = "") {
  const e = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^mailto:/i, "");
  if (!e.includes("@") || JUNK_MAIL.test(e)) return "";
  const mailHost = e.split("@")[1] || "";
  if (DIRECTORY_HOST.test(mailHost)) return "";
  let host = "";
  try {
    host = website && isOfficeWebsite(website) ? new URL(website).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }
  if (host) return e.endsWith(`@${host}`) || e.endsWith(`.${host}`) ? e : "";
  return e;
}

async function fetchPage(url, ms = 12000, extra = {}, opts = {}) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href) || isPeopleSearchUrl(href)) return null;
  try {
    const { body, url: finalUrl } = await httpGet(href, ms, { ...listingBrowserHeaders(), ...extra }, opts);
    const html = String(body || "");
    if (html.length < 80) return null;
    return { html, url: finalUrl || href };
  } catch {
    return null;
  }
}

/** CORS-open reader so Pages can see an office site without waiting on dead cors.sh relays. */
export function listingReaderUrl(url) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href) || isPeopleSearchUrl(href)) return "";
  if (/^https?:\/\/r\.jina\.ai\//i.test(href)) return href;
  return `${LISTING_READER}${href}`;
}

function listingReaderBlocked(body) {
  const t = String(body || "");
  if (t.length < 80) return true;
  const head = t.slice(0, 900);
  return /returned error 429|Access Denied|Just a moment|Enable JavaScript|anomaly\/images\/challenge/i.test(head);
}

async function fetchListingPage(url, ms = LISTING_PAGE_MS) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href) || isPeopleSearchUrl(href)) return null;
  const budget = Math.min(Number(ms) || LISTING_PAGE_MS, 4500);
  const readers = [
    listingReaderUrl(href),
    `https://api.allorigins.win/raw?url=${encodeURIComponent(href)}`,
  ].filter(Boolean);
  const hit = await Promise.any(
    readers.map(async (reader) => {
      const { body } = await httpGet(reader, budget, { Accept: "text/plain,*/*" });
      if (listingReaderBlocked(body)) throw new Error("blocked");
      return { html: String(body), url: href };
    }),
  ).catch(() => null);
  if (hit) return hit;
  return fetchPage(href, Math.min(budget, 3000), listingBrowserHeaders({ zillow: /zillow/i.test(href) }), {
    skipPublicRelays: true,
  });
}

function contactsFromHtml(html, website = "") {
  const hit = extractContactsFromHtml(String(html || "").slice(0, 220000), {}, { requireAddress: false }) || {};
  const tels = extractPhones(html);
  const mails = extractEmails(html);
  const phone = hit.phone || (tels[0] ? formatPhone(tels[0]) : "");
  let email = cleanBizEmail(hit.email, website);
  if (!email) {
    for (const m of mails) {
      email = cleanBizEmail(m, website);
      if (email) break;
    }
  }
  const site = isOfficeWebsite(hit.website) ? hit.website : isOfficeWebsite(website) ? website : "";
  return mergeContacts({
    phone: phone && !isJunkPhone(phone) ? phone : "",
    email,
    website: site,
    name: hit.name || "",
    source: "web",
  });
}

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) flattenJsonLd(n, out);
    return out;
  }
  if (typeof node === "object") {
    out.push(node);
    if (node["@graph"]) flattenJsonLd(node["@graph"], out);
  }
  return out;
}

export function parseJsonLdBusinesses(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    try {
      const nodes = flattenJsonLd(JSON.parse(m[1]));
      for (const n of nodes) {
        const types = [n["@type"]].flat().map((t) => String(t || ""));
        if (!types.some((t) => /InsuranceAgency|RealEstateAgent|RealEstateOffice|LocalBusiness|Organization|Place/i.test(t))) {
          continue;
        }
        const addr = n.address && typeof n.address === "object" ? n.address : {};
        const street = String(addr.streetAddress || n.streetAddress || "").trim();
        const city = String(addr.addressLocality || "").trim();
        const phone = formatPhone(n.telephone || n.phone || "") || "";
        const email = cleanBizEmail(n.email || "");
        const website = String(Array.isArray(n.sameAs) ? "" : n.url || n.sameAs || "").trim();
        if (!phone && !email && !street) continue;
        out.push({
          name: String(n.name || "").trim(),
          phone: phone && !isJunkPhone(phone) ? phone : "",
          email,
          website: isOfficeWebsite(website) ? website : "",
          address: [street, city, addr.addressRegion || "OK", addr.postalCode || ""].filter(Boolean).join(", "),
          street,
          city,
          source: "jsonld",
        });
      }
    } catch {
      /* ignore one block */
    }
  }
  if (!out.length) {
    const loose =
      String(html || "").match(/\{[^{}]*"@type"\s*:\s*"InsuranceAgency"[\s\S]{0,1600}?\}/gi) || [];
    for (const block of loose) {
      const name = (block.match(/"name"\s*:\s*"([^"]+)"/i) || [])[1] || "";
      const street = (block.match(/"streetAddress"\s*:\s*"([^"]+)"/i) || [])[1] || "";
      const city = (block.match(/"addressLocality"\s*:\s*"([^"]+)"/i) || [])[1] || "";
      const phone = formatPhone((block.match(/"telephone"\s*:\s*"([^"]+)"/i) || [])[1] || "");
      const email = cleanBizEmail((block.match(/"email"\s*:\s*"([^"]+)"/i) || [])[1] || "");
      if (!phone && !email) continue;
      out.push({
        name,
        phone: phone && !isJunkPhone(phone) ? phone : "",
        email,
        website: "",
        address: [street, city, "OK"].filter(Boolean).join(", "),
        street,
        city,
        source: "jsonld",
      });
    }
  }
  return out;
}

function pickMatchingBusiness(rows, inv) {
  const house = houseFromAddress(inv?.address);
  const phone = phoneDigits(inv?.phone || "");
  let best = null;
  let score = -1;
  for (const row of rows || []) {
    let s = 0;
    if (house && houseFromAddress(row.address || row.street) === house) s += 8;
    if (phone && phoneDigits(row.phone || "") === phone) s += 6;
    if (namesLikelySame(inv?.name || inv?.company, row.name)) s += 3;
    if (row.phone) s += 1;
    if (row.email) s += 1;
    if (s > score) {
      score = s;
      best = row;
    }
  }
  if (score >= 3) return best;
  return null;
}

const STREET_SUFFIX = new Set(
  (
    "st street ave avenue rd road dr drive blvd boulevard ln lane ct court cir circle pl place way ter terrace " +
    "pkwy parkway trl trail hwy highway loop run path pike sq square xing crossing bnd bend cv cove pt point " +
    "ridge rdg creek crk park plaza walk row expy expressway fwy freeway manor mnr grove grv hollow holw " +
    "heights hts landing lndg meadows mdws springs spgs trace trce vista vly valley crest knoll"
  ).split(" "),
);
const UNIT_WORD = /^(apt|unit|ste|suite|lot|bldg|building|fl|floor|rm|room|#\d*)$/i;

function titleWords(bits) {
  return bits.join(" ").replace(/\s+/g, " ").trim();
}

/** Index of the last street-type word, so "2200 Westheimer Dr Norman" splits into street + city. */
function lastStreetSuffixIndex(bits) {
  for (let i = bits.length - 1; i > 0; i -= 1) {
    if (STREET_SUFFIX.has(String(bits[i] || "").toLowerCase().replace(/\.$/, ""))) return i;
  }
  return -1;
}

function houseFromStreet(street) {
  return (String(street || "").match(/^(\d+[A-Za-z]?)\b/) || [])[1] || "";
}

function joinAddressParts({ street, city, state, zip }) {
  return [street, city, state || "OK", zip].map((s) => String(s || "").trim()).filter(Boolean).join(", ");
}

/**
 * Split a listing slug into street / city / state / zip. The ZIP is the strongest
 * disambiguator a geocoder has, so it must survive parsing — dropping it is what puts a
 * dot on the wrong block.
 */
export function parseRealtorDetailParts(slug) {
  const raw = decodeURIComponent(String(slug || "").split("?")[0]).replace(/\/+$/, "");
  const bits = raw.split("_").filter(Boolean);
  if (bits.length < 3) return null;
  if (/^M/i.test(bits[bits.length - 1] || "")) bits.pop();
  let zip = "";
  if (/^\d{5}(?:-\d{4})?$/.test(bits[bits.length - 1] || "")) zip = bits.pop().slice(0, 5);
  let state = "";
  if (/^[A-Za-z]{2}$/.test(bits[bits.length - 1] || "")) state = bits.pop().toUpperCase();
  const city = (bits.pop() || "").replace(/-/g, " ").trim();
  const street = (bits.join(" ") || "").replace(/-/g, " ").trim();
  if (!/\d/.test(street)) return null;
  const parts = { house: houseFromStreet(street), street, city, state: state || "OK", zip };
  return { ...parts, address: joinAddressParts(parts) };
}

export function parseZillowDetailParts(path) {
  const raw = decodeURIComponent(String(path || "").split("?")[0]).replace(/\/+$/, "");
  const segs = raw.split("/").filter(Boolean);
  const slug = segs.find((p) => /\d/.test(p) && !/_zpid$/i.test(p)) || segs[0] || "";
  const bits = slug.replace(/_rb$/i, "").split("-").filter(Boolean);
  if (bits.length < 3) return null;
  let zip = "";
  if (/^\d{5}$/.test(bits[bits.length - 1] || "")) zip = bits.pop();
  let state = "";
  if (/^[A-Za-z]{2}$/.test(bits[bits.length - 1] || "")) state = bits.pop().toUpperCase();
  let cut = lastStreetSuffixIndex(bits);
  // "…-Main-St-APT-4-Norman" — the unit rides with the street, not the city.
  while (cut > 0 && cut + 1 < bits.length && UNIT_WORD.test(bits[cut + 1] || "")) {
    cut += /^\d+$/.test(bits[cut + 2] || "") ? 2 : 1;
  }
  let street = titleWords(bits);
  let city = "";
  if (cut > 0 && cut < bits.length - 1) {
    street = titleWords(bits.slice(0, cut + 1));
    city = titleWords(bits.slice(cut + 1));
  }
  if (!/\d/.test(street)) return null;
  const parts = { house: houseFromStreet(street), street, city, state: state || "OK", zip };
  return { ...parts, address: joinAddressParts(parts) };
}

export function parseRealtorDetailSlug(slug) {
  return parseRealtorDetailParts(slug)?.address || "";
}

export function parseZillowDetailSlug(path) {
  return parseZillowDetailParts(path)?.address || "";
}

/** Split a free-text listing address back into the pieces a structured geocoder wants. */
export function listingAddressParts(address) {
  const raw = String(address || "").trim();
  if (!raw) return null;
  const bits = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!bits.length) return null;
  const street = bits[0];
  if (!/\d/.test(street)) return null;
  let zip = "";
  let state = "";
  let city = "";
  const tail = [...bits.slice(1)];
  const last = tail[tail.length - 1] || "";
  const zipInTail = last.match(/\b(\d{5})(?:-\d{4})?$/);
  if (zipInTail) {
    zip = zipInTail[1];
    const rest = last.replace(/\b\d{5}(?:-\d{4})?$/, "").trim();
    if (rest) tail[tail.length - 1] = rest;
    else tail.pop();
  }
  const stateAt = tail.findIndex((s) => /^(ok|oklahoma)$/i.test(s));
  if (stateAt >= 0) {
    state = "OK";
    tail.splice(stateAt, 1);
  }
  city = tail.join(" ").trim();
  const parts = { house: houseFromStreet(street), street, city, state: state || "OK", zip };
  return { ...parts, address: joinAddressParts(parts) };
}

function listingDedupeKey(row) {
  const house = houseFromStreet(row?.street || row?.address || "");
  const street = streetKey(String(row?.street || row?.address || "").replace(/^\d+[A-Za-z]?\s+/, ""));
  if (house && street) return `${house}:${street}`;
  if (row?.address) return nameKey(row.address).replace(/\s+/g, "");
  if (validInvestorCoord(row?.lat, row?.lon)) return `${Number(row.lat).toFixed(5)}:${Number(row.lon).toFixed(5)}`;
  return "";
}

function pushListing(out, seen, row) {
  const n = normalizeListing(row);
  if (!n.address && !validInvestorCoord(n.lat, n.lon)) return;
  const key = listingDedupeKey({ ...row, address: n.address, lat: n.lat, lon: n.lon });
  if (!key || seen.has(key)) return;
  seen.add(key);
  // Structured pieces ride along until geocoding; normalizeListing drops them before save.
  if (row.street) n.parts = { house: row.house || "", street: row.street, city: row.city || "", state: row.state || "OK", zip: row.zip || "" };
  out.push(n);
}

const OK_CITY_RE =
  /\b(Oklahoma City|Tulsa|Edmond|Norman|Broken Arrow|Moore|Midwest City|Lawton|Stillwater|Enid|Muskogee|Bartlesville|Shawnee|Owasso|Yukon|Bethany|Del City|Jenks|Bixby|Sapulpa|Ponca City|Ardmore|Altus|Guymon|Woodward|McAlester|Ada|Durant|Claremore|Tahlequah|Coweta|Nichols Hills|The Village|Warr Acres|Mustang|Choctaw|Harrah|Newcastle|Noble|Moore|Piedmont|Guthrie|El Reno|Washington|Purcell|Blanchard|Newalla|Choctaw)\b/i;

/**
 * Free-text streets on an office site (Jina markdown, contact pages, IDX crumbs).
 * Realtor/Zillow slugs are preferred when present; this is what actually fills
 * gold dots when those hosts 429.
 */
export function parseStreetAddressesFromText(text, { officeAddress = "", cityHint = "Oklahoma City" } = {}) {
  const blob = String(text || "").replace(/<[^>]+>/g, " ");
  const officeHouse = houseFromAddress(officeAddress);
  const officeStreet = streetKey(parseStreetAddress(officeAddress).street || officeAddress);
  const out = [];
  const seen = new Set();
  const re =
    /\b(\d{1,6}[A-Za-z]?)\s+((?:(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)\.?\s+)?)([A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}?)\s+(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Cir|Circle|Pl|Place|Way|Ter|Terrace|Pkwy|Parkway|Trl|Trail|Hwy|Highway|Loop)\.?\b(?:\s*,?\s*([A-Za-z .']{3,28}))?(?:\s*,?\s*(OK|Oklahoma)\b)?(?:\s+(\d{5}))?/gi;
  let m;
  while ((m = re.exec(blob)) && out.length < MAX_LISTINGS) {
    const suffix = String(m[4] || "").replace(/\.$/, "");
    if (!STREET_SUFFIX.has(suffix.toLowerCase())) continue;
    const street = `${m[1]} ${m[2] || ""}${m[3]} ${suffix}`.replace(/\s+/g, " ").trim();
    if (
      officeHouse &&
      houseFromStreet(street) === officeHouse &&
      streetKey(street.replace(/^\d+[A-Za-z]?\s+/, "")) === officeStreet
    ) {
      continue;
    }
    if (/images? were found|no images|directions|click here|^beds$|^baths$/i.test(street)) continue;
    if (/^0+$/.test(m[1])) continue;
    let city = String(m[5] || "").trim();
    if (/^(ok|oklahoma|united|states|suite|apt|unit|the|and|for|sale|listed)$/i.test(city)) city = "";
    if (city && !OK_CITY_RE.test(city)) city = "";
    const named = (city && OK_CITY_RE.test(city) && city.match(OK_CITY_RE)?.[1]) || blob.slice(m.index, m.index + 80).match(OK_CITY_RE)?.[1] || "";
    if (named) city = named;
    else if (!city && OK_CITY_RE.test(cityHint)) city = cityHint;
    else if (!city) city = "Oklahoma City";
    const zip = m[7] || "";
    const parts = { house: m[1], street, city, state: "OK", zip };
    pushListing(out, seen, { ...parts, address: joinAddressParts(parts), source: "page" });
  }
  return out;
}

/** Homes attributed to this office/agent — never a city-wide dump. */
export function parseSaleListingsFromHtml(html, { officeName = "", officeAddress = "" } = {}) {
  const blob = String(html || "");
  const out = [];
  const seen = new Set();
  const realtor = /https?:\/\/(?:www\.)?realtor\.com\/realestateandhomes-detail\/([^"'?\s]+)/gi;
  let m;
  while ((m = realtor.exec(blob)) && out.length < MAX_LISTINGS) {
    const parts = parseRealtorDetailParts(m[1]);
    if (!parts) continue;
    pushListing(out, seen, {
      ...parts,
      url: `https://www.realtor.com/realestateandhomes-detail/${m[1]}`,
      source: "realtor",
    });
  }
  const zillow = /https?:\/\/(?:www\.)?zillow\.com\/homedetails\/([^"'?\s]+)/gi;
  while ((m = zillow.exec(blob)) && out.length < MAX_LISTINGS) {
    const parts = parseZillowDetailParts(m[1]);
    if (!parts) continue;
    pushListing(out, seen, { ...parts, url: `https://www.zillow.com/homedetails/${m[1]}`, source: "zillow" });
  }
  const redfin = /https?:\/\/(?:www\.)?redfin\.com\/OK\/([A-Za-z0-9/_-]+)/gi;
  while ((m = redfin.exec(blob)) && out.length < MAX_LISTINGS) {
    const path = m[1];
    const segs = path.split("/").filter(Boolean);
    const street = (segs[1] || "").replace(/-/g, " ");
    if (!/\d/.test(street)) continue;
    pushListing(out, seen, {
      house: houseFromStreet(street),
      street,
      city: (segs[0] || "").replace(/-/g, " "),
      state: "OK",
      address: joinAddressParts({ street, city: (segs[0] || "").replace(/-/g, " "), state: "OK" }),
      url: `https://www.redfin.com/OK/${path}`,
      source: "redfin",
    });
  }

  // Coordinates printed by the listing site itself are the house, not a geocoder guess.
  const coordBlocks =
    blob.match(/\{[^{}]{0,240}"(?:latitude|lat)"\s*:\s*-?\d+\.\d+[^{}]{0,240}\}/gi) || [];
  for (const block of coordBlocks) {
    const lat = Number((block.match(/"(?:latitude|lat)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    const lon = Number((block.match(/"(?:longitude|lon|lng)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    const line = (block.match(/"(?:line|streetAddress|full_street_address)"\s*:\s*"([^"]{6,80})"/i) || [])[1];
    if (!validInvestorCoord(lat, lon) || !inOklahoma(lat, lon)) continue;
    pushListing(out, seen, {
      lat,
      lon,
      address: line || "",
      source: "embed",
      precision: "rooftop",
      geoSource: "listing",
    });
  }

  const addrJson =
    /"address"\s*:\s*\{\s*"line"\s*:\s*"([^"]+)"\s*,\s*"city"\s*:\s*"([^"]+)"\s*,\s*"state_code"\s*:\s*"([^"]+)"/gi;
  while ((m = addrJson.exec(blob)) && out.length < MAX_LISTINGS) {
    const address = [m[1], m[2], m[3]].filter(Boolean).join(", ");
    if (!/\d/.test(m[1])) continue;
    const nearby = blob.slice(m.index, m.index + 500);
    const lat = Number((nearby.match(/"(?:lat|latitude)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    const lon = Number((nearby.match(/"(?:lon|lng|longitude)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    const mapped = Number.isFinite(lat) && Number.isFinite(lon);
    pushListing(out, seen, {
      address,
      house: houseFromStreet(m[1]),
      street: m[1],
      city: m[2],
      state: m[3],
      lat: mapped ? lat : null,
      lon: mapped ? lon : null,
      source: "embed",
      precision: mapped ? "rooftop" : "approx",
      geoSource: mapped ? "listing" : "",
    });
  }

  if (officeName && out.length > 12 && !namesLikelySame(officeName, blob.slice(0, 4000))) {
    /* city search pages can leak unrelated homes — keep only if the office is named nearby */
  }
  if (out.length < 6) {
    const cityHint = (() => {
      const named = blob.match(OK_CITY_RE);
      return named ? named[1] : "";
    })();
    for (const row of parseStreetAddressesFromText(blob, { cityHint, officeAddress })) {
      pushListing(out, seen, row);
    }
  }
  return out.slice(0, MAX_LISTINGS);
}

function tagsToContacts(tags = {}) {
  const phone = formatPhone(tags.phone || tags["contact:phone"] || tags["contact:mobile"] || "") || "";
  const email = cleanBizEmail(tags.email || tags["contact:email"] || "");
  const website = String(tags.website || tags["contact:website"] || tags.url || "").trim();
  return {
    name: tags.name || tags.operator || "",
    phone: phone && !isJunkPhone(phone) ? phone : "",
    email,
    website: isOfficeWebsite(website) ? website : "",
    source: "osm",
  };
}

async function osmElementTags(osmType, osmId) {
  const kind = { N: "node", W: "way", R: "relation", node: "node", way: "way", relation: "relation" }[osmType];
  const id = Number(osmId);
  if (!kind || !id) return null;
  try {
    const { body } = await httpGet(`${OSM_API}/${kind}/${id}.json`, 10000, {
      Accept: "application/json",
      "User-Agent": "GroundControl/1.0 (joshuagwatts)",
    });
    const el = JSON.parse(body || "{}")?.elements?.[0];
    return el?.tags || null;
  } catch {
    return null;
  }
}

async function photonOfficeHits(name, lat, lon) {
  const u = new URL(PHOTON_URL);
  u.searchParams.set("q", String(name || "").trim() || "oklahoma");
  u.searchParams.set("limit", "6");
  if (Number.isFinite(Number(lat))) u.searchParams.set("lat", String(lat));
  if (Number.isFinite(Number(lon))) u.searchParams.set("lon", String(lon));
  try {
    const { body } = await httpGet(u.toString(), 9000, { Accept: "application/json" });
    return JSON.parse(body || "{}")?.features || [];
  } catch {
    return [];
  }
}

async function contactsFromOsm(inv) {
  const office = { lat: Number(inv.lat), lon: Number(inv.lon) };
  const feats = await photonOfficeHits(inv.name || inv.company, inv.lat, inv.lon);
  const ranked = feats
    .map((feat) => {
      const coords = feat?.geometry?.coordinates;
      const lon = Number(coords?.[0]);
      const lat = Number(coords?.[1]);
      const dist =
        validInvestorCoord(lat, lon) && validInvestorCoord(office.lat, office.lon) ? metersBetween(office, { lat, lon }) : 99999;
      return { feat, dist };
    })
    .filter((row) => row.dist < 250)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);
  for (const { feat } of ranked) {
    const p = feat?.properties || {};
    if (
      p.name &&
      !officesLikelySame(inv.name || inv.company, p.name) &&
      nameKey(p.name) !== nameKey(inv.name || inv.company)
    ) {
      continue;
    }
    const tags = await osmElementTags(p.osm_type, p.osm_id);
    if (!tags) continue;
    const hit = tagsToContacts(tags);
    if (hit.phone || hit.email || hit.website) return hit;
  }
  return null;
}

function brandLocatorUrls(inv) {
  const name = `${inv?.name || ""} ${inv?.company || ""}`;
  const city = citySlug(investorCity(inv));
  const urls = [];
  if (/state\s*farm/i.test(name)) urls.push(`https://www.statefarm.com/agent/us/ok/${city}`);
  if (/farmers/i.test(name)) urls.push(`https://agents.farmers.com/ok/${city}`);
  if (/allstate/i.test(name)) urls.push(`https://agents.allstate.com/ok/${city}.html`);
  if (/nationwide/i.test(name)) urls.push(`https://www.nationwide.com/insurance-agents/${city}-ok`);
  if (/farm bureau/i.test(name)) urls.push(`https://www.okfarmbureau.org/find-an-agent/`);
  return urls;
}

async function contactsFromBrandLocator(inv) {
  for (const url of brandLocatorUrls(inv)) {
    const page = await fetchPage(url, 12000);
    if (!page?.html) continue;
    const rows = parseJsonLdBusinesses(page.html);
    const hit = pickMatchingBusiness(rows, inv);
    if (hit && (hit.phone || hit.email)) return { ...hit, source: "locator" };
    const agent = page.html.match(/https?:\/\/www\.statefarm\.com\/agent\/us\/ok\/[^"'?\s]+/i);
    if (agent?.[0] && houseFromAddress(inv.address)) {
      const deep = await fetchPage(agent[0], 10000);
      if (deep?.html) {
        const deepRows = parseJsonLdBusinesses(deep.html);
        const deepHit = pickMatchingBusiness(deepRows, inv);
        if (deepHit && (deepHit.phone || deepHit.email)) return { ...deepHit, source: "locator" };
      }
    }
  }
  return null;
}

async function contactsFromWebsite(url) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href) || isPeopleSearchUrl(href)) return null;
  let base;
  try {
    base = new URL(href);
  } catch {
    return null;
  }
  const paths = [href];
  if (!/contact/i.test(href)) {
    paths.push(`${base.origin}/contact`, `${base.origin}/contact-us`, `${base.origin}/about`);
  }
  let hit = { phone: "", email: "", website: href };
  for (const path of paths.slice(0, 3)) {
    const page = await fetchPage(path, 10000);
    if (!page?.html) continue;
    hit = mergeContacts(hit, contactsFromHtml(page.html, href));
    if (hit.phone && hit.email) break;
  }
  return hit.phone || hit.email ? hit : null;
}

async function contactsFromDirectories(inv) {
  const city = investorCity(inv);
  const name = inv.name || inv.company;
  const urls = [
    formatYellowPagesBizNameUrl(name, city),
    `https://www.bbb.org/search?find_country=USA&find_text=${encodeURIComponent(name)}&find_loc=${encodeURIComponent(`${city}, OK`)}`,
  ].filter(Boolean);
  const q = `"${name}" "${city}" OK (insurance OR realtor OR realty) (phone OR email OR tel)`;
  const ddg = await fetchPage(`${DDG_HTML}${encodeURIComponent(q)}`, 10000);
  if (ddg?.html) {
    for (const u of extractSearchResultUrls(ddg.html, { limit: 6 })) {
      if (isPeopleSearchUrl(u)) continue;
      urls.push(u);
    }
  }
  let hit = { phone: "", email: "", website: "" };
  for (const url of [...new Set(urls)].slice(0, 6)) {
    const page = await fetchPage(url, 10000);
    if (!page?.html) continue;
    hit = mergeContacts(hit, contactsFromHtml(page.html, url));
    if (hit.phone && hit.email) break;
  }
  return hit.phone || hit.email ? { ...hit, source: "directory" } : null;
}

export function mergeInvestorPublic(base, extra = {}) {
  const listings = [
    ...((extra.listings || []).length ? extra.listings : []),
    ...(base.listings || []),
  ];
  const seen = new Map();
  const mergedListings = [];
  for (const row of listings) {
    const n = normalizeListing(row);
    const key = n.address ? nameKey(n.address).replace(/\s+/g, "") : `${n.lat}:${n.lon}`;
    if (!key) continue;
    const prevI = seen.get(key);
    if (prevI == null) {
      seen.set(key, mergedListings.length);
      mergedListings.push(n);
      continue;
    }
    // Same address string from both sources: the county-assessor parcel wins
    // (parcel-precision coords), grafting the listing's URL onto it.
    const prev = mergedListings[prevI];
    if (n.source === "county assessor" && prev.source !== "county assessor") {
      if (!n.url && prev.url) n.url = prev.url;
      mergedListings[prevI] = n;
    } else if (prev.source === "county assessor" && n.source !== "county assessor" && !prev.url && n.url) {
      prev.url = n.url;
    }
  }
  return normalizeInvestor({
    ...base,
    phone: extra.phone || base.phone,
    email: extra.email || base.email,
    website: extra.website || base.website,
    address: (base.address || "").length >= String(extra.address || "").length ? base.address : extra.address,
    listings: mergedListings.slice(0, MAX_LISTINGS),
    source: extra.source || base.source,
  });
}

export async function fetchOsmOfficesInBounds(bounds) {
  const box = clampOfficeBounds(bounds);
  if (!box) return [];
  let els = [];
  try {
    const data = await overpassJson(officeOverpassQuery(box.south, box.west, box.north, box.east), 16000);
    els = (data?.elements || []).filter(isOfficeOsmElement);
  } catch {
    els = [];
  }
  if (!els.length) {
    try {
      const data = await overpassJson(officeOverpassQueryNarrow(box.south, box.west, box.north, box.east), 12000);
      els = (data?.elements || []).filter(isOfficeOsmElement);
    } catch {
      els = [];
    }
  }
  if (els.length >= 3) return els;
  try {
    const dump = await osmMapJson(box.south, box.west, box.north, box.east, 12000);
    const extra = (dump?.elements || []).filter(isOfficeOsmElement);
    const seen = new Set(els.map((el) => `${el.type || "n"}:${el.id || `${el.lat}:${el.lon}`}`));
    for (const el of extra) {
      const key = `${el.type || "n"}:${el.id || `${el.lat}:${el.lon}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      els.push(el);
    }
  } catch {
    /* map dump optional */
  }
  return els;
}

/**
 * Every office lookup gets a wall-clock budget. Without one a single unreachable
 * agency website holds the whole in-view queue and only the first pin ever fills in.
 */
export const SHALLOW_LOOKUP_MS = 7000;
export const DEEP_LOOKUP_MS = 20000;
/** Wall clock for a selected star's sale homes — contacts can keep running after this. */
export const LISTING_LOOKUP_MS = 36000;
const LISTING_PAGE_MS = 5000;
const LISTING_GEO_WORKERS = 4;
const LISTING_READER = "https://r.jina.ai/";
/** kvCORE public listings are the shared OKC MLS dump, not one office's inventory. */
const FALLBACK_MLS_WEBSITE = "https://www.mcgrawrealtors.com/";

/** Only McGraw itself can use the shared MLS dump as this office's homes. */
export function listingFallbackWebsite(inv) {
  const blob = `${inv?.name || ""} ${inv?.company || ""} ${inv?.website || ""}`;
  return /mcgraw/i.test(blob) ? FALLBACK_MLS_WEBSITE : "";
}

/**
 * Office inventory URLs we have already verified. Search can miss these when
 * DuckDuckGo ranks Zillow city dumps first — that is not nearby MLS, it is
 * this office's own public site.
 */
export function knownOfficeListingSites(inv) {
  const blob = nameKey(`${inv?.name || ""} ${inv?.company || ""} ${inv?.website || ""}`);
  const out = [];
  if (/\bseabrooke\b/.test(blob)) {
    out.push(
      "https://www.keyrealtyokc.com/active-listings",
      "https://seabrooke.appfolio.com/listings",
    );
  }
  if (/\bmcgraw\b/.test(blob)) {
    out.push("https://www.mcgrawrealtors.com/", "https://www.mcgrawpropertymanagement.com/oklahoma-city-rentals");
  }
  if (/\bmulinix\b/.test(blob)) out.push("https://kwnorman.kw.com/");
  if (/\bverbode\b/.test(blob)) out.push("https://verbode.com/");
  return out;
}

/** Keep office sites + this office's Appfolio; drop city portals and other brokers' rentals. */
export function listingSourceFitsOffice(url, inv) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return false;
  let host = "";
  let path = "";
  try {
    const u = new URL(href);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (DIRECTORY_HOST.test(host) || LISTING_PORTAL_HOST.test(host) || PEOPLE_SEARCH.test(href)) return false;
  const isAppfolio = /appfolio\.com$/i.test(host);
  if (!isOfficeWebsite(href) && !isAppfolio) return false;
  const unique = officeUniqueTokens(inv?.name || inv?.company);
  if (isAppfolio && unique.length && !unique.some((t) => host.includes(t))) return false;
  if (/^(www\.)?(coldwellbanker|century21|remax|exprealty)\.com$/i.test(host)) return false;
  if (/kw\.com$/i.test(host)) {
    const office = nameKey(inv?.name || inv?.company);
    if (unique.some((t) => `${host} ${path}`.includes(t))) return true;
    if (/\bmulinix\b/.test(office) && /kwnorman/i.test(host)) return true;
    if (unique.length) return false;
  }
  return true;
}

export function withDeadline(promise, ms, fallback = null) {
  let timer = 0;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(0, Number(ms) || 0));
    }),
  ]).then((v) => {
    clearTimeout(timer);
    return v;
  });
}

export async function enrichInvestorContacts(inv, { deep = false, osmHits = [], budgetMs = 0 } = {}) {
  if (!inv) return null;
  let hit = {
    phone: inv.phone || "",
    email: inv.email || "",
    website: inv.website || "",
    address: inv.address || "",
  };
  const deadline = Date.now() + (Number(budgetMs) || (deep ? DEEP_LOOKUP_MS : SHALLOW_LOOKUP_MS));
  const left = () => Math.max(0, deadline - Date.now());
  const osmEl = pickOsmOfficeForInvestor(inv, osmHits);
  if (osmEl) hit = mergeContacts(hit, tagsToContacts(osmEl.tags || {}));
  if (!hit.phone || !hit.email) {
    // OSM and the brand locator never depend on each other — ask both at once.
    const jobs = [];
    if (!hit.phone) jobs.push(withDeadline(contactsFromOsm(inv), Math.min(left(), deep ? 9000 : 5000)));
    jobs.push(withDeadline(contactsFromBrandLocator(inv), Math.min(left(), deep ? 11000 : 5500)));
    for (const found of await Promise.all(jobs)) {
      if (found) hit = mergeContacts(hit, found);
    }
  }
  if (hit.website && (!hit.phone || !hit.email) && left() > 1200) {
    const site = await withDeadline(contactsFromWebsite(hit.website), Math.min(left(), 8000));
    if (site) hit = mergeContacts(hit, { ...site, email: cleanBizEmail(site.email, hit.website) });
  }
  if (deep && !hit.phone && left() > 2000) {
    const dir = await withDeadline(contactsFromDirectories(inv), left());
    if (dir) {
      hit = mergeContacts(hit, {
        ...dir,
        email: hit.website ? cleanBizEmail(dir.email, hit.website) : "",
        website: hit.website || (isOfficeWebsite(dir.website) ? dir.website : ""),
      });
    }
  }
  if (!hit.phone && !hit.email && !hit.website) return null;
  return {
    phone: hit.phone || "",
    email: hit.email || "",
    website: hit.website || "",
    address: hit.address || inv.address || "",
    source: hit.source || "public",
  };
}

export function listingUrlsForOffice(inv) {
  const urls = [];
  if (inv?.website) {
    urls.push(inv.website);
    try {
      const origin = new URL(inv.website).origin;
      const paths = /appfolio\.com/i.test(origin)
        ? ["/listings", "/listings/listings"]
        : ["/listings", "/homes", "/properties", "/featured-listings", "/active-listings", "/homes-for-sale", "/idx/featured", "/idx"];
      for (const path of paths) urls.push(`${origin}${path}`);
    } catch {
      /* ignore */
    }
    return [...new Set(urls.filter(Boolean))].slice(0, 8);
  }
  return [];
}

/** kvCORE (and similar) public JSON — lat/lon already on the row, no geocode wait. */
export function idxJsonUrlsForOffice(website) {
  const href = String(website || "").trim();
  if (!isOfficeWebsite(href) || /appfolio\.com/i.test(href)) return [];
  try {
    const origin = new URL(href).origin;
    return [`${origin}/wp-json/kvcoreidx/v1/api/public/listings?limit=40`];
  } catch {
    return [];
  }
}

/** Jina wraps JSON in a markdown reader page — peel that off before JSON.parse. */
export function parseJsonPayload(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let raw = fence ? fence[1].trim() : t;
  const md = raw.match(/Markdown Content:\s*([\s\S]+)/i);
  if (md) raw = md[1].trim();
  const start = raw.search(/[\[{]/);
  if (start < 0) return null;
  raw = raw.slice(start);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatListingPrice(n) {
  const x = Number(n);
  if (Number.isFinite(x) && x > 0) return `$${Math.round(x).toLocaleString("en-US")}`;
  return String(n || "").trim();
}

export function idxRowBelongsToOffice(officeName, row) {
  const name = String(officeName || "").trim();
  if (!name) return false;
  const broker = String(row?.brokername || "").trim();
  const agent = String(row?.agentname || "").trim();
  const blob = nameKey(`${broker} ${agent}`);
  const unique = officeUniqueTokens(name);
  if (unique.length) {
    const hit = unique.filter((t) => blob.includes(t));
    if (!hit.length) return false;
    return namesLikelySame(name, broker) || namesLikelySame(name, agent) || hit.length === unique.length;
  }
  return (
    namesLikelySame(name, broker) ||
    officesLikelySame(name, broker) ||
    namesLikelySame(name, agent) ||
    namesLikelySame(name, `${broker} ${agent}`.trim())
  );
}

function collectIdxListingNodes(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectIdxListingNodes(n, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (Array.isArray(node.data)) collectIdxListingNodes(node.data, out);
  if (Array.isArray(node.listings)) collectIdxListingNodes(node.listings, out);
  if (Array.isArray(node.results)) collectIdxListingNodes(node.results, out);
  const address = String(node.address || node.street_address || node.unparsedAddress || node.line || "").trim();
  const lat = Number(node.lat ?? node.latitude ?? node.geo_lat);
  const lon = Number(node.long ?? node.lng ?? node.lon ?? node.longitude ?? node.geo_lon);
  const hasAddr = Boolean(address && /\d/.test(address));
  const mapped = Number.isFinite(lat) && Number.isFinite(lon);
  if (!hasAddr && !mapped) return out;
  const city = String(node.city || node.addressLocality || "").trim();
  const state = String(node.state || node.state_code || "OK").trim() || "OK";
  const zip = String(node.zip || node.zipcode || node.postal_code || "").replace(/\D/g, "").slice(0, 5);
  out.push({
    address: joinAddressParts({ street: address, city, state, zip }),
    house: houseFromStreet(address),
    street: address,
    city,
    state,
    zip,
    lat: mapped ? lat : null,
    lon: mapped ? lon : null,
    price: formatListingPrice(node.price || node.list_price),
    url: String(node.url || node.listing_url || "").trim(),
    brokername: String(node.brokername || node.broker_name || node.office || "").trim(),
    agentname: String(node.agentname || node.agent_name || "").trim(),
    source: "idx",
    precision: mapped ? "rooftop" : "approx",
    geoSource: mapped ? "listing" : "",
  });
  return out;
}

/** Homes from an IDX JSON dump. Broker/agent match = this office; otherwise nearby. */
export function parseIdxListingsFromJson(json, { officeName = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of collectIdxListingNodes(json)) {
    const attribution = idxRowBelongsToOffice(officeName, row) ? "office" : "nearby";
    pushListing(out, seen, { ...row, attribution });
  }
  return out.slice(0, MAX_LISTINGS);
}

/**
 * Office-site HTML and broker-matched IDX rows only.
 * Unmatched city MLS leftovers are never this office's homes — do not draw them.
 */
export function pickOfficeListings(htmlRows, idxRows) {
  const office = [];
  const officeSeen = new Set();
  for (const row of htmlRows || []) {
    if (String(row?.attribution || "office").toLowerCase() === "nearby") continue;
    pushListing(office, officeSeen, { ...row, attribution: "office" });
  }
  for (const row of idxRows || []) {
    if (String(row?.attribution || "").toLowerCase() !== "office") continue;
    pushListing(office, officeSeen, { ...row, attribution: "office" });
  }
  return office;
}

/** Website already on the OSM pin — listing scrape must not wait on the contact hunt. */
export function officeWebsiteFromOsm(inv, osmHits = []) {
  const el = pickOsmOfficeForInvestor(inv, osmHits);
  return tagsToContacts(el?.tags || {}).website || "";
}

/**
 * How tightly a geocoder hit is pinned. A road centreline ("street") is exactly the result
 * that drops a listing dot in the middle of the road, so it is graded and then thrown away.
 */
/** Photon calls a named cafe on the block a "house" — those are POIs, not the address we asked for. */
const PHOTON_POI_KEYS = new Set([
  "amenity",
  "leisure",
  "tourism",
  "shop",
  "office",
  "landuse",
  "craft",
  "healthcare",
  "historic",
  "man_made",
  "natural",
]);

export function photonHitPrecision(props = {}) {
  const type = String(props.type || "").toLowerCase();
  const key = String(props.osm_key || "").toLowerCase();
  if (String(props.housenumber || "").trim()) return "rooftop";
  if (type === "street" || key === "highway" || key === "railway" || key === "waterway") return "street";
  if (
    key === "boundary" ||
    ["city", "town", "village", "locality", "district", "county", "state", "region", "postcode", "other"].includes(type)
  ) {
    return "area";
  }
  if (type === "house") return PHOTON_POI_KEYS.has(key) ? "approx" : "rooftop";
  if (key === "building") return "parcel";
  return "approx";
}

export function nominatimHitPrecision(hit = {}) {
  const addr = hit.address || {};
  const cls = String(hit.class || hit.category || "").toLowerCase();
  const addressType = String(hit.addresstype || "").toLowerCase();
  if (String(addr.house_number || "").trim() || addressType === "house" || addressType === "building") return "rooftop";
  if (cls === "building" || cls === "place") return "parcel";
  if (cls === "highway" || addressType === "road") return "street";
  if (cls === "boundary" || ["city", "town", "village", "suburb", "postcode", "county", "state"].includes(addressType)) {
    return "area";
  }
  return "approx";
}

function houseNumbersMatch(want, got) {
  const a = String(want || "").replace(/^0+/, "").toLowerCase();
  if (!a) return false;
  const b = String(got || "").toLowerCase();
  if (!b) return false;
  return b
    .split(/[-,;/\s]+/)
    .map((s) => s.replace(/^0+/, "").trim())
    .includes(a);
}

const STREET_CANON = {
  street: "st",
  st: "st",
  avenue: "ave",
  ave: "ave",
  road: "rd",
  rd: "rd",
  drive: "dr",
  dr: "dr",
  boulevard: "blvd",
  blvd: "blvd",
  lane: "ln",
  ln: "ln",
  court: "ct",
  ct: "ct",
  circle: "cir",
  cir: "cir",
  place: "pl",
  pl: "pl",
  terrace: "ter",
  ter: "ter",
  parkway: "pkwy",
  pkwy: "pkwy",
  trail: "trl",
  trl: "trl",
  highway: "hwy",
  hwy: "hwy",
};

function streetKey(s) {
  return nameKey(s)
    .replace(/\b(north|south|east|west|n|s|e|w|ne|nw|se|sw)\b/g, "")
    .replace(/\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|circle|cir|place|pl|terrace|ter|parkway|pkwy|trail|trl|highway|hwy)\b/g, (w) => STREET_CANON[w] || w)
    .replace(/\s+/g, " ")
    .trim();
}

/** Grade one geocoder candidate against the address we asked for. Negative = unusable. */
export function scoreListingGeoHit(cand, want = {}, near = null) {
  if (!cand || !validInvestorCoord(cand.lat, cand.lon) || !inOklahoma(cand.lat, cand.lon)) return -1;
  if (cand.precision === "street" || cand.precision === "area") return -1;
  let s = cand.precision === "rooftop" ? 6 : cand.precision === "parcel" ? 3 : 1;
  if (want.house) {
    if (houseNumbersMatch(want.house, cand.housenumber)) s += 5;
    else if (cand.housenumber) return -1;
    else if (cand.precision === "rooftop") s -= 2;
  }
  if (want.zip && cand.postcode) s += String(cand.postcode).startsWith(want.zip) ? 3 : -4;
  if (want.city && cand.city) s += nameKey(cand.city) === nameKey(want.city) ? 2 : -2;
  if (want.street && cand.street) s += streetKey(cand.street) === streetKey(want.street) ? 2 : -1;
  if (near && validInvestorCoord(near.lat, near.lon)) {
    const km = metersBetween({ lat: Number(near.lat), lon: Number(near.lon) }, cand) / 1000;
    if (km > MAX_LISTING_KM) return -1;
    if (km < 12) s += 1;
  }
  return s;
}

function pickGeoHit(cands, want, near) {
  let best = null;
  let score = 2;
  for (const cand of cands || []) {
    const s = scoreListingGeoHit(cand, want, near);
    if (s > score) {
      score = s;
      best = cand;
    }
  }
  return best;
}

async function photonGeoCandidates(parts, near) {
  const u = new URL(PHOTON_URL);
  u.searchParams.set("q", parts.address);
  u.searchParams.set("limit", "8");
  u.searchParams.set("lang", "en");
  if (Number.isFinite(Number(near?.lat))) u.searchParams.set("lat", String(near.lat));
  if (Number.isFinite(Number(near?.lon))) u.searchParams.set("lon", String(near.lon));
  try {
    const { body } = await httpGet(u.toString(), 8000, { Accept: "application/json" });
    return (JSON.parse(body || "{}")?.features || []).map((feat) => {
      const p = feat?.properties || {};
      return {
        lat: Number(feat?.geometry?.coordinates?.[1]),
        lon: Number(feat?.geometry?.coordinates?.[0]),
        precision: photonHitPrecision(p),
        housenumber: p.housenumber || "",
        street: p.street || p.name || "",
        city: p.city || p.district || "",
        postcode: p.postcode || "",
        geoSource: "photon",
      };
    });
  } catch {
    return [];
  }
}

/**
 * The Census geocoder interpolates along the real address range of the real block, so it
 * lands on the house even when OSM has never heard of it. It is the only source here with
 * near-complete US street coverage, which is why it runs before Nominatim.
 */
/**
 * Esri World Geocode — CORS * so phones on Pages can pin a listing without a
 * public relay. PointAddress is the rooftop; StreetAddress is the interpolated
 * house on the right block (same grade we give Census).
 */
export function parseArcGisMatch(cand = {}) {
  const a = cand.attributes || {};
  const loc = cand.location || {};
  const addrType = String(a.Addr_type || "").toLowerCase();
  const house = String(a.AddNum || "").trim();
  const stAddr = String(a.StAddr || "").trim();
  const street = stAddr.replace(/^\d+\s+/, "").trim() || String(a.StName || "").trim();
  let precision = "approx";
  if (addrType === "pointaddress" || addrType === "subaddress") precision = "rooftop";
  else if (addrType === "streetaddress" || addrType === "streetint") precision = "parcel";
  else if (addrType === "streetname") precision = "street";
  else if (addrType === "locality" || addrType === "postal" || addrType === "postalext") precision = "area";
  else if (house) precision = "parcel";
  return {
    lat: Number(loc.y),
    lon: Number(loc.x),
    precision,
    housenumber: house,
    street,
    city: a.City || "",
    postcode: String(a.Postal || "").slice(0, 5),
    geoSource: "arcgis",
  };
}

function accuracySlice(list) {
  const hearts = list.filter((inv) => String(inv.kind) === "insurance");
  const stars = list.filter((inv) => String(inv.kind) === "realestate");
  const withPhone = list.filter((inv) => investorHasContact(inv));
  const missingPhone = list.filter((inv) => !investorHasContact(inv));
  const homes = stars.flatMap((inv) => (Array.isArray(inv.listings) ? inv.listings : []));
  const drawn = homes.filter(listingIsMappable);
  const verified = drawn.filter(listingIsExact);
  const addressOnly = homes.filter((row) => String(row?.address || "").trim() && !listingIsMappable(row));
  const nameOf = (inv) => String(inv?.name || inv?.company || "").trim();
  return {
    offices: list.length,
    hearts: hearts.length,
    stars: stars.length,
    withPhone: withPhone.length,
    missingPhone: missingPhone.length,
    listings: homes.length,
    drawn: drawn.length,
    verified: verified.length,
    approximate: Math.max(0, drawn.length - verified.length),
    addressOnly: addressOnly.length,
    missingPhoneNames: missingPhone.map(nameOf).filter(Boolean).slice(0, 8),
    looseHomes: drawn.filter((h) => !listingIsExact(h)).map((h) => h.address).filter(Boolean).slice(0, 8),
    addressOnlyHomes: addressOnly.map((h) => h.address).filter(Boolean).slice(0, 8),
  };
}

/** Frame vs on-map office/listing counts for tests and status lines. */
export function summarizeAgentAccuracy(investors = [], bounds = null) {
  const list = Array.isArray(investors) ? investors : [];
  const inView = bounds ? list.filter((inv) => investorInBounds(inv, bounds)) : list;
  const scoped = accuracySlice(inView);
  const onMap = accuracySlice(list);
  return {
    ...scoped,
    onMap: onMap.offices,
    onMapHearts: onMap.hearts,
    onMapStars: onMap.stars,
    cameraEmpty: Boolean(bounds) && scoped.offices === 0 && onMap.offices > 0,
  };
}

export function parseCensusMatch(match = {}) {
  const c = match.coordinates || {};
  const comp = match.addressComponents || {};
  const matched = String(match.matchedAddress || "");
  const house = (matched.match(/^\s*(\d+[A-Za-z]?)\b/) || [])[1] || "";
  const street = [comp.preDirection, comp.streetName, comp.suffixType, comp.suffixDirection]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ");
  return {
    lat: Number(c.y),
    lon: Number(c.x),
    // Interpolated onto the correct side of the correct block — good enough to point at a roof.
    precision: "parcel",
    housenumber: house,
    street,
    city: comp.city || "",
    postcode: String(comp.zip || "").slice(0, 5),
    geoSource: "census",
  };
}

async function arcgisGeoCandidates(parts, near) {
  if (!parts.street) return [];
  const u = new URL(ARCGIS_GEOCODER_URL);
  u.searchParams.set("f", "json");
  u.searchParams.set("SingleLine", parts.address);
  u.searchParams.set("outFields", "Match_addr,Addr_type,StName,AddNum,StAddr,City,RegionAbbr,Postal");
  u.searchParams.set("maxLocations", "6");
  u.searchParams.set("sourceCountry", "USA");
  u.searchParams.set("category", "Address");
  u.searchParams.set("searchExtent", `${OK_EXTENT.west},${OK_EXTENT.south},${OK_EXTENT.east},${OK_EXTENT.north}`);
  if (Number.isFinite(Number(near?.lat)) && Number.isFinite(Number(near?.lon))) {
    u.searchParams.set("location", `${Number(near.lon)},${Number(near.lat)}`);
    u.searchParams.set("distance", "80000");
  }
  try {
    const { body } = await httpGet(u.toString(), 8000, { Accept: "application/json" });
    return (JSON.parse(body || "{}")?.candidates || []).map(parseArcGisMatch);
  } catch {
    return [];
  }
}

function censusReachableWithoutRelay() {
  // Pages / Safari: Census has no CORS and the public relays are dead. Native
  // Capacitor HTTP (the APK) can still ask it after ArcGIS.
  if (typeof window === "undefined") return true;
  try {
    return Boolean(httpDiag().nativeHttp);
  } catch {
    return false;
  }
}

async function censusGeoCandidates(parts) {
  if (!parts.street || !censusReachableWithoutRelay()) return [];
  const u = new URL(CENSUS_GEOCODER_URL);
  u.searchParams.set("address", parts.address);
  u.searchParams.set("benchmark", "Public_AR_Current");
  u.searchParams.set("format", "json");
  try {
    const { body } = await httpGet(u.toString(), 9000, { Accept: "application/json" });
    const matches = JSON.parse(body || "{}")?.result?.addressMatches || [];
    return matches.slice(0, 4).map(parseCensusMatch);
  } catch {
    return [];
  }
}

let nominatimGate = Promise.resolve();
/** Nominatim asks for one request per second — queue them instead of getting rate-limited. */
function nominatimSlot() {
  const wait = nominatimGate.then(() => new Promise((r) => setTimeout(r, 1100)));
  nominatimGate = wait.catch(() => {});
  return wait;
}

async function nominatimGeoCandidates(parts) {
  if (!parts.street) return [];
  const u = new URL(NOMINATIM_URL);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("limit", "5");
  u.searchParams.set("countrycodes", "us");
  u.searchParams.set("state", "Oklahoma");
  u.searchParams.set("street", parts.street);
  if (parts.city) u.searchParams.set("city", parts.city);
  if (parts.zip) u.searchParams.set("postalcode", parts.zip);
  try {
    await nominatimSlot();
    const { body } = await httpGet(u.toString(), 9000, {
      Accept: "application/json",
      "User-Agent": "GroundControl/1.0 (joshuagwatts)",
    });
    const rows = JSON.parse(body || "[]");
    return (Array.isArray(rows) ? rows : []).map((hit) => {
      const addr = hit.address || {};
      return {
        lat: Number(hit.lat),
        lon: Number(hit.lon),
        precision: nominatimHitPrecision(hit),
        housenumber: addr.house_number || "",
        street: addr.road || "",
        city: addr.city || addr.town || addr.village || addr.hamlet || "",
        postcode: addr.postcode || "",
        geoSource: "nominatim",
      };
    });
  } catch {
    return [];
  }
}

function geoResult(hit) {
  return hit ? { lat: hit.lat, lon: hit.lon, precision: hit.precision, geoSource: hit.geoSource } : null;
}

/**
 * Resolve a listing address to the house. Returns null rather than a point on the road —
 * a dot on the centreline reads as a real address and sends a crew to the wrong building.
 */
export async function geocodeListing(address, near) {
  const parts = typeof address === "string" ? listingAddressParts(address) : address;
  if (!parts?.address || parts.address.length < 8) return null;
  // ArcGIS first: CORS * and US rooftops. Photon-before-Esri plus Nominatim's
  // 1-req/s queue is why a tapped star sat on "looking up listings" forever.
  const arcgis = await arcgisGeoCandidates(parts, near);
  const arcgisHit = pickGeoHit(arcgis, parts, near);
  if (arcgisHit) return geoResult(arcgisHit);
  const photon = await photonGeoCandidates(parts, near);
  const confirmed = photon.find(
    (c) => c.precision === "rooftop" && houseNumbersMatch(parts.house, c.housenumber) && scoreListingGeoHit(c, parts, near) > 0,
  );
  if (confirmed) return geoResult(confirmed);
  const photonHit = pickGeoHit(photon, parts, near);
  if (photonHit) return geoResult(photonHit);
  const census = await censusGeoCandidates(parts);
  return geoResult(pickGeoHit(census, parts, near));
}

function metersBetween(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

export function listingNearOffice(office, home, maxKm = MAX_LISTING_KM) {
  if (!validInvestorCoord(home?.lat, home?.lon)) return false;
  if (!validInvestorCoord(office?.lat, office?.lon)) return true;
  const meters = metersBetween(office, home);
  if (meters < 90) return false;
  return meters <= maxKm * 1000;
}

function listingMatchesOffice(inv, row) {
  const officeHouse = houseFromAddress(inv?.address);
  if (!officeHouse) return false;
  const officeStreet = streetKey(parseStreetAddress(inv.address || "").street || inv.address || "");
  const house = houseFromStreet(row?.street || row?.address || "");
  const street = streetKey(String(row?.street || row?.address || "").replace(/^\d+[A-Za-z]?\s+/, ""));
  return house === officeHouse && Boolean(officeStreet) && street === officeStreet;
}

async function listingsFromPages(urls, inv) {
  const out = [];
  const seen = new Set();
  const absorb = (page) => {
    if (!page?.html) return;
    for (const row of parseSaleListingsFromHtml(page.html, { officeName: inv.name || inv.company, officeAddress: inv.address || "" })) {
      if (listingMatchesOffice(inv, row)) continue;
      pushListing(out, seen, { ...row, url: row.url || page.url, attribution: "office" });
    }
  };
  const list = urls.filter(Boolean).slice(0, 7);
  if (!list.length) return out;
  absorb(await fetchListingPage(list[0], LISTING_PAGE_MS));
  if (out.length < 6 && list.length > 1) {
    const pages = await Promise.all(list.slice(1).map((url) => fetchListingPage(url, LISTING_PAGE_MS)));
    for (const page of pages) absorb(page);
  }
  return out;
}

async function listingsFromIdxJson(website, inv) {
  const out = [];
  const seen = new Set();
  for (const url of idxJsonUrlsForOffice(website)) {
    const page = await fetchListingPage(url, LISTING_PAGE_MS);
    if (!page?.html) continue;
    const json = parseJsonPayload(page.html);
    if (!json) continue;
    for (const row of parseIdxListingsFromJson(json, { officeName: inv?.name || inv?.company })) {
      pushListing(out, seen, row);
    }
    if (out.length) break;
  }
  return out;
}

async function discoverOfficeWebsite(inv) {
  const sources = await discoverOfficeListingSources(inv);
  return sources[0] || "";
}

function scoreListingSource(url, inv) {
  if (!listingSourceFitsOffice(url, inv)) return -1;
  const unique = officeUniqueTokens(inv?.name || inv?.company);
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return -1;
  }
  let s = 1;
  if (unique.some((t) => host.includes(t))) s += 8;
  if (unique.some((t) => path.includes(t))) s += 2;
  if (/appfolio\.com$/i.test(host)) s += 5;
  if (/active-listings|homes-for-sale|\/listings/i.test(path)) s += 3;
  return s;
}

function urlsFromSearchPage(html) {
  const out = extractSearchResultUrls(html, { limit: 20 });
  const re = /\bhttps?:\/\/[^\s)\]"'<>]+/gi;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 30) {
    const href = String(m[0] || "").replace(/[.,;]+$/, "");
    if (/^https?:\/\//i.test(href)) out.push(href);
  }
  return out;
}

/** Office sites + Appfolio inventory pages from DDG Lite (html.duckduckgo.com is captcha'd). */
export async function discoverOfficeListingSources(inv) {
  const name = inv?.name || inv?.company;
  const city = investorCity(inv);
  if (!name) return [];
  const queries = [
    `${name} ${city} OK appfolio listings`,
    `"${name}" ${city} OK ("active listings" OR listings OR website)`,
  ];
  const pages = await Promise.all(
    queries.map((q) => fetchListingPage(`${DDG_LITE}${encodeURIComponent(q)}`, 5500)),
  );
  const ranked = [];
  const seen = new Set();
  for (const page of pages) {
    if (!page?.html) continue;
    for (const u of urlsFromSearchPage(page.html)) {
      const key = String(u || "")
        .replace(/\/$/, "")
        .toLowerCase();
      if (!key || seen.has(key)) continue;
      const s = scoreListingSource(u, inv);
      if (s < 0) continue;
      seen.add(key);
      ranked.push({ u, s });
    }
  }
  ranked.sort((a, b) => b.s - a.s);
  return ranked.map((row) => row.u).slice(0, 4);
}

function pinListingGeo(next, geo) {
  if (!geo) return next;
  if (!inOklahoma(geo.lat, geo.lon)) return next;
  return { ...next, lat: geo.lat, lon: geo.lon, precision: geo.precision, geoSource: geo.geoSource };
}

async function geocodeListingRows(inv, rows, { limit = MAX_LISTING_GEOCODE, workers = LISTING_GEO_WORKERS, onMapped } = {}) {
  const office = { lat: Number(inv?.lat), lon: Number(inv?.lon) };
  const cityHint = nameKey(investorCity(inv));
  const todo = (rows || []).slice(0, MAX_FETCH_LISTINGS).sort((a, b) => {
    const ac = nameKey(`${a.city || ""} ${a.address || ""}`).includes(cityHint) ? 0 : 1;
    const bc = nameKey(`${b.city || ""} ${b.address || ""}`).includes(cityHint) ? 0 : 1;
    return ac - bc;
  });
  const out = [];
  let cursor = 0;
  let geoLeft = limit;
  let mappedPainted = 0;
  const n = Math.min(workers, Math.max(1, todo.length));
  async function worker() {
    while (cursor < todo.length) {
      const row = todo[cursor];
      cursor += 1;
      let next = { ...row };
      if (!listingIsMappable(next) && geoLeft > 0 && String(next.address || "").trim()) {
        const parts = next.parts || listingAddressParts(next.address);
        if (parts) {
          geoLeft -= 1;
          next = pinListingGeo(next, await geocodeListing(parts, office));
        }
      }
      if (!validInvestorCoord(next.lat, next.lon) || !inOklahoma(next.lat, next.lon)) {
        if (next.address) out.push(normalizeListing({ ...next, lat: null, lon: null, precision: "street" }));
        continue;
      }
      if (!listingNearOffice(office, next)) {
        if (String(next.attribution || "") === "nearby") continue;
        if (next.address) out.push(normalizeListing({ ...next, lat: null, lon: null, precision: "street" }));
        continue;
      }
      out.push(normalizeListing(next));
      if (typeof onMapped === "function" && listingIsMappable(next)) {
        mappedPainted += 1;
        if (mappedPainted <= 3 || mappedPainted === out.filter(listingIsMappable).length) {
          try {
            onMapped(out.slice());
          } catch {
            /* peek optional */
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out.slice(0, MAX_FETCH_LISTINGS);
}

export async function fetchInvestorListings(inv, { osmHits = [], onScraped, onMapped } = {}) {
  if (!inv || String(inv.kind) !== "realestate") return [];
  const notify = (rows) => {
    if (typeof onScraped === "function" && rows.length) {
      try {
        onScraped(rows);
      } catch {
        /* peek optional */
      }
    }
  };
  async function hunt(site) {
    if (!isOfficeWebsite(site) && !/appfolio\.com/i.test(String(site || ""))) return [];
    const idxP = listingsFromIdxJson(site, inv);
    const homeP = listingsFromPages([site], inv);
    const [idxRows, homeRows] = await Promise.all([idxP, homeP]);
    let picked = pickOfficeListings(homeRows, idxRows);
    if (picked.length < 4) {
      const extraUrls = listingUrlsForOffice({ ...inv, website: site }).filter((u) => u !== site);
      const extra = extraUrls.length ? await listingsFromPages(extraUrls, inv) : [];
      picked = pickOfficeListings([...homeRows, ...extra], idxRows);
    }
    picked = picked.filter((row) => String(row?.attribution || "") !== "nearby" && !listingMatchesOffice(inv, row));
    notify(picked);
    return picked;
  }
  const sites = [];
  const seenSite = new Set();
  const pushSite = (raw) => {
    const u = String(raw || "").trim();
    if (!u) return;
    const key = u.replace(/\/$/, "").toLowerCase();
    if (seenSite.has(key)) return;
    if (!isOfficeWebsite(u) && !/appfolio\.com/i.test(u)) return;
    seenSite.add(key);
    sites.push(u);
  };
  pushSite(inv.website);
  pushSite(officeWebsiteFromOsm(inv, osmHits));
  for (const u of knownOfficeListingSites(inv)) pushSite(u);
  let bag = [];
  const bagSeen = new Set();
  const absorb = (rows) => {
    for (const row of rows || []) pushListing(bag, bagSeen, row);
  };
  let hunted = 0;
  if (sites.length) {
    const batch = sites.slice(0, 2);
    const rows = await Promise.all(batch.map((site) => hunt(site)));
    for (const row of rows) absorb(row);
    hunted = batch.length;
  }
  if (bag.length < 6) {
    if (!bag.length) {
      for (const u of await discoverOfficeListingSources(inv)) pushSite(u);
    }
    for (const site of sites.slice(hunted)) {
      absorb(await hunt(site));
      if (bag.length >= 8) break;
    }
  }
  const fallback = listingFallbackWebsite({ ...inv, website: sites[0] || inv.website });
  if (!bag.length && fallback) {
    const extra = await listingsFromIdxJson(fallback, inv);
    absorb(pickOfficeListings([], extra).filter((row) => String(row?.attribution || "") !== "nearby"));
    notify(bag);
  }
  return geocodeListingRows(inv, bag, { onMapped });
}

function allListings(inv) {
  return Array.isArray(inv?.listings) ? inv.listings : [];
}

/** Fill missing phone/email and, for a selected star, the agent's actual sale homes. */
export async function enrichInvestorFromPublic(inv, { deep = false, osmHits = [], budgetMs = 0, onPartial, onListingsSettled, onListingsResume } = {}) {
  if (!inv) return null;
  const budget = Number(budgetMs) || (deep ? DEEP_LOOKUP_MS : SHALLOW_LOOKUP_MS);
  const mappedCount = officeOwnedMappedCount(inv);
  const wantListings = String(inv.kind) === "realestate" && deep && mappedCount < OFFICE_LISTING_HUNT_BELOW;
  const website = inv.website || officeWebsiteFromOsm(inv, osmHits);
  const seeded = website && website !== inv.website ? { ...inv, website } : inv;
  const listingsP = wantListings
    ? withDeadline(
        fetchInvestorListings(seeded, {
          osmHits,
          onScraped: (rows) => {
            if (typeof onPartial === "function") onPartial(mergeInvestorPublic(seeded, { listings: rows }));
          },
          onMapped: (rows) => {
            if (typeof onPartial === "function") onPartial(mergeInvestorPublic(seeded, { listings: rows }));
          },
        }),
        LISTING_LOOKUP_MS,
        [],
      )
    : Promise.resolve(allListings(inv));
  const contactsP = withDeadline(enrichInvestorContacts(seeded, { deep, osmHits, budgetMs: budget }), budget + 1500);

  let found = await listingsP;
  if (typeof onListingsSettled === "function") {
    try {
      onListingsSettled();
    } catch {
      /* peek optional */
    }
  }
  let listings = allListings(inv).filter(listingIsOfficeOwned);
  let foundList = Array.isArray(found) ? found.filter(listingIsOfficeOwned) : [];
  if (foundList.length) listings = foundList;
  const contacts = await contactsP;
  const foundSite = isOfficeWebsite(contacts?.website) ? contacts.website : "";
  const usedSite = isOfficeWebsite(seeded.website) ? seeded.website : "";
  if (wantListings && !foundList.length && foundSite && foundSite !== usedSite) {
    if (typeof onListingsResume === "function") {
      try {
        onListingsResume();
      } catch {
        /* peek optional */
      }
    }
    found = await withDeadline(
      fetchInvestorListings(
        { ...seeded, website: foundSite },
        {
          osmHits,
          onScraped: (rows) => {
            if (typeof onPartial === "function") onPartial(mergeInvestorPublic({ ...seeded, website: foundSite }, { listings: rows }));
          },
          onMapped: (rows) => {
            if (typeof onPartial === "function") onPartial(mergeInvestorPublic({ ...seeded, website: foundSite }, { listings: rows }));
          },
        },
      ),
      LISTING_LOOKUP_MS,
      [],
    );
    foundList = Array.isArray(found) ? found.filter(listingIsOfficeOwned) : [];
    if (foundList.length) listings = foundList;
    if (typeof onListingsSettled === "function") {
      try {
        onListingsSettled();
      } catch {
        /* peek optional */
      }
    }
  }
  const scraped = foundList.length ? foundList : null;
  if (
    String(inv.kind) === "realestate" &&
    deep &&
    !scraped &&
    mappedInvestorListings({ listings }).length < 1 &&
    listings.some((row) => String(row?.address || "").trim())
  ) {
    listings = await withDeadline(geocodeListingRows(inv, listings), LISTING_LOOKUP_MS, listings);
  }
  if (typeof onPartial === "function" && wantListings && foundList.length) {
    try {
      onPartial(mergeInvestorPublic(inv, { listings }));
    } catch {
      /* peek optional */
    }
  }

  const extra = { ...(contacts || {}), listings };
  const next = mergeInvestorPublic(seeded, extra);
  const betterContact = (next.phone && next.phone !== inv.phone) || (next.email && next.email !== inv.email);
  const betterList =
    allListings(next).length > allListings(inv).length ||
    investorListings(next).length > investorListings(inv).length ||
    mappedInvestorListings(next).length > mappedInvestorListings(inv).length;
  if (!betterContact && !betterList && !(next.website && !inv.website)) {
    if (investorHasContact(inv) && String(inv.kind) !== "realestate") return null;
    if (String(inv.kind) === "realestate" && officeOwnedMappedCount(inv)) return null;
  }
  return next;
}
