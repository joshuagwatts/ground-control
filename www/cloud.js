import { orderFor, orderForEfficient, orderForConsultant } from "./command.js";
import { httpPostJson, httpGet } from "./net.js";
import { agentSystem } from "./crew.js";

/** @type {Array<{id:string, label:string, field:string, base:string, life:string, boost:string, fishy?:boolean, headers?:Record<string,string>}>} */
export const PROVIDERS = [
  {
    id: "groq",
    label: "Groq",
    field: "groq",
    base: "https://api.groq.com/openai/v1",
    // llama-3.3-70b-versatile shut down Aug 16 2026 for free/dev tiers.
    life: "openai/gpt-oss-120b",
    boost: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"],
    reasoning: true,
    keyUrl: "https://console.groq.com/keys",
    tip: "Fast · openai/gpt-oss-120b (Llama 3.3 retired).",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    field: "openrouter",
    base: "https://openrouter.ai/api/v1",
    life: "meta-llama/llama-3.3-70b-instruct:free",
    boost: "qwen/qwen3-coder:free",
    headers: { "HTTP-Referer": "https://github.com/joshuagwatts/ground-control", "X-Title": "Ground Control" },
    keyUrl: "https://openrouter.ai/keys",
    tip: "One key · :free models · vision via Gemini routes.",
    vision: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    field: "cerebras",
    base: "https://api.cerebras.ai/v1",
    // Public catalog is gpt-oss-120b + gemma-4-31b. Old Llama IDs 404.
    life: "gpt-oss-120b",
    boost: "gpt-oss-120b",
    models: ["gpt-oss-120b", "gemma-4-31b"],
    reasoning: true,
    keyUrl: "https://cloud.cerebras.ai",
    tip: "High speed · gpt-oss-120b (402 = add credits on Cerebras).",
  },
  {
    id: "mistral",
    label: "Mistral",
    field: "mistral",
    base: "https://api.mistral.ai/v1",
    life: "mistral-small-latest",
    boost: "mistral-small-latest",
    keyUrl: "https://console.mistral.ai/api-keys/",
    tip: "Paste API key from console.",
  },
  {
    id: "gemini",
    label: "Gemini",
    field: "gemini",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    // gemini-2.0-flash shut down Jun 2026 → 404. Docs now use gemini-3.6-flash.
    life: "gemini-3.6-flash",
    boost: "gemini-3.6-flash",
    models: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-3-flash-preview", "gemini-flash-latest"],
    fishy: true,
    keyUrl: "https://aistudio.google.com/apikey",
    tip: "Google AI Studio key · vision OK for rocks/shingles.",
    vision: true,
  },
  {
    id: "xai",
    label: "Grok",
    field: "xai",
    base: "https://api.x.ai/v1",
    life: "grok-3-mini",
    boost: "grok-3-mini",
    models: ["grok-3-mini", "grok-3-mini-latest", "grok-4", "grok-4-0709", "grok-2-1212", "grok-beta"],
    fishy: true,
    keyUrl: "https://console.x.ai/",
    tip: "xAI console key · /models often 404 — chat ping validates.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    field: "deepseek",
    base: "https://api.deepseek.com",
    life: "deepseek-chat",
    boost: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    tip: "Efficient · strong coding · OpenAI-compatible.",
  },
  {
    id: "openai",
    label: "OpenAI",
    field: "openai",
    base: "https://api.openai.com/v1",
    life: "gpt-4o-mini",
    boost: "gpt-4o",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1-nano"],
    keyUrl: "https://platform.openai.com/api-keys",
    tip: "ChatGPT family · strong vision via gpt-4o.",
    vision: true,
  },
  {
    id: "anthropic",
    label: "Claude",
    field: "anthropic",
    base: "https://api.anthropic.com/v1",
    // Haiku is the cheap/fast default; Sonnet for boost drafts.
    life: "claude-haiku-4-5",
    boost: "claude-sonnet-5",
    models: [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-3-5-haiku-latest",
      "claude-3-haiku-20240307",
    ],
    headers: { "anthropic-version": "2023-06-01" },
    fishy: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    tip: "Anthropic · Claude Haiku by default · OpenAI-compat /v1.",
  },
];

const SPENT_KEY = "groundcontrol.spent.v1";

