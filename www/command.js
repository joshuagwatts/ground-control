/** Chain of command — best brain for the job, then the next, then Pip's own voice. */

export const JOBS = {
  life: {
    label: "CHAT",
    brains: ["anthropic", "groq", "gemini", "openrouter", "openai", "cerebras", "deepseek", "mistral", "xai"],
  },
  boost: {
    label: "DRAFT",
    brains: ["anthropic", "openai", "groq", "openrouter", "cerebras", "deepseek", "mistral", "gemini"],
  },
  code: {
    label: "CODE",
    brains: ["deepseek", "anthropic", "openai", "openrouter", "groq", "cerebras", "mistral"],
  },
  wx: {
    label: "WX",
    brains: ["gemini", "anthropic", "cerebras", "openrouter", "groq", "deepseek", "mistral"],
  },
  vision: {
    label: "LENS",
    brains: ["gemini", "openai", "anthropic", "openrouter"],
  },
  theme: {
    label: "THEME",
    brains: [],
  },
  meal: {
    label: "MEALS",
    brains: ["gemini", "anthropic", "groq", "openrouter", "cerebras", "deepseek", "mistral"],
  },
};

const CODE_HINT =
  /\b(code|coding|refactor|function|bug|traceback|python|javascript|typescript|repo|debug|implement|glsl|shader|webgl)\b/i;
