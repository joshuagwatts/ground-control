/** Roof inspection jobs — address, hail pin, lens verdict. */

import { uid } from "./store.js";

export function newJob(partial = {}) {
  return {
    id: uid(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    address: "",
    lat: "",
    lon: "",
    notes: "",
    hail: null,
    lens: null,
    photos: [],
    status: "open",
    ...partial,
  };
}

export function upsertJob(db, job) {
  if (!db.jobs) db.jobs = [];
  const next = { ...job, updated: new Date().toISOString() };
  const i = db.jobs.findIndex((j) => j.id === next.id);
  if (i >= 0) db.jobs[i] = next;
  else db.jobs.unshift(next);
  return next;
}

export function jobSummary(job) {
  if (!job) return "";
  const bits = [job.address || "Unpinned job"];
  const lens = job.lens;
  if (lens?.status === "KNOW") {
    const k = lens.known || {};
    bits.push(`${k.manufacturer || ""} ${k.product || ""} ${k.color || ""}`.trim());
    if (k.discontinued) bits.push("DISCONTINUED");
  } else if (lens?.status === "NARROWED") bits.push("LENS NARROWED");
  else if (lens) bits.push("LENS OPEN");
  if (job.hail?.days) bits.push(`${job.hail.days} hail days`);
  return bits.filter(Boolean).join(" · ");
}
