/** Team pack sync — one-click push/pull via GitHub Contents API + Pages. */

export const TEAM_REPO = "joshuagwatts/ground-control";
export const TEAM_MARKS_PATH = "www/data/team-marks.json";
export const TEAM_DONE_PATH = "www/data/team-done.json";

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${String(token || "").trim()}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function githubGetContents(path, token) {
  const url = `https://api.github.com/repos/${TEAM_REPO}/contents/${path}`;
  const res = await fetch(url, { headers: githubHeaders(token), cache: "no-store" });
  if (res.status === 404) return { ok: true, missing: true, sha: null, json: null };
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`GitHub read ${res.status}${msg ? `: ${msg.slice(0, 80)}` : ""}`);
  }
  const data = await res.json();
  const raw = typeof data.content === "string" ? atob(String(data.content).replace(/\n/g, "")) : "";
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { ok: true, missing: false, sha: data.sha || null, json };
}

async function githubPutContents(path, json, token, { sha = null, message } = {}) {
  const body = {
    message: message || `chore: update ${path.split("/").pop()}`,
    content: utf8ToBase64(JSON.stringify(json, null, 2) + "\n"),
    branch: "main",
  };
  if (sha) body.sha = sha;
  const url = `https://api.github.com/repos/${TEAM_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`GitHub push ${res.status}${msg ? `: ${msg.slice(0, 120)}` : ""}`);
  }
  return res.json();
}

/** Publish JSON to the repo so Pages picks it up for the whole team. */
export async function pushTeamJson(path, pack, token) {
  const key = String(token || "").trim();
  if (!key) throw new Error("Add a GitHub token in Settings (Team sync) once");
  const current = await githubGetContents(path, key);
  await githubPutContents(path, pack, key, {
    sha: current.sha,
    message: `chore: team sync ${path.split("/").pop()}`,
  });
  return { ok: true, path };
}

/** Read latest team pack from GitHub (authoritative) — fallback when Pages is stale. */
export async function fetchTeamJsonFromGithub(path, token) {
  const key = String(token || "").trim();
  if (!key) return null;
  const current = await githubGetContents(path, key);
  if (current.missing) return null;
  return current.json;
}
