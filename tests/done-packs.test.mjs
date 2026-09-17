import { parseDoneList, withCity, MAX_DONE, mergeDonePack, serializeTeamDonePack } from "../www/done.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const parsed = parseDoneList(`Address
400 S Bryant, Edmond, OK
"2521 Tredington Way, Edmond, OK",done
no digits here
400 S Bryant, Edmond, OK
`);
assert(parsed.length === 2, "parse two addresses, skip header/dupes");
assert(parsed[0].includes("Bryant"), "first line");

assert(withCity("400 S Bryant", "Edmond, OK") === "400 S Bryant, Edmond, OK", "append city");
assert(withCity("400 S Bryant, Edmond, OK", "Edmond, OK") === "400 S Bryant, Edmond, OK", "already has city");
assert(MAX_DONE === 400, "cap");

const local = {
  text: "400 S Bryant, Edmond, OK",
  houses: [{ id: "done-0", address: "400 S Bryant, Edmond, OK", lat: 35.65, lon: -97.47 }],
  geo: {},
};
const pack = {
  text: "2521 Tredington Way, Edmond, OK",
  houses: [{ id: "done-9", address: "2521 Tredington Way, Edmond, OK", lat: 35.66, lon: -97.48 }],
  geo: { "2521 tredington way, edmond, ok": { lat: 35.66, lon: -97.48, v: 2 } },
};
const merged = mergeDonePack(local, pack);
assert(merged.houses.length === 2, "merge houses");
assert(parseDoneList(merged.text).length === 2, "merge text");
assert(merged.geo["2521 tredington way, edmond, ok"].lat === 35.66, "merge geo");

const snap = serializeTeamDonePack(merged);
assert(snap.v === 1 && snap.houses.length === 2, "serialize pack");

console.log("done-packs ok");
