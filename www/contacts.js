/** High-confidence listing for a pinned house — OSM/Nominatim at this address only. */
import { httpGet, overpassJson } from "./net.js";
import { flagNetProfile, listingBrowserHeaders } from "./device.js";
import { OK_RENT_CITY_ROWS } from "./ok-rent-cities.js";

const NOM_UA = { "User-Agent": "GroundControl/1.0 (joshuagwatts)", "Accept-Language": "en" };
const RENT_STORE_KEY = "hs-rent-flags-v1";
const RENT_STORE_MAX = 2800;
const US_STATES = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", "district of columbia": "dc",
  florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in",
  iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms", missouri: "mo",
  montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh", "new jersey": "nj",
  "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd",
  ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri",
  "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut",
  vermont: "vt", virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy",
};

const SKIP_HOST =
  /duckduckgo|google\.|bing\.com|yahoo\.com|zillow|realtor\.com|redfin|facebook\.com|instagram|twitter\.com|x\.com|linkedin|youtube|tiktok|wikipedia\.org|census\.gov/i;
const JUNK_MAIL =
  /example\.com$|noreply|no-reply|privacy@|support@duckduckgo|sentry\.io$|wixpress|godaddy|wordpress\.com$|png$|jpg$|gif$/i;

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function formatZillowUrl(address) {
  const p = parseStreetAddress(address);
  const coordOnly = /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(String(address || "").trim());
  if (coordOnly || !p.house) return "";
  const streetSlug = String(p.street || "")
    .replace(/\./g, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "");
  const citySlug = String(p.city || "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "");
  const state = p.state ? String(p.state).toUpperCase() : "";
  const slug = [p.house, streetSlug, citySlug, state, p.zip].filter(Boolean).join("-").replace(/-+/g, "-");
  return slug ? `https://www.zillow.com/homes/${slug}_rb/` : "";
}

/** True when the URL targets a specific property, not the Zillow home page. */
export function isUsableZillowUrl(url) {
  const u = String(url || "").trim();
  if (!u || /^https?:\/\/(www\.)?zillow\.com\/?$/i.test(u)) return false;
  if (/zillow\.com\/homedetails\//i.test(u)) return true;
  if (/zillow\.com\/homes\/for_rent\//i.test(u)) return true;
  if (/zillow\.com\/(?:apartments|b)\//i.test(u)) return true;
  if (/zillow\.com\/homes\/[^/?#]+_rb\/?$/i.test(u)) return true;
  return /zillow\.com\/homes\/\d+[A-Za-z]?-/i.test(u);
}

/** Prefer a scraped homedetails link; otherwise build from a street address. */
export function resolveZillowUrl(address, existing = "") {
  const ex = String(existing || "").trim();
  if (isUsableZillowUrl(ex)) return ex;
  const built = formatZillowUrl(address);
  return built || "";
}

/** Zillow For Rent search URL for a street address. */
export function formatZillowRentUrl(address) {
  const sale = formatZillowUrl(address);
  if (!sale) return "";
  return sale.replace("/homes/", "/homes/for_rent/");
}

/** True when address is in Oklahoma (phone-book lookups are OK-only). */
export function isOklahomaAddress(address, parts = null) {
  const p = parts && typeof parts === "object" ? parts : parseStreetAddress(address);
  if (stateAbbr(p.state) === "ok") return true;
  return /\bOK\b|\bOklahoma\b/i.test(String(address || ""));
}

function addressPathSlug(parts) {
  const streetSlug = String(parts.street || "")
    .replace(/\./g, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "");
  const citySlug = String(parts.city || "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "");
  return {
    street: [parts.house, streetSlug].filter(Boolean).join("-").replace(/-+/g, "-"),
    cityState: [citySlug, "OK"].filter(Boolean).join("-").replace(/-+/g, "-"),
    zip: String(parts.zip || "").trim(),
  };
}

/** Pull phones embedded in Zillow page JSON (rent / sale contact cards). */
function extractZillowEmbeddedPhones(html) {
  const out = [];
  const re =
    /"(?:phoneNumber|contactPhone|businessPhone|agentPhoneNumber|phone)"\s*:\s*"([^"]{7,40})"/gi;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 8) {
    if (isJunkPhone(m[1])) continue;
    const d = phoneDigits(m[1]);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Only skip empty / hard HTTP walls — native fetches get real listing HTML; ignore captcha-word false positives. */
function isEmptyOrHardBlock(html) {
  const h = String(html || "");
  if (h.length < 400) return true;
  const head = h.slice(0, 2500);
  if (/<title[^>]*>\s*(access denied|attention required|just a moment)\s*</i.test(head) && h.length < 8000) return true;
  return false;
}

async function zillowListingContacts(address, parts) {
  const url = formatZillowUrl(address);
  if (!url || !parts?.house) return null;
  const page = await fetchHtml(url, 14000);
  if (!page?.html || isEmptyOrHardBlock(page.html)) return null;
  let html = page.html;
  let detailUrl = page.url || url;
  const rel =
    html.match(/href="(\/homedetails\/[^"]+?\/[^"]+_zpid\/[^"]*)"/i) ||
    html.match(/href="(\/homedetails\/[^"]+_zpid\/[^"]*)"/i);
  const abs = html.match(/https:\/\/www\.zillow\.com\/homedetails\/[^"'\s]+_zpid\/[^"'\s]*/i);
  if (rel?.[1]) detailUrl = `https://www.zillow.com${rel[1]}`;
  else if (abs?.[0]) detailUrl = abs[0];
  if (detailUrl !== url && detailUrl.includes("homedetails")) {
    const detail = await fetchHtml(detailUrl, 14000);
    if (detail?.html) html = detail.html;
  }
  const contacts = extractContactsFromHtml(html.slice(0, 220000), parts, { requireAddress: false });
  const embedded = extractZillowEmbeddedPhones(html);
  let phone = contacts?.phone || "";
  if (!phone && embedded[0]) phone = formatPhone(embedded[0]);
  const zillow_url = detailUrl.includes("homedetails") ? detailUrl : "";
  const _public_text = publicTextFromHtml(html);
  const base =
    contacts || phone || zillow_url
      ? { ...(contacts || {}), phone: phone || contacts?.phone || "", zillow_url }
      : null;
  return base ? { ...base, _public_text } : _public_text ? { _public_text } : null;
}

/**
 * Zillow For Rent — landlord / leasing phone on the rental listing for this house.
 * Green map labels use these phones the same as sale-listing contacts.
 */
async function zillowRentContacts(address, parts) {
  const url = formatZillowRentUrl(address);
  if (!url || !parts?.house) return null;
  const page = await fetchHtml(url, 14000);
  if (!page?.html || isEmptyOrHardBlock(page.html)) return null;
  let html = page.html;
  let detailUrl = page.url || url;
  // Prefer a specific rental homedetails / apartment card when the search page lists one.
  const rentRel =
    html.match(/href="(\/homedetails\/[^"]+?\/[^"]+_zpid\/[^"]*)"/i) ||
    html.match(/href="(\/b\/[^"]+?\/\d+_bpid\/[^"]*)"/i) ||
    html.match(/href="(\/apartments\/[^"]+?\/\d+_zpid\/[^"]*)"/i);
  const rentAbs = html.match(
    /https:\/\/www\.zillow\.com\/(?:homedetails|apartments|b)\/[^"'\s]+/i,
  );
  if (rentRel?.[1]) detailUrl = `https://www.zillow.com${rentRel[1]}`;
  else if (rentAbs?.[0]) detailUrl = rentAbs[0];
  if (detailUrl !== (page.url || url)) {
    const detail = await fetchHtml(detailUrl, 14000);
    if (detail?.html) html = detail.html;
  }
  // Rent pages often omit the full street in the contact card — still require house #.
  const contacts = extractContactsFromHtml(html.slice(0, 240000), parts, { requireAddress: false });
  const embedded = extractZillowEmbeddedPhones(html);
  let phone = contacts?.phone || "";
  if (!phone && embedded[0]) phone = formatPhone(embedded[0]);
  if (!phone) {
    const tel = String(html).match(/tel:(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i);
    if (tel && !isJunkPhone(tel[1])) phone = formatPhone(tel[1]);
  }
  if (!phone && !contacts?.email && !contacts?.name) {
    const text = publicTextFromHtml(html);
    return text ? { _public_text: text, zillow_rent: true } : null;
  }
  return {
    ...(contacts || {}),
    phone: phone || contacts?.phone || "",
    zillow_url: /homedetails|apartments|_bpid|_zpid/i.test(detailUrl) ? detailUrl : "",
    zillow_rent: true,
    source: "zillow-rent",
    _public_text: publicTextFromHtml(html),
  };
}

/**
 * Oklahoma-only modern phone book: address → listed phone (411 / Whitepages address pages).
 * Address-keyed directory only — not people-search profile pages.
 */
async function oklahomaPhoneBookContacts(address, parts) {
  if (!parts?.house || !isOklahomaAddress(address, parts)) return null;
  const city = String(parts.city || "").trim();
  if (!city) return null;
  const slug = addressPathSlug({ ...parts, state: "ok" });
  if (!slug.street) return null;
  const urls = [
    `https://www.411.com/address/${slug.street}/${slug.cityState}${slug.zip ? `/${slug.zip}` : ""}`,
    `https://www.whitepages.com/address/${slug.street}/${slug.cityState}${slug.zip ? `/${slug.zip}` : ""}`,
    `https://www.anywho.com/people/${slug.street}/${slug.cityState}${slug.zip ? `/${slug.zip}` : ""}`,
  ];
  for (const url of urls) {
    const page = await fetchHtml(url, 12000);
    if (!page?.html || isEmptyOrHardBlock(page.html)) continue;
    // Must mention this house number so we don't take a random neighbor listing.
    const contacts = extractContactsFromHtml(page.html.slice(0, 200000), parts, { requireAddress: true });
    if (contacts?.phone && !isJunkPhone(contacts.phone)) {
      return {
        ...contacts,
        phone: contacts.phone,
        source: "ok-phonebook",
        _public_text: publicTextFromHtml(page.html),
      };
    }
    // Fallback: first non-junk tel: on an address page that includes the house #.
    if (pageMentionsAddress(page.html, parts)) {
      const tels = extractPhones(page.html);
      for (const d of tels) {
        if (isJunkPhone(d)) continue;
        return {
          phone: formatPhone(d),
          source: "ok-phonebook",
          _public_text: publicTextFromHtml(page.html),
        };
      }
    }
  }
  return null;
}

function cityPathSlug(city) {
  return String(city || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** apartments.com address / city search for this street. */
export function formatApartmentsComSearchUrl(address) {
  const p = parseStreetAddress(address);
  if (!p.house || !p.street) return "";
  const streetSlug = String(p.street || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const city = cityPathSlug(p.city || "edmond");
  const state = String(p.state || "ok").toLowerCase();
  const slug = [p.house, streetSlug, city, state, p.zip].filter(Boolean).join("-").replace(/-+/g, "-");
  return `https://www.apartments.com/${slug}/`;
}

export function formatRealtorRentSearchUrl(address) {
  const p = parseStreetAddress(address);
  if (!p.house || !p.street) return "";
  const city = cityPathSlug(p.city || "edmond");
  const street = String(p.street || "")
    .replace(/\./g, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "");
  return `https://www.realtor.com/apartments/${city}_ok/${p.house}-${street}`;
}

/** apartments.com city search (`edmond-ok/` or `edmond-ok/2/`). */
export function formatApartmentsComCityUrl(city, state, { page = 1 } = {}) {
  const c = cityPathSlug(city);
  const st = stateAbbr(state) || cityPathSlug(state);
  if (!c || !st) return "";
  const base = `https://www.apartments.com/${c}-${st}/`;
  return page > 1 ? `https://www.apartments.com/${c}-${st}/${page}/` : base;
}

/**
 * Pull placards from apartments.com city HTML (window.startup / legacy __APARTMENTS_DATA__ / JSON-LD).
 */
export function parseApartmentsComSearchHtml(html) {
  const h = String(html || "");
  if (!h) return [];
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const key = `${phoneDigits(raw.phone)}|${Number(raw.lat).toFixed(5)}|${Number(raw.lon).toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(raw);
  };

  const fromPlacard = (p) => {
    if (!p || typeof p !== "object") return null;
    const geo = p.geography || p.location || p.coordinates || {};
    const addr = p.addressInfo || p.address || p.location || {};
    const street =
      addr.address ||
      addr.streetAddress ||
      addr.fullAddress ||
      addr.line1 ||
      p.streetAddress ||
      "";
    const phone = listingPhoneFromRaw(
      p.phone,
      p.listingPhone,
      p.phoneNumber,
      p.contactPhone,
      ...(Array.isArray(p.phones) ? p.phones : []),
      ...(Array.isArray(p.phoneNumbers) ? p.phoneNumbers : []),
    );
    const path = String(p.url || p.listingUrl || p.canonicalUrl || p.detailUrl || "").trim();
    const listingUrl = path
      ? path.startsWith("http")
        ? path
        : `https://www.apartments.com${path.startsWith("/") ? "" : "/"}${path}`
      : "";
    return rentFlagRow({
      name: p.propertyName || p.name || p.buildingName || "",
      street,
      city: addr.city || p.city || "",
      state: addr.state || addr.stateCode || p.state || "",
      zip: addr.zip || addr.postalCode || p.zip || "",
      lat: geo.latitude ?? geo.lat ?? p.latitude ?? p.lat,
      lon: geo.longitude ?? geo.lng ?? geo.lon ?? p.longitude ?? p.lng,
      phone,
      listingUrl,
      source: "apartments",
    });
  };

  const tryPlacards = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) push(fromPlacard(p));
  };

  const extractBalancedObject = (src, fromIdx) => {
    if (src[fromIdx] !== "{") return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = fromIdx; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(fromIdx, i + 1);
      }
    }
    return null;
  };

  // Embedded startup blob(s) — brace-match so nested placards survive.
  const assignRe = /window\.(?:startup|__APARTMENTS_DATA__)\s*=\s*\{/gi;
  let am;
  while ((am = assignRe.exec(h))) {
    const json = extractBalancedObject(h, am.index + am[0].length - 1);
    if (!json) continue;
    try {
      const data = JSON.parse(json);
      tryPlacards(data?.listing?.placards);
      tryPlacards(data?.placards);
      tryPlacards(data?.listing?.map?.pins);
      tryPlacards(data?.map?.pins);
    } catch {
      /* ignore */
    }
  }

  // Loose placards array if the window assign was truncated.
  if (!out.length) {
    const looseIdx = h.indexOf('"placards"');
    if (looseIdx >= 0) {
      const arrStart = h.indexOf("[", looseIdx);
      if (arrStart >= 0) {
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = arrStart; i < h.length; i++) {
          const ch = h[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') {
            inStr = true;
            continue;
          }
          if (ch === "[") depth += 1;
          else if (ch === "]") {
            depth -= 1;
            if (depth === 0) {
              try {
                tryPlacards(JSON.parse(h.slice(arrStart, i + 1)));
              } catch {
                /* ignore */
              }
              break;
            }
          }
        }
      }
    }
  }

  // JSON-LD ApartmentComplex nodes (coords; phone when present).
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(h))) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = Array.isArray(data) ? data : data?.["@graph"] ? data["@graph"] : [data];
      for (const n of nodes) {
        const entity = n?.mainEntity && typeof n.mainEntity === "object" ? n.mainEntity : n;
        const types = [].concat(entity?.["@type"] || n?.["@type"] || []).map(String);
        if (!types.some((t) => /ApartmentComplex|Residence|Place/i.test(t))) continue;
        const geo = entity?.geo || n?.geo || {};
        const addr = entity?.address || n?.address || {};
        const id = String(entity?.["@id"] || n?.["@id"] || entity?.url || n?.url || "").replace(/#.*$/, "");
        push(
          rentFlagRow({
            name: entity?.name || n?.name || "",
            street: addr.streetAddress || "",
            city: addr.addressLocality || "",
            state: addr.addressRegion || "",
            zip: addr.postalCode || "",
            lat: geo.latitude,
            lon: geo.longitude,
            phone: listingPhoneFromRaw(entity?.telephone, n?.telephone),
            listingUrl: id.startsWith("http") ? id : "",
            source: "apartments",
          }),
        );
      }
    } catch {
      /* ignore */
    }
  }

  // Placard cards: tel: + nearby lat/lng in data attrs or JSON crumbs.
  if (!out.length) {
    const cardRe =
      /data-latitude=["']?(-?\d+\.\d+)["']?[^>]{0,400}data-longitude=["']?(-?\d+\.\d+)["']?[\s\S]{0,1200}?tel:(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/gi;
    while ((m = cardRe.exec(h))) {
      push(
        rentFlagRow({
          name: "",
          street: "",
          city: "",
          state: "",
          zip: "",
          lat: m[1],
          lon: m[2],
          phone: m[3],
          listingUrl: "",
          source: "apartments",
        }),
      );
    }
  }

  return out;
}

/** Full state name slug for Rent.com paths (`OK` → `oklahoma`). */
export function statePathSlug(state) {
  const abbr = stateAbbr(state);
  if (!abbr) return cityPathSlug(state);
  const hit = Object.entries(US_STATES).find(([, code]) => code === abbr);
  return hit ? hit[0].replace(/\s+/g, "-") : abbr;
}

/** Zillow city For Rent search (`edmond-ok/rentals`). */
export function formatZillowCityRentUrl(city, state) {
  const c = cityPathSlug(city);
  const st = stateAbbr(state) || cityPathSlug(state);
  if (!c || !st) return "";
  return `https://www.zillow.com/${c}-${st}/rentals/`;
}

/**
 * Rent.com city search. `kind` is apartments | houses.
 * Homes-for-rent pages carry leasing phones in __NEXT_DATA__.
 */
export function formatRentComCityUrl(city, state, { kind = "apartments", page = 1 } = {}) {
  const c = cityPathSlug(city);
  const st = statePathSlug(state);
  if (!c || !st) return "";
  const type = kind === "houses" ? "houses" : "apartments";
  const base = `https://www.rent.com/${st}/${c}-${type}`;
  return page > 1 ? `${base}?page=${page}` : base;
}

export function extractNextDataJson(html) {
  const m = String(html || "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function listingPhoneFromRaw(...raws) {
  for (const raw of raws) {
    const s = String(raw || "").trim();
    if (!s || isJunkPhone(s)) continue;
    const pretty = formatPhone(s);
    if (pretty) return pretty;
  }
  return "";
}

function rentFlagRow({ name, street, city, state, zip, lat, lon, phone, listingUrl, source }) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!phone || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return {
    name: String(name || "").trim(),
    street: String(street || "").trim(),
    city: String(city || "").trim(),
    state: String(state || "").trim(),
    zip: String(zip || "").trim(),
    lat: la,
    lon: lo,
    phone,
    listingUrl: String(listingUrl || "").trim(),
    source,
    phone_kind: "rental",
    zillow_rent: source === "zillow-rent",
  };
}

/** Rent.com city search — listings include lat/lng + leasing phones. */
export function parseRentComSearchJson(html) {
  const data = extractNextDataJson(html);
  const listings = data?.props?.pageProps?.pageData?.location?.listingSearch?.listings;
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(listings) ? listings : []) {
    const loc = row?.location || {};
    const path = String(row?.urlPathname || row?.url || "").trim();
    const listingUrl = path
      ? path.startsWith("http")
        ? path
        : `https://www.rent.com${path.startsWith("/") ? "" : "/"}${path}`
      : "";
    const hit = rentFlagRow({
      name: row?.name || "",
      street: row?.address || row?.addressFull || "",
      city: loc.city || "",
      state: loc.stateAbbr || loc.state || "",
      zip: loc.zip || "",
      lat: loc.lat,
      lon: loc.lng,
      phone: listingPhoneFromRaw(
        row?.phoneMobile,
        row?.phoneDesktop,
        row?.phoneMobileText,
        row?.phoneDesktopText,
        row?.mitsPhone?.raw,
        row?.mitsPhone?.formatted,
      ),
      listingUrl,
      source: "rent-com",
    });
    if (!hit) continue;
    const key = `${phoneDigits(hit.phone)}|${hit.lat.toFixed(5)}|${hit.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** Zillow city rentals — coords + detail URL; phones live on the detail page. */
export function parseZillowRentSearchJson(html) {
  const data = extractNextDataJson(html);
  const listings = data?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;
  const out = [];
  for (const row of Array.isArray(listings) ? listings : []) {
    const ll = row?.latLong || {};
    const status = String(row?.statusType || row?.statusText || "");
    if (status && !/FOR_RENT|for\s*rent/i.test(status)) continue;
    const path = String(row?.detailUrl || "").trim();
    const listingUrl = path
      ? path.startsWith("http")
        ? path
        : `https://www.zillow.com${path.startsWith("/") ? "" : "/"}${path}`
      : "";
    const hit = rentFlagRow({
      name: row?.buildingName || "",
      street: row?.addressStreet || row?.address || "",
      city: row?.addressCity || "",
      state: row?.addressState || "",
      zip: row?.addressZipcode || "",
      lat: ll.latitude,
      lon: ll.longitude,
      phone: listingPhoneFromRaw(row?.brokerPhoneNumber, row?.phone, row?.phoneNumber),
      listingUrl,
      source: "zillow-rent",
    });
    if (!hit && Number.isFinite(Number(ll.latitude)) && Number.isFinite(Number(ll.longitude)) && listingUrl) {
      out.push({
        name: String(row?.buildingName || "").trim(),
        street: String(row?.addressStreet || row?.address || "").trim(),
        city: String(row?.addressCity || "").trim(),
        state: String(row?.addressState || "").trim(),
        zip: String(row?.addressZipcode || "").trim(),
        lat: Number(ll.latitude),
        lon: Number(ll.longitude),
        phone: "",
        listingUrl,
        source: "zillow-rent",
        phone_kind: "rental",
        zillow_rent: true,
      });
      continue;
    }
    if (hit) out.push(hit);
  }
  return out;
}

export function parseZillowRentDetailPhone(html) {
  const h = String(html || "");
  if (!h) return "";
  if (isEmptyOrHardBlock(h) && !/tel:/i.test(h)) return "";
  const embedded = extractZillowEmbeddedPhones(h);
  if (embedded[0]) return formatPhone(embedded[0]);
  const tel = h.match(/tel:(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i);
  if (tel && !isJunkPhone(tel[1])) return formatPhone(tel[1]);
  return "";
}

/** All Oklahoma municipalities (pop ≥ 1000) — generated list + sweep progress for statewide Flags. */
const rentFlagCache = new Map();
const rentCityCache = new Map();
let rentSweepInFlight = null;
let rentSweepEpoch = 0;

const RENT_CITY_SWEPT_KEY = "hs-rent-cities-swept-v1";

function loadSweptRentCities() {
  try {
    if (typeof localStorage === "undefined") return {};
    const j = JSON.parse(localStorage.getItem(RENT_CITY_SWEPT_KEY) || "null");
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function saveSweptRentCities(map) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(RENT_CITY_SWEPT_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

function markRentCitiesSwept(names, at = Date.now()) {
  const cur = loadSweptRentCities();
  for (const n of names || []) {
    const k = cityPathSlug(n);
    if (k) cur[k] = at;
  }
  saveSweptRentCities(cur);
}

function clearSweptRentCitiesNear(lat, lon, km = 45) {
  const cur = loadSweptRentCities();
  let changed = false;
  for (const row of OK_RENT_CITY_ROWS) {
    if (haversineKm(lat, lon, row.lat, row.lon) > km) continue;
    const k = cityPathSlug(row.name);
    if (k && cur[k]) {
      delete cur[k];
      changed = true;
    }
  }
  if (changed) saveSweptRentCities(cur);
}

function rentCityNeedsSweep(name, swept, now = Date.now()) {
  const at = Number(swept[cityPathSlug(name)]) || 0;
  return !at || now - at > RENT_SWEEP_FRESH_MS;
}

export function loadPersistedRentFlags() {
  try {
    if (typeof localStorage === "undefined") return [];
    const j = JSON.parse(localStorage.getItem(RENT_STORE_KEY) || "null");
    if (!j || !Array.isArray(j.flags)) return [];
    return j.flags.filter((r) => r?.phone && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));
  } catch {
    return [];
  }
}

export function persistedRentFlagsAt() {
  try {
    if (typeof localStorage === "undefined") return 0;
    const j = JSON.parse(localStorage.getItem(RENT_STORE_KEY) || "null");
    return Number(j?.at) || 0;
  } catch {
    return 0;
  }
}

export function persistRentFlags(rows) {
  try {
    if (typeof localStorage === "undefined") return;
    const merged = mergeRentFlagList(loadPersistedRentFlags(), rows).slice(0, RENT_STORE_MAX);
    localStorage.setItem(RENT_STORE_KEY, JSON.stringify({ at: Date.now(), flags: merged }));
  } catch {
    /* quota / private mode */
  }
}

export function citiesNearPoint(lat, lon) {
  return OK_RENT_CITY_ROWS.slice()
    .sort((a, b) => {
      const da = haversineKm(lat, lon, a.lat, a.lon);
      const db = haversineKm(lat, lon, b.lat, b.lon);
      // Distance wins. Pop is only a tiny tie-break — a 6 km pop bias was
      // promoting Oklahoma City over nearer suburbs (Edmond / Moore / Yukon).
      if (Math.abs(da - db) < 0.8) return (b.pop || 0) - (a.pop || 0);
      return da - db;
    })
    .map((r) => r.name);
}

export function isOklahomaLatLon(lat, lon) {
  return Number(lat) >= 33.6 && Number(lat) <= 37.05 && Number(lon) >= -103.05 && Number(lon) <= -94.4;
}

/** Nearest Oklahoma municipality — panhandle / west OK never forced to OKC. */
export function inferOkCity(lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return "";
  if (!isOklahomaLatLon(lat, lon)) return "";
  return citiesNearPoint(lat, lon)[0] || "Oklahoma City";
}

export function mergeRentFlagList(into, rows) {
  const out = Array.isArray(into) ? into.slice() : [];
  const seen = new Set(
    out.map((r) => `${phoneDigits(r.phone)}|${Number(r.lat).toFixed(4)}|${Number(r.lon).toFixed(4)}`),
  );
  for (const r of rows || []) {
    if (!r?.phone || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const key = `${phoneDigits(r.phone)}|${r.lat.toFixed(4)}|${r.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function fetchRentComCityPages(city, state, { kinds = ["apartments", "houses"], pages = 2 } = {}) {
  const cacheKey = `${cityPathSlug(city)}|${statePathSlug(state)}|${kinds.join(",")}|${pages}`;
  if (rentCityCache.has(cacheKey)) return rentCityCache.get(cacheKey);
  const work = (async () => {
    const acc = [];
    for (const kind of kinds) {
      for (let page = 1; page <= pages; page++) {
        const url = formatRentComCityUrl(city, state, { kind, page });
        if (!url) break;
        if (rentFlagCache.has(url)) {
          acc.push(...rentFlagCache.get(url));
          if ((rentFlagCache.get(url) || []).length < 20) break;
          continue;
        }
        const pageHit = await fetchHtml(url, 16000, listingBrowserHeaders());
        const list = parseRentComSearchJson(pageHit?.html || "");
        rentFlagCache.set(url, list);
        acc.push(...list);
        if (list.length < 20) break;
      }
    }
    return mergeRentFlagList([], acc);
  })();
  rentCityCache.set(cacheKey, work);
  try {
    const rows = await work;
    rentCityCache.set(cacheKey, Promise.resolve(rows));
    return rows;
  } catch {
    rentCityCache.delete(cacheKey);
    return [];
  }
}

async function fetchApartmentsComCityPages(city, state, { pages = 1 } = {}) {
  const cacheKey = `apts|${cityPathSlug(city)}|${stateAbbr(state) || cityPathSlug(state)}|${pages}`;
  if (rentCityCache.has(cacheKey)) return rentCityCache.get(cacheKey);
  const work = (async () => {
    const acc = [];
    for (let page = 1; page <= pages; page++) {
      const url = formatApartmentsComCityUrl(city, state, { page });
      if (!url) break;
      if (rentFlagCache.has(url)) {
        acc.push(...rentFlagCache.get(url));
        if ((rentFlagCache.get(url) || []).length < 12) break;
        continue;
      }
      const pageHit = await fetchHtml(url, 16000, listingBrowserHeaders());
      const list = parseApartmentsComSearchHtml(pageHit?.html || "");
      rentFlagCache.set(url, list);
      acc.push(...list);
      if (list.length < 12) break;
    }
    return mergeRentFlagList([], acc);
  })();
  rentCityCache.set(cacheKey, work);
  try {
    const rows = await work;
    rentCityCache.set(cacheKey, Promise.resolve(rows));
    return rows;
  } catch {
    rentCityCache.delete(cacheKey);
    return [];
  }
}

async function fetchZillowCityRentPhones(
  city,
  state,
  { lat, lon, have = [], maxDetails = 6, bounds = null, onPartial = null } = {},
) {
  const url = formatZillowCityRentUrl(city, state);
  if (!url) return [];
  const page = await fetchHtml(url, 12000, listingBrowserHeaders({ zillow: true }));
  const found = parseZillowRentSearchJson(page?.html || "");
  const inArea = (r) => {
    if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) return false;
    if (bounds) {
      const pad = 12;
      const midLat = (Number(bounds.south) + Number(bounds.north)) / 2;
      const dLat = pad / 111.32;
      const dLon = pad / (111.32 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
      return (
        r.lat >= Number(bounds.south) - dLat &&
        r.lat <= Number(bounds.north) + dLat &&
        r.lon >= Number(bounds.west) - dLon &&
        r.lon <= Number(bounds.east) + dLon
      );
    }
    return haversineKm(lat, lon, r.lat, r.lon) <= 30;
  };
  const local = found.filter(inArea);
  const pool = local.length ? local : found;
  const withPhone = pool.filter((r) => r.phone);
  if (typeof onPartial === "function" && withPhone.length) onPartial(withPhone);

  const needPhone = pool
    .filter((r) => !r.phone && r.listingUrl)
    .filter((r) => !have.some((h) => haversineKm(h.lat, h.lon, r.lat, r.lon) < 0.08))
    .sort((a, b) => haversineKm(lat, lon, a.lat, a.lon) - haversineKm(lat, lon, b.lat, b.lon))
    .slice(0, Math.max(maxDetails, 12));

  // All detail pages in parallel — chunking made 9 Zillow hits take forever.
  const got = await Promise.all(
    needPhone.map(async (row) => {
      const deep = await fetchHtml(row.listingUrl, 9000, listingBrowserHeaders({ zillow: true })).catch(() => null);
      const phone = parseZillowRentDetailPhone(deep?.html || "");
      if (!phone) return null;
      return { ...row, phone, phone_kind: "rental", zillow_rent: true, source: "zillow-rent" };
    }),
  );
  const details = got.filter(Boolean);
  if (typeof onPartial === "function" && details.length) onPartial(details);
  return mergeRentFlagList(withPhone, details);
}

function rentFlagsNearPoint(rows, lat, lon, km = 28) {
  return (rows || []).filter(
    (r) =>
      r?.phone &&
      Number.isFinite(Number(r.lat)) &&
      Number.isFinite(Number(r.lon)) &&
      haversineKm(lat, lon, Number(r.lat), Number(r.lon)) <= km,
  );
}

function rentFlagsInBounds(rows, bounds, padKm = 12) {
  if (!bounds) return Array.isArray(rows) ? rows.filter((r) => r?.phone) : [];
  const south = Number(bounds.south);
  const west = Number(bounds.west);
  const north = Number(bounds.north);
  const east = Number(bounds.east);
  if (![south, west, north, east].every(Number.isFinite)) {
    return Array.isArray(rows) ? rows.filter((r) => r?.phone) : [];
  }
  const midLat = (south + north) / 2;
  const dLat = padKm / 111.32;
  const dLon = padKm / (111.32 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  const s = south - dLat;
  const n = north + dLat;
  const w = west - dLon;
  const e = east + dLon;
  return (rows || []).filter(
    (r) =>
      r?.phone &&
      Number.isFinite(Number(r.lat)) &&
      Number.isFinite(Number(r.lon)) &&
      Number(r.lat) >= s &&
      Number(r.lat) <= n &&
      Number(r.lon) >= w &&
      Number(r.lon) <= e,
  );
}

function isOklahomaCityName(name) {
  return /^(oklahoma\s*city|okc)$/i.test(String(name || "").trim());
}

/** Cities whose centers fall in (or just beside) the visible map frame. */
export function citiesInMapBounds(bounds, { lat, lon, limit = 5 } = {}) {
  const south = Number(bounds?.south);
  const west = Number(bounds?.west);
  const north = Number(bounds?.north);
  const east = Number(bounds?.east);
  const hasB = [south, west, north, east].every(Number.isFinite);
  const clat = Number(lat);
  const clon = Number(lon);
  const hasC = Number.isFinite(clat) && Number.isFinite(clon);
  if (!hasB && !hasC) return [];

  const padKm = 10;
  const midLat = hasB ? (south + north) / 2 : clat;
  const dLat = padKm / 111.32;
  const dLon = padKm / (111.32 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  const s = hasB ? south - dLat : clat - dLat;
  const n = hasB ? north + dLat : clat + dLat;
  const w = hasB ? west - dLon : clon - dLon;
  const e = hasB ? east + dLon : clon + dLon;

  let inView = OK_RENT_CITY_ROWS.filter((r) => r.lat >= s && r.lat <= n && r.lon >= w && r.lon <= e);
  if (!inView.length && hasC) {
    inView = OK_RENT_CITY_ROWS.slice()
      .sort((a, b) => haversineKm(clat, clon, a.lat, a.lon) - haversineKm(clat, clon, b.lat, b.lon))
      .slice(0, 2);
  } else if (hasC) {
    inView = inView
      .slice()
      .sort((a, b) => haversineKm(clat, clon, a.lat, a.lon) - haversineKm(clat, clon, b.lat, b.lon));
  }
  const names = [];
  for (const row of inView) {
    if (names.length >= limit) break;
    if (names.some((x) => cityPathSlug(x) === cityPathSlug(row.name))) continue;
    names.push(row.name);
  }
  return names;
}

/**
 * Map-view Flags: Rent.com + apartments.com + Zillow for towns in the frame.
 * Rent/apts paint first; Zillow detail phones stream in without blocking.
 */
const RENT_SWEEP_FRESH_MS = 25 * 60 * 1000;

export async function lookupViewportRentFlags(lat, lon, opts = {}) {
  const onBatch = typeof opts.onBatch === "function" ? opts.onBatch : null;
  const force = opts.force === true;
  const retarget = opts.retarget === true;
  const viewportOnly = opts.viewportOnly !== false;
  const bounds = opts.bounds && typeof opts.bounds === "object" ? opts.bounds : null;
  const ordered = citiesInMapBounds(bounds, { lat, lon, limit: 4 });
  const fallbackOrdered =
    !ordered.length && (isOklahomaLatLon(lat, lon) || stateAbbr(opts.state || "") === "ok")
      ? citiesNearPoint(lat, lon).slice(0, 2)
      : [];
  const viewCities = ordered.length ? ordered : fallbackOrdered;
  const city = String(opts.city || viewCities[0] || inferOkCity(lat, lon) || "").trim();
  const state = String(opts.state || (isOklahomaLatLon(lat, lon) ? "OK" : "")).trim();
  const inOk = isOklahomaLatLon(lat, lon) || stateAbbr(state) === "ok";
  const profile = flagNetProfile();
  let acc = [];
  let persistTimer = 0;
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persistRentFlags(acc);
    }, 400);
  };
  const paintRows = (rows) => {
    if (!onBatch) return;
    // Wide pad so a tight zoom still keeps the town's listings.
    if (bounds) onBatch(rentFlagsInBounds(rows, bounds, 14));
    else onBatch(rentFlagsNearPoint(rows, lat, lon, 28));
  };
  const emitView = (rows) => {
    if (!rows?.length) return;
    acc = mergeRentFlagList(acc, rows);
    schedulePersist();
    paintRows(acc);
  };

  const cached = loadPersistedRentFlags();
  if (cached.length) {
    acc = mergeRentFlagList(acc, cached);
    paintRows(cached);
  }

  if ((force || retarget) && rentSweepInFlight) {
    rentSweepEpoch += 1;
    rentSweepInFlight = null;
  } else if (rentSweepInFlight) {
    return rentSweepInFlight.then(() => acc);
  }

  if (force) {
    // Keep rentFlagCache (parsed HTML) so revisiting a town is instant.
    rentCityCache.clear();
    if (inOk) clearSweptRentCitiesNear(lat, lon, 40);
  }

  const epoch = rentSweepEpoch;
  const work = (async () => {
    if (epoch !== rentSweepEpoch) return acc;

    const primary = city || viewCities[0] || "";
    const rest = viewCities.filter((c) => cityPathSlug(c) !== cityPathSlug(primary));
    const fastCities = [primary, ...rest]
      .filter(Boolean)
      .filter((c, i, arr) => arr.findIndex((x) => cityPathSlug(x) === cityPathSlug(c)) === i)
      .filter((c) => {
        if (!isOklahomaCityName(c)) return true;
        if (isOklahomaCityName(primary)) return true;
        if (!bounds) return false;
        const okc = OK_RENT_CITY_ROWS.find((r) => isOklahomaCityName(r.name));
        if (!okc) return false;
        return (
          okc.lat >= Number(bounds.south) &&
          okc.lat <= Number(bounds.north) &&
          okc.lon >= Number(bounds.west) &&
          okc.lon <= Number(bounds.east)
        );
      })
      .slice(0, 3);

    const fetchRentApts = async (c) => {
      const [rentRows, aptRows] = await Promise.all([
        fetchRentComCityPages(c, state || "OK", { kinds: ["apartments", "houses"], pages: 1 }).catch(() => []),
        fetchApartmentsComCityPages(c, state || "OK", { pages: 1 }).catch(() => []),
      ]);
      return mergeRentFlagList(rentRows, aptRows);
    };

    // 1) Rent.com + apartments.com for EVERY view city in parallel — paint ASAP.
    await Promise.all(
      fastCities.map(async (c) => {
        if (epoch !== rentSweepEpoch) return;
        const rows = await fetchRentApts(c);
        if (epoch !== rentSweepEpoch) return;
        emitView(rows);
        markRentCitiesSwept([c]);
      }),
    );
    if (epoch !== rentSweepEpoch) return acc;

    // 2) Zillow for primary (+ neighbor) streams phones without blocking rent paint.
    const zMax = Number(profile.zillowDetails) > 0 ? Math.max(12, Number(profile.zillowDetails)) : 0;
    if (zMax > 0 && primary) {
      const zCities = fastCities.slice(0, 2);
      await Promise.all(
        zCities.map(async (c, i) => {
          if (epoch !== rentSweepEpoch) return;
          const rows = await fetchZillowCityRentPhones(c, state || "OK", {
            lat,
            lon,
            have: acc,
            maxDetails: i === 0 ? zMax : Math.min(6, zMax),
            bounds,
            onPartial: (part) => {
              if (epoch === rentSweepEpoch) emitView(part);
            },
          }).catch(() => []);
          if (epoch === rentSweepEpoch) emitView(rows);
        }),
      );
    }
    if (epoch !== rentSweepEpoch) return acc;

    if (inOk && !viewportOnly) {
      const swept = loadSweptRentCities();
      const now = Date.now();
      const skip = new Set(fastCities.map((c) => cityPathSlug(c)).filter(Boolean));
      const batch = citiesNearPoint(lat, lon)
        .filter((c) => !skip.has(cityPathSlug(c)) && rentCityNeedsSweep(c, swept, now))
        .slice(0, 6);
      if (batch.length) {
        void (async () => {
          await Promise.all(
            batch.map(async (c) => {
              if (epoch !== rentSweepEpoch) return;
              const rows = await fetchRentApts(c);
              if (epoch === rentSweepEpoch) {
                emitView(rows);
                markRentCitiesSwept([c]);
              }
            }),
          );
        })();
      }
    }
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
      persistRentFlags(acc);
    }
    return acc;
  })();

  rentSweepInFlight = work.finally(() => {
    if (epoch === rentSweepEpoch) rentSweepInFlight = null;
  });
  return work;
}

export function formatYellowPagesAddressUrl(address) {
  const p = parseStreetAddress(address);
  if (!p.house || !p.street) return "";
  const city = cityPathSlug(p.city || "edmond");
  const street = encodeURIComponent(`${p.house} ${p.street}`);
  return `https://www.yellowpages.com/search?search_terms=${street}&geo_location_terms=${encodeURIComponent(`${p.city || "Edmond"}, OK`)}`;
}

/** OK city → chamber / member-directory hosts (business phones at the address). */
const OK_CHAMBER_HOSTS = {
  woodward: ["woodwardokchamber.com", "woodwardchamber.com"],
  edmond: ["edmondchamber.com"],
  oklahoma: ["okcchamber.com", "greateroklahomacity.com"],
  "oklahoma city": ["okcchamber.com", "greateroklahomacity.com"],
  okc: ["okcchamber.com"],
  tulsa: ["tulsachamber.com"],
  enid: ["enidchamber.com"],
  stillwater: ["stillwaterchamber.org"],
  norman: ["normanokchamber.org", "normanchamber.com"],
  lawton: ["lawtonfortsillchamber.com"],
  moore: ["moorechamber.com"],
  yukon: ["yukonchamber.com"],
  "midwest city": ["midwestcitychamber.com"],
  "broken arrow": ["brokenarrowchamber.com"],
  shawnee: ["shawneechamber.com"],
  bartlesville: ["bartlesville.com"],
  muskogee: ["muskogeechamber.org"],
  ponca: ["poncacitychamber.com"],
  "ponca city": ["poncacitychamber.com"],
  ardmore: ["ardmore.org"],
  duncan: ["duncanchamber.com"],
  altus: ["altuschamber.com"],
  guymon: ["guymonchamber.com"],
  weatherford: ["weatherfordokchamber.com"],
  clinton: ["clintonok.org"],
  elreno: ["elrenochamber.com"],
  "el reno": ["elrenochamber.com"],
};

function chamberHostsForCity(city) {
  const key = String(city || "")
    .toLowerCase()
    .replace(/\./g, "")
    .trim();
  if (!key) return [];
  if (OK_CHAMBER_HOSTS[key]) return OK_CHAMBER_HOSTS[key];
  for (const [k, hosts] of Object.entries(OK_CHAMBER_HOSTS)) {
    if (key.includes(k) || k.includes(key)) return hosts;
  }
  return [];
}

/** Pull listing phones from HTML (embedded JSON + tel: + address-gated extract). */
function phonesFromListingHtml(html, parts) {
  if (!html || isEmptyOrHardBlock(html)) return null;
  if (!pageMentionsAddress(html, parts)) {
    // Search result shells sometimes bury the house # in JSON only.
    if (!String(html).includes(String(parts.house || ""))) return null;
  }
  const contacts = extractContactsFromHtml(html.slice(0, 240000), parts, { requireAddress: false });
  let phone = contacts?.phone || "";
  if (!phone) {
    const embedded = extractZillowEmbeddedPhones(html);
    if (embedded[0]) phone = formatPhone(embedded[0]);
  }
  if (!phone) {
    const tel = String(html).match(/tel:(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i);
    if (tel && !isJunkPhone(tel[1])) phone = formatPhone(tel[1]);
  }
  if (!phone) {
    for (const d of extractPhones(html)) {
      if (isJunkPhone(d)) continue;
      phone = formatPhone(d);
      break;
    }
  }
  if (!phone) return null;
  return {
    ...(contacts || {}),
    phone,
    name: contacts?.name || "",
    _public_text: publicTextFromHtml(html),
  };
}

async function contactsFromDirectUrls(urls, parts, source) {
  for (const url of urls.filter(Boolean).slice(0, 4)) {
    const page = await fetchHtml(url, 12000);
    if (!page?.html) continue;
    const hit = phonesFromListingHtml(page.html, parts);
    if (hit?.phone) return { ...hit, source };
    // Follow one apartment/business detail link if search page has no phone.
    const detail =
      page.html.match(/href="(https?:\/\/www\.apartments\.com\/[^"]{12,180})"/i) ||
      page.html.match(/href="(https?:\/\/www\.realtor\.com\/[^"]{12,180})"/i) ||
      page.html.match(/href="(\/[^"]*(?:apartment|property|listing|member)[^"]{8,120})"/i);
    if (detail?.[1]) {
      const next = detail[1].startsWith("http") ? detail[1] : new URL(detail[1], page.url || url).href;
      if (next === url) continue;
      const deep = await fetchHtml(next, 12000);
      const deepHit = phonesFromListingHtml(deep?.html || "", parts);
      if (deepHit?.phone) return { ...deepHit, source };
    }
  }
  return null;
}

/** apartments.com + Realtor apartments for this house. */
async function apartmentsListingContacts(address, parts) {
  if (!parts?.house || !parts?.street) return null;
  const urls = [formatApartmentsComSearchUrl(address), formatRealtorRentSearchUrl(address)].filter(Boolean);
  return contactsFromDirectUrls(urls, parts, "apartments");
}

/** Yellow Pages business listing at this address. */
async function yellowPagesBusinessContacts(address, parts) {
  if (!parts?.house || !parts?.street) return null;
  const url = formatYellowPagesAddressUrl(address);
  return contactsFromDirectUrls([url], parts, "yellowpages");
}

/**
 * Parse DuckDuckGo HTML results into absolute https URLs (chamber / rental hosts).
 */
export function extractSearchResultUrls(html, { allowHostRe = null, limit = 6 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    try {
      let u = decodeURIComponent(String(raw || "").replace(/\+/g, " "));
      if (!/^https?:\/\//i.test(u)) return;
      u = u.split("#")[0];
      const host = new URL(u).hostname.toLowerCase();
      if (SKIP_HOST.test(host) && !/apartments\.com|realtor\.com|yellowpages|chamber/i.test(host)) return;
      if (allowHostRe && !allowHostRe.test(host)) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.push(u);
    } catch {
      /* ignore */
    }
  };
  const blob = String(html || "");
  let m;
  const uddg = /uddg=([^&"]+)/gi;
  while ((m = uddg.exec(blob)) && out.length < limit) push(m[1]);
  const href = /href="(https?:\/\/[^"]+)"/gi;
  while ((m = href.exec(blob)) && out.length < limit) {
    if (/duckduckgo|google\.|bing\.|yahoo\./i.test(m[1])) continue;
    push(m[1]);
  }
  return out.slice(0, limit);
}

/**
 * OK chamber of commerce + similar business directories for the address
 * (e.g. Woodward Chamber member listings).
 */
async function okChamberBusinessContacts(address, parts) {
  if (!parts?.house || !isOklahomaAddress(address, parts)) return null;
  const city = String(parts.city || "").trim();
  const streetQ = `${parts.house} ${parts.street}`.trim();
  const hosts = chamberHostsForCity(city);
  const queries = [];
  if (hosts.length) {
    for (const host of hosts.slice(0, 2)) {
      queries.push(`site:${host} "${streetQ}"`);
      queries.push(`site:${host} ${streetQ} ${city}`);
    }
  }
  queries.push(`"${streetQ}" ${city} OK "chamber of commerce"`);
  queries.push(`"${streetQ}" ${city} OK (chamber OR "member directory")`);
  const allowHostRe =
    /chamber|chambermaster|growthzone|memberclicks|yellowpages|apartments\.com|realtor\.com|biz|business/i;
  const urls = [];
  for (const q of queries.slice(0, 4)) {
    const page = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, 10000);
    if (!page?.html) continue;
    urls.push(...extractSearchResultUrls(page.html, { allowHostRe, limit: 5 }));
    if (urls.length >= 6) break;
  }
  // ChamberMaster / GrowthZone directory paths when we know the host.
  for (const host of hosts.slice(0, 2)) {
    urls.push(`https://www.${host}/list/`);
    urls.push(`https://www.${host}/directory/`);
    urls.push(`https://${host}/list/`);
    urls.push(`https://members.${host}/list/`);
    urls.push(`https://www.${host}/search?q=${encodeURIComponent(streetQ)}`);
    urls.push(`https://www.${host}/list/ql/any/any/any/any?q=${encodeURIComponent(streetQ)}`);
  }
  const uniq = [...new Set(urls)].slice(0, 8);
  return contactsFromDirectUrls(uniq, parts, "chamber");
}

/** Strip tags for LLM extraction — listing/assessor pages only, never people-search. */
export function publicTextFromHtml(html) {
  return decodeEntities(String(html || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000);
}

/** Parse model JSON for contact fields; empty/invalid → blanks. */
export function parseAiContactJson(text) {
  const raw = String(text || "");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { name: "", phone: "", email: "" };
  try {
    const j = JSON.parse(m[0]);
    return {
      name: String(j.name || j.owner_name || "").trim().slice(0, 80),
      phone: String(j.phone || j.owner_phone || "").trim().slice(0, 40),
      email: String(j.email || j.owner_email || "")
        .trim()
        .toLowerCase()
        .slice(0, 80),
    };
  } catch {
    return { name: "", phone: "", email: "" };
  }
}

/**
 * Fill missing name/phone/email from PUBLIC listing/assessor text via keyed chat APIs.
 * Does not search Google/Facebook/people-finder — only extracts what is already in `publicText`.
 */
export async function enrichContactsWithChat(settings, { address = "", ownerName = "", existing = {}, publicText = "" } = {}) {
  const parts = parseStreetAddress(address);
  if (!parts.house) return null;
  const text = String(publicText || "").trim();
  if (text.length < 60) return null;
  let keyed = [];
  try {
    const { keyedProviders } = await import("./cloud.js");
    keyed = keyedProviders(settings) || [];
  } catch {
    return null;
  }
  if (!keyed.length) return null;

  const havePhone = Boolean(existing.owner_phone || existing.phone);
  const haveEmail = Boolean(existing.owner_email || existing.email);
  const haveName = Boolean(ownerName || existing.owner_name || existing.name);
  if (havePhone && haveEmail && haveName) return null;

  const sys = `You extract contact fields that already appear in the PUBLIC PROPERTY text below for one house.
Rules:
- Only the current owner-of-record, listing agent, or listing office for THIS address.
- Never invent names, phones, or emails. If unsure, use "".
- Never guess from memory or invent Oklahoma residents.
- Never use personal social profiles or people-search.
- Reply with JSON only: {"name":"","phone":"","email":""}`;

  const user = `House: ${address}
Assessor / known owner name: ${ownerName || "(none)"}
Already have phone: ${havePhone ? "yes" : "no"}
Already have email: ${haveEmail ? "yes" : "no"}

PUBLIC TEXT:
${text.slice(0, 9000)}`;

  try {
    const { chatComplete } = await import("./cloud.js");
    const out = await chatComplete(
      settings,
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      0.1,
      350,
      "life",
    );
    const parsed = parseAiContactJson(out?.text);
    const hit = mergeContacts({
      name: haveName ? "" : parsed.name,
      phone: havePhone ? "" : parsed.phone,
      email: haveEmail ? "" : parsed.email,
    });
    if (!hit.name && !hit.phone && !hit.email) return null;
    return hit;
  } catch {
    return null;
  }
}

async function assessorPublicText(url) {
  const u = String(url || "");
  if (!/^https?:\/\//i.test(u)) return "";
  // County assessor / parcel sites only — not people-search hosts
  if (!/oklahomacounty\.org|clevelandcounty|tulsacounty|assessor|incog|county\.|ok\.us/i.test(u)) return "";
  if (SKIP_HOST.test(u)) return "";
  const page = await fetchHtml(u, 10000);
  if (!page?.html || isEmptyOrHardBlock(page.html)) return "";
  return publicTextFromHtml(page.html);
}

export function parseStreetAddress(address) {
  const raw = String(address || "").replace(/\s+/g, " ").trim();
  const out = { raw, house: "", street: "", city: "", state: "", zip: "" };
  if (!raw || /^-?\d+\.\d+/.test(raw)) return out;
  const zip = raw.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip) out.zip = zip[1];
  const bits = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const head = bits[0] || raw;
  const hm = head.match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  if (hm) {
    out.house = hm[1];
    out.street = hm[2].replace(/\.$/, "").trim();
  }
  if (bits[1]) out.city = bits[1].replace(/\b\d{5}(?:-\d{4})?\b/, "").trim();
  for (const bit of bits.slice(1)) {
    const st = stateAbbr(bit.replace(/\b\d{5}(?:-\d{4})?\b/, "").trim());
    if (st) {
      out.state = st;
      break;
    }
  }
  return out;
}

export function stateAbbr(s) {
  const t = String(s || "").trim().toLowerCase();
  if (/^[a-z]{2}$/.test(t)) return t;
  return US_STATES[t] || "";
}

export function streetKey(street) {
  const skip =
    /^(n|s|e|w|ne|nw|se|sw|north|south|east|west|st|ave|dr|ln|rd|blvd|way|ct|pl|cir|pkwy|hwy|street|avenue|drive|lane|road|court|place|circle)$/i;
  const bits = String(street || "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((b) => !skip.test(b));
  return bits.find((b) => b.length >= 4) || bits[0] || "";
}

export function sameHouse(a, b) {
  const pa = a && typeof a === "object" && a.house != null ? a : parseStreetAddress(a);
  const pb = b && typeof b === "object" && b.house != null ? b : parseStreetAddress(b);
  if (!pa.house || !pb.house) return false;
  if (String(pa.house).toLowerCase() !== String(pb.house).toLowerCase()) return false;
  const ka = streetKey(pa.street);
  const kb = streetKey(pb.street);
  if (ka && kb && ka !== kb) return false;
  return true;
}

function emptyListing() {
  return { name: "", phone: "", email: "", website: "", facebook: "", instagram: "" };
}

/** Keep OSM tags only when they belong to this house number and street. */
export function listingForPin(seed, pinAddress) {
  const pin = parseStreetAddress(pinAddress || seed?.address);
  if (!pin.house) return emptyListing();
  const seedAddr = seed?.address || pinAddress;
  if (!sameHouse(pin, seedAddr)) return emptyListing();
  return mergeContacts({
    name: seed?.name || "",
    phone: seed?.phone || seed?.owner_phone || "",
    email: seed?.email || seed?.owner_email || "",
    website: seed?.website || "",
    facebook: seed?.facebook || seed?.facebook_url || "",
    instagram: seed?.instagram || seed?.instagram_url || "",
  });
}

function firstPhone(raw) {
  return (
    String(raw || "")
      .split(/[;,/|]/)
      .map((s) => s.trim())
      .find(Boolean) || ""
  );
}

export function phoneDigits(raw) {
  const d = String(firstPhone(raw)).replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (String(raw || "").trim().startsWith("+") && d.length >= 10) return `+${d}`;
  return "";
}

export function formatPhone(raw) {
  const e164 = phoneDigits(raw);
  const d = e164.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return firstPhone(raw);
}

export function isJunkPhone(raw) {
  const ten = phoneDigits(raw).replace(/\D/g, "").slice(-10);
  if (ten.length !== 10) return true;
  if (ten.slice(3, 6) === "555") return true;
  if (/(\d)\1{6,}/.test(ten)) return true;
  return false;
}

export function extractPhones(text) {
  const out = [];
  const blob = decodeEntities(text);
  const re = /(?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s])[2-9]\d{2}[-.\s]\d{4}/g;
  let m;
  while ((m = re.exec(blob)) && out.length < 8) {
    if (isJunkPhone(m[0])) continue;
    const digits = phoneDigits(m[0]);
    if (digits && !out.includes(digits)) out.push(digits);
  }
  return out;
}

export function extractEmails(text) {
  const out = [];
  const blob = decodeEntities(text);
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let m;
  while ((m = re.exec(blob)) && out.length < 8) {
    const e = m[0].toLowerCase().replace(/^mailto:/i, "");
    if (JUNK_MAIL.test(e)) continue;
    if (!out.includes(e)) out.push(e);
  }
  const ob = blob.match(/[A-Z0-9._%+-]+\s*(?:\[at\]|\(at\))\s*[A-Z0-9.-]+\s*(?:\[dot\]|\(dot\))\s*[A-Z]{2,}/gi) || [];
  for (const row of ob) {
    const e = row
      .replace(/\s*(?:\[at\]|\(at\))\s*/i, "@")
      .replace(/\s*(?:\[dot\]|\(dot\))\s*/gi, ".")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (e.includes("@") && !JUNK_MAIL.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

export function publicFacebookUrl(raw) {
  let s = String(raw || "").trim().replace(/^@/, "");
  if (!s) return "";
  if (!/^https?:/i.test(s)) {
    if (!/^[\w.]+$/.test(s)) return "";
    s = `https://www.facebook.com/${s}`;
  }
  try {
    const u = new URL(s);
    if (!/(^|\.)facebook\.com$/i.test(u.hostname) && !/(^|\.)fb\.com$/i.test(u.hostname)) return "";
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/" || /^\/(profile\.php|people|share|watch|login|dialog|sharer|groups)\b/i.test(path)) return "";
    return `https://www.facebook.com${path}`;
  } catch {
    return "";
  }
}

export function publicInstagramUrl(raw) {
  let s = String(raw || "").trim().replace(/^@/, "");
  if (!s) return "";
  if (!/^https?:/i.test(s)) {
    if (!/^[\w.]+$/.test(s)) return "";
    s = `https://www.instagram.com/${s}`;
  }
  try {
    const u = new URL(s);
    if (!/(^|\.)instagram\.com$/i.test(u.hostname) && !/(^|\.)instagr\.am$/i.test(u.hostname)) return "";
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/" || /^\/(p|reel|reels|stories|accounts)\b/i.test(path)) return "";
    return `https://www.instagram.com${path}`;
  } catch {
    return "";
  }
}

function socialsFromTags(tags = {}) {
  return {
    facebook: publicFacebookUrl(tags.facebook || tags["contact:facebook"] || ""),
    instagram: publicInstagramUrl(tags.instagram || tags["contact:instagram"] || ""),
  };
}

function socialsFromHtml(html) {
  const fb = [];
  const ig = [];
  const hrefs = String(html || "").matchAll(/href=["']([^"']+)["']/gi);
  for (const m of hrefs) {
    const f = publicFacebookUrl(m[1]);
    if (f && !fb.includes(f)) fb.push(f);
    const i = publicInstagramUrl(m[1]);
    if (i && !ig.includes(i)) ig.push(i);
  }
  return { facebook: fb[0] || "", instagram: ig[0] || "" };
}
function jsonLdContacts(html) {
  const hit = { name: "", phone: "", email: "", website: "", facebook: "", instagram: "" };
  const blocks = String(html || "").match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const takeSocial = (url) => {
    if (!hit.facebook) hit.facebook = publicFacebookUrl(url);
    if (!hit.instagram) hit.instagram = publicInstagramUrl(url);
  };
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    if (!hit.name && typeof node.name === "string") hit.name = node.name.trim();
    const tel = node.telephone || node.phone;
    if (!hit.phone && tel) hit.phone = Array.isArray(tel) ? tel[0] : tel;
    const em = node.email;
    if (!hit.email && em) hit.email = Array.isArray(em) ? em[0] : em;
    const url = node.url || node.website;
    if (!hit.website && typeof url === "string" && /^https?:/i.test(url)) hit.website = url;
    const same = node.sameAs;
    if (typeof same === "string") takeSocial(same);
    else if (Array.isArray(same)) same.forEach(takeSocial);
    walk(node.address);
    walk(node.contactPoint);
    walk(node["@graph"]);
  };
  for (const block of blocks) {
    const raw = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      walk(JSON.parse(raw));
    } catch {
      /* ignore bad json-ld */
    }
  }
  return hit;
}

function itempropContacts(html) {
  const tel = String(html || "").match(/itemprop=["']telephone["'][^>]*>([^<]+)/i)
    || String(html || "").match(/itemprop=["']telephone["'][^>]*content=["']([^"']+)/i);
  const em = String(html || "").match(/itemprop=["']email["'][^>]*>([^<]+)/i)
    || String(html || "").match(/mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  return {
    phone: tel ? tel[1] : "",
    email: em ? em[1] : "",
  };
}

function pageMentionsAddress(html, parts) {
  if (!parts?.house) return false;
  const text = decodeEntities(String(html || "")).replace(/<[^>]+>/g, " ");
  if (!text.includes(parts.house)) return false;
  if (parts.street) {
    const token = parts.street.split(/\s+/)[0];
    if (token && token.length >= 4 && !new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) return false;
  }
  return true;
}

function scoredFromText(html, parts, opts = {}) {
  // Do not bail on captcha/cf strings — listing pages often mention them in JS and still carry phones.
  if (opts.requireAddress !== false && !pageMentionsAddress(html, parts)) return null;
  const ld = jsonLdContacts(html);
  const meta = itempropContacts(html);
  const telHref = String(html || "").match(/tel:(\+?[0-9().\-\s]{7,})/i);
  const mailHref = String(html || "").match(/mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const phones = [
    ld.phone,
    meta.phone,
    telHref && telHref[1],
    ...extractPhones(html),
  ]
    .map((p) => phoneDigits(p))
    .filter((p) => p && !isJunkPhone(p));
  const emails = [ld.email, meta.email, mailHref && mailHref[1], ...extractEmails(html)].filter(Boolean);
  const uniquePhones = [...new Set(phones)];
  const uniqueMail = [...new Set(emails.map((e) => String(e).toLowerCase()).filter((e) => !JUNK_MAIL.test(e)))];
  const hrefSocial = socialsFromHtml(html);
  const facebook = ld.facebook || hrefSocial.facebook;
  const instagram = ld.instagram || hrefSocial.instagram;
  if (!uniquePhones.length && !uniqueMail.length && !ld.name && !facebook && !instagram) return null;
  return {
    name: ld.name || "",
    phone: uniquePhones[0] ? formatPhone(uniquePhones[0]) : "",
    email: uniqueMail[0] || "",
    website: ld.website || "",
    facebook,
    instagram,
  };
}

export function extractContactsFromHtml(html, parts = {}, opts = {}) {
  return scoredFromText(html, parts, opts);
}

export function mergeContacts(...parts) {
  const hit = { name: "", phone: "", email: "", website: "", facebook: "", instagram: "", zillow_url: "", source: "" };
  for (const p of parts) {
    if (!p) continue;
    if (!hit.name && (p.name || p.owner_name)) hit.name = String(p.name || p.owner_name).trim();
    if (!hit.phone && (p.phone || p.owner_phone)) {
      const formatted = formatPhone(p.phone || p.owner_phone);
      if (formatted && !isJunkPhone(formatted)) {
        hit.phone = formatted;
        hit.source = String(p.source || "").trim();
      }
    }
    if (!hit.email && (p.email || p.owner_email)) {
      const e = String(p.email || p.owner_email).trim().toLowerCase();
      if (e && !JUNK_MAIL.test(e)) hit.email = e;
    }
    if (!hit.website && p.website) hit.website = String(p.website).trim();
    if (!hit.facebook) hit.facebook = publicFacebookUrl(p.facebook || p.facebook_url || "");
    if (!hit.instagram) hit.instagram = publicInstagramUrl(p.instagram || p.instagram_url || "");
    const z = String(p.zillow_url || "").trim();
    if (z && isUsableZillowUrl(z)) hit.zillow_url = z;
    if (p.zillow_rent === true) hit.zillow_rent = true;
  }
  return hit;
}

/** For-rent listing hosts → green flags (phone required). */
export function isRentalPhoneSource(source) {
  return /zillow[-_]?rent|for_rent|apartments|realtor|rent[-_.]?com/i.test(String(source || ""));
}

/** Chamber / YP / OSM amenity (and similar) → blue business flags. */
export function isBusinessPhoneSource(source) {
  return /chamber|yellowpages|yp\b|business|member|osm-business|amenity|shop|office|craft/i.test(
    String(source || ""),
  );
}

/** OSM POI tags that are public businesses, not residential house phones. */
export function isOsmBusinessTags(tags = {}) {
  return Boolean(tags?.amenity || tags?.shop || tags?.office || tags?.craft || tags?.healthcare);
}

/**
 * Flags only: rental listing + phone → "rental"; business directory + phone → "business".
 * Homeowner / phone-book / sale-listing phones stay empty (no flag).
 */
export function classifyFlagPhone(hit = {}) {
  const phone = String(hit.phone || hit.owner_phone || "").trim();
  if (!phone) return "";
  const source = String(hit.source || "");
  const url = String(hit.zillow_url || "");
  if (
    hit.zillow_rent === true ||
    hit.phone_kind === "rental" ||
    /for_rent|\/apartments\//i.test(url) ||
    isRentalPhoneSource(source)
  ) {
    return "rental";
  }
  if (hit.phone_kind === "business" || isBusinessPhoneSource(source)) return "business";
  return "";
}

async function fetchHtml(url, ms = 9000, extraHeaders = {}) {
  try {
    const { body, url: finalUrl } = await httpGet(url, ms, extraHeaders);
    return { html: String(body || ""), url: finalUrl || url };
  } catch {
    return null;
  }
}

async function huntPages(urls, parts, opts = {}) {
  const pages = await Promise.all(urls.slice(0, 6).map((u) => fetchHtml(u, 9000)));
  let hit = { name: "", phone: "", email: "", website: "" };
  for (const page of pages) {
    if (!page) continue;
    hit = mergeContacts(hit, extractContactsFromHtml(page.html.slice(0, 140000), parts, opts));
    if (hit.phone && hit.email) break;
  }
  return hit;
}

function nominatimHitAddress(h) {
  const a = h?.address || {};
  if (a.house_number && a.road) {
    return `${a.house_number} ${a.road}, ${a.city || a.town || a.village || ""}, ${a.state || ""}`;
  }
  return h?.display_name || "";
}

async function nominatimSearchContacts(address, parts) {
  const q = String(address || "").trim();
  if (q.length < 8 || !parts?.house) return null;
  try {
    const { body } = await httpGet(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&extratags=1&limit=3`,
      9000,
      NOM_UA,
    );
    const hits = JSON.parse(body || "[]");
    for (const h of hits) {
      if (!sameHouse(parts, nominatimHitAddress(h))) continue;
      const extra = h.extratags || {};
      const phone = firstPhone(extra.phone || extra["contact:phone"] || extra["contact:mobile"] || "");
      const email = extra.email || extra["contact:email"] || "";
      const website = extra.website || extra["contact:website"] || extra.url || "";
      const social = socialsFromTags(extra);
      if (phone || email || website || social.facebook || social.instagram) {
        return { name: h.name || extra.operator || "", phone, email, website, ...social, wikidata: extra.wikidata || "" };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function overpassContacts(lat, lon, parts) {
  if (!parts.house) return null;
  const hn = String(parts.house).replace(/"/g, "");
  const q = `[out:json][timeout:12];(
    nwr(around:140,${lat},${lon})["addr:housenumber"="${hn}"];
  );out tags center 16;`;
  try {
    const data = await overpassJson(q, 14000);
    const scored = [];
    for (const el of data.elements || []) {
      const tags = el.tags || {};
      const house = String(tags["addr:housenumber"] || "");
      const street = String(tags["addr:street"] || "");
      if (!sameHouse(parts, `${house} ${street}`.trim())) continue;
      const phone = firstPhone(tags.phone || tags["contact:phone"] || tags["contact:mobile"] || "");
      const email = tags.email || tags["contact:email"] || "";
      const website = tags.website || tags["contact:website"] || "";
      const social = socialsFromTags(tags);
      if (!phone && !email && !website && !social.facebook && !social.instagram) continue;
      const elat = Number(el.lat || el.center?.lat);
      const elon = Number(el.lon || el.center?.lon);
      const dist = Number.isFinite(elat) && Number.isFinite(elon) ? haversineKm(lat, lon, elat, elon) : 0.08;
      scored.push({
        dist,
        house,
        name: tags.name || tags.operator || "",
        phone,
        email,
        website,
        ...social,
        wikidata: tags.wikidata || "",
        source: isOsmBusinessTags(tags) ? "osm-business" : "",
      });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored[0] || null;
  } catch {
    return null;
  }
}

async function wikidataContacts(qid) {
  const id = String(qid || "").trim();
  if (!/^Q\d+$/i.test(id)) return null;
  try {
    const { body } = await httpGet(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, 9000);
    const ent = JSON.parse(body || "{}")?.entities?.[id];
    const claim = (pid) => {
      const v = ent?.claims?.[pid]?.[0]?.mainsnak?.datavalue?.value;
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && v.text) return v.text;
      return "";
    };
    return {
      phone: claim("P1329"),
      email: String(claim("P968") || "").replace(/^mailto:/i, ""),
      website: claim("P856"),
    };
  } catch {
    return null;
  }
}

async function contactsFromWebsite(url, parts) {
  const href = String(url || "").trim();
  if (!parts?.house || !/^https?:\/\//i.test(href)) return null;
  let base;
  try {
    base = new URL(href);
  } catch {
    return null;
  }
  if (SKIP_HOST.test(base.hostname)) return null;
  const paths = [href];
  const root = `${base.origin}/`;
  if (!/contact/i.test(href)) {
    paths.push(`${root}contact`, `${root}contact-us`, `${root}contact.html`);
  }
  return huntPages(paths, parts);
}

/** Fast phone hunt for Flags — rentals + public businesses only (no phone book / sale listings). */
export async function lookupFlagPhone(lat, lon, address = "") {
  const parts = parseStreetAddress(address);
  const blank = { owner_name: "", owner_phone: "", owner_email: "", zillow_url: "", source: "", phone_kind: "" };
  if (!parts.house) return blank;
  let hit = { name: "", phone: "", email: "", zillow_url: "" };

  const batch = await Promise.all([
    apartmentsListingContacts(address, parts).catch(() => null),
    zillowRentContacts(address, parts).catch(() => null),
    yellowPagesBusinessContacts(address, parts).catch(() => null),
    isOklahomaAddress(address, parts) ? okChamberBusinessContacts(address, parts).catch(() => null) : null,
  ]);
  for (const part of batch) {
    if (part) hit = mergeContacts(hit, part);
  }
  if (!hit.phone && Number.isFinite(lat) && Number.isFinite(lon)) {
    const osm = await overpassContacts(lat, lon, parts).catch(() => null);
    if (osm?.phone && classifyFlagPhone(osm) === "business") hit = mergeContacts(hit, osm);
  }
  const phoneKind = classifyFlagPhone(hit);
  if (!phoneKind) {
    return { ...blank, owner_name: hit.name || "", owner_email: hit.email || "", zillow_url: hit.zillow_url || "" };
  }
  return {
    owner_name: hit.name || "",
    owner_phone: hit.phone || "",
    owner_email: hit.email || "",
    zillow_url: hit.zillow_url || "",
    source: hit.source || "",
    phone_kind: phoneKind,
    zillow_rent: hit.zillow_rent === true,
  };
}

export async function lookupPlaceContacts(lat, lon, address = "", seed = {}, settings = null) {
  const parts = parseStreetAddress(address);
  const blank = {
    owner_name: "",
    owner_phone: "",
    owner_email: "",
    facebook_url: "",
    instagram_url: "",
    zillow_url: "",
  };
  if (!parts.house) return blank;
  let hit = listingForPin(seed, address);
  const publicChunks = [];
  const [osm, nom] = await Promise.all([
    Number.isFinite(lat) && Number.isFinite(lon) ? overpassContacts(lat, lon, parts).catch(() => null) : null,
    nominatimSearchContacts(address, parts).catch(() => null),
  ]);
  hit = mergeContacts(hit, osm, nom);

  // Sale / rent listings + apartments.com + chamber / YP businesses.
  const zillowHit = await zillowListingContacts(address, parts).catch(() => null);
  if (zillowHit?._public_text) publicChunks.push(zillowHit._public_text);
  if (zillowHit) hit = mergeContacts(hit, zillowHit);
  if (!hit.phone) {
    const rentHit = await zillowRentContacts(address, parts).catch(() => null);
    if (rentHit?._public_text) publicChunks.push(rentHit._public_text);
    if (rentHit) hit = mergeContacts(hit, rentHit);
  }
  if (!hit.phone) {
    const apts = await apartmentsListingContacts(address, parts).catch(() => null);
    if (apts?._public_text) publicChunks.push(apts._public_text);
    if (apts) hit = mergeContacts(hit, apts);
  }
  if (!hit.phone && isOklahomaAddress(address, parts)) {
    const chamber = await okChamberBusinessContacts(address, parts).catch(() => null);
    if (chamber?._public_text) publicChunks.push(chamber._public_text);
    if (chamber) hit = mergeContacts(hit, chamber);
  }
  if (!hit.phone) {
    const yp = await yellowPagesBusinessContacts(address, parts).catch(() => null);
    if (yp?._public_text) publicChunks.push(yp._public_text);
    if (yp) hit = mergeContacts(hit, yp);
  }

  // Oklahoma phone book (411 / Whitepages address directory) — OK addresses only.
  if (!hit.phone && isOklahomaAddress(address, parts)) {
    const book = await oklahomaPhoneBookContacts(address, parts).catch(() => null);
    if (book?._public_text) publicChunks.push(book._public_text);
    if (book) hit = mergeContacts(hit, book);
  }

  const site = osm?.website || nom?.website || hit.website;
  if (site && (!hit.phone || !hit.email || !hit.facebook)) {
    hit = mergeContacts(hit, await contactsFromWebsite(site, parts));
  }
  const qid = osm?.wikidata || nom?.wikidata;
  if (qid && (!hit.phone || !hit.email)) {
    hit = mergeContacts(hit, await wikidataContacts(qid));
  }
  if (settings && publicChunks.length && (!hit.phone || !hit.email || !hit.name)) {
    const ai = await enrichContactsWithChat(settings, {
      address,
      ownerName: hit.name || "",
      existing: hit,
      publicText: publicChunks.join("\n\n"),
    }).catch(() => null);
    if (ai) hit = mergeContacts(hit, ai);
  }
  return {
    owner_name: hit.name || "",
    owner_phone: hit.phone || "",
    owner_email: hit.email || "",
    facebook_url: hit.facebook || "",
    instagram_url: hit.instagram || "",
    zillow_url: hit.zillow_url || "",
    _public_text: publicChunks.join("\n\n"),
  };
}

/** Second-pass gap fill after assessor returns — uses assessor page + prior listing text only. */
export async function fillContactGapsWithChat(settings, { address, assessor = null, contacts = {}, publicText = "" } = {}) {
  if (!settings) return null;
  const havePhone = Boolean(contacts.owner_phone || contacts.phone);
  const haveEmail = Boolean(contacts.owner_email || contacts.email);
  const haveName = Boolean(assessor?.name || contacts.owner_name || contacts.name);
  if (havePhone && haveEmail && haveName) return null;
  const chunks = [publicText || contacts._public_text || ""];
  if (assessor?.url) {
    const snip = await assessorPublicText(assessor.url).catch(() => "");
    if (snip) chunks.push(snip);
  }
  const text = chunks.filter(Boolean).join("\n\n");
  if (text.length < 60) return null;
  return enrichContactsWithChat(settings, {
    address,
    ownerName: assessor?.name || contacts.owner_name || contacts.name || "",
    existing: contacts,
    publicText: text,
  });
}
