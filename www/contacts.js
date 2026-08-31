/** High-confidence listing for a pinned house — OSM/Nominatim at this address only. */
import { httpGet } from "./net.js";

const NOM_UA = { "User-Agent": "GroundControl/1.0 (joshuagwatts)", "Accept-Language": "en" };
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

async function zillowListingContacts(address, parts) {
  const url = formatZillowUrl(address);
  if (!url || !parts?.house) return null;
  const page = await fetchHtml(url, 14000);
  if (!page?.html || /captcha|access denied|cf-challenge/i.test(page.html)) return null;
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
  if (!page?.html || /captcha|access denied|cf-challenge/i.test(page.html)) return null;
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
  ];
  for (const url of urls) {
    const page = await fetchHtml(url, 12000);
    if (!page?.html || /captcha|access denied|cf-challenge|are you a robot/i.test(page.html)) continue;
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
  if (!page?.html || /captcha|access denied/i.test(page.html)) return "";
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
  if (/captcha|are you a robot|access denied|cf-challenge/i.test(html || "")) return null;
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
  const hit = { name: "", phone: "", email: "", website: "", facebook: "", instagram: "", zillow_url: "" };
  for (const p of parts) {
    if (!p) continue;
    if (!hit.name && (p.name || p.owner_name)) hit.name = String(p.name || p.owner_name).trim();
    if (!hit.phone && (p.phone || p.owner_phone)) {
      const formatted = formatPhone(p.phone || p.owner_phone);
      if (formatted && !isJunkPhone(formatted)) hit.phone = formatted;
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
  }
  return hit;
}

async function fetchHtml(url, ms = 9000) {
  try {
    const { body, url: finalUrl } = await httpGet(url, ms);
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
    const { body } = await httpGet(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, 14000);
    const data = JSON.parse(body || "{}");
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

  // Sale listing first, then For Rent (landlord / leasing phones → green labels).
  const zillowHit = await zillowListingContacts(address, parts).catch(() => null);
  if (zillowHit?._public_text) publicChunks.push(zillowHit._public_text);
  if (zillowHit) hit = mergeContacts(hit, zillowHit);
  if (!hit.phone) {
    const rentHit = await zillowRentContacts(address, parts).catch(() => null);
    if (rentHit?._public_text) publicChunks.push(rentHit._public_text);
    if (rentHit) hit = mergeContacts(hit, rentHit);
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
