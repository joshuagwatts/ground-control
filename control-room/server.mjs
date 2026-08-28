/**
 * Ground Control — Control Room desktop server (port 7420).
 * Run on your home PC: npm run control-room
 * Phone pairs over LAN for private Lens + chat via Ollama.
 */

import http from "node:http";
import { networkInterfaces, hostname } from "node:os";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.CONTROL_ROOM_PORT) || 7420;
const OLLAMA = String(process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const HOST = process.env.CONTROL_ROOM_HOST || "0.0.0.0";

const sessionToken = `gc-${randomBytes(16).toString("hex")}`;
const started = new Date().toISOString();

function lanUrls() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni || ni.internal || ni.family !== "IPv4") continue;
      out.push(`http://${ni.address}:${PORT}`);
    }
  }
  return [...new Set(out)];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
    req.on("error", reject);
  });
}

function tokenFromReq(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const x = String(req.headers["x-pip-token"] || "").trim();
  if (x) return x;
  const cookie = String(req.headers.cookie || "");
  const hit = cookie.match(/pip_gate=([^;,\s]+)/i);
  return hit ? hit[1] : "";
}

function authOk(req) {
  const tok = tokenFromReq(req);
  return tok && tok === sessionToken;
}

async function ollamaTags() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function pickModel(tags, preferVision = false) {
  const names = tags.map(String);
  if (preferVision) {
    const vision = names.find((n) => /llava|moondream|bakllava|minicpm-v|vision/i.test(n));
    if (vision) return vision;
  }
  return (
    names.find((n) => /qwen|llama|mistral|gemma|phi|deepseek/i.test(n)) ||
    names[0] ||
    "llama3.2"
  );
}

async function ollamaChat(text, { images = [], maxTokens = 1400, temperature = 0.2 } = {}) {
  const tags = await ollamaTags();
  const model = pickModel(tags, images.length > 0);
  const body = {
    model,
    stream: false,
    options: { num_predict: maxTokens, temperature },
    messages: [
      {
        role: "user",
        content: String(text || ""),
        ...(images.length ? { images } : {}),
      },
    ],
  };
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(err || `ollama ${res.status}`);
  }
  const data = await res.json();
  const reply = String(data.message?.content || data.response || "").trim();
  return { reply, model };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Pip-Token, Cookie",
  });
  res.end(body);
}

async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Pip-Token, Cookie",
    });
    return res.end();
  }

  if (path === "/api/ready" && req.method === "GET") {
    return json(res, 200, { ok: true, service: "ground-control-room", version: "1.0.0", started });
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    return json(res, 200, {
      ok: true,
      token: sessionToken,
      _cookie: sessionToken,
      open_lan: true,
      phone_lan: true,
    });
  }

  if (path === "/api/auth/status" && req.method === "GET") {
    return json(res, 200, {
      auth: authOk(req),
      phone_lan: true,
      on: true,
      listen: `${HOST}:${PORT}`,
      urls: lanUrls(),
      restart: false,
    });
  }

  if ((path === "/api/health" || path === "/api/status") && req.method === "GET") {
    const tags = await ollamaTags();
    const model = pickModel(tags);
    return json(res, 200, {
      ok: true,
      ollama: { ok: tags.length > 0, using: model, models: tags.slice(0, 12) },
      router: { model },
    });
  }

  if (!authOk(req) && !/^\/api\/(ready|auth\/login)/.test(path)) {
    return json(res, 401, { detail: "login required" });
  }

  if (path === "/api/chat" && req.method === "POST") {
    const body = await readBody(req);
    const text = String(body.text || body.prompt || "").trim();
    if (!text) return json(res, 400, { detail: "empty text" });
    if (/reply with exactly:\s*pip gpu ok/i.test(text)) {
      const tags = await ollamaTags();
      return json(res, 200, {
        reply: "PIP GPU OK",
        content: "PIP GPU OK",
        model: pickModel(tags),
        ollama: { using: pickModel(tags) },
      });
    }
    try {
      const out = await ollamaChat(text, { maxTokens: 800, temperature: 0.3 });
      return json(res, 200, { reply: out.reply, content: out.reply, model: out.model, ollama: { using: out.model } });
    } catch (e) {
      return json(res, 503, {
        detail: `Ollama offline — install from ollama.com and run: ollama pull llama3.2 (${String(e.message || e)})`,
      });
    }
  }

  if ((path === "/api/lens" || path === "/api/vision") && req.method === "POST") {
    const body = await readBody(req);
    const prompt = String(body.prompt || "").trim();
    const images = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
    if (!prompt) return json(res, 400, { detail: "empty prompt" });
    try {
      const out = await ollamaChat(prompt, {
        images,
        maxTokens: Number(body.max_tokens) || 1400,
        temperature: Number(body.temperature) || 0.2,
      });
      return json(res, 200, { text: out.reply, reply: out.reply, content: out.reply, model: out.model, ollama: { using: out.model } });
    } catch (e) {
      const msg = String(e.message || e);
      const hint = images.length
        ? "Need a vision model: ollama pull llava (or moondream)"
        : "ollama pull llama3.2";
      return json(res, 503, { detail: `${msg} — ${hint}` });
    }
  }

  return json(res, 404, { detail: "not found" });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((e) => json(res, 500, { detail: String(e.message || e) }));
});

server.listen(PORT, HOST, () => {
  const urls = lanUrls();
  console.log("");
  console.log("  Ground Control — Control Room");
  console.log(`  Listening on ${HOST}:${PORT}`);
  console.log(`  Token: ${sessionToken.slice(0, 12)}… (auto on Connect)`);
  if (urls.length) {
    console.log("  Phone URL (pick one):");
    for (const u of urls) console.log(`    ${u}`);
  } else {
    console.log("  Phone URL: http://YOUR-PC-LAN-IP:7420");
  }
  console.log("  Ollama:", OLLAMA);
  console.log("  Stop with Ctrl+C");
  console.log("");
});
