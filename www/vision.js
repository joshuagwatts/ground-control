/** Vision lens — rock / shingle / general ID via Gemini or OpenRouter (free keys). */

import { PROVIDERS, privacyOn, markHealth } from "./cloud.js";
import { httpPostJson } from "./net.js";

const VISION_ORDER = ["gemini", "openai", "anthropic", "openrouter"];

const VISION_MODELS = {
  gemini: "gemini-3.6-flash",
  openrouter: "google/gemini-2.5-flash:free",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-5",
};

const PROMPTS = {
  rock: `You are Pip's field lens. Identify this rock/mineral/specimen.
Reply in this exact shape (plain text, no markdown fences):
ID: <best name>
CONF: <high|med|low>
TYPE: <igneous|sedimentary|metamorphic|mineral|man-made|unknown>
TELLS: <2 short visual tells>
NOTE: <one practical sentence — hardness/use/lookalike caveat>
Don't Panic. Be honest when unsure.`,

  shingle: `You are Pip's roof lens. Identify this roofing shingle or roofing material from the photo.
Reply in this exact shape (plain text, no markdown fences):
ID: <product family / style if known, else asphalt 3-tab / architectural / metal / tile / etc>
CONF: <high|med|low>
MAT: <asphalt|architectural laminate|metal|clay|concrete|wood|slate|other>
AGE: <new|mid|aging|failing|unknown> — base on granule loss, cracks, curling if visible
DAMAGE: <none|granule loss|cracking|curling|impact/hail dents|missing|unknown>
NOTE: <one practical sentence for an adjuster/homeowner. Hail-like bruises ≠ proof of claim.>
Don't Panic. Be honest when the photo is unclear.`,

  lens: `You are Ground Control's field lens (Google-Lens style, Hitchhiker tone).
Identify the main subject on a roofing / construction job — flashing, vents, pipe boots, penetrations, plants, hardware, materials, or whatever is actually in the shot.
Reply plain text:
ID: <what it is>
CONF: <high|med|low>
KIND: <roofing|flashing|penetration|plant|animal|object|text|scene|other>
TELLS: <2 short visual tells>
NOTE: <one useful sentence for a crew on a roof>
Don't Panic. Say when unsure. Do not invent a shingle product line.`,
};

function providerKey(settings, prov) {
  return String(settings[prov.field] || "").trim();
}

export function visionProvidersReady(settings) {
  return VISION_ORDER.filter((id) => {
    const p = PROVIDERS.find((x) => x.id === id);
    return p && providerKey(settings, p);
  });
}

export const MAX_CHAT_PHOTOS = 8;

/** Collect data-URL images from chat extras (single or many). */
export function normalizeVisionImages(extras = {}) {
  const out = [];
  const push = (u) => {
    const s = String(u || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(extras.images)) extras.images.forEach(push);
  else push(extras.image);
  return out.slice(0, MAX_CHAT_PHOTOS);
}

/** Compress image for multimodal APIs (max edge 1280, JPEG). */
export function fileToDataUrl(file, maxEdge = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("no image"));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        URL.revokeObjectURL(url);
        resolve(dataUrl);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

export function pickImageFiles({ capture = false, multiple = true } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (multiple) input.multiple = true;
    // capture + multiple fights the gallery picker — camera stays single-shot.
    if (capture && !multiple) input.setAttribute("capture", "environment");
    input.style.display = "none";
    document.body.appendChild(input);
    const cleanup = () => {
      try {
        input.remove();
      } catch {
        /* ignore */
      }
    };
    input.onchange = () => {
      const files = Array.from(input.files || []).filter(Boolean);
      cleanup();
      if (!files.length) reject(new Error("cancelled"));
      else resolve(files.slice(0, MAX_CHAT_PHOTOS));
    };
    input.oncancel = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    setTimeout(() => input.click(), 0);
  });
}

export function pickImageFile({ capture = true } = {}) {
  return pickImageFiles({ capture, multiple: false }).then((files) => files[0]);
}

async function visionOnce(prov, key, model, prompt, dataUrl) {
  const payload = {
    model,
    temperature: 0.2,
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };
  const data = await httpPostJson(
    `${prov.base.replace(/\/$/, "")}/chat/completions`,
    {
      Authorization: `Bearer ${key}`,
      ...(prov.headers || {}),
    },
    payload,
    45000,
  );
  if (data?.error) {
    const err = data.error;
    throw new Error(typeof err === "string" ? err : err.message || JSON.stringify(err));
  }
  const text = String((((data.choices || [])[0] || {}).message || {}).content || "").trim();
  if (!text) throw new Error("empty vision reply");
  return { text, provider: prov.id, model };
}

