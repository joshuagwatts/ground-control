/** Phone brain — privacy-first chain, cloud only when needed, leak tags for the UI. */
import { FALLBACK, isBlank, sanitizeReply, talkSystem, SHOTS, agentSystem, pipOrchestratorSystem, agentLabel, autoSystem } from "./crew.js";
import {
  chatChain,
  chatComplete,
  chatCloudEnabled,
  cloudComplete,
  cloudStatus,
  compareComplete,
  liveProviderIds,
  markHealth,
  parseCrossAgentIntent,
  privacyOn,
  providerHealth,
  usableProviders,
} from "./cloud.js";
import { draftVoice } from "./kind.js";
import { typedLinks } from "./digest.js";
import { pickJob, skipLocalModel } from "./command.js";
import { liteComplete } from "./piplite.js";
import { normalizeVisionImages } from "./vision.js";

const QWEN_MLC = [
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
];
const QWEN_TF = "onnx-community/Qwen2.5-0.5B-Instruct";

let backend = null;
let loading = null;
let lastProgress = "";
let lastBrain = { label: "—", provider: "", model: "" };
/** @type {{ leaked:boolean, provider:string, via:string, reason:string, tokens:number }} */
let lastTurn = { leaked: false, provider: "", via: "", reason: "", tokens: 0 };
let pendingTheme = null;
const listeners = new Set();

export function takePendingTheme() {
  const hit = pendingTheme;
  pendingTheme = null;
  return hit;
}

export function takeLastTurn() {
  const hit = { ...lastTurn };
  lastTurn = { leaked: false, provider: "", via: "", reason: "" };
  return hit;
}

export function peekLastTurn() {
  return { ...lastTurn };
}

export function brainReady() {
  return true;
}

export function pipStatus() {
  if (backend) return "PIP ON DECK";
  if (loading) return lastProgress || "PIP // WAKING";
  return lastProgress || "PIP ON DECK";
}

export function activeBrain() {
  return { ...lastBrain };
}

function setBrain(provider, model) {
  const label =
    provider === "desktop"
      ? "DESKTOP"
      : provider === "xai"
        ? "GROK"
        : provider === "local"
          ? "QWEN"
          : provider === "lite"
            ? "LITE"
            : provider === "web"
            ? "WEB"
            : String(provider || "PIP").toUpperCase();
  lastBrain = { label, provider: provider || "", model: model || "" };
}

function setTurn({ leaked = false, provider = "", via = "", reason = "", tokens = 0 } = {}) {
  lastTurn = {
    leaked: Boolean(leaked),
    provider: String(provider || ""),
    via: String(via || ""),
    reason: String(reason || ""),
    tokens: Number(tokens) || 0,
  };
  if (provider) setBrain(provider, via);
}

function emit(msg) {
  lastProgress = String(msg || "").slice(0, 56);
  for (const fn of listeners) {
    try {
      fn(lastProgress);
    } catch {
      /* ignore */
    }
  }
}

function track(onProgress) {
  if (typeof onProgress === "function") listeners.add(onProgress);
}

async function loadMod(urls) {
  let last = "";
  for (const url of urls) {
    try {
      return await import(url);
    } catch (e) {
      last = String(e.message || e);
    }
  }
  throw new Error(last || "could not load Qwen runtime");
}

function formatQwenChat(messages) {
  let out = "";
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    out += `<|im_start|>${role}\n${m.content || ""}\n`;
  }
  out += "<|im_start|>assistant\n";
  return out;
}

function stripQwenAssistant(raw, prompt) {
  let text = String(raw || "");
  if (prompt && text.startsWith(prompt)) text = text.slice(prompt.length);
  const marker = "<|im_start|>assistant";
  const idx = text.lastIndexOf(marker);
  if (idx >= 0) text = text.slice(idx + marker.length);
  text = text.split("<|im_end|>")[0];
  text = text.split("<|im_start|>")[0];
  return sanitizeReply(text.trim());
}

