import {
  INVESTOR_KINDS,
  newInvestor,
  upsertInvestor,
  removeInvestor,
  setInvestorRelationship,
  isPartner,
  promoteRelationship,
  parseRegionNames,
  resolveInvestorRegions,
  matchCountyRegion,
  matchCityRegion,
  investorDisplayName,
  investorGlyphSvg,
  promoteButtonLabel,
  normalizeInvestor,
} from "../www/investors.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

assert(INVESTOR_KINDS.some((k) => k.id === "insurance"), "insurance kind");
assert(INVESTOR_KINDS.some((k) => k.id === "realestate"), "realestate kind");

const heart = newInvestor({
  kind: "insurance",
  name: "Pat Broker",
  company: "Capitol Claims",
  phone: "405-555-0199",
  email: "pat@capitol.test",
  address: "1 N Broadway, Edmond, OK",
  lat: 35.652,
  lon: -97.478,
});
assert(heart.kind === "insurance" && heart.relationship === "prospect", "default prospect");
assert(!isPartner(heart), "not partner yet");
assert(/Promote to red heart/.test(promoteButtonLabel(heart)), "promote label");
assert(investorDisplayName(heart) === "Pat Broker", "display name");
assert(investorGlyphSvg(heart).includes("heart") && investorGlyphSvg(heart).includes("prospect"), "broken heart svg");

const { list, investor } = upsertInvestor([], heart);
assert(list.length === 1 && investor.id === heart.id, "upsert insert");
const promoted = setInvestorRelationship(list, heart.id, "partner");
assert(isPartner(promoted[0]), "promoted to partner");
assert(promoteRelationship(promoted[0]) === "prospect", "toggle back");
assert(investorGlyphSvg(promoted[0]).includes("partner"), "full heart svg");
assert(removeInvestor(promoted, heart.id).length === 0, "remove");

const star = newInvestor({
  kind: "realestate",
  name: "Skyline Holdings",
  regionText: "Edmond, Oklahoma County, Tulsa metro, Mystery Town",
  lat: 35.68,
  lon: -97.53,
});
assert(star.kind === "realestate" && star.relationship === "prospect", "re prospect");
assert(parseRegionNames("Edmond, Oklahoma County\nNorman").includes("Norman"), "parse regions");
const shapes = resolveInvestorRegions(star);
assert(shapes.some((s) => s.type === "city" && s.name === "Edmond" && s.radiusM > 0), "edmond city circle");
assert(shapes.some((s) => s.type === "county" && /Oklahoma/.test(s.name) && s.ring?.length >= 4), "oklahoma county box");
assert(shapes.filter((s) => s.type === "county").length >= 4, "tulsa metro expands counties");
assert(shapes.some((s) => s.type === "label" && /Mystery/.test(s.name)), "unknown region kept as label");
assert(matchCountyRegion("cleveland county")?.name === "Cleveland", "county match");
assert(matchCityRegion("Oklahoma City")?.name === "Oklahoma City", "city match");
assert(/star/.test(investorGlyphSvg(star)), "outline star");
const gold = normalizeInvestor({ ...star, relationship: "partner" });
assert(/partner/.test(investorGlyphSvg(gold)), "filled star");
assert(/Promote to gold star/.test(promoteButtonLabel(star)), "star promote label");

const bad = normalizeInvestor({ kind: "nope", relationship: "maybe", name: "X" });
assert(bad.kind === "insurance" && bad.relationship === "prospect", "normalize fallbacks");

console.log("investors ok");
