/** Public office contacts + an agent's actual for-sale homes (not county boxes). */

import { httpGet, osmMapJson, overpassJson } from "./net.js";
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
  investorListings,
  listingFromBizRow,
  normalizeInvestor,
  normalizeListing,
  validInvestorCoord,
} from "./investors.js";

const OSM_API = "https://api.openstreetmap.org/api/0.6";
const PHOTON_URL = "https://photon.komoot.io/api/";
const DDG_HTML = "https://html.duckduckgo.com/html/?q=";
const MAX_LISTINGS = 40;

const PEOPLE_SEARCH =
  /facebook\.com|instagram\.com|linkedin\.com|truepeoplesearch|beenverified|spokeo|fastpeoplesearch|thatsthem|intelius|radaris|cyberbackground|whitepages\.com\/name|411\.com\/people|anywho\.com\/people/i;
const JUNK_MAIL =
  /example\.com$|noreply|no-reply|privacy@|support@duckduckgo|sentry\.io$|wixpress|godaddy|wordpress\.com$|png$|jpg$|gif$|keen\.io$|cloudflare|schema\.org|placeholder|sentry|wix\.com$|thebbb\.org$|bbb\.org$|yellowpages\.com$|yelp\.com$|facebook\.com$|google\.com$|interactiveblue\.com$|squarespace\.com$|hubspot\.com$|mailchimp\.com$|constantcontact\.com$/i;
const DIRECTORY_HOST =
  /yellowpages\.com|bbb\.org|thebbb\.org|yelp\.com|facebook\.com|duckduckgo|realtor\.com|zillow\.com|redfin\.com|homes\.com|chamberofcommerce\.com/i;
const GENERIC_NAME =
  /^(the|and|llc|inc|co|corp|agency|insurance|ins|realty|real|estate|realtor|realtors|group|company|associates|office|agent|agents|farm|state|farmers|allstate|nationwide)$/i;

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

export function isOfficeOsmElement(el) {
  const t = el?.tags || {};
  if (t.office === "insurance" || t.office === "estate_agent") return true;
  return /state\s*farm|farmers insurance|allstate|nationwide|farm bureau/i.test(t.name || "");
}