async function makeWebLlm() {
  const webllm = await loadMod([
    "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm",
    "https://esm.run/@mlc-ai/web-llm",
  ]);
  const create = webllm.CreateMLCEngine;
  let err = "";
  for (const model of QWEN_MLC) {
    try {
      emit(`QWEN ${model.includes("1.5B") ? "1.5B" : "0.5B"}`);
      const engine = await create(model, {
        initProgressCallback: (p) => {
          const pct = Math.round((p.progress || 0) * 100);
          emit(p.text ? String(p.text).slice(0, 48) : `QWEN ${pct}%`);
        },
      });
      return {
        kind: "webllm",
        complete: async (messages, temperature, maxTokens) => {
          const out = await engine.chat.completions.create({
            messages,
            temperature,
            max_tokens: maxTokens,
          });
          return ((((out.choices || [])[0] || {}).message || {}).content || "").trim();
        },
      };
    } catch (e) {
      err = String(e.message || e);
    }
  }
  throw new Error(err || "WebGPU Qwen would not wake");
}

function tfProgress(info) {
  if (!info || typeof info !== "object") return;
  if (info.status === "progress" && info.total) {
    emit(`QWEN ${Math.round((100 * (info.loaded || 0)) / info.total)}%`);
  } else if (info.status === "download") {
    emit("QWEN FETCH");
  } else if (info.status === "ready" || info.status === "done") {
    emit("PIP ON DECK");
  }
}

function tfText(out, prompt) {
  const row = Array.isArray(out) ? out[0] : out;
  const gen = row && row.generated_text;
  if (typeof gen === "string") return stripQwenAssistant(gen, prompt);
  if (Array.isArray(gen)) {
    for (let i = gen.length - 1; i >= 0; i -= 1) {
      const turn = gen[i];
      if (turn && turn.role === "assistant" && turn.content) return sanitizeReply(String(turn.content));
    }
    const last = gen[gen.length - 1];
    if (last && last.content) return sanitizeReply(String(last.content));
  }
  return sanitizeReply(String((row && (row.text || row.content)) || ""));
}

async function makeTransformers() {
  emit("QWEN WASM");
  const tf = await loadMod([
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm",
    "https://esm.sh/@huggingface/transformers@3.5.1",
  ]);
  if (tf.env) {
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;
  }
  const generator = await tf.pipeline("text-generation", QWEN_TF, {
    dtype: "q4",
    progress_callback: tfProgress,
  });
  return {
    kind: "tf",
    complete: async (messages, temperature, maxTokens) => {
      const prompt = formatQwenChat(messages);
      const out = await generator(prompt, {
        max_new_tokens: maxTokens,
        temperature,
        do_sample: temperature > 0.15,
        return_full_text: false,
      });
      return tfText(out, prompt);
    },
  };
}

