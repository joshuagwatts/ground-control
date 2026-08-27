import { parseDoneList, withCity, clusterSixPacks, packLine, distM, MAX_DONE } from "../www/done.js";

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

const origin = { lat: 35.6528, lon: -97.4783 };
const near = (dLat, dLon, address) => ({
  lat: origin.lat + dLat,
  lon: origin.lon + dLon,
  address,
});
assert(distM(origin, near(0.0004, 0)) < 50, "nearby house is close");

const three = [
  near(0, 0, "100 Oak St, Edmond, OK"),
  near(0.0003, 0, "102 Oak St, Edmond, OK"),
  near(0.0006, 0, "104 Oak St, Edmond, OK"),
];
const warmPacks = clusterSixPacks(three);
assert(warmPacks.length === 1, "three nearby houses are one pack");
assert(warmPacks[0].warm && !warmPacks[0].full && warmPacks[0].need === 3, "3/6 is warm");
assert(/3\/6/.test(packLine(warmPacks[0])), "warm pack line");

const six = three.concat([
  near(0.0002, 0.0002, "101 Oak St, Edmond, OK"),
  near(0.0004, 0.0002, "103 Oak St, Edmond, OK"),
  near(0.0005, -0.0002, "105 Oak St, Edmond, OK"),
]);
const fullPacks = clusterSixPacks(six);
assert(fullPacks.length === 1 && fullPacks[0].full && !fullPacks[0].warm, "six nearby is complete");
assert(/complete/i.test(packLine(fullPacks[0])), "full pack line");

const far = clusterSixPacks([
  { lat: 35.65, lon: -97.48, address: "1 A St" },
  { lat: 35.72, lon: -97.55, address: "9 Z St" },
]);
assert(far.length === 2 && far.every((p) => p.warm), "far houses are separate warm packs");
assert(MAX_DONE === 400, "cap");

console.log("done-packs ok");
