/** Public contact hunt for a pinned address — OSM, listings, search pages. */
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

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  if (!parts?.house) return true;
  const text = decodeEntities(String(html || "")).replace(/<[^>]+>/g, " ");
  if (!text.includes(parts.house)) return false;
  if (parts.street) {
    const token = parts.street.split(/\s+/)[0];
    if (token && token.length >= 4 && !new RegExp(token, "i").test(text)) return false;
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
  const hit = { name: "", phone: "", email: "", website: "", facebook: "", instagram: "" };
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
  }
  return hit;
}

function searchResultUrls(html) {
  const urls = [];
  const add = (raw) => {
    try {
      const href = decodeURIComponent(String(raw || "").replace(/&amp;/g, "&"));
      const u = new URL(href, "https://example.com");
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (SKIP_HOST.test(u.hostname)) return;
      const clean = `${u.origin}${u.pathname}${u.search}`;
      if (!urls.includes(clean)) urls.push(clean);
    } catch {
      /* ignore */
    }
  };
  const ddg = /uddg=([^&"]+)/g;
  let m;
  while ((m = ddg.exec(html || "")) && urls.length < 8) add(m[1]);
  const hrefs = /<a[^>]+href=["'](https?:\/\/[^"'<>]+)/gi;
  while ((m = hrefs.exec(html || "")) && urls.length < 10) add(m[1]);
  return urls.slice(0, 8);
}

function directoryUrls(parts) {
  if (!parts.house || !parts.street || !parts.city) return [];
  const st = parts.state || "ok";
  const street = `${parts.house} ${parts.street}`;
  const citySt = `${parts.city} ${st}`;
  const hy = [parts.house, parts.street, parts.city, st.toUpperCase()].join("-").replace(/\s+/g, "-");
  const fps = `${slug(`${parts.house} ${parts.street}`)}_${slug(`${parts.city} ${st}`)}`;
  return [
    `https://thatsthem.com/address/${hy}`,
    `https://www.fastpeoplesearch.com/address/${fps}`,
    `https://www.truepeoplesearch.com/resultaddress?street=${encodeURIComponent(street)}&citystatezip=${encodeURIComponent(citySt)}`,
    `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(street)}&geo_location_terms=${encodeURIComponent(`${parts.city}, ${st}`)}`,
    `https://www.whitepages.com/address/${encodeURIComponent(street)}/${encodeURIComponent(`${parts.city}-${st}`)}`,
  ];
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

async function nominatimSearchContacts(address) {
  const q = String(address || "").trim();
  if (q.length < 8) return null;
  try {
    const { body } = await httpGet(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&extratags=1&limit=3`,
      9000,
      NOM_UA,
    );
    const hits = JSON.parse(body || "[]");
    for (const h of hits) {
      const extra = h.extratags || {};
      const phone = firstPhone(extra.phone || extra["contact:phone"] || extra["contact:mobile"] || "");
      const email = extra.email || extra["contact:email"] || "";
      const website = extra.website || extra["contact:website"] || extra.url || "";
      const social = socialsFromTags(extra);
      if (phone || email || website || social.facebook || social.instagram) {
        return { name: h.name || extra.operator || "", phone, email, website, ...social };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function overpassContacts(lat, lon, parts) {
  const around = parts.house ? 140 : 50;
  const houseClause = parts.house
    ? `nwr(around:${around},${lat},${lon})["addr:housenumber"="${String(parts.house).replace(/"/g, "")}"];`
    : "";
  const q = `[out:json][timeout:12];(${houseClause}
    nwr(around:40,${lat},${lon})["phone"];
    nwr(around:40,${lat},${lon})["contact:phone"];
    nwr(around:40,${lat},${lon})["email"];
    nwr(around:40,${lat},${lon})["contact:email"];
  );out tags center 16;`;
  try {
    const { body } = await httpGet(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, 14000);
    const data = JSON.parse(body || "{}");
    const scored = [];
    for (const el of data.elements || []) {
      const tags = el.tags || {};
      const house = String(tags["addr:housenumber"] || "");
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
        same: parts.house && house && house.toLowerCase() === String(parts.house).toLowerCase(),
        name: tags.name || tags.operator || "",
        phone,
        email,
        website,
        ...social,
        wikidata: tags.wikidata || "",
      });
    }
    scored.sort((a, b) => Number(b.same) - Number(a.same) || a.dist - b.dist);
    if (parts.house) {
      const match = scored.find((s) => s.same);
      if (match) return match;
      return null;
    }
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

async function searchEngineContacts(address, parts) {
  const q = String(address || "").trim();
  if (q.length < 8) return { urls: [] };
  const queries = [
    `"${q}" phone`,
    `"${q}" email`,
    `"${parts.house || ""} ${parts.street || ""}" ${parts.city || ""} contact`.trim(),
  ].filter((s) => s.length > 10);
  const pages = await Promise.all(
    queries.flatMap((query) => [
      fetchHtml(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, 10000),
      fetchHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, 10000),
    ]),
  );
  let hit = { name: "", phone: "", email: "", website: "" };
  const urls = [];
  for (const page of pages) {
    if (!page) continue;
    const snippet = extractContactsFromHtml(page.html, parts);
    if (snippet) hit = mergeContacts(hit, snippet);
    for (const u of searchResultUrls(page.html)) {
      if (!urls.includes(u)) urls.push(u);
    }
  }
  return { ...hit, urls };
}

async function contactsFromWebsite(url, parts) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return null;
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
  return huntPages(paths, parts, { requireAddress: false });
}

export async function lookupPlaceContacts(lat, lon, address = "", seed = {}) {
  const parts = parseStreetAddress(address);
  let hit = mergeContacts(seed);
  const [osm, nom, dirs] = await Promise.all([
    Number.isFinite(lat) && Number.isFinite(lon) ? overpassContacts(lat, lon, parts).catch(() => null) : null,
    nominatimSearchContacts(address).catch(() => null),
    huntPages(directoryUrls(parts), parts).catch(() => null),
  ]);
  hit = mergeContacts(hit, osm, nom, dirs);
  if (osm?.website && (!hit.phone || !hit.email || !hit.facebook)) {
    hit = mergeContacts(hit, await contactsFromWebsite(osm.website, parts));
  }
  if (hit.website && (!hit.phone || !hit.email || !hit.facebook)) {
    hit = mergeContacts(hit, await contactsFromWebsite(hit.website, parts));
  }
  if (!hit.phone || !hit.email) {
    const serps = await searchEngineContacts(address, parts).catch(() => ({ urls: [] }));
    hit = mergeContacts(hit, serps);
    if (!hit.phone || !hit.email) {
      hit = mergeContacts(hit, await huntPages(serps.urls || [], parts));
    }
  }
  const qid = osm?.wikidata || seed.wikidata;
  if ((!hit.phone || !hit.email) && qid) {
    hit = mergeContacts(hit, await wikidataContacts(qid));
  }
  return {
    owner_name: hit.name || "",
    owner_phone: hit.phone || "",
    owner_email: hit.email || "",
    facebook_url: hit.facebook || "",
    instagram_url: hit.instagram || "",
  };
}