/**
 * Identify an image. mode: rock | shingle | lens
 * Needs LEAKY (or chat-style keys) — vision always leaves device.
 */
export async function identifyImage(settings, dataUrl, mode = "lens") {
  if (privacyOn(settings)) {
    throw new Error("SECURE blocks photo lens — flip LEAKY (cloud vision leaves the device)");
  }
  const prompt = PROMPTS[mode] || PROMPTS.lens;
  const ready = visionProvidersReady(settings);
  if (!ready.length) {
    throw new Error("Need Gemini or OpenRouter key in DATA for photo ID (free AI Studio / OpenRouter)");
  }
  const errors = [];
  for (const id of ready) {
    const prov = PROVIDERS.find((p) => p.id === id);
    const key = providerKey(settings, prov);
    const model = VISION_MODELS[id] || prov.life;
    try {
      const out = await visionOnce(prov, key, model, prompt, dataUrl);
      markHealth(id, true);
      return {
        ...out,
        mode,
        leaked: true,
        text: `${out.text}\n\n— Ground Control lens · ${String(out.provider).toUpperCase()} · LEAKED`,
      };
    } catch (e) {
      markHealth(id, false, String(e.message || e).slice(0, 120));
      errors.push(`${id}: ${String(e.message || e).slice(0, 100)}`);
    }
  }
  throw new Error(errors.join(" · ") || "vision failed");
}

/** Multi-image vision (shingle sequence). Tries Gemini / OpenAI / Anthropic / OpenRouter. */
export async function visionComplete(settings, prompt, dataUrls, { maxTokens = 1200, temperature = 0.05 } = {}) {
  if (privacyOn(settings)) {
    throw new Error("SECURE blocks photo lens — flip LEAKY (cloud vision leaves the device)");
  }
  const urls = (Array.isArray(dataUrls) ? dataUrls : [dataUrls]).filter(Boolean).slice(0, MAX_CHAT_PHOTOS);
  if (!urls.length) throw new Error("no images");
  const ready = visionProvidersReady(settings);
  if (!ready.length) {
    throw new Error("Need a vision key in KEYS — Gemini, OpenAI, Anthropic, or OpenRouter");
  }
  const errors = [];
  const content = [
    { type: "text", text: prompt },
    ...urls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  for (const id of ready) {
    const prov = PROVIDERS.find((p) => p.id === id);
    const key = providerKey(settings, prov);
    const model = VISION_MODELS[id] || (id === "openai" ? "gpt-4o" : id === "anthropic" ? "claude-sonnet-5" : prov.life);
    try {
      const payload = {
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: "user", content }],
      };
      const data = await httpPostJson(
        `${prov.base.replace(/\/$/, "")}/chat/completions`,
        { Authorization: `Bearer ${key}`, ...(prov.headers || {}) },
        payload,
        60000,
      );
      if (data?.error) {
        const err = data.error;
        throw new Error(typeof err === "string" ? err : err.message || JSON.stringify(err));
      }
      const text = String((((data.choices || [])[0] || {}).message || {}).content || "").trim();
      if (!text) throw new Error("empty vision reply");
      markHealth(id, true);
      return { text, provider: prov.id, model, leaked: true };
    } catch (e) {
      markHealth(id, false, String(e.message || e).slice(0, 120));
      errors.push(`${id}: ${String(e.message || e).slice(0, 100)}`);
    }
  }
  throw new Error(errors.join(" · ") || "vision failed");
}

export async function pickAndIdentify(settings, mode = "lens") {
  const file = await pickImageFile({ capture: true });
  const dataUrl = await fileToDataUrl(file);
  const hit = await identifyImage(settings, dataUrl, mode);
  return { ...hit, dataUrl, name: file.name || "photo.jpg" };
}

export function detectVisionMode(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(shingle|roof|roofing|granule|architectural asphalt)\b/.test(t)) return "shingle";
  if (/\b(rock|mineral|geology|stone|specimen|crystal|gem)\b/.test(t)) return "rock";
  if (/\b(identify|what is this|lens|photo|picture|image|look at)\b/.test(t)) return "lens";
  return "lens";
}
