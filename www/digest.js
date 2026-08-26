import { httpGet } from "./net.js";

const URL_RE =
  /(https?:\/\/[^\s<>"']+)|(www\.[^\s<>"']+)|((?:instagram\.com|instagr\.am)\/[A-Za-z0-9._]+)|(?<![A-Za-z0-9._])(@[A-Za-z0-9._]{2,30})(?![A-Za-z0-9.@])/gi;
const SOCIAL_HREF =
  /https?:\/\/(?:www\.)?(instagram\.com|tiktok\.com|youtube\.com|youtu\.be|vimeo\.com|linkedin\.com|twitter\.com|x\.com|facebook\.com|twitch\.tv|soundcloud\.com|bandcamp\.com|open\.spotify\.com)\/[^\s"'<>]+/gi;
const IG_APP = "936619743392459";
const KIND_HOST = [
  ["instagram", ["instagram.com", "instagr.am"]],
  ["tiktok", ["tiktok.com"]],
  ["youtube", ["youtube.com", "youtu.be"]],
  ["vimeo", ["vimeo.com"]],
  ["linkedin", ["linkedin.com"]],
  ["twitter", ["twitter.com", "x.com"]],
  ["facebook", ["facebook.com"]],
  ["twitch", ["twitch.tv"]],
  ["soundcloud", ["soundcloud.com"]],
  ["bandcamp", ["bandcamp.com"]],
  ["spotify", ["spotify.com"]],
];
const CRAFT = [
  ["3D generalist", ["3d generalist", "cinema 4d", "blender", "octane", "unreal"]],
  ["motion / VFX", ["motion graphic", "animation", "vfx", "after effects"]],
  ["live visuals / VJ", ["live visual", "video jockey", "laser", "pangolin", "vj"]],
  ["holograms", ["hologram", "holographic"]],
  ["installations", ["installation"]],
  ["projection mapping", ["projection map", "mural mapping"]],
  ["sound / music", ["ableton", "sound design", "music production"]],
];

export function normalizeUrl(raw) {
  let text = String(raw || "").trim().replace(/[).,;]+$/, "");
  if (!text) return "";
  if (text.startsWith("@") && !text.includes("/")) {
    const handle = text.slice(1).trim();
    return handle ? `https://www.instagram.com/${handle}/` : "";
  }
  if (/^(www\.)?instagram\.com\//i.test(text)) text = "https://" + text.replace(/^https?:\/\//i, "");
  if (text.toLowerCase().startsWith("www.")) text = "https://" + text;
  try {
    const u = new URL(text);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString().split("#")[0];
  } catch {
    return "";
  }
}

export function parseUrls(text) {
  const found = [];
  const seen = new Set();
  const blob = String(text || "");
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(blob))) {
    const url = normalizeUrl(m[0]);
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    found.push(url);
    if (found.length >= 24) break;
  }
  return found;
}

export function kindOf(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "site";
  }
  for (const [kind, needles] of KIND_HOST) {
    if (needles.some((n) => host === n || host.endsWith("." + n))) return kind;
  }
  return "site";
}

export function groupLinks(urls) {
  const out = {};
  for (const url of urls) {
    const k = kindOf(url);
    if (!out[k]) out[k] = [];
    out[k].push(url);
  }
  return out;
}

function first(by, ...kinds) {
  const hits = [];
  for (const k of kinds) hits.push(...(by[k] || []));
  return hits.join("\n");
}

