/** AccuLynx jobs → map pins. Needs an API key from my.acculynx.com/apikeys. */

import { httpGet } from "./net.js";
import { validMarkCoord } from "./marks.js";

const BASE = "https://api.acculynx.com/api/v2";
const PAGE = 50;
const MAX_JOBS = 800;
const GEO_CAP = 80;

export function accuKey(settings) {
  return String(settings?.acculynx || "").trim();
}

export function formatAccuAddress(addr) {
  if (!addr || typeof addr !== "object") return "";
  const street = [addr.street1 || addr.street, addr.street2].filter(Boolean).join(" ").trim();
  const state = typeof addr.state === "object" ? addr.state?.name || addr.state?.abbreviation || "" : addr.state || "";
  const zip = addr.zipCode || addr.zip || "";
  return [street, addr.city, state, zip].filter(Boolean).join(", ").replace(/\s+,/g, ",");
}

function contactName(job) {
  const rows = job.contacts || [];
  for (const row of rows) {
    const c = row.contact && typeof row.contact === "object" ? row.contact : row;
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    if (name) return name;
    if (c.companyName) return String(c.companyName);
  }
  return "";
}

export function jobDidLine(job) {
  const trades = Array.isArray(job.trades) ? job.trades : [];
  return [job.workType, job.category, ...trades, job.milestone].filter(Boolean).join(" · ");
}

export function normalizeAccuJob(raw = {}) {
  const geo = raw.geoLocation || {};
  const lat = Number(geo.latitude ?? raw.lat);
  const lon = Number(geo.longitude ?? raw.lon);
  const trades = (raw.tradeTypes || raw.trades || []).map((t) => t.name || t).filter(Boolean);
  return {
    id: String(raw.id || raw.jobId || ""),
    jobNumber: String(raw.jobNumber || ""),
    jobName: String(raw.jobName || ""),
    milestone: String(raw.currentMilestone || raw.milestone || ""),
    category: String(raw.jobCategory?.name || raw.category || ""),
    workType: String(raw.workType?.name || raw.workType || ""),
    trades,
    address: formatAccuAddress(raw.locationAddress) || String(raw.address || ""),
    lat: validMarkCoord(lat, lon) ? lat : null,
    lon: validMarkCoord(lat, lon) ? lon : null,
    created: String(raw.createdDate || raw.created || ""),
    modified: String(raw.modifiedDate || raw.modified || ""),
    milestoneDate: String(raw.milestoneDate || ""),
    contactName: contactName(raw) || String(raw.contactName || ""),
    did: "",
  };
}

function withDid(job) {
  return { ...job, did: jobDidLine(job) };
}

export function accuColor(milestone) {
  const m = String(milestone || "").toLowerCase();
  if (m === "completed" || m === "closed" || m === "invoiced") return "#22c55e";
  if (m === "approved") return "#2dd4bf";
  if (m === "cancelled") return "#64748b";
  if (m === "prospect" || m === "lead") return "#60a5fa";
  return "#38bdf8";
}

export function accuDone(milestone) {
  return /^(completed|closed|invoiced)$/i.test(String(milestone || ""));
}

async function accuGet(key, path, timeoutMs = 20000) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  try {
    const { body, status } = await httpGet(url, timeoutMs, {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    });
    if (status === 401) throw new Error("AccuLynx key rejected");
    if (status === 429) throw new Error("AccuLynx rate limit — try again in a minute");
    if (status >= 400) throw new Error(`AccuLynx ${status}`);
    try {
      return JSON.parse(body || "{}");
    } catch {
      return {};
    }
  } catch (e) {
    const msg = String(e.message || e);
    if (/401/.test(msg)) throw new Error("AccuLynx key rejected");
    if (/429/.test(msg)) throw new Error("AccuLynx rate limit — try again in a minute");
    throw e;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchAccuJobs(key, { onPage } = {}) {
  const token = String(key || "").trim();
  if (!token) throw new Error("Paste an AccuLynx API key in Settings");
  const jobs = [];
  let index = 0;
  let pageSize = PAGE;
  while (jobs.length < MAX_JOBS) {
    const path = `/jobs?pageSize=${pageSize}&recordStartIndex=${index}&includes=contact&sortBy=ModifiedDate&sortOrder=Descending`;
    let data;
    try {
      data = await accuGet(token, path);
    } catch (e) {
      const msg = String(e.message || e);
      if (pageSize > 25 && /400|416/.test(msg) && index === 0) {
        pageSize = 25;
        continue;
      }
      if (/rate limit/i.test(msg) && index > 0) break;
      throw e;
    }
    const items = data.items || data.Items || [];
    if (!items.length) break;
    for (const raw of items) {
      const job = withDid(normalizeAccuJob(raw));
      if (job.id) jobs.push(job);
    }
    index += items.length;
    if (onPage) onPage({ count: jobs.length, index });
    if (items.length < pageSize) break;
    await sleep(220);
  }
  return jobs.slice(0, MAX_JOBS);
}

export async function geocodeAccuJobs(jobs, geoCache = {}) {
  const cache = { ...geoCache };
  let looked = 0;
  const out = [];
  for (const job of jobs || []) {
    if (validMarkCoord(job.lat, job.lon)) {
      out.push(job);
      continue;
    }
    const q = String(job.address || "").trim();
    if (!q) {
      out.push(job);
      continue;
    }
    const hit = cache[q];
    if (hit && validMarkCoord(hit.lat, hit.lon)) {
      out.push({ ...job, lat: hit.lat, lon: hit.lon });
      continue;
    }
    if (looked >= GEO_CAP) {
      out.push(job);
      continue;
    }
    looked += 1;
    try {
      const { body } = await httpGet(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
        9000,
        { "User-Agent": "GroundControl/1.0 (joshuagwatts)" },
      );
      const row = (JSON.parse(body || "[]") || [])[0];
      const lat = Number(row?.lat);
      const lon = Number(row?.lon);
      if (validMarkCoord(lat, lon)) {
        cache[q] = { lat, lon };
        out.push({ ...job, lat, lon });
      } else out.push(job);
    } catch {
      out.push(job);
    }
    await sleep(1100);
  }
  return { jobs: out, geo: cache, looked };
}

export function accuJobsOnMap(jobs) {
  return (jobs || []).filter((j) => validMarkCoord(j.lat, j.lon));
}

export function accuJobsCsv(jobs) {
  const header = ["jobNumber", "jobName", "milestone", "workType", "category", "trades", "address", "contact", "lat", "lon"];
  const lines = [header.join(",")];
  for (const j of jobs || []) {
    lines.push(
      [j.jobNumber, j.jobName, j.milestone, j.workType, j.category, (j.trades || []).join("; "), j.address, j.contactName, j.lat, j.lon]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(","),
    );
  }
  return lines.join("\n");
}
