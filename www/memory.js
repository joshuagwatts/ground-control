/** Substantive user moments — story grows with the operator. */

const NOISE = /^(no|nah|nope|yes|yeah|yep|yup|ok|okay|k|thanks|thank you|thx|ty|lol|lmao|haha|heh|wtf|ugh|hm+|hmm+)[\s.!?]*$/i;
const BUG_ONLY = /^\s*(there'?s? a )?(bug|error|crash|broken|fix (this|it)|didn'?t work|doesn'?t work|not working|again|still broken)[\s.!?]*$/i;
const BUG_WORDS = /\b(bug|broken|crash|error|fix it|didn'?t work|doesn'?t work|not working)\b/i;
const STORY = /\b(because|remember|story|childhood|family|dream|goal|want|love|hate|feel|felt|art|music|festival|career|resume|portfolio|why|who i am|my name|i am|i'm|we are|inspire|motivat|struggle|hope|fear|grow|journey|origin|mission|vision)\b/i;

export function substanceScore(text) {
  const t = String(text || "").trim();
  if (t.length < 20) return 0;
  if (NOISE.test(t) || BUG_ONLY.test(t)) return 0;
  let score = Math.min(Math.floor(t.length / 6), 45);
  score += Math.min(t.split(/\s+/).length, 25);
  if (t.includes("?")) score += 6;
  if (/\b(i|my|me|we|our|mine)\b/i.test(t)) score += 12;
  if (STORY.test(t)) score += 18;
  if (BUG_WORDS.test(t) && t.length < 90) score -= 30;
  return Math.max(0, score);
}

export function captureMoment(db, text, minScore = 12) {
  const score = substanceScore(text);
  if (score < minScore) return null;
  const tags = [];
  if (STORY.test(text)) tags.push("story");
  if (text.includes("?")) tags.push("question");
  if (text.length > 180) tags.push("long");
  const row = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    role: "user",
    content: text.trim(),
    score,
    tags: tags.join(","),
    at: new Date().toISOString(),
  };
  if (!Array.isArray(db.moments)) db.moments = [];
  db.moments.unshift(row);
  db.moments = db.moments.slice(0, 200);
  return row;
}

export function storyBrief(db, limit = 10, minScore = 14) {
  const rows = (db.moments || [])
    .filter((m) => (m.score || 0) >= minScore)
    .slice(0, limit)
    .reverse();
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    let s = String(r.content || "").replace(/\n/g, " ");
    if (s.length > 380) s = s.slice(0, 377) + "…";
    return `- ${s}`;
  });
  return "Operator moments (substance, on this device):\n" + lines.join("\n");
}

export function chainBrief(db) {
  const health = (db && db.settings && db.settings.brain_health) || {};
  const leaky = String(db?.settings?.privacy_mode || "secure").toLowerCase() === "leaky";
  const keys = ["anthropic", "groq", "openrouter", "gemini", "cerebras", "mistral", "xai", "deepseek", "openai"].filter(
    (id) => db && db.settings && String(db.settings[id] || "").trim(),
  );
  if (!keys.length) {
    return leaky
      ? "LEAKY but no cloud keys — paste in DATA or use desktop GPU."
      : "No cloud keys saved. SECURE prefers desktop GPU, then Qwen.";
  }
  const bits = keys.map((id) => {
    const h = health[id];
    const st = h && h.ok === true ? "live" : h && h.ok === false ? "down" : "keyed";
    return `${id}:${st}`;
  });
  return leaky
    ? `LEAKY master brain: ${bits.join(" → ")}. Upscale to LIVE, downscale on fail, then desktop, then Qwen.`
    : `SECURE cascade: desktop → ${bits.join(" → ")} → Qwen. Prefer private first.`;
}

export function rememberReply(db, text) {
  const t = String(text || "").trim();
  if (t.length < 40) return null;
  if (!Array.isArray(db.moments)) db.moments = [];
  db.moments.unshift({
    id: Date.now().toString(36) + "p",
    role: "pip",
    content: t.slice(0, 400),
    score: 16,
    tags: "pip",
    at: new Date().toISOString(),
  });
  db.moments = db.moments.slice(0, 200);
  return db.moments[0];
}

export function topMoments(db, n = 8) {
  return (db.moments || []).filter((m) => (m.score || 0) >= 14).slice(0, n);
}