export function pickLink(question, kit) {
  const q = String(question || "").toLowerCase();
  const urls = parseUrls((kit && kit.links) || "");
  const extra = ((kit && kit.digest && kit.digest.sources) || []).map((s) => s.url).filter(Boolean);
  for (const u of extra) if (!urls.includes(u)) urls.push(u);
  const by = groupLinks(urls);
  const site = by.site || [];
  if (q.includes("instagram")) return first(by, "instagram");
  if (q.includes("tiktok")) return first(by, "tiktok");
  if (q.includes("linkedin")) return first(by, "linkedin");
  if (/youtube|youtu|showreel|demo reel|demo-reel/.test(q)) return first(by, "youtube", "vimeo");
  if (q.includes("vimeo")) return first(by, "vimeo", "youtube");
  if (/soundcloud|bandcamp|spotify|mixcloud/.test(q)) return first(by, "soundcloud", "bandcamp", "spotify");
  if (/twitter|x\.com|x handle/.test(q)) return first(by, "twitter");
  if (q.includes("facebook")) return first(by, "facebook");
  if (q.includes("twitch")) return first(by, "twitch");
  if (/website|web site|portfolio|personal site|homepage|home page/.test(q)) {
    const urls = site.join("\n") || first(by, "instagram", "youtube");
    if (/describe|about|tell us|what is/.test(q)) {
      return [kit.one_liner || kit.bio_short, urls].filter(Boolean).join("\n\n");
    }
    return urls;
  }
  if (/\bsocials?\b/.test(q) || q.includes("social media")) {
    const social = Object.entries(by)
      .filter(([k]) => k !== "site")
      .flatMap(([, rows]) => rows);
    return (social.length ? social : urls).join("\n");
  }
  if (/\b(links?|urls?|web)\b/.test(q) && !/cover|letter|why|describe|about/.test(q)) return urls.join("\n");
  return null;
}

export function typedLinks(kit) {
  return groupLinks(parseUrls((kit && kit.links) || ""));
}

function igHandle(url) {
  try {
    const first = new URL(url).pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
    if (/^(p|reel|reels|stories|tv|explore|accounts)$/i.test(first)) return "";
    return /^[A-Za-z0-9._]{1,30}$/.test(first) ? first : "";
  } catch {
    return "";
  }
}

