/** Lightweight public-web lookup for CHAT — normal LLM style, not a Guide tab. */
import { httpGet } from "./net.js";

const WANT_WEB =
  /^(?:what|who|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|tell me|look up|lookup|search|find|latest|current|news|explain|define)\b/i;
const SKIP_WEB =
  /\b(apply|application|cover letter|theme|ui color|meal plan|macros?|hail|storm|radar|pair desktop|proton)\b/i;

export function wantsWeb(text) {
  const t = String(text || "").trim();
  if (t.length < 8 || t.length > 280) return false;
  if (SKIP_WEB.test(t)) return false;
  if (WANT_WEB.test(t)) return true;
  return /\?$/.test(t) && t.split(/\s+/).length >= 4;
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function duckInstant(q) {
  const url = `https://api.duckduckgo.com/?${new URLSearchParams({
    q,
    format: "json",
    no_html: "1",
    skip_disambig: "1",
  })}`;
  const { body } = await httpGet(url, 10000);
  const data = JSON.parse(body || "{}");
  const bits = [];
  if (data.AbstractText) {
    bits.push({
      title: data.Heading || "DuckDuckGo",
      text: String(data.AbstractText).slice(0, 900),
      url: data.AbstractURL || "",
      source: "duckduckgo",
    });
  }
  for (const t of data.RelatedTopics || []) {
    if (bits.length >= 3) break;
    const row = t.Topics ? t.Topics[0] : t;
    if (!row?.Text) continue;
    bits.push({
      title: stripHtml(row.Text).slice(0, 80),
      text: stripHtml(row.Text).slice(0, 400),
      url: row.FirstURL || "",
      source: "duckduckgo",
    });
  }
  return bits;
}

async function wikiSummary(q) {
  const slug = encodeURIComponent(String(q || "").trim().replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
  try {
    const { body, status } = await httpGet(url, 10000);
    if (status === 404) return null;
    const data = JSON.parse(body || "{}");
    const extract = String(data.extract || "").trim();
    if (!extract) return null;
    return {
      title: data.title || q,
      text: extract.slice(0, 900),
      url: data.content_urls?.desktop?.page || "",
      source: "wikipedia",
    };
  } catch {
    return null;
  }
}

/** Pull a short web brief for the LLM. Never throws. */
export async function webBrief(text) {
  const q = String(text || "").trim();
  if (!q || !wantsWeb(q)) return "";
  const hits = [];
  try {
    hits.push(...(await duckInstant(q)));
  } catch {
    /* optional */
  }
  if (!hits.length) {
    try {
      const w = await wikiSummary(q);
      if (w) hits.push(w);
    } catch {
      /* optional */
    }
  }
  if (!hits.length) return "";
  return [
    "Live web notes (use these; say if unsure):",
    ...hits.slice(0, 3).map((h, i) => {
      const src = h.url ? ` · ${h.url}` : "";
      return `${i + 1}. ${h.title} (${h.source})${src}\n${h.text}`;
    }),
  ].join("\n\n");
}
