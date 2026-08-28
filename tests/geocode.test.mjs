import { pickGeocodeHits, scoreGeocodeHit, geoCacheOk } from "../www/geocode.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const q = "400 S Bryant, Edmond, OK";
const streetCentroid = {
  lat: 35.652,
  lon: -97.478,
  address: "South Bryant Avenue, Edmond, Oklahoma",
  house: "",
  street: "South Bryant Avenue",
  source: "nominatim",
};
const censusHouse = {
  lat: 35.64012,
  lon: -97.47901,
  address: "400 S BRYANT AVE, EDMOND, OK, 73034",
  house: "400",
  street: "S BRYANT AVE",
  source: "census",
};
const wrongHouse = {
  lat: 35.641,
  lon: -97.479,
  address: "1200 S Bryant, Edmond, OK",
  house: "1200",
  street: "S Bryant",
  source: "nominatim",
};
const cityBlob = {
  lat: 35.6528,
  lon: -97.478,
  address: "Edmond, Oklahoma, United States",
  house: "",
  street: "",
  source: "open-meteo",
};

const south = {
  lat: 35.65059,
  lon: -97.45995,
  address: "400 S Bryant Ave, Edmond, Oklahoma, 73034",
  house: "400",
  street: "S Bryant Ave",
  addrType: "PointAddress",
  source: "arcgis",
};
const north = {
  lat: 35.65878,
  lon: -97.46033,
  address: "400 N BRYANT AVE, EDMOND, OK, 73034",
  house: "400",
  street: "N BRYANT AVE",
  source: "census",
};
const blvd = {
  lat: 35.65074,
  lon: -97.47809,
  address: "400 S BLVD, EDMOND, OK, 73034",
  house: "400",
  street: "S BLVD",
  source: "census",
};
const ranked = pickGeocodeHits([streetCentroid, cityBlob, wrongHouse, north, south, censusHouse, blvd], q);
assert(ranked[0].source === "arcgis", `south Bryant PointAddress should win, got ${ranked[0].source} ${ranked[0].address} score=${ranked[0].score}`);
assert(scoreGeocodeHit(south, q) > scoreGeocodeHit(north, q), "400 S Bryant must beat 400 N Bryant");
assert(scoreGeocodeHit(north, q) < 70, "north Bryant must not lock south Bryant");
assert(scoreGeocodeHit(blvd, q) < 70, "wrong street (BLVD) must not look house-ok");

assert(!geoCacheOk({ lat: 35.65, lon: -97.47, address: q }, q), "old cache without v=2 is stale");
assert(!geoCacheOk({ lat: 35.65, lon: -97.47, v: 2, houseOk: false }, q), "street centroid cache is not ok");
assert(geoCacheOk({ lat: 35.64, lon: -97.479, v: 2, houseOk: true }, q), "v2 houseOk cache is ok");

console.log("geocode ok");