function unescapeJs(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return String(raw || "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
}

function formatIg(user, handle) {
  const name = (user.full_name || "").trim();
  const who = (user.username || handle || "").trim();
  const bio = String(user.biography || "").replace(/\\n/g, "\n").trim();
  const ext = (user.external_url || "").trim();
  const followers = user.edge_followed_by && user.edge_followed_by.count;
  const captions = [];
  const edges = (((user.edge_owner_to_timeline_media || {}).edges) || []).slice(0, 12);
  for (const edge of edges) {
    const caps = ((((edge.node || {}).edge_media_to_caption || {}).edges) || []);
    const text = ((((caps[0] || {}).node || {}).text) || "").trim();
    if (text && !captions.includes(text)) captions.push(text.slice(0, 320));
  }
  const lines = [];
  if (who) lines.push("@" + who);
  if (name) lines.push(name);
  if (bio) lines.push("", bio);
  if (ext) lines.push("", "Site: " + ext);
  if (typeof followers === "number" && followers) lines.push("Followers (public): " + followers);
  if (captions.length) {
    lines.push("", "Recent public captions:");
    for (const cap of captions) lines.push("- " + cap);
  }
  return { body: lines.join("\n").trim(), external: ext, title: who ? "@" + who : name, captions, bio, name };
}

function parseIgHtml(html, url) {
  const handle = igHandle(url);
  const grab = (re) => {
    const m = String(html || "").match(re);
    return m ? unescapeJs(m[1]) : "";
  };
  const user = {
    biography: grab(/"biography"\s*:\s*"((?:\\.|[^"\\])*)"/),
    full_name: grab(/"full_name"\s*:\s*"((?:\\.|[^"\\])*)"/),
    username: grab(/"username"\s*:\s*"((?:\\.|[^"\\])*)"/) || handle,
    external_url: grab(/"external_url"\s*:\s*"((?:\\.|[^"\\])*)"/),
    edge_followed_by: {},
    edge_owner_to_timeline_media: { edges: [] },
  };
  if (!user.biography) {
    const og = String(html || "").match(/property=["']og:description["'][^>]+content=["']([^"']+)/i);
    user.biography = og ? og[1] : "";
  }
  return formatIg(user, handle);
}

async function digestInstagram(url) {
  const handle = igHandle(url);
  const headers = {
    Accept: "application/json",
    "X-IG-App-ID": IG_APP,
    "X-ASBD-ID": "129477",
    Referer: "https://www.instagram.com/",
  };
  if (handle) {
    for (const api of [
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${handle}`,
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${handle}`,
    ]) {
      try {
        const page = await httpGet(api, 16000, headers);
        let payload = {};
        try {
          payload = JSON.parse(page.body || "{}");
        } catch {
          payload = {};
        }
        const user = (payload.data && payload.data.user) || payload.user;
        if (user && typeof user === "object") {
          const formatted = formatIg(user, handle);
          if (formatted.body.length >= 12) {
            return {
              url: `https://www.instagram.com/${handle}/`,
              kind: "instagram",
              title: formatted.title,
              body: formatted.body,
              status: "ok",
              socials: formatted.external ? [formatted.external] : [],
              bio: formatted.bio,
              name: formatted.name,
            };
          }
        }
      } catch {
        /* try embed */
      }
    }
    try {
      const embed = await httpGet(`https://www.instagram.com/${handle}/embed/`, 16000);
      const formatted = parseIgHtml(embed.body || "", url);
      if (formatted.body.length >= 12) {
        return {
          url: `https://www.instagram.com/${handle}/`,
          kind: "instagram",
          title: formatted.title,
          body: formatted.body,
          status: "ok",
          socials: formatted.external ? [formatted.external] : [],
          bio: formatted.bio,
          name: formatted.name,
        };
      }
    } catch {
      /* wall */
    }
  }
  return {
    url,
    kind: "instagram",
    title: handle ? "@" + handle : url,
    body: handle
      ? `Instagram handle: @${handle}\nPublic grid was behind a login wall. Bio not available without cookies.`
      : "",
    status: "wall",
    socials: [],
  };
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<(nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSocials(html) {
  const found = [];
  const seen = new Set();
  const blob = String(html || "");
  let m;
  SOCIAL_HREF.lastIndex = 0;
  while ((m = SOCIAL_HREF.exec(blob))) {
    const url = m[0].split("?")[0].replace(/\/+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
    if (found.length >= 8) break;
  }
  return found;
}

function metaContent(html, keys) {
  const blob = String(html || "");
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']+)["']`,
      "i",
    );
    const alt = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${key}["']`,
      "i",
    );
    const m = blob.match(re) || blob.match(alt);
    if (m && m[1].trim()) return m[1].replace(/\s+/g, " ").trim();
  }
  return "";
}

function jsonLdPeople(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    try {
      const data = JSON.parse(m[1].replace(/&quot;/g, '"'));
      const nodes = [];
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (typeof node !== "object") return;
        nodes.push(node);
        if (node["@graph"]) walk(node["@graph"]);
      };
      walk(data);
      for (const n of nodes) {
        const t = String(n["@type"] || "");
        if (/Person|Artist|Organization/i.test(t)) out.push(n);
      }
    } catch {
      /* ignore bad json-ld */
    }
  }
  return out;
}

function aboutLinks(html, base) {
  const found = [];
  const seen = new Set();
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return found;
  }
  const re = /href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    try {
      const u = new URL(m[1], base);
      if (u.origin !== origin) continue;
      const path = u.pathname.toLowerCase();
      if (!/\/(about|about-me|aboutme|bio|biography|artist|cv|resume|statement|who)(\/|$)/i.test(path)) continue;
      const url = u.toString().split("#")[0];
      const key = url.replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(url);
    } catch {
      continue;
    }
    if (found.length >= 3) break;
  }
  return found;
}