function loadSpent() {
  try {
    return JSON.parse(localStorage.getItem(SPENT_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveSpent(map) {
  localStorage.setItem(SPENT_KEY, JSON.stringify(map));
}

function spentUntil(msg) {
  const m = String(msg || "");
  if (/daily|per.?day|24.?h|month|quota.?reset/i.test(m)) {
    const d = new Date();
    d.setHours(24, 5, 0, 0);
    return d.getTime();
  }
  return Date.now() + 3 * 60 * 60 * 1000;
}

export function isQuotaFail(msg) {
  return /429|rate.?limit|too many requests|quota|insufficient.?quota|credit|billing|usage.?limit|token.?limit|exceeded your|resource.?exhausted|out of credits|spend.?limit|monthly.?limit|free.?tier.*limit|tokens? per (day|minute|hour)/i.test(
    String(msg || ""),
  );
}

/** True when this API hit quota/rate limits recently — skip until until. */
export function isSpent(id) {
  const key = String(id || "");
  if (!key) return false;
  const map = loadSpent();
  const row = map[key];
  if (!row) return false;
  if (Date.now() > Number(row.until || 0)) {
    delete map[key];
    saveSpent(map);
    return false;
  }
  return true;
}

export function markSpent(id, error = "") {
  const key = String(id || "");
  if (!key) return;
  const map = loadSpent();
  map[key] = {
    until: spentUntil(error),
    error: String(error || "").slice(0, 140),
    at: Date.now(),
  };
  saveSpent(map);
  markHealth(key, false, `MAXED · ${String(error || "quota").slice(0, 80)}`);
}

export function clearSpent(id) {
  const map = loadSpent();
  if (id) {
    delete map[id];
    saveSpent(map);
    return;
  }
  saveSpent({});
}

export function spentMap() {
  const map = loadSpent();
  const out = {};
  for (const [id, row] of Object.entries(map)) {
    if (isSpent(id)) out[id] = row;
  }
  return out;
}

/** Keyed providers that still have budget (not maxed). */
export function usableProviders(settings) {
  return keyedProviders(settings).filter((p) => !isSpent(p.id));
}

export function keyTag(settings, prov, health = null) {
  const key = providerKey(settings, prov);
  if (!key) return { tag: "NO KEY", state: "off" };
  if (isSpent(prov.id)) return { tag: "MAXED", state: "bad" };
  const h = health || liveHealth[prov.id];
  if (h?.ok === true) return { tag: "LIVE", state: "on" };
  if (h?.ok === false) return { tag: /MAXED/i.test(h.error || "") ? "MAXED" : "KEY BAD", state: "bad" };
  return { tag: "KEY SET", state: "key" };
}

export function keyHint(settings, prov) {
  const key = providerKey(settings, prov);
  if (!key) return "";
  if (key.length < 10) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
export function privacyOn(settings) {
  const mode = String(settings.privacy_mode || "leaky").toLowerCase();
  return mode !== "leaky" && mode !== "leak" && mode !== "0" && mode !== "false" && mode !== "off";
}

export function brainPin(settings) {
  return String(settings.brain_pin || "auto").toLowerCase();
}

function providerKey(settings, prov) {
  return normalizeApiKey(settings[prov.field]);
}

/** Strip paste cruft — Bearer prefix, quotes, whitespace. */
export function normalizeApiKey(raw) {
  let k = String(raw || "").trim();
  k = k.replace(/^Bearer\s+/i, "").trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  return k;
}

export function clearHealth(id) {
  delete liveHealth[id];
  return providerHealth();
}

export function keyedProviders(settings) {
  return PROVIDERS.filter((p) => providerKey(settings, p));
}

const liveHealth = {};

export function providerHealth() {
  return { ...liveHealth };
}

export function markHealth(id, ok, error = "") {
  liveHealth[id] = { ok: Boolean(ok), error: String(error || "").slice(0, 120), at: Date.now() };
  return liveHealth[id];
}

/** Restore probe results saved on the phone. */
export function hydrateHealth(saved) {
  if (!saved || typeof saved !== "object") return providerHealth();
  for (const [id, row] of Object.entries(saved)) {
    if (!row || typeof row !== "object") continue;
    // Drop stale "KEY BAD" from the short-lived chat-ping probe (v0.1.51).
    const err = String(row.error || "");
    if (row.ok === false && /empty reply|PIP OK|chat ping|timeout|failed/i.test(err) && !/http 40[13]|invalid.?api|unauthorized|no key/i.test(err)) {
      continue;
    }
    // Stale /models 404 or model-id misses are not "bad key".
    if (row.ok === false && /http 404|empty models|model.*not found|does not exist|not found for api/i.test(err) && !/http 40[13]|invalid.?api|unauthorized/i.test(err)) {
      continue;
    }
    liveHealth[id] = {
      ok: Boolean(row.ok),
      error: err.slice(0, 120),
      at: Number(row.at) || Date.now(),
    };
  }
  return providerHealth();
}

function isAuthFail(msg) {
  return /incorrect.?api.?key|invalid.?api.?key|unauthorized|http 401|authentication/i.test(String(msg || ""));
}

/** Parse "tell Gemini to share with Groq" / "Gemini say something to Groq" relay intents. */
export function parseAgentRelay(text) {
  const agents = "groq|openrouter|gemini|grok|xai|cerebras|mistral|deepseek|openai|chatgpt|claude|anthropic|haiku|sonnet";
  const norm = (id) => {
    const x = String(id || "").toLowerCase();
    if (x === "grok") return "xai";
    if (x === "chatgpt") return "openai";
    if (x === "claude" || x === "haiku" || x === "sonnet") return "anthropic";
    return x;
  };
  const t = String(text || "").trim();
  const speakVerb = "say|tell|talk|message|ask|greet|welcome|introduce|impress";
  // "I want Gemini to say something to Groq" / "have Gemini greet Groq"
  let m = t.match(
    new RegExp(
      `\\b(?:want|tell|ask|have|get|let)\\s+(${agents})\\s+to\\s+(?:(?:${speakVerb})\\s+)?(?:something\\s+)?(?:to\\s+)?(${agents})\\b`,
      "i",
    ),
  );
  if (m && norm(m[1]) !== norm(m[2])) {
    return { from: norm(m[1]), to: norm(m[2]), raw: t, speak: true };
  }
  // "have Gemini greet Groq" (no "to" after speaker)
  m = t.match(
    new RegExp(
      `\\b(?:want|tell|ask|have|get|let)\\s+(${agents})\\s+(?:${speakVerb})\\s+(?:something\\s+)?(?:to\\s+)?(${agents})\\b`,
      "i",
    ),
  );
  if (m && norm(m[1]) !== norm(m[2])) {
    return { from: norm(m[1]), to: norm(m[2]), raw: t, speak: true };
  }
  // "Gemini greet Groq" / "Gemini say something to Groq"
  m = t.match(
    new RegExp(
      `\\b(${agents})\\s+(?:${speakVerb})\\s+(?:something\\s+)?(?:to\\s+|with\\s+|at\\s+)?(${agents})\\b`,
      "i",
    ),
  );
  if (m && norm(m[1]) !== norm(m[2])) {
    return { from: norm(m[1]), to: norm(m[2]), raw: t, speak: true };
  }
  // "Gemini … first impression … to Groq"
  m = t.match(
    new RegExp(
      `\\b(${agents})\\b[\\s\\S]{0,80}?\\b(?:${speakVerb}|make\\s+(?:a\\s+)?(?:good\\s+)?(?:first\\s+)?impression)\\b[\\s\\S]{0,60}?\\b(?:to|with|at)\\s+(${agents})\\b`,
      "i",
    ),
  );
  if (m && norm(m[1]) !== norm(m[2])) {
    return { from: norm(m[1]), to: norm(m[2]), raw: t, speak: true };
  }
  // "tell Gemini to share/send with Groq"
  m = t.match(
    new RegExp(
      `\\b(?:tell|ask|have|get)\\s+(${agents})\\b[\\s\\S]{0,140}?\\b(?:share|send|pass|relay|forward|give)\\b[\\s\\S]{0,100}?\\b(?:with|to)\\s+(${agents})\\b`,
      "i",
    ),
  );
  if (m) return { from: norm(m[1]), to: norm(m[2]), raw: t };
  m = t.match(new RegExp(`\\b(?:share|send|pass|relay|forward)\\b[\\s\\S]{0,80}?\\b(?:with|to)\\s+(${agents})\\b`, "i"));
  if (m) return { from: null, to: norm(m[1]), raw: t };
  m = t.match(
    new RegExp(`\\b(${agents})\\b[\\s\\S]{0,50}?\\b(?:share|send|pass|relay)\\b[\\s\\S]{0,50}?\\b(?:with|to)\\s+(${agents})\\b`, "i"),
  );
  if (m) return { from: norm(m[1]), to: norm(m[2]), raw: t };
  // "Tell Gemini to make a good first impression" + earlier "to Groq"
  m = t.match(new RegExp(`\\b(?:tell|ask|have|get)\\s+(${agents})\\s+to\\b`, "i"));
  if (m) {
    const from = norm(m[1]);
    const toHit = t.match(new RegExp(`\\b(?:to|with|at)\\s+(${agents})\\b`, "i"));
    const to = toHit ? norm(toHit[1]) : null;
    if (to && to !== from) return { from, to, raw: t, speak: true };
    return { from, to: null, raw: t, speak: true };
  }
  // last: bare "say something to Groq" (no speaker named)
  m = t.match(
    new RegExp(`\\b(?:say|tell|talk|message|ask)\\s+(?:something\\s+)?(?:to\\s+)?(${agents})\\b`, "i"),
  );
  if (m) return { from: null, to: norm(m[1]), raw: t, direct: true, speak: true };
  return null;
}

/**
 * Crew relay.
 * speak=true → source agent addresses the target (bubble = source). Used for greetings / first impressions.
 * speak=false → source prepares a handoff; target continues (bubble = target).
 */
export async function agentRelayComplete(
  settings,
  {
    fromId,
    toId,
    payload,
    operator = "Joshua",
    temperature = 0.7,
    maxTokens = 1200,
    speak = false,
  } = {},
) {
  const toProv = toId ? PROVIDERS.find((p) => p.id === toId) : null;
  const fromProv = fromId ? PROVIDERS.find((p) => p.id === fromId) : null;
  let handoff = String(payload || "").trim();
  let fromLabel = "";

  // Speak mode: FROM talks TO the other agent — that speech is the deliverable.
  if (speak && fromProv) {
    const fromKey = providerKey(settings, fromProv);
    if (!fromKey) throw new Error(`No ${fromProv.label} key — paste in DATA`);
    fromLabel = fromProv.label || fromId;
    const toLabel = toProv?.label || toId || "the other agent";
    const out = await openaiWithFallback(fromProv, fromKey, "life", [
      {
        role: "system",
        content:
          `${agentSystem(fromId, operator)}\n` +
          `You are speaking directly to ${toLabel} (another AI on Joshua's crew). ` +
          `Address them by name. First impression — clear, sharp, no meta ("as an AI…"). ` +
          `Do not reply to Joshua; speak to ${toLabel}.`,
      },
      {
        role: "user",
        content: `Joshua's instruction:\n${handoff}\n\nNow speak to ${toLabel}.`,
      },
    ], temperature, Math.min(maxTokens, 600));
    markHealth(fromId, true);
    return {
      text: out.text,
      provider: out.provider,
      model: out.model,
      from: fromId,
      to: toId || null,
      speaker: fromId,
      handoff: String(out.text || "").trim(),
      tokens: Number(out.tokens) || 0,
      speak: true,
    };
  }

  if (!toProv) throw new Error(`Unknown agent: ${toId || "?"}`);
  const toKey = providerKey(settings, toProv);
  if (!toKey) throw new Error(`No ${toProv.label} key — paste in DATA`);

  if (fromProv && fromId !== toId) {
    const fromKey = providerKey(settings, fromProv);
    if (!fromKey) throw new Error(`No ${fromProv.label} key — paste in DATA`);
    fromLabel = fromProv.label || fromId;
    const prep = await openaiWithFallback(fromProv, fromKey, "life", [
      {
        role: "system",
        content:
          `${agentSystem(fromId, operator)}\n` +
          `Prepare a concise handoff for ${toProv.label}. Include facts, code, lists, or conclusions — no meta commentary.`,
      },
      { role: "user", content: `Hand off to ${toProv.label}:\n\n${handoff}` },
    ], temperature, maxTokens);
    markHealth(fromId, true);
    handoff = String(prep.text || handoff).trim();
  }

  const out = await openaiWithFallback(toProv, toKey, "life", [
    { role: "system", content: agentSystem(toId, operator) },
    {
      role: "user",
      content: fromLabel
        ? `${fromLabel} sent you this:\n\n${handoff}\n\nContinue the task as yourself.`
        : handoff,
    },
  ], temperature, maxTokens);
  markHealth(toId, true);
  return {
    text: out.text,
    provider: out.provider,
    model: out.model,
    from: fromId || null,
    to: toId,
    speaker: toId,
    handoff,
    tokens: Number(out.tokens) || 0,
    speak: false,
  };
}

async function validateOne(settings, prov) {
  // xAI + Gemini often 404 on /models even with valid keys — chat ping is truth.
  if (prov.fishy || prov.id === "xai") {
    const ping = await chatPing(settings, prov);
    if (ping.ok) return { ok: true, id: prov.id, models: 1, via: "chat" };
    if (isAuthFail(ping.error)) return { ok: false, id: prov.id, error: ping.error };
    const r = await probeModels(settings, prov);
    if (r.ok) return r;
    return { ok: false, id: prov.id, error: ping.error || r.error, soft: true };
  }
  const ping = await chatPing(settings, prov);
  if (ping.ok) return { ok: true, id: prov.id, models: 1, via: "chat" };
  if (isAuthFail(ping.error)) return { ok: false, id: prov.id, error: ping.error };
  const r = await probeModels(settings, prov);
  if (r.ok) return r;
  if (isAuthFail(r.error)) return { ok: false, id: prov.id, error: r.error };
  return { ok: false, id: prov.id, error: ping.error || r.error, soft: true };
}

export async function probeModels(settings, prov) {
  const key = providerKey(settings, prov);
  if (!key) {
    return { ok: false, id: prov.id, error: "no key" };
  }
  try {
    const { body, status } = await httpGet(`${prov.base.replace(/\/$/, "")}/models`, 12000, {
      Authorization: `Bearer ${key}`,
      ...(prov.headers || {}),
    });
    if (!status) throw new Error("network failed (status 0)");
    if (status === 401 || status === 403) throw new Error(`http ${status} unauthorized`);
    if (status >= 400) throw new Error(`http ${status}`);
    let data = {};
    try {
      data = JSON.parse(body || "{}");
    } catch {
      throw new Error("bad JSON from /models");
    }
    const n = Array.isArray(data.data)
      ? data.data.length
      : Array.isArray(data.models)
        ? data.models.length
        : data.object === "list" || data.data
          ? 1
          : 0;
    if (!n && !Array.isArray(data.data) && body && body.length < 8) throw new Error("empty models");
    if (!n && !data.data && !data.models && !data.object) throw new Error("empty models body");
    return { ok: true, id: prov.id, models: n || 1 };
  } catch (e) {
    return { ok: false, id: prov.id, error: String(e.message || e).slice(0, 160) };
  }
}

/**
 * Auto-check keyed APIs (/models auth). Bad keys → red. No manual probe button.
 */
export async function validateKeyed(settings, { only } = {}) {
  let keyed = keyedProviders(settings);
  if (only != null) {
    const id = String(only).toLowerCase();
    keyed = keyed.filter((p) => p.id === id || p.field === id);
  }
  const jobs = keyed.map(async (prov) => {
    const r = await validateOne(settings, prov);
    if (r.ok) markHealth(prov.id, true);
    else if (isAuthFail(r.error)) markHealth(prov.id, false, r.error);
    else clearHealth(prov.id);
    return { id: prov.id, label: prov.label, ...r };
  });
  return Promise.all(jobs);
}

/** @deprecated use validateKeyed */
export async function probeKeyed(settings) {
  return validateKeyed(settings);
}

export function cloudStatus(settings) {
  const leaky = !privacyOn(settings);
  const pin = brainPin(settings);
  const keyed = keyedProviders(settings);
  return {
    leaky,
    pin,
    keyed: keyed.map((p) => p.id),
    grok: Boolean(providerKey(settings, PROVIDERS.find((x) => x.id === "xai"))),
    health: providerHealth(),
  };
}

function modelFor(prov, lane) {
  return lane === "boost" ? prov.boost : prov.life;
}

function laneForJob(job) {
  if (job === "boost" || job === "code") return "boost";
  return "life";
}

function modelsFor(prov, lane) {
  const primary = modelFor(prov, lane);
  const extras = Array.isArray(prov.models) ? prov.models : [];
  return [...new Set([primary, ...extras].filter(Boolean))];
}

function messageText(msg) {
  if (!msg || typeof msg !== "object") return "";
  const c = msg.content;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (Array.isArray(c)) {
    const joined = c
      .map((p) => {
        if (typeof p === "string") return p;
        if (!p || typeof p !== "object") return "";
        return p.text || p.content || p.output_text || "";
      })
      .join("")
      .trim();
    if (joined) return joined;
  }
  // gpt-oss / reasoning models often put the answer in reasoning fields with empty content.
  const reasoned = String(msg.reasoning || msg.reasoning_content || msg.refusal || "").trim();
  if (!reasoned) return "";
  // Prefer last non-empty paragraph after thinking markers.
  const cleaned = reasoned
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^thinking[:\s].*$/gim, "")
    .trim();
  return cleaned || reasoned;
}

/** LIVE cloud ids (probe ok) — chat should prefer these. */
export function liveProviderIds(settings) {
  const health = providerHealth();
  return usableProviders(settings)
    .map((p) => p.id)
    .filter((id) => health[id]?.ok === true);
}

/**
 * Pack chat history for cloud APIs:
 * one system (Pip voice) + recent user/assistant turns.
 * Avoids multi-system / long few-shot dumps that free APIs reject.
 */
export function packMessagesForCloud(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = [];
  const turns = [];
  for (const m of list) {
    if (!m) continue;
    const role = m.role === "assistant" || m.role === "pip" ? "assistant" : m.role === "system" ? "system" : "user";
    if (Array.isArray(m.content)) {
      // Multimodal (text + image_url) — keep structure for vision APIs.
      const parts = m.content
        .map((p) => {
          if (!p || typeof p !== "object") return null;
          if (p.type === "text" && p.text) return { type: "text", text: String(p.text).slice(0, 6000) };
          if (p.type === "image_url" && p.image_url?.url) {
            return { type: "image_url", image_url: { url: String(p.image_url.url) } };
          }
          return null;
        })
        .filter(Boolean);
      if (!parts.length) continue;
      if (role === "system") {
        systems.push(parts.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
      } else {
        turns.push({ role, content: parts });
      }
      continue;
    }
    const content = String(m.content || "").trim();
    if (!content) continue;
    if (role === "system") systems.push(content);
    else turns.push({ role, content: content.slice(0, 6000) });
  }
  const system = systems.join("\n\n").slice(0, 8000);
  const recent = turns.slice(-12);
  const out = [];
  if (system) out.push({ role: "system", content: system });
  out.push(...recent);
  if (!out.length) out.push({ role: "user", content: "hey" });
  return out;
}

/** Minimal payload when full history/system gets rejected by free-tier APIs. */
export function slimMessagesForCloud(messages) {
  const packed = packMessagesForCloud(messages);
  const system = packed.find((m) => m.role === "system")?.content || "";
  const user = [...packed].reverse().find((m) => m && m.role === "user");
  const slimSys =
    (typeof system === "string"
      ? system
          .split("\n")
          .filter((line) => !/^Voice examples|^Job:/i.test(line.trim()))
          .slice(0, 12)
          .join("\n")
          .slice(0, 1400)
      : "") || "You are Pip — direct, warm, honest. Stay in character.";
  let userContent = "hey";
  if (user) {
    if (Array.isArray(user.content)) {
      userContent = user.content.map((p) => {
        if (p?.type === "text") return { type: "text", text: String(p.text || "").slice(0, 4000) };
        if (p?.type === "image_url") return p;
        return null;
      }).filter(Boolean);
      if (!userContent.length) userContent = "hey";
    } else {
      userContent = String(user.content || "hey").slice(0, 4000);
    }
  }
  return [
    { role: "system", content: slimSys },
    { role: "user", content: userContent },
  ];
}

async function openaiOnce(prov, key, model, messages, temperature, maxTokens, tools) {
  const packed = packMessagesForCloud(messages);
  const payload = {
    model,
    messages: packed,
    temperature: Math.min(1, Math.max(0, Number(temperature) || 0.7)),
    max_tokens: Math.min(4096, Math.max(64, Number(maxTokens) || 1024)),
  };
  // Only gpt-oss-style models want reasoning_effort — others 400 on unknown fields.
  if (prov.reasoning && /gpt-oss|o1|o3|reasoning/i.test(model)) {
    payload.reasoning_effort = "low";
  }
  if (tools && tools.length) payload.tools = tools;
  let data;
  try {
    data = await httpPostJson(
      `${prov.base.replace(/\/$/, "")}/chat/completions`,
      {
        Authorization: `Bearer ${key}`,
        ...(prov.headers || {}),
      },
      payload,
      45000,
    );
  } catch (e) {
    throw new Error(`${prov.id}: ${String(e.message || e).slice(0, 140)}`);
  }
  if (data?.error) {
    const err = data.error;
    const msg = typeof err === "string" ? err : err.message || JSON.stringify(err);
    throw new Error(`${prov.id}: ${String(msg).slice(0, 140)}`);
  }
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  let text = messageText(msg);
  if (!text) text = messageText(choice);
  if (!text && !(msg.tool_calls || []).length) throw new Error(`${prov.id} empty reply`);
  const usage = data.usage || {};
  const tokens =
    (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0) ||
    Number(usage.total_tokens) ||
    0;
  return {
    text,
    message: msg,
    tool_calls: msg.tool_calls || [],
    provider: prov.id,
    model,
    tokens,
    usage,
  };
}

async function openaiWithFallback(prov, key, lane, messages, temperature, maxTokens, tools) {
  const errors = [];
  const models = modelsFor(prov, lane);
  for (const model of models) {
    try {
      return await openaiOnce(prov, key, model, messages, temperature, maxTokens, tools);
    } catch (e) {
      const msg = String(e.message || e);
      errors.push(msg.slice(0, 120));
      // Bad key won't magically work on another model ID.
      if (isAuthFail(msg)) break;
    }
  }
  if (!errors.some(isAuthFail)) {
    const slim = slimMessagesForCloud(messages);
    for (const model of models.slice(0, 3)) {
      try {
        const out = await openaiOnce(prov, key, model, slim, temperature, maxTokens, tools);
        return { ...out, slim: true };
      } catch (e) {
        const msg = String(e.message || e);
        errors.push(`slim/${model}: ${msg.slice(0, 100)}`);
        if (isAuthFail(msg)) break;
      }
    }
  }
  throw new Error(errors.join(" · ") || `${prov.id} failed`);
}

/** CHAT — fastest reliable brains first (orderFor / JOBS.life owns the cascade). */
export function chatCloudEnabled(settings) {
  return keyedProviders(settings).length > 0;
}

export function chatChain(settings, job = "life", ask = "") {
  const pin = brainPin(settings);
  if (pin === "local" || pin === "lite" || pin === "qwen") return [];
  const keyedIds = usableProviders(settings).map((p) => p.id);
  // Explicit agent pick (groq/gemini/cerebras/…) — ONLY that brain. Never silent-fallback to another API.
  if (pin && pin !== "auto" && pin !== "compare" && pin !== "all" && pin !== "desktop") {
    const only = PROVIDERS.find((p) => p.id === pin);
    if (only && keyedIds.includes(pin)) return [only];
    // Pinned but spent — fail clear rather than silent-switch.
    if (only && providerKey(settings, only) && isSpent(pin)) {
      return [];
    }
    return [];
  }
  // Vision pin — only providers that accept image_url.
  if (pin === "vision") {
    const order = ["gemini", "openai", "anthropic", "openrouter"];
    return order.map((id) => PROVIDERS.find((p) => p.id === id)).filter((p) => p && keyedIds.includes(p.id));
  }
  const effectivePin = pin === "compare" || pin === "all" ? "auto" : pin;
  const mode = String(settings.route_mode || "").toLowerCase();
  // AUTO = efficient cascade. PIP (default for auto-pin chat) = consultant fit.
  const ids =
    mode === "auto"
      ? orderForEfficient(keyedIds, liveHealth, ask)
      : mode === "pip"
        ? orderForConsultant(keyedIds, liveHealth, ask, job)
        : orderFor(job, keyedIds, liveHealth, effectivePin, ask);
  return ids.map((id) => PROVIDERS.find((p) => p.id === id)).filter(Boolean);
}

/** OPP/CODE cloud chain — same LIVE upscale/downscale as CHAT when LEAKY. */
export function chain(settings, lane = "life", ask = "") {
  if (privacyOn(settings)) return [];
  const pin = brainPin(settings);
  const keyedIds = usableProviders(settings).map((p) => p.id);
  const job = lane === "boost" ? "boost" : lane === "code" ? "code" : "life";
  const mode = String(settings.route_mode || "").toLowerCase();
  const ids =
    mode === "auto"
      ? orderForEfficient(keyedIds, liveHealth, ask)
      : mode === "pip"
        ? orderForConsultant(keyedIds, liveHealth, ask, job)
        : orderFor(job, keyedIds, liveHealth, pin, ask);
  return ids.map((id) => PROVIDERS.find((p) => p.id === id)).filter(Boolean);
}

export async function cloudCompleteTools(settings, messages, tools, lane = "boost", temperature = 0.2, maxTokens = 8000) {
  const errors = [];
  for (const prov of chain(settings, lane)) {
    if (isSpent(prov.id)) continue;
    const key = providerKey(settings, prov);
    if (!key) continue;
    try {
      const out = await openaiWithFallback(prov, key, lane, messages, temperature, maxTokens, tools);
      markHealth(prov.id, true);
      return out;
    } catch (e) {
      const msg = String(e.message || e);
      if (isQuotaFail(msg)) markSpent(prov.id, msg);
      else markHealth(prov.id, false, msg.slice(0, 120));
      errors.push(`${prov.id}: ${msg.slice(0, 120)}`);
    }
  }
  throw new Error(errors.join(" · ") || "CODE needs LEAKY + a cloud key, or pair desktop for GPU code edits");
}

export async function chatComplete(settings, messages, temperature = 0.7, maxTokens = 1024, job = "life") {
  const errors = [];
  const pin = brainPin(settings);
  const pinned =
    pin && pin !== "auto" && pin !== "compare" && pin !== "all" && pin !== "desktop" && pin !== "local" && pin !== "lite" && pin !== "qwen";
  const user = [...(messages || [])].reverse().find((m) => m && m.role === "user");
  const ask = typeof user?.content === "string" ? user.content : "";
  const chainList = chatChain(settings, job, ask);
  if (!chainList.length) {
    if (pinned && isSpent(pin)) throw new Error(`${pin.toUpperCase()} maxed — quota/rate limit. Try another agent or wait.`);
    if (pinned) throw new Error(`${pin.toUpperCase()} not keyed — paste key in DATA or pick another agent`);
    throw new Error("no keyed chat brains — paste keys in DATA or unpin");
  }
  for (const prov of chainList) {
    if (isSpent(prov.id)) continue;
    const key = providerKey(settings, prov);
    if (!key) continue;
    try {
      const out = await openaiWithFallback(prov, key, laneForJob(job), messages, temperature, maxTokens);
      markHealth(prov.id, true);
      return out;
    } catch (e) {
      const msg = String(e.message || e);
      if (isQuotaFail(msg)) markSpent(prov.id, msg);
      else if (isAuthFail(msg)) markHealth(prov.id, false, msg);
      // Soft miss — keep prior LIVE so hierarchy isn't poisoned by one timeout.
      errors.push(`${prov.id}: ${msg.slice(0, 120)}`);
    }
  }
  if (pinned) {
    throw new Error(errors[0] || `${pin.toUpperCase()} failed`);
  }
  throw new Error(errors.join(" · ") || "no cloud brain keyed");
}

/** One-shot chat ping — validates key beyond /models. */
export async function chatPing(settings, prov) {
  const key = providerKey(settings, prov);
  if (!key) return { ok: false, id: prov.id, error: "no key" };
  try {
    const out = await openaiWithFallback(
      prov,
      key,
      "life",
      [
        { role: "system", content: "Reply with exactly: PIP OK" },
        { role: "user", content: "ping" },
      ],
      0,
      16,
    );
    const ok = /pip\s*ok/i.test(out.text || "") || Boolean(String(out.text || "").trim());
    if (ok) markHealth(prov.id, true);
    return { ok, id: prov.id, model: out.model, text: out.text };
  } catch (e) {
    // Do not poison /models LIVE — chat fail is a separate signal.
    return { ok: false, id: prov.id, error: String(e.message || e).slice(0, 160) };
  }
}

const AGENT_ALIASES = {
  grok: "xai",
  chatgpt: "openai",
  claude: "anthropic",
  haiku: "anthropic",
  sonnet: "anthropic",
};

function normAgentId(id) {
  const x = String(id || "").toLowerCase();
  return AGENT_ALIASES[x] || x;
}

/** Brains with keys attached — skip maxed + known-bad until re-paste/re-validate. */
export function compareProviders(settings, health = null) {
  const h = health || liveHealth;
  return keyedProviders(settings).filter((p) => !isSpent(p.id) && h[p.id]?.ok !== false);
}

/** "Say something to Gemini" / crew cross-talk in COMPARE. */
export function parseCrossAgentIntent(text) {
  const agents = "groq|openrouter|gemini|grok|xai|cerebras|mistral|deepseek|openai|chatgpt|claude|anthropic|haiku|sonnet";
  const t = String(text || "").trim();
  const relay = parseAgentRelay(t);
  if (relay?.from && relay?.to) {
    const fromProv = PROVIDERS.find((p) => p.id === relay.from);
    const toProv = PROVIDERS.find((p) => p.id === relay.to);
    return {
      from: relay.from,
      to: relay.to,
      fromLabel: fromProv?.label || relay.from,
      toLabel: toProv?.label || relay.to,
      target: relay.to,
      targetLabel: toProv?.label || relay.to,
      speak: Boolean(relay.speak),
      raw: t,
    };
  }
  let m = t.match(
    new RegExp(
      `\\b(?:say|tell|talk|message|ask|welcome|greet|introduce)\\s+(?:something\\s+)?(?:to\\s+)?(${agents})\\b`,
      "i",
    ),
  );
  if (m) {
    const target = normAgentId(m[1]);
    const prov = PROVIDERS.find((p) => p.id === target);
    return { target, targetLabel: prov?.label || target, raw: t };
  }
  m = t.match(new RegExp(`\\b(?:for|to)\\s+(${agents})\\b`, "i"));
  if (m) {
    const target = normAgentId(m[1]);
    const prov = PROVIDERS.find((p) => p.id === target);
    return { target, targetLabel: prov?.label || target, raw: t };
  }
  return null;
}

function compareUserContent(prov, operator, ask, crossHint, prior) {
  const name = prov.label || prov.id;
  let userContent = ask;
  const crewLines = [];
  for (const m of prior || []) {
    if (!m?.content) continue;
    if (Array.isArray(m.compare)) {
      for (const c of m.compare) {
        if (c?.ok && c.text) {
          crewLines.push(`${String(c.label || c.provider || "?").toUpperCase()}: ${String(c.text).slice(0, 500)}`);
        }
      }
    } else if (m.agent && m.agent !== "pip" && m.agent !== "auto" && m.agent !== "compare") {
      crewLines.push(`${String(m.agent).toUpperCase()}: ${String(m.content).slice(0, 500)}`);
    }
  }
  const listenBlock =
    crewLines.length > 0
      ? `\n\nCrew floor (you can hear them — one conversation, do not start a loop):\n${crewLines.slice(-6).join("\n")}`
      : "";

  if (crossHint?.from && crossHint?.to) {
    if (crossHint.to === prov.id) {
      userContent =
        `Joshua to the crew: "${ask}"\n\n` +
        `You're ${name}. ${crossHint.fromLabel || "A crewmate"} may speak to you. ` +
        `Listen. When they address you, answer them briefly as yourself, then include Joshua. ` +
        `Do not demand another round.${listenBlock}`;
    } else if (crossHint.from === prov.id) {
      userContent =
        `Joshua to the crew: "${ask}"\n\n` +
        `You're ${name}. Speak directly to ${crossHint.toLabel || "your crewmate"} — first impression / message. ` +
        `Address them by name. Joshua is listening.${listenBlock}`;
    } else {
      userContent =
        `Joshua to the crew: "${ask}"\n\n` +
        `You're ${name}. ${crossHint.fromLabel || "Someone"} is speaking to ${crossHint.toLabel || "another agent"}. ` +
        `Stay brief; you may react once if useful. No pile-on.${listenBlock}`;
    }
  } else if (crossHint?.target) {
    if (crossHint.target === prov.id) {
      userContent =
        `Joshua to the crew: "${ask}"\n\n` +
        `You're ${name}. This is directed at you — first impression, make it count. Reply as yourself to Joshua.${listenBlock}`;
    } else {
      userContent =
        `Joshua to the crew: "${ask}"\n\n` +
        `You're ${name}. Part of this is for ${crossHint.targetLabel}. ` +
        `Reply to Joshua; you may acknowledge ${crossHint.targetLabel} naturally if it fits.${listenBlock}`;
    }
  } else if (listenBlock) {
    userContent = `Joshua: "${ask}"${listenBlock}\n\nReply as ${name} in the shared conversation.`;
  }

  const priorMsgs = (prior || [])
    .filter((m) => m && m.content && !m.image && !m.compare)
    .slice(-8)
    .map((m) => {
      const who =
        m.role === "user"
          ? null
          : m.agent && m.agent !== "pip" && m.agent !== "auto" && m.agent !== "compare"
            ? String(m.agent).toUpperCase()
            : null;
      return {
        role: m.role === "user" ? "user" : "assistant",
        content: who ? `[${who}]: ${String(m.content).slice(0, 1200)}` : String(m.content).slice(0, 1200),
      };
    });
  return [
    { role: "system", content: agentSystem(prov.id, operator) },
    ...priorMsgs,
    { role: "user", content: userContent },
  ];
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]);
}

/**
 * Parallel compare — streams each brain as it finishes (no waiting on slow/dead APIs).
 * Each agent gets its own native system prompt (not Pip's voice).
 */
export async function compareComplete(
  settings,
  messages,
  temperature = 0.7,
  maxTokens = 1024,
  job = "life",
  { onPartial, timeoutMs = 26000, crossHint, health, prior } = {},
) {
  void job;
  const keyed = compareProviders(settings, health);
  if (!keyed.length) throw new Error("no keyed chat brains — paste keys in DATA");
  const user = [...(messages || [])].reverse().find((m) => m && m.role === "user");
  const ask = String((user && user.content) || "").trim() || "hey";
  const operator = settings?.operator || "Joshua";
  const history = prior || (messages || []).filter((m) => m.role === "user" || m.role === "assistant" || m.role === "pip");
  const slots = keyed.map((prov) => ({
    provider: prov.id,
    label: prov.label || prov.id,
    text: "",
    ok: false,
    pending: true,
  }));

  const emitPartial = (row, index) => {
    slots[index] = { ...row, pending: false };
    const snap = slots.map((r) => ({ ...r }));
    if (onPartial) onPartial(row, snap, { done: snap.filter((r) => !r.pending).length, total: keyed.length });
  };

  if (onPartial) onPartial(null, [...slots], { done: 0, total: keyed.length });

  const jobs = keyed.map((prov, index) => {
    const key = providerKey(settings, prov);
    if (!key) {
      const row = { provider: prov.id, label: prov.label || prov.id, text: "", error: "no key", ok: false };
      emitPartial(row, index);
      return Promise.resolve(row);
    }
    const run = async () => {
      try {
        const perAgent = compareUserContent(prov, operator, ask, crossHint, history);
        const out = await openaiWithFallback(prov, key, "life", perAgent, temperature, maxTokens);
        markHealth(prov.id, true);
        return {
          provider: out.provider,
          label: prov.label || prov.id,
          model: out.model,
          text: out.text,
          tokens: Number(out.tokens) || 0,
          ok: true,
        };
      } catch (e) {
        const err = String(e.message || e).slice(0, 160);
        if (isQuotaFail(err)) markSpent(prov.id, err);
        return {
          provider: prov.id,
          label: prov.label || prov.id,
          text: "",
          error: err,
          ok: false,
        };
      }
    };
    return withTimeout(run(), timeoutMs, prov.label || prov.id)
      .catch((e) => {
        const err = String(e.message || e).slice(0, 160);
        if (isQuotaFail(err)) markSpent(prov.id, err);
        return {
          provider: prov.id,
          label: prov.label || prov.id,
          text: "",
          error: err,
          ok: false,
        };
      })
      .then((row) => {
        emitPartial(row, index);
        return row;
      });
  });

  const settled = await Promise.all(jobs);
  const ok = settled.filter((r) => r && r.ok && r.text);
  if (!ok.length) {
    throw new Error(settled.map((r) => `${r.label || r.provider}: ${r.error || "fail"}`).join(" · ") || "compare failed");
  }
  return {
    text: ok[0].text,
    provider: ok[0].provider,
    model: ok[0].model,
    tokens: ok[0].tokens,
    compare: settled,
    leaked: true,
  };
}

export async function cloudComplete(settings, messages, lane = "life", temperature = 0.7, maxTokens = 400) {
  const errors = [];
  for (const prov of chain(settings, lane)) {
    const key = providerKey(settings, prov);
    if (!key) continue;
    try {
      const out = await openaiWithFallback(prov, key, lane, messages, temperature, maxTokens);
      markHealth(prov.id, true);
      return out;
    } catch (e) {
      errors.push(`${prov.id}: ${String(e.message || e).slice(0, 120)}`);
    }
  }
  throw new Error(errors.join(" · ") || "no cloud brain keyed");
}

export async function probeProvider(settings, providerId) {
  const prov = PROVIDERS.find((p) => p.id === providerId);
  if (!prov) return { ok: false, error: "unknown provider" };
  const key = providerKey(settings, prov);
  if (!key) return { ok: false, error: "no key" };
  try {
    const out = await openaiOnce(
      prov,
      key,
      prov.life,
      [
        { role: "system", content: "Reply with exactly: PIP OK" },
        { role: "user", content: "ping" },
      ],
      0,
      8,
    );
    return { ok: /pip ok/i.test(out.text), provider: prov.id, sample: out.text.slice(0, 40) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
