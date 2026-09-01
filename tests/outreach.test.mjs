import {
  leadFromDossier,
  upsertLead,
  updateLead,
  removeLead,
  stormSnippet,
  renderOutreachMessage,
  outreachCsv,
  countByStatus,
  leadKey,
} from "../www/outreach.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const dossier = {
  address: "400 S Bryant, Edmond, OK",
  lat: 35.652,
  lon: -97.478,
  owner_name: "Jane Owner",
  owner_phone: "4055550100",
  assessor_record: "Built 1998 · 2,100 sf",
  hail: [{ date: "2024-05-15T00:00:00Z", size_in: "1.75" }],
};

assert(stormSnippet(dossier).includes("1.8") && stormSnippet(dossier).includes("2024-05-15"), "storm snippet");
const lead = leadFromDossier(dossier);
assert(lead.address.includes("400 S Bryant") && lead.status === "queued", "lead from dossier");
assert(leadKey(lead) === "35.65200,-97.47800", "lead key coords");

const first = upsertLead([], lead, { idGen: () => "a1" });
assert(first.added && first.list.length === 1, "insert lead");
const dupe = upsertLead(first.list, { ...lead, owner_name: "Jane O" }, { idGen: () => "a2" });
assert(!dupe.added && dupe.list.length === 1 && dupe.lead.owner_name === "Jane O", "dedupe lead");

const touched = updateLead(dupe.list, "a1", { status: "contacted", notes: "Left VM" });
assert(touched.lead.status === "contacted" && touched.lead.notes === "Left VM", "update lead");
assert(removeLead(touched.list, "a1").length === 0, "remove lead");

const msg = renderOutreachMessage("hail_inspection", lead, { company: "High Ground Roofing", operator: "Joshua" });
assert(/High Ground Roofing/.test(msg.body) && /Jane/.test(msg.body) && /hail mapping/i.test(msg.body), "hail template");
assert(/discontinued/i.test(renderOutreachMessage("discontinued_shingle", lead, { company: "HG" }).body), "shingle template");

const counts = countByStatus([{ status: "queued" }, { status: "queued" }, { status: "won" }]);
assert(counts.queued === 2 && counts.won === 1, "status counts");

assert(outreachCsv([lead]).includes("400 S Bryant") && outreachCsv([lead]).includes("owner_name"), "csv export");

console.log("outreach ok");