export function officeOverpassQuery(south, west, north, east) {
  const s = Number(south).toFixed(5);
  const w = Number(west).toFixed(5);
  const n = Number(north).toFixed(5);
  const e = Number(east).toFixed(5);
  return `[out:json][timeout:12][bbox:${s},${w},${n},${e}];(
    node["office"="insurance"];
    way["office"="insurance"];
    node["office"="estate_agent"];
    way["office"="estate_agent"];
    node["name"~"State Farm|Farmers Insurance|Allstate|Nationwide",i];
    way["name"~"State Farm|Farmers Insurance|Allstate|Nationwide",i];
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
    if (!isOfficeOsmElement(el)) continue;
    const ll = osmElementLatLon(el);
    const tags = el.tags || {};
    const name = String(tags.name || tags.operator || "").trim();
    if (!ll || !name) continue;
    const row = listingFromBizRow({
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
      office: tags.office || "",
    });
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
  const p = parseStreetAddress(inv?.address || "");
  if (p.city) return p.city;
  const m = String(inv?.address || "").match(
    /\b(Oklahoma City|Tulsa|Edmond|Norman|Broken Arrow|Moore|Midwest City|Lawton|Stillwater|Enid|Muskogee|Bartlesville|Shawnee|Owasso|Yukon|Bethany|Del City|Jenks|Bixby|Sapulpa|Ponca City|Ardmore|Altus|Guymon|Woodward|McAlester|Ada|Durant|Claremore|Tahlequah|Coweta)\b/i,
  );
  return m ? m[1] : "Oklahoma City";
}

function citySlug(city) {
  return String(city || "oklahoma-city")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function officeSlug(name) {
  return nameKey(name).replace(/\s+/g, "-").slice(0, 48);
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

async function fetchPage(url, ms = 12000, extra = {}) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href) || isPeopleSearchUrl(href)) return null;
  try {
    const { body, url: finalUrl } = await httpGet(href, ms, { ...listingBrowserHeaders(), ...extra });
    const html = String(body || "");
    if (html.length < 80) return null;
    return { html, url: finalUrl || href };
  } catch {
    return null;
  }
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

export function parseRealtorDetailSlug(slug) {
  const raw = decodeURIComponent(String(slug || "").split("?")[0]).replace(/\/+$/, "");
  const bits = raw.split("_").filter(Boolean);
  if (bits.length < 3) return "";
  const last = bits[bits.length - 1] || "";
  if (/^M/i.test(last)) bits.pop();
  let zip = "";
  if (/^\d{5}(?:-\d{4})?$/.test(bits[bits.length - 1] || "")) zip = bits.pop();
  let state = "";
  if (/^[A-Za-z]{2}$/.test(bits[bits.length - 1] || "")) state = bits.pop().toUpperCase();
  const city = (bits.pop() || "").replace(/-/g, " ");
  const street = (bits.join(" ") || "").replace(/-/g, " ");
  const addr = [street, city, state || "OK", zip].filter(Boolean).join(", ");
  return /\d/.test(street) ? addr : "";
}

export function parseZillowDetailSlug(path) {
  const raw = decodeURIComponent(String(path || "").split("?")[0]).replace(/\/+$/, "");
  const parts = raw.split("/").filter(Boolean);
  const slug = parts.find((p) => /\d/.test(p) && !/_zpid$/i.test(p)) || parts[0] || "";
  const bits = slug.replace(/_rb$/i, "").split("-").filter(Boolean);
  if (bits.length < 3) return "";
  if (/^\d{5}$/.test(bits[bits.length - 1] || "")) bits.pop();
  if (/^[A-Za-z]{2}$/.test(bits[bits.length - 1] || "")) bits.pop();
  const street = bits.join(" ");
  return /\d/.test(street) ? `${street.replace(/-/g, " ")}, OK` : "";
}

function pushListing(out, seen, row) {
  const n = normalizeListing(row);
  if (!n.address && !validInvestorCoord(n.lat, n.lon)) return;
  const key = n.address
    ? nameKey(n.address).replace(/\s+/g, "")
    : `${Number(n.lat).toFixed(5)}:${Number(n.lon).toFixed(5)}`;
  if (!key || seen.has(key)) return;
  seen.add(key);
  out.push(n);
}

/** Homes attributed to this office/agent — never a city-wide dump. */
export function parseSaleListingsFromHtml(html, { officeName = "" } = {}) {
  const blob = String(html || "");
  const out = [];
  const seen = new Set();
  const realtor = /https?:\/\/(?:www\.)?realtor\.com\/realestateandhomes-detail\/([^"'?\s]+)/gi;
  let m;
  while ((m = realtor.exec(blob)) && out.length < MAX_LISTINGS) {
    const address = parseRealtorDetailSlug(m[1]);
    if (!address) continue;
    pushListing(out, seen, { address, url: `https://www.realtor.com/realestateandhomes-detail/${m[1]}`, source: "realtor" });
  }
  const zillow = /https?:\/\/(?:www\.)?zillow\.com\/homedetails\/([^"'?\s]+)/gi;
  while ((m = zillow.exec(blob)) && out.length < MAX_LISTINGS) {
    const address = parseZillowDetailSlug(m[1]);
    if (!address) continue;
    pushListing(out, seen, { address, url: `https://www.zillow.com/homedetails/${m[1]}`, source: "zillow" });
  }
  const redfin = /https?:\/\/(?:www\.)?redfin\.com\/OK\/([A-Za-z0-9/_-]+)/gi;
  while ((m = redfin.exec(blob)) && out.length < MAX_LISTINGS) {
    const path = m[1];
    const street = path.split("/").filter(Boolean)[1] || "";
    const address = street.replace(/-/g, " ");
    if (!/\d/.test(address)) continue;
    pushListing(out, seen, { address: `${address}, OK`, url: `https://www.redfin.com/OK/${path}`, source: "redfin" });
  }

  const coordBlocks =
    blob.match(/\{[^{}]{0,240}"(?:latitude|lat)"\s*:\s*-?\d+\.\d+[^{}]{0,240}\}/gi) || [];
  for (const block of coordBlocks) {
    const lat = Number((block.match(/"(?:latitude|lat)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    const lon = Number((block.match(/"(?:longitude|lon|lng)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    const line = (block.match(/"(?:line|streetAddress|full_street_address)"\s*:\s*"([^"]{6,80})"/i) || [])[1];
    if (!validInvestorCoord(lat, lon) || !inOklahoma(lat, lon)) continue;
    pushListing(out, seen, { lat, lon, address: line || "", source: "embed" });
  }

  const addrJson =
    /"address"\s*:\s*\{\s*"line"\s*:\s*"([^"]+)"\s*,\s*"city"\s*:\s*"([^"]+)"\s*,\s*"state_code"\s*:\s*"([^"]+)"/gi;
  while ((m = addrJson.exec(blob)) && out.length < MAX_LISTINGS) {
    const address = [m[1], m[2], m[3]].filter(Boolean).join(", ");
    if (!/\d/.test(m[1])) continue;
    const nearby = blob.slice(m.index, m.index + 500);
    const lat = Number((nearby.match(/"(?:lat|latitude)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    const lon = Number((nearby.match(/"(?:lon|lng|longitude)"\s*:\s*(-?\d+\.\d+)/i) || [])[1]);
    pushListing(out, seen, {
      address,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      source: "embed",
    });
  }

  if (officeName && out.length > 12 && !namesLikelySame(officeName, blob.slice(0, 4000))) {
    /* city search pages can leak unrelated homes — keep only if the office is named nearby */
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
    .sort((a, b) => a.dist - b.dist);
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
  const seen = new Set();
  const mergedListings = [];
  for (const row of listings) {
    const n = normalizeListing(row);
    const key = n.address ? nameKey(n.address).replace(/\s+/g, "") : `${n.lat}:${n.lon}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    mergedListings.push(n);
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
    const data = await overpassJson(officeOverpassQuery(box.south, box.west, box.north, box.east), 14000);
    els = (data?.elements || []).filter(isOfficeOsmElement);
  } catch {
    els = [];
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

export async function enrichInvestorContacts(inv, { deep = false, osmHits = [] } = {}) {
  if (!inv) return null;
  let hit = {
    phone: inv.phone || "",
    email: inv.email || "",
    website: inv.website || "",
    address: inv.address || "",
  };
  const osmEl = pickOsmOfficeForInvestor(inv, osmHits);
  if (osmEl) hit = mergeContacts(hit, tagsToContacts(osmEl.tags || {}));
  if (!hit.phone) {
    const osm = await contactsFromOsm(inv).catch(() => null);
    if (osm) hit = mergeContacts(hit, osm);
  }
  if (!hit.phone || !hit.email) {
    const brand = await contactsFromBrandLocator(inv).catch(() => null);
    if (brand) hit = mergeContacts(hit, brand);
  }
  if (hit.website && (!hit.phone || !hit.email)) {
    const site = await contactsFromWebsite(hit.website).catch(() => null);
    if (site) hit = mergeContacts(hit, { ...site, email: cleanBizEmail(site.email, hit.website) });
  }
  if (deep && !hit.phone) {
    const dir = await contactsFromDirectories(inv).catch(() => null);
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

function listingUrlsForOffice(inv) {
  const name = inv.name || inv.company;
  const city = citySlug(investorCity(inv));
  const slug = officeSlug(name);
  return [
    `https://www.realtor.com/realestateagents/${slug}_${city}_ok`,
    `https://www.realtor.com/realestateagents/${slug}_${city}_ok/`,
    `https://www.zillow.com/${city}-ok/realtor/${slug}/`,
  ];
}

async function geocodeListing(address, near) {
  const q = String(address || "").trim();
  if (q.length < 8) return null;
  const u = new URL(PHOTON_URL);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "1");
  if (Number.isFinite(Number(near?.lat))) u.searchParams.set("lat", String(near.lat));
  if (Number.isFinite(Number(near?.lon))) u.searchParams.set("lon", String(near.lon));
  try {
    const { body } = await httpGet(u.toString(), 8000, { Accept: "application/json" });
    const feat = JSON.parse(body || "{}")?.features?.[0];
    const lon = Number(feat?.geometry?.coordinates?.[0]);
    const lat = Number(feat?.geometry?.coordinates?.[1]);
    if (!validInvestorCoord(lat, lon) || !inOklahoma(lat, lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

function metersBetween(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

async function listingsFromPages(urls, inv) {
  const out = [];
  const seen = new Set();
  for (const url of urls.slice(0, 5)) {
    const page = await fetchPage(url, 12000, listingBrowserHeaders({ zillow: /zillow/i.test(url) }));
    if (!page?.html) continue;
    for (const row of parseSaleListingsFromHtml(page.html, { officeName: inv.name || inv.company })) {
      pushListing(out, seen, { ...row, url: row.url || page.url });
    }
    if (out.length >= 8) break;
  }
  return out;
}

export async function fetchInvestorListings(inv) {
  if (!inv || String(inv.kind) !== "realestate") return [];
  const name = inv.name || inv.company;
  const city = investorCity(inv);
  const urls = listingUrlsForOffice(inv);
  const q = `site:realtor.com/realestateagents "${name}" ${city} OK`;
  const ddg = await fetchPage(`${DDG_HTML}${encodeURIComponent(q)}`, 10000);
  if (ddg?.html) {
    for (const u of extractSearchResultUrls(ddg.html, { allowHostRe: /realtor\.com|zillow\.com|redfin\.com/i, limit: 5 })) {
      urls.unshift(u);
    }
  }
  if (inv.website) {
    urls.push(inv.website);
    try {
      const origin = new URL(inv.website).origin;
      urls.push(`${origin}/listings`, `${origin}/homes-for-sale`, `${origin}/search`);
    } catch {
      /* ignore */
    }
  }
  const rows = await listingsFromPages([...new Set(urls)], inv);
  const office = { lat: Number(inv.lat), lon: Number(inv.lon) };
  const located = [];
  for (const row of rows.slice(0, MAX_LISTINGS)) {
    let next = { ...row };
    if (!validInvestorCoord(next.lat, next.lon) && next.address) {
      const geo = await geocodeListing(next.address, office);
      if (geo) {
        next.lat = geo.lat;
        next.lon = geo.lon;
      }
    }
    if (!validInvestorCoord(next.lat, next.lon) || !inOklahoma(next.lat, next.lon)) continue;
    if (validInvestorCoord(office.lat, office.lon) && metersBetween(office, next) < 90) continue;
    located.push(normalizeListing(next));
  }
  return located.slice(0, MAX_LISTINGS);
}

/** Fill missing phone/email and, for a selected star, the agent's actual sale homes. */
export async function enrichInvestorFromPublic(inv, { deep = false, osmHits = [] } = {}) {
  if (!inv) return null;
  const listingsP =
    String(inv.kind) === "realestate" && deep && investorListings(inv).length < 2
      ? fetchInvestorListings(inv).catch(() => [])
      : Promise.resolve(investorListings(inv));
  const [contacts, found] = await Promise.all([
    enrichInvestorContacts(inv, { deep, osmHits }).catch(() => null),
    listingsP,
  ]);
  let listings = investorListings(inv);
  if (Array.isArray(found) && found.length) listings = found;
  const extra = { ...(contacts || {}), listings };
  const next = mergeInvestorPublic(inv, extra);
  const betterContact = (next.phone && next.phone !== inv.phone) || (next.email && next.email !== inv.email);
  const betterList = investorListings(next).length > investorListings(inv).length;
  if (!betterContact && !betterList && !(next.website && !inv.website)) {
    if (investorHasContact(inv) && String(inv.kind) !== "realestate") return null;
    if (String(inv.kind) === "realestate" && investorListings(inv).length) return null;
  }
  return next;
}