function mailtoOf(html) {
  const m = String(html || "").match(/mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  return m ? m[1] : "";
}

function telOf(html) {
  const m = String(html || "").match(/tel:(\+?[0-9().\-\s]{7,})/i);
  return m ? m[1].trim() : "";
}

const BIO_JUNK =
  /cookie|subscribe|newsletter|add to cart|sign in|log in|privacy policy|all rights reserved|skip to|menu|home\s+about\s+contact/i;

function paragraphBio(text) {
  const paras = String(text || "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 80 && p.length <= 1200 && !BIO_JUNK.test(p) && /[a-z]/i.test(p));
  return paras[0] || "";
}

function headingBio(text) {
  const m = String(text || "").match(
    /(?:^|\n)\s*(about(?:\s+me|\s+the\s+artist)?|bio(?:graphy)?|artist statement|statement|who i am)\s*\n+([\s\S]{80,1600})/i,
  );
  if (!m) return "";
  const chunk = m[2]
    .split(/\n{2,}/)[0]
    .replace(/\s+/g, " ")
    .trim();
  return chunk.length >= 60 && !BIO_JUNK.test(chunk) ? chunk.slice(0, 1200) : "";
}

function pickBio({ jsonLd, meta, heading, ig, body }) {
  const ld = (jsonLd && (jsonLd.description || jsonLd.jobTitle)) || "";
  const ranked = [heading, ld, ig, meta, paragraphBio(body)].map((s) => String(s || "").trim()).filter(Boolean);
  return ranked[0] || "";
}

function materialsFrom(blob, crafts) {
  if (crafts.length) return crafts.join(", ");
  const m = String(blob || "").match(
    /(?:i (?:make|create|build|work (?:with|in)|specialize in)|we (?:make|build) )\s*([^.!?\n]{12,180})/i,
  );
  return m ? m[0].trim().slice(0, 220) : "";
}

function takeField(cur, next, autoPrev) {
  const now = String(cur || "").trim();
  const add = String(next || "").trim();
  if (!add) return now;
  if (!now) return add;
  if (autoPrev && now === autoPrev) return add;
  return now;
}

async function digestSite(url) {
  const page = await httpGet(url, 16000);
  const html = page.body || "";
  const titleM = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const people = jsonLdPeople(html);
  const person = people[0] || {};
  const title = (titleM ? titleM[1].replace(/\s+/g, " ").trim() : "") || person.name || url;
  const desc = metaContent(html, ["description", "og:description", "twitter:description"]);
  const text = stripHtml(html).slice(0, 12000);
  const heading = headingBio(text);
  const body = [desc, heading, text].filter(Boolean).join("\n\n").slice(0, 8000);
  const email = mailtoOf(html) || (typeof person.email === "string" ? person.email.replace(/^mailto:/i, "") : "");
  const phone = telOf(html);
  const name = typeof person.name === "string" ? person.name : "";
  return {
    url: page.url || url,
    kind: kindOf(page.url || url),
    title: String(title).slice(0, 160),
    body,
    status: /sign in|log in|login to continue/i.test(html.slice(0, 2000)) ? "wall" : "ok",
    socials: extractSocials(html),
    about: aboutLinks(html, page.url || url),
    bio: pickBio({ jsonLd: person, meta: desc, heading, body: text }),
    email,
    phone,
    name,
  };
}

export async function digestUrl(url) {
  if (kindOf(url) === "instagram") return digestInstagram(url);
  return digestSite(url);
}

function craftsFrom(blob) {
  const low = String(blob || "").toLowerCase();
  return CRAFT.filter(([, needles]) => needles.some((n) => low.includes(n))).map(([name]) => name);
}

export function assembleResume(kit, sources) {
  const name = (kit.full_name || kit.artist_name || "Operator").trim();
  const loc = [kit.city, kit.state, kit.country].filter(Boolean).join(", ");
  const blob = sources.map((s) => s.body || "").join("\n");
  const crafts = craftsFrom(blob + " " + (kit.materials || ""));
  const lines = [`# ${name}`, "", kit.one_liner || "", ""];
  const meta = [loc, kit.email, kit.phone, kit.artist_name].filter(Boolean);
  if (meta.length) {
    lines.push(meta.join(" | "));
    lines.push("");
  }
  lines.push(kit.bio_short || kit.bio_long || "");
  lines.push("");
  if (crafts.length) {
    lines.push("## Labels");
    lines.push(crafts.join(", "));
    lines.push("");
  }
  lines.push("## Web");
  for (const src of sources) {
    if (!src.url) continue;
    const tag = src.status === "wall" ? " (handle kept)" : src.body ? " (read)" : "";
    lines.push(src.url + tag);
  }
  lines.push("");
  lines.push("## Source material");
  for (const src of sources) {
    const body = (src.body || "").trim();
    if (!body || (src.kind === "instagram" && src.status === "wall" && body.length < 80)) continue;
    lines.push(`### ${src.title || src.kind || "Source"}`);
    lines.push("");
    lines.push(body.slice(0, 4000));
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

export async function ingestLinks(kit, onProgress) {
  const base = kit || {};
  const prevAuto = (base.digest && base.digest.auto) || {};
  const urls = parseUrls(base.links || "");
  const sources = [];
  const seen = new Set();
  const queue = [...urls];
  while (queue.length) {
    const url = queue.shift();
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (onProgress) onProgress(`READ ${kindOf(url).toUpperCase()}`);
    let page;
    try {
      page = await digestUrl(url);
    } catch (err) {
      page = { url, kind: kindOf(url), title: url, body: "", status: "error", socials: [], note: String(err.message || err) };
    }
    sources.push(page);
    const follow = [];
    if (page.kind === "site" || (page.kind === "instagram" && page.status === "ok")) {
      follow.push(...(page.socials || []).slice(0, 6));
    }
    if (page.kind === "site") follow.push(...(page.about || []).slice(0, 2));
    for (const extra of follow) {
      const n = extra.replace(/\/+$/, "").toLowerCase();
      if (!seen.has(n)) queue.push(extra);
    }
    if (sources.length >= 16) break;
  }
  const ig = sources.find((s) => s.kind === "instagram" && s.status === "ok") || {};
  const site = sources.find((s) => s.kind === "site" && s.status === "ok") || {};
  const blob = sources.map((s) => s.body || "").join("\n");
  const crafts = craftsFrom(blob + " " + (base.materials || ""));
  const bio = pickBio({
    jsonLd: { description: site.bio, name: site.name },
    meta: site.bio,
    heading: headingBio(site.body || blob),
    ig: ig.bio,
    body: blob,
  });
  const extracted = {
    full_name: site.name || ig.name || "",
    artist_name: (ig.title || "").replace(/^@/, "") || site.name || "",
    email: site.email || "",
    phone: site.phone || "",
    one_liner: (bio || "").split(/(?<=[.!?])\s+/)[0].slice(0, 180),
    bio_short: bio.slice(0, 700),
    bio_long: (bio || site.body || ig.bio || "").slice(0, 1800),
    materials: materialsFrom(blob, crafts),
  };
  const next = { ...base };
  for (const key of Object.keys(extracted)) {
    next[key] = takeField(next[key], extracted[key], prevAuto[key]);
  }
  const allUrls = [];
  for (const src of sources) {
    if (src.url && !allUrls.includes(src.url)) allUrls.push(src.url);
  }
  for (const url of urls) if (!allUrls.includes(url)) allUrls.unshift(url);
  next.links = allUrls.join("\n");
  next.resume = assembleResume(next, sources);
  next.digest = {
    sources: sources.map((s) => ({
      url: s.url,
      kind: s.kind,
      title: s.title,
      status: s.status,
      chars: (s.body || "").length,
    })),
    links_key: next.links,
    auto: extracted,
  };
  return next;
}

export function needsIngest(kit) {
  const links = String((kit && kit.links) || "").trim();
  if (!links) return false;
  if (!(kit && kit.resume)) return true;
  const key = (kit.digest && kit.digest.links_key) || "";
  return key !== links;
}
