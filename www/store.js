const KEY = "groundcontrol.v1";

function blank() {
  return {
    chat: [],
    jobs: [],
    marks: [],
    acculynx: { jobs: [], geo: {}, syncedAt: "" },
    lens: { mode: "shingle", photos: [], shots: [], last: null, field: null },
    settings: {
      operator: "Joshua",
      company: "Ground Control",
      acculynx: "",
      marksLastKind: "ping",
      marksLastProduct: "atlas-glassmaster",
      showAccu: true,
      showMarks: true,
      humor: 40,
      honesty: 98,
      privacy_mode: "leaky",
      brain_pin: "auto",
      chat_agent: "pip",
      groq: "",
      openrouter: "",
      cerebras: "",
      mistral: "",
      gemini: "",
      xai: "",
      deepseek: "",
      openai: "",
      anthropic: "",
      desktop_url: "",
      desktop_token: "",
      desktop_password: "",
      desktop_paired: false,
      desktop_live: null,
      lat: "",
      lon: "",
      city: "",
      units: "imperial",
      brain_health: {},
    },
  };
}

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return blank();
    const base = blank();
    return {
      ...base,
      ...raw,
      lens: { ...base.lens, ...(raw.lens || {}) },
      settings: { ...base.settings, ...(raw.settings || {}) },
      chat: Array.isArray(raw.chat) ? raw.chat : [],
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      marks: Array.isArray(raw.marks) ? raw.marks : [],
      acculynx: {
        jobs: Array.isArray(raw.acculynx?.jobs) ? raw.acculynx.jobs : [],
        geo: raw.acculynx?.geo && typeof raw.acculynx.geo === "object" ? raw.acculynx.geo : {},
        syncedAt: String(raw.acculynx?.syncedAt || ""),
      },
    };
  } catch {
    return blank();
  }
}

export function save(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
