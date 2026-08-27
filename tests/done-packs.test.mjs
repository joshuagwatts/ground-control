import { parseDoneList, withCity, MAX_DONE } from "../www/done.js";

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

console.log("done-packs ok");