const WX_HINT = /\b(hail|storm|radar|weather|nws|wind report|dossier|roof)\b/i;
const DRAFT_HINT = /\b(apply|application|draft|resume|cover letter|bio|opp|open call)\b/i;
const MEAL_HINT = /\b(meals?|breakfast|lunch|dinner|snack|grocery|macros?|kcal|vegan|vegetarian|what to eat|meal plan)\b/i;
const VISION_HINT = /\b(image|photo|picture|screenshot|look at this|what('s| is) (in|this)|rock|shingle|lens)\b/i;
const WIT_HINT = /\b(joke|roast|spicy|opinionated|wit|funny|grok|memes?)\b/i;
const PROSE_HINT = /\b(write|essay|nuance|careful|edit (this|prose|copy)|rewrite|claude|haiku|sonnet|letter)\b/i;
const FAST_HINT = /\b(fast|quick|asap|speed|one.?liner|short answer)\b/i;
const NOT_CHAT_JOB = /\b(apply|application|hail|storm|zillow|deadline|cover letter)\b/i;

export function pickJob(text) {
  const t = String(text || "");
  if (VISION_HINT.test(t) && !DRAFT_HINT.test(t)) return "vision";
  if (MEAL_HINT.test(t) && !DRAFT_HINT.test(t)) return "meal";
  if (WX_HINT.test(t) && !DRAFT_HINT.test(t)) return "wx";
  if (CODE_HINT.test(t)) return "code";
  if (DRAFT_HINT.test(t)) return "boost";
  return "life";
}

/** Coding work now lives in main CHAT (Cursor-style), not a CODE tab. */
export function looksLikeCodeRequest(text) {
  const t = String(text || "");
  if (/\b(upgrade\s+(on\s+)?pc|phone\s+www|edit\s+(the\s+)?(app|ui|css|js)|reload\s+overlay)\b/i.test(t)) {
    return true;
  }
  return CODE_HINT.test(t) && !DRAFT_HINT.test(t) && !MEAL_HINT.test(t);
}

export function wantsDesktopCodeUpgrade(text) {
  return /\b(upgrade\s+(on\s+)?pc|desktop\s+upgrade|phone\s+www\s+on\s+(pc|desktop))\b/i.test(String(text || ""));
}

/** Bump brains that fit this ask to the front of an already-filtered list. */
function specialtyBoost(ask, ordered) {
  const t = String(ask || "");
  if (!t || !ordered.length) return ordered;
  const bump = [];
  if (VISION_HINT.test(t)) bump.push("gemini", "openai", "anthropic", "openrouter");
  if (CODE_HINT.test(t)) bump.push("deepseek", "anthropic", "openai", "openrouter");
  if (PROSE_HINT.test(t)) bump.push("anthropic", "openai", "mistral");
  if (WIT_HINT.test(t)) bump.push("xai", "groq");
  if (FAST_HINT.test(t)) bump.push("groq", "cerebras", "anthropic");
  if (DRAFT_HINT.test(t)) bump.push("anthropic", "openai", "groq");
  if (MEAL_HINT.test(t)) bump.push("gemini", "anthropic", "groq");
  if (WX_HINT.test(t)) bump.push("gemini", "anthropic");
  const head = [];
  for (const id of bump) {
    if (ordered.includes(id) && !head.includes(id)) head.push(id);
  }
  if (!head.length) return ordered;
  return [...head, ...ordered.filter((id) => !head.includes(id))];
}

export function orderFor(job, keyedIds, health = {}, pin = "auto", ask = "") {
  const spec = JOBS[job] || JOBS.life;
  if (pin === "local" || pin === "lite" || pin === "qwen") return [];
  const keyed = spec.brains.filter((id) => keyedIds.includes(id));
  // Prefer pin first, but always fall through to other keyed brains.
  let ordered = keyed;
  if (pin && pin !== "auto" && keyedIds.includes(pin)) {
    ordered = [pin, ...keyed.filter((id) => id !== pin)];
  }
  // Job list may omit a keyed brain — still allow it at the end.
  for (const id of keyedIds) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  ordered = specialtyBoost(ask, ordered);
  // If every probe is "bad", still try them — stale health was blocking chat.
  const anyLive = ordered.some((id) => health[id]?.ok === true);
  if (!anyLive) return ordered;
  const live = ordered.filter((id) => health[id]?.ok !== false);
  const down = ordered.filter((id) => health[id]?.ok === false);
  return [...live, ...down];
}

/**
 * AUTO mode — efficiency first: cheap/fast cascade.
 * Only bumps specialty when the ask clearly needs it (vision/code).
 */
export function orderForEfficient(keyedIds, health = {}, ask = "") {
  const t = String(ask || "");
  const speed = ["groq", "cerebras", "anthropic", "openrouter", "mistral", "gemini", "deepseek", "openai", "xai"];
  let bump = speed;
  if (VISION_HINT.test(t)) bump = ["gemini", "openai", "anthropic", "openrouter", ...speed];
  else if (CODE_HINT.test(t)) bump = ["deepseek", "groq", "cerebras", "anthropic", "openrouter", ...speed];
  else if (WX_HINT.test(t)) bump = ["gemini", "groq", "cerebras", "anthropic", ...speed];

  const head = [];
  for (const id of bump) {
    if (keyedIds.includes(id) && !head.includes(id)) head.push(id);
  }
  for (const id of keyedIds) {
    if (!head.includes(id)) head.push(id);
  }
  const anyLive = head.some((id) => health[id]?.ok === true);
  if (!anyLive) return head;
  const live = head.filter((id) => health[id]?.ok !== false);
  const down = head.filter((id) => health[id]?.ok === false);
  return [...live, ...down];
}

/**
 * PIP mode — consultant fit: best brain for the circumstance, not the cheapest.
 * Specialty + job ranking; quality models lead for life/prose/drafts.
 */
export function orderForConsultant(keyedIds, health = {}, ask = "", job = "life") {
  return orderFor(job, keyedIds, health, "auto", ask);
}

export function describeChain(keyedIds, health = {}, desktop = false, pin = "auto", desktopLive = null, leaky = false) {
  const rows = [];
  const cloudRows = [];
  for (const id of ["anthropic", "groq", "openrouter", "gemini", "cerebras", "deepseek", "openai", "mistral", "xai"]) {
    const keyed = keyedIds.includes(id);
    const ok = health[id]?.ok;
    let state = "off";
    if (keyed && ok === true) state = "on";
    else if (keyed && ok === false) state = "bad";
    else if (keyed) state = "key";
    cloudRows.push({
      id,
      label: id === "xai" ? "GROK" : id === "anthropic" ? "CLAUDE" : id.toUpperCase(),
      state,
    });
  }
  const desk = desktop
    ? [
        {
          id: "desktop",
          label: "DESKTOP",
          state:
            desktopLive === true
              ? "on"
              : desktopLive === false
                ? "bad"
                : pin === "desktop" || (!leaky && pin === "auto")
                  ? "key"
                  : "key",
        },
      ]
    : [];
  // LEAKY: show cloud strip first (master brain). SECURE: desktop first.
  if (leaky) rows.push(...cloudRows, ...desk);
  else rows.push(...desk, ...cloudRows);
  rows.push({
    id: "lite",
    label: "LITE",
    state: pin === "lite" || pin === "local" ? "on" : "key",
  });
  rows.push({
    id: "local",
    label: "QWEN",
    state: pin === "qwen" ? "key" : "skip",
  });
  return rows;
}

export function skipLocalModel(settings) {
  // Heavy on-device Qwen only when explicitly pinned.
  return String(settings?.brain_pin || "auto").toLowerCase() !== "qwen";
}

export { NOT_CHAT_JOB };
