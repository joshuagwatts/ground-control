import { MARK_KINDS, kindMeta, newMark, upsertMark, removeMark, filterMarks, marksCsv, marksPlainList, outreachDraft, validMarkCoord } from "../www/marks.js";
import { formatAccuAddress, normalizeAccuJob, jobDidLine, accuColor, accuDone, accuJobsOnMap, accuJobsCsv } from "../www/acculynx.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

assert(kindMeta("atlas").short === "ATLAS", "atlas kind");
assert(MARK_KINDS.some((k) => k.id === "zone"), "zone kind");
assert(validMarkCoord(35.5, -97.5), "ok coord");
assert(!validMarkCoord(0, 0), "zero coord");

const pin = newMark({ lat: 35.5, lon: -97.5, kind: "atlas", label: "Atlas", note: "GlassMaster", address: "400 S Bryant, Edmond, OK" });
assert(pin.kind === "atlas" && pin.label === "Atlas", "new mark");
const { list, mark } = upsertMark([], pin);
assert(list.length === 1 && mark.id === pin.id, "upsert insert");
const edited = upsertMark(list, { ...mark, note: "We finished the block" });
assert(edited.list[0].note.includes("finished"), "upsert edit");
assert(removeMark(edited.list, mark.id).length === 0, "remove");
assert(filterMarks([pin], "atlas").length === 1, "filter atlas");
assert(filterMarks([pin], "work").length === 0, "filter miss");
assert(marksCsv([pin]).includes("GlassMaster"), "csv");
assert(marksPlainList([pin]).includes("400 S Bryant"), "plain list");

const letter = outreachDraft([pin], { company: "High Ground", operator: "Joshua" });
assert(letter.count === 1 && /discontinued/i.test(letter.body) && /High Ground/.test(letter.body), "letter");

const raw = {
  id: "abc",
  jobNumber: "HG-100",
  jobName: "HG-100: Test",
  currentMilestone: "Completed",
  jobCategory: { name: "Residential" },
  workType: { name: "Insurance" },
  tradeTypes: [{ name: "Roofing" }],
  locationAddress: { street1: "400 S Bryant", city: "Edmond", state: "OK", zipCode: "73034" },
  geoLocation: { latitude: 35.652, longitude: -97.478 },
  contacts: [{ contact: { firstName: "Jane", lastName: "Owner" } }],
};
const job = normalizeAccuJob(raw);
assert(job.address.includes("400 S Bryant"), "accu address");
assert(job.lat === 35.652 && job.lon === -97.478, "accu geo");
assert(job.contactName === "Jane Owner", "accu contact");
assert(jobDidLine(job).includes("Roofing"), "did line");
assert(accuColor("Completed") === "#22c55e", "done color");
assert(accuDone("Closed"), "closed is done");
assert(accuJobsOnMap([job]).length === 1, "on map");
assert(formatAccuAddress({ street: "1 Main", city: "Tulsa", state: "OK" }).includes("Tulsa"), "street alias");
assert(accuJobsCsv([job]).includes("HG-100"), "accu csv");

console.log("field-marks ok");