export async function ensurePip(onProgress) {
  track(onProgress);
  if (backend) {
    emit("PIP ON DECK");
    return backend;
  }
  if (loading) return loading;
  loading = (async () => {
    emit("PIP // WAKING");
    const errors = [];
    if (navigator.gpu) {
      try {
        backend = await makeWebLlm();
        emit("PIP ON DECK");
        return backend;
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }
    try {
      backend = await makeTransformers();
      emit("PIP ON DECK");
      return backend;
    } catch (e) {
      errors.push(String(e.message || e));
    }
    throw new Error(errors.filter(Boolean).join(" · ") || "Qwen would not wake");
  })();
  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

async function localComplete(messages, temperature = 0.7, maxTokens = 400) {
  const eng = await ensurePip();
  const raw = await eng.complete(messages, temperature, maxTokens);
  const cleaned = sanitizeReply(raw);
  if (!cleaned) throw new Error("local blank reply");
  return { text: cleaned, provider: "local", model: eng.kind || "qwen", leaked: false };
}

/**
 * Brain chain — cloud keys speak as Pip whenever present.
 * Keys present: cloud hierarchy first (LIVE preferred) → desktop → error (Lite only if pinned)
 * No keys: desktop → Pip Lite guide
 * SECURE still limits OPP/CODE/vision scrapes; chat with pasted keys is intentional.
 * Pin compare/all: parallel tabs. Pin lite/local: Guide only.
 */
async function routedComplete(settings, messages, lane, temperature, maxTokens, onProgress, job = "life", callbacks = {}) {
  track(onProgress);
  const errors = [];
  const cloud = cloudStatus(settings);
  const isChat = lane === "life";
  const secure = privacyOn(settings);
  pendingTheme = null;
  const routeJob = job || (isChat ? "life" : lane === "boost" ? "boost" : "code");
  const allowQwen = !skipLocalModel(settings);
  const hasKeys = chatCloudEnabled(settings);
  const liveCloud = liveProviderIds(settings);
  const pin = String(settings?.brain_pin || "auto").toLowerCase();

  const tryCloud = async () => {
    if (!hasKeys) throw new Error("no cloud keys on phone — paste them in DATA");
    if (!isChat && !cloud.leaky) throw new Error("SECURE blocks cloud for OPP/CODE — flip LEAKY");
    const chainList = isChat ? chatChain(settings, routeJob) : null;
    if (isChat && !(chainList || []).length) {
      throw new Error("no keyed chat brains — paste keys in DATA or unpin");
    }
    const first = isChat ? chainList[0] : null;
    emit(isChat && first ? String(first.label || first.id).toUpperCase() : "CLOUD");
    const out = isChat
      ? await chatComplete(settings, messages, temperature, maxTokens, routeJob)
      : await cloudComplete(settings, messages, lane, temperature, maxTokens);
    // Cloud replies speak as Pip — keep text; do not trash as "blank" for normal help phrases.
    const cleaned = sanitizeReply(out.text) || String(out.text || "").trim();
    if (!cleaned) throw new Error(`${out.provider} empty`);
    markHealth(out.provider, true);
    return {
      text: cleaned,
      provider: out.provider,
      model: out.model,
      leaked: true,
      tokens: Number(out.tokens) || 0,
    };
  };

  const tryCompare = async () => {
    if (!hasKeys) throw new Error("compare needs cloud keys in DATA");
    if (secure && !isChat) throw new Error("SECURE blocks compare for OPP — flip LEAKY");
    emit("COMPARE…");
    const crossHint = callbacks.crossHint || null;
    const out = await compareComplete(settings, messages, temperature, maxTokens, routeJob, {
      onPartial: callbacks.onComparePartial,
      crossHint,
      health: providerHealth(),
      prior: callbacks.prior,
    });
    const cleaned = sanitizeReply(out.text) || String(out.text || "").trim();
    if (!cleaned) throw new Error("compare blank");
    return {
      text: cleaned,
      provider: out.provider,
      model: out.model,
      leaked: true,
      tokens: Number(out.tokens) || 0,
      compare: out.compare,
    };
  };

  const tryLite = async () => {
    emit("PIP LITE");
    const user = [...messages].reverse().find((m) => m.role === "user");
    const hit = liteComplete(String((user && user.content) || ""), {
      operator: settings?.operator || "",
    });
    if (!hit?.text) throw new Error("lite blank");
    // With keys or desktop, Lite is Guide-only (pin lite/local), never general chat.
    if (pin !== "lite" && pin !== "local" && hasKeys) {
      throw new Error("lite skipped — use cloud");
    }
    return hit;
  };

  const tryQwen = async () => {
    emit("QWEN");
    return localComplete(messages, temperature, maxTokens);
  };

  const steps = [];
  if (isChat) {
    if (pin === "lite" || pin === "local") {
      steps.push(["lite", tryLite]);
    } else if (pin === "qwen") {
      steps.push(["local", tryQwen]);
      steps.push(["lite", tryLite]);
    } else if (pin === "compare" || pin === "all") {
      // COMPARE is all-or-show-tabs — never quietly degrade into a single cascaded cloud reply.
      steps.push(["compare", tryCompare]);
    } else if (pin !== "auto") {
      // Pinned cloud agent — that API only.
      steps.push(["cloud", tryCloud]);
    } else if (hasKeys) {
      steps.push(["cloud", tryCloud]);
      steps.push(["lite", tryLite]);
    } else {
      steps.push(["lite", tryLite]);
    }
  } else if (secure) {
    steps.push(["cloud", tryCloud]);
  } else {
    steps.push(["cloud", tryCloud]);
  }
  void allowQwen;
  void liveCloud;

  const seen = new Set();
  for (const [name, fn] of steps) {
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      const hit = await fn();
      if (hit?.text) {
        setTurn({
          leaked: hit.leaked,
          provider: hit.provider,
          via: hit.model || "",
          reason: hit.compare
            ? "compare tabs"
            : hit.leaked
              ? "cloud API as Pip"
              : hit.provider === "lite"
                ? "pip lite guide"
                : "desktop/local",
          tokens: hit.tokens || 0,
        });
        return hit;
      }
    } catch (e) {
      const msg = String(e.message || e).slice(0, 140);
      errors.push(`${name}: ${msg}`);
      emit(`${String(name).toUpperCase()} FAIL · ${msg.slice(0, 48)}`);
    }
  }

  const detail = errors.join(" · ") || "no brain answered";
  setTurn({ leaked: false, provider: "", via: "", reason: detail });
  throw new Error(detail);
}

const SPARK_LINES = [
  "One clean next step.",
  "Stay with the work.",
  "Small moves stack up.",
  "Quiet focus wins.",
  "Do the next right thing.",
  "Keep the craft honest.",
  "Breathe, then build.",
  "Progress over polish.",
  "Show up again.",
  "Make it a little better.",
];

export async function sparkLine(recent = [], stanceLabel = "PIP") {
  // Never wake on-device Qwen for vibe nudges — too slow on phone.
  void stanceLabel;
  const seen = new Set((recent || []).map((x) => String(x || "").toLowerCase()));
  const pool = SPARK_LINES.filter((l) => !seen.has(l.toLowerCase()));
  const pick = pool[Math.floor(Math.random() * (pool.length || 1))] || SPARK_LINES[0];
  return pick;
}

async function complete(messages, temperature = 0.7, maxTokens = 400, settings = null, lane = "life", onProgress = null) {
  if (settings) {
    const out = await routedComplete(settings, messages, lane, temperature, maxTokens, onProgress);
    return out.text;
  }
  throw new Error("no brain settings — pair desktop or paste LIVE keys");
}

/**
 * @returns {Promise<{ text:string, leaked:boolean, provider:string, via:string, agent?:string }>}
 */
export async function chat(settings, history, text, onProgress, kit, db, extras = {}) {
  track(onProgress);
  const operator = settings.operator || "Joshua";
  let momentLine = "";
  if (db) {
    try {
      const { storyBrief, chainBrief } = await import("./memory.js");
      momentLine = [storyBrief(db, 10, 14), chainBrief(db)].filter(Boolean).join("\n");
    } catch {
      /* optional */
    }
  }
  let askText = String(text || "");
  let forceCompare = false;
  const cmp = askText.match(/^\s*(compare|ask all|all brains?)\s*[:\-]?\s*/i);
  if (cmp) {
    forceCompare = true;
    askText = askText.slice(cmp[0].length).trim() || askText;
  }

  const agent = String(settings?.chat_agent || "pip").toLowerCase();
  const asSelf =
    Boolean(extras.asSelf) ||
    (agent !== "pip" &&
      agent !== "gc" &&
      agent !== "auto" &&
      agent !== "compare" &&
      agent !== "lite" &&
      agent !== "local" &&
      agent !== "qwen");

  const visionImages = normalizeVisionImages(extras);
  const hasVision = visionImages.length > 0;

  let routePin = String(settings?.brain_pin || "auto").toLowerCase();
  let routeMode = "";
  if (forceCompare || agent === "compare") routePin = "compare";
  else if (agent === "desktop") routePin = "desktop";
  else if (hasVision) routePin = "vision";
  else if (asSelf) routePin = agent;
  else if (agent === "auto") {
    routePin = "auto";
    routeMode = "auto";
  } else if (agent === "pip" || agent === "gc") {
    routePin = "auto";
    routeMode = "pip";
  }

  const routeSettings = { ...settings, brain_pin: routePin, route_mode: routeMode };
  const job = pickJob(askText);
  const maxTok = hasVision ? Math.min(1600, 700 + visionImages.length * 120) : agent === "auto" ? 700 : 1100;
  const temp = agent === "auto" ? 0.45 : 0.7;
  let context = extras.webContext || "";
  let webUsed = Boolean(extras.webContext);
  if (!context) {
    try {
      const { webBrief, wantsWeb } = await import("./web.js");
      if (wantsWeb(askText)) {
        emit("WEB…");
        context = await Promise.race([
          webBrief(askText),
          new Promise((resolve) => setTimeout(() => resolve(""), 2500)),
        ]);
        webUsed = Boolean(context);
      }
    } catch {
      /* optional */
    }
  }
  if (db) {
    try {
      const { mealBrief } = await import("./meals.js");
      if (job === "meal" || /\b(meals?|breakfast|lunch|dinner)\b/i.test(askText)) {
        context = [context, `Today's meals:\n${mealBrief(db)}`].filter(Boolean).join("\n");
      }
    } catch {
      /* optional */
    }
  }

  let system;
  if (forceCompare || agent === "compare") {
    // compareComplete rebuilds per-agent native prompts; keep a thin placeholder here.
    system = [autoSystem(operator), momentLine, context].filter(Boolean).join("\n");
  } else if (asSelf) {
    system = [agentSystem(agent === "desktop" ? "desktop" : agent, operator), momentLine, context]
      .filter(Boolean)
      .join("\n");
  } else if (agent === "auto") {
    system = [autoSystem(operator), momentLine, context].filter(Boolean).join("\n");
  } else {
    // Pip — personal consultant among the crew (not Auto).
    const voiceExamples =
      "Voice examples (stay in this register):\n" +
      SHOTS.filter((_, i) => i % 2 === 1)
        .slice(0, 4)
        .map((m) => `- ${m.content}`)
        .join("\n");
    const roster = usableProviders(settings).map((p) => p.label || p.id);
    const sysBase = `${pipOrchestratorSystem(operator, settings.humor, settings.honesty, kit, roster)}\nJob: ${job}.`;
    system = [sysBase, voiceExamples, momentLine, context].filter(Boolean).join("\n");
  }

  const prior = (history || []).filter((m) => m && m.content && m.content !== text).slice(-10);
  const visionAsk =
    askText ||
    (visionImages.length > 1 ? `What's in these ${visionImages.length} images? Be direct.` : "What's in this image? Be direct.");
  const userContent = hasVision
    ? [
        { type: "text", text: visionAsk },
        ...visionImages.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : askText;
  const messages = [
    { role: "system", content: system },
    ...prior
      .filter((m) => !m.image)
      .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
    { role: "user", content: userContent },
  ];

  if (hasVision) {
    emit(visionImages.length > 1 ? `VISION · ${visionImages.length} PHOTOS…` : "VISION…");
  }

  let hit = null;
  let errMsg = "";
  const chatCallbacks = {
    onComparePartial: extras.onComparePartial,
    crossHint: parseCrossAgentIntent(askText),
    prior: history,
  };
  try {
    hit = await routedComplete(routeSettings, messages, "life", temp, maxTok, onProgress, job, chatCallbacks);
  } catch (e) {
    errMsg = String(e.message || e);
  }
  if (!hit?.text) {
    try {
      const fallbackSys = asSelf
        ? agentSystem(agent === "desktop" ? "desktop" : agent, operator)
        : agent === "auto"
          ? autoSystem(operator)
          : pipOrchestratorSystem(
              operator,
              settings.humor,
              settings.honesty,
              kit,
              usableProviders(settings).map((p) => p.label || p.id),
            );
      hit = await routedComplete(
        routeSettings,
        [
          { role: "system", content: fallbackSys },
          { role: "user", content: userContent },
        ],
        "life",
        temp,
        Math.min(maxTok, agent === "auto" ? 512 : 900),
        onProgress,
        job,
        chatCallbacks,
      );
    } catch (e) {
      errMsg = errMsg || String(e.message || e);
    }
  }

  if (!hit?.text) {
    const live = liveProviderIds(settings);
    const tip = errMsg
      ? hasVision
        ? `Vision failed (${errMsg}). Need Gemini / OpenAI / OpenRouter key · LEAKY on.`
        : live.length && routePin === "auto"
          ? `Cloud brains failed (${errMsg}). Fix red keys in DATA · or pick another agent next to LENS.`
          : `Couldn't reach ${agentLabel(asSelf ? agent : "pip")}. ${errMsg}. Pick another agent or fix keys in DATA.`
      : FALLBACK;
    setTurn({ leaked: false, provider: "", via: "", reason: tip });
    return { text: tip, leaked: false, provider: "pip", via: "", error: true, agent: asSelf ? agent : "pip" };
  }

  const leaked = Boolean(hit.leaked || webUsed);
  const outAgent =
    forceCompare || agent === "compare" ? "compare" : asSelf ? agent : agent === "auto" ? "auto" : "pip";
  setTurn({
    leaked,
    provider: hit.provider,
    via: hit.model || "",
    reason: outAgent === "compare"
      ? "compare tabs"
      : asSelf
        ? `${agentLabel(agent)} as themselves`
        : leaked
          ? "cloud via Pip"
          : "local/desktop",
    tokens: hit.tokens || 0,
  });
  return {
    text: hit.text,
    leaked,
    provider: hit.provider,
    via: hit.model || "",
    tokens: hit.tokens || 0,
    compare: hit.compare || null,
    agent: outAgent,
  };
}



export async function draftAnswers(settings, { title, kit, questions, kind }, onProgress) {
  track(onProgress);
  const kitBits = { ...kit };
  delete kitBits.email;
  delete kitBits.phone;
  delete kitBits.ready;
  delete kitBits.digest;
  kitBits.links_by_kind = typedLinks(kit);
  kitBits.resume = String(kit.resume || "").slice(0, 2800);
  const asks = questions.map((q) => ({
    q: q.prompt || q.q || "",
    type: q.type || "short",
    hint: q.hint || "",
  }));
  const mode = String(settings?.route_mode || settings?.chat_agent || "pip").toLowerCase();
  const voice =
    mode === "auto"
      ? "Efficient drafts. Short. Kit-only. No consultant theater."
      : "You draft as Pip's application consultant — grounded in KIT, tailored to THIS call's type and questions. Sharp, honest, paste-ready.";
  const messages = [
    {
      role: "system",
      content:
        "You draft application answers for Pip's operator from KIT only. " +
        draftVoice(kind) +
        " " +
        voice +
        " Ground every sentence in KIT. Do not invent employers, awards, clients, or numbers. " +
        "If a number is required and missing, write ESTIMATE and say they must confirm. " +
        "Match the question. Instagram fields get only the Instagram URL. Website fields get the site. " +
        "Resume/CV fields get the assembled resume. Socials get socials. Do not dump every link into every field. " +
        "No corporate sludge. No emoji. No email or phone. " +
        "Also write a5: the same facts at a 5th-grade reading level. " +
        'Return ONLY JSON {"answers":[{"q":"...","a":"...","a5":"..."}]} one object per question, same q text.',
    },
    {
      role: "user",
      content: `CALL: ${title}\nMODE: ${mode}\nKIT:\n${JSON.stringify(kitBits)}\nQUESTIONS:\n${JSON.stringify(asks)}`,
    },
  ];
  const hit = await routedComplete(
    { ...settings, brain_pin: settings.brain_pin || "auto", route_mode: mode === "auto" ? "auto" : "pip" },
    messages,
    "boost",
    mode === "auto" ? 0.25 : 0.4,
    mode === "auto" ? 1000 : 1600,
    onProgress,
  );
  setTurn({
    leaked: Boolean(hit.leaked),
    provider: hit.provider,
    via: hit.model || "",
    reason: hit.leaked ? "application draft left device" : "draft stayed local",
  });
  const raw = hit.text;
  const parsed = parseJson(raw);
  const map = new Map();
  for (const item of parsed.answers || []) {
    if (!item || typeof item !== "object") continue;
    const q = String(item.q || item.prompt || "").trim().toLowerCase();
    const a = String(item.a || item.answer || "").trim();
    const a5 = String(item.a5 || item.plain || "").trim();
    if (q && a) map.set(q, { a, a5 });
  }
  return questions.map((q) => {
    const prompt = q.prompt || q.q || "";
    const row = map.get(prompt.trim().toLowerCase()) || {};
    return { ...q, q: prompt, a: row.a || q.a || "", a5: row.a5 || q.a5 || "" };
  });
}

function parseJson(text) {
  const raw = String(text || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < 0) return {};
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return {};
  }
}

export { cloudStatus, privacyOn };
