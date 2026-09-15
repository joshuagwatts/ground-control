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
  investorRegionBounds,
  investorListingBounds,
  investorListings,
  classifyInvestorKind,
  listingFromBizRow,
  mergeListedAndSaved,
  mergeInvestorListings,
  defaultRegionsForListing,
  fetchPhotonInvestorsNear,
  investorInBounds,
} from "../www/investors.js";
import { migrateInvestorOfficeSettings } from "../www/store.js";
import {
  parseSaleListingsFromHtml,
  parseRealtorDetailSlug,
  parseJsonLdBusinesses,
  cleanBizEmail,
  namesLikelySame,
  mergeInvestorPublic,
  sameOfficeBrand,
  officesLikelySame,
  officeOverpassQuery,
  clampOfficeBounds,
  applyOsmOfficesToInvestors,
  listedInvestorsFromOsmElements,
  pickOsmOfficeForInvestor,
} from "../www/investor-public.js";

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
const box = investorRegionBounds(star);
assert(box && box.south < 35.68 && box.north > 35.68 && box.west < -97.53 && box.east > -97.12, "region bounds cover edmond + oklahoma county");
assert(matchCountyRegion("cleveland county")?.name === "Cleveland", "county match");
assert(matchCityRegion("Oklahoma City")?.name === "Oklahoma City", "city match");
assert(/star/.test(investorGlyphSvg(star)), "outline star");
const gold = normalizeInvestor({ ...star, relationship: "partner" });
assert(/partner/.test(investorGlyphSvg(gold)), "filled star");
assert(/Promote to gold star/.test(promoteButtonLabel(star)), "star promote label");

const bad = normalizeInvestor({ kind: "nope", relationship: "maybe", name: "X" });
assert(bad.kind === "insurance" && bad.relationship === "prospect", "normalize fallbacks");

assert(classifyInvestorKind("State Farm") === "insurance", "state farm");
assert(classifyInvestorKind("Keller Williams Realty") === "realestate", "kw");
assert(classifyInvestorKind("Abrahams Nationwide Bonding Bail") === "", "skip bail");
assert(classifyInvestorKind("Farmers", "office=insurance") === "insurance", "osm insurance tag");
assert(classifyInvestorKind("Local Broker", "estate_agent") === "realestate", "osm realtor tag");

const listed = listingFromBizRow({
  name: "Early Insurance Agency",
  street: "17342 North May Avenue",
  city: "Edmond",
  state: "OK",
  lat: 35.6487,
  lon: -97.5662,
  phone: "(405) 936-9200",
  source: "osm",
});
assert(listed && listed.kind === "insurance" && listed.id.startsWith("list:insurance:"), "listed heart id");
assert(/936-9200/.test(listed.phone), "listed phone");

const saved = mergeListedAndSaved([listed], [{ ...listed, relationship: "partner", note: "good partner" }], []);
assert(saved.length === 1 && saved[0].relationship === "partner" && saved[0].note === "good partner", "promote listing persists");
assert(mergeListedAndSaved([listed], [], [listed.id]).length === 0, "hidden listing stays off");

const dup = mergeInvestorListings([
  [listed],
  [listingFromBizRow({ ...listed, lat: listed.lat + 0.0004, phone: "" })],
]);
assert(dup.length === 1 && /936-9200/.test(dup[0].phone), "nearby duplicate offices collapse");

assert(defaultRegionsForListing("realestate", "Edmond", 35.65, -97.48).length === 0, "no county box defaults");

const homes = normalizeInvestor({
  kind: "realestate",
  name: "Brick & Beam Realty",
  lat: 35.2108,
  lon: -97.4762,
  listings: [
    { address: "101 W Main St, Norman, OK", lat: 35.222, lon: -97.445, url: "https://www.realtor.com/realestateandhomes-detail/101-W-Main-St_Norman_OK_73069_M1" },
    { address: "2200 Westheimer Dr, Norman, OK", lat: 35.201, lon: -97.51 },
  ],
});
assert(investorListings(homes).length === 2, "two mapped listings");
const listBox = investorListingBounds(homes);
assert(listBox && listBox.south < 35.201 && listBox.north > 35.222, "listing bounds hug the homes not the county");
assert(listBox.east - listBox.west < 0.2, "listing box is not a county-sized yellow rectangle");

const slugAddr = parseRealtorDetailSlug("123-Main-St_Oklahoma-City_OK_73120_M12345");
assert(/123 Main St/i.test(slugAddr) && /Oklahoma City/i.test(slugAddr), "realtor slug → street");

const parsedHomes = parseSaleListingsFromHtml(`
  <a href="https://www.realtor.com/realestateandhomes-detail/1601-E-Imhoff-Rd_Norman_OK_73071_M99887">listing</a>
  <a href="https://www.zillow.com/homedetails/2200-Westheimer-Dr-Norman-OK-73069/111_zpid/">z</a>
  {"address":{"line":"708 24th Avenue Northwest","city":"Norman","state_code":"OK"},"coordinate":{"lat":35.2275,"lon":-97.4791}}
`);
assert(parsedHomes.some((h) => /Imhoff/i.test(h.address)), "realtor detail listing");
assert(parsedHomes.some((h) => /Westheimer/i.test(h.address)), "zillow detail listing");

const ld = parseJsonLdBusinesses(`<script type="application/ld+json">{"@type":"InsuranceAgency","name":"Devin Smith","telephone":"4052907108","email":"devin@okcjakes.com","address":{"streetAddress":"3639 NW 63rd Street","addressLocality":"Oklahoma City"}}</script>`);
assert(ld.some((r) => /290-7108/.test(r.phone) && r.email.includes("okcjakes")), "agency json-ld phone+email");
assert(!cleanBizEmail("team@keen.io"), "drop tracker emails");
assert(!cleanBizEmail("info@thebbb.org"), "drop bureau directory email");
assert(cleanBizEmail("jake@okcjakes.com", "https://www.okcjakes.com/") === "jake@okcjakes.com", "keep office email");
assert(namesLikelySame("Keller Williams Realty", "Keller Williams Realty Tulsa"), "office name overlap");

const filled = mergeInvestorPublic(
  { ...listed, phone: "", email: "" },
  { phone: "(405) 936-9200", email: "hello@early.test", listings: homes.listings },
);
assert(/936-9200/.test(filled.phone) && filled.email.includes("early"), "public enrich fills heart contact");
assert(filled.listings.length === 2, "public enrich keeps sale homes");

const savedBlank = mergeListedAndSaved([listed], [{ ...listed, phone: "", note: "called" }], []);
assert(/936-9200/.test(savedBlank[0].phone) && savedBlank[0].note === "called", "empty saved phone does not wipe listing phone");

const none = await fetchPhotonInvestorsNear(35.47, -97.52, { insurance: false, realestate: false });
assert(none.length === 0, "no office hunt when hearts and stars are off");

const reset = migrateInvestorOfficeSettings({
  showInsuranceInvestors: true,
  showRealEstateInvestors: true,
});
assert(reset.showInsuranceInvestors === false && reset.showRealEstateInvestors === false, "old always-on offices turn off");
assert(reset.investorOfficeOptIn === true, "opt-in flag set");
assert(
  migrateInvestorOfficeSettings({
    showInsuranceInvestors: true,
    investorOfficeOptIn: true,
  }).showInsuranceInvestors === true,
  "explicit on stays on after opt-in",
);

assert(sameOfficeBrand("State Farm", "State Farm Insurance — Jake Smith"), "state farm brand");
assert(officesLikelySame("State Farm", "State Farm Insurance"), "state farm names match via brand");
assert(/State Farm/.test(officeOverpassQuery(35.4, -97.6, 35.55, -97.42)), "overpass asks for State Farm");

const wide = clampOfficeBounds({ south: 33.6, west: -103, north: 37, east: -94.4 });
assert(wide && wide.north - wide.south <= 0.23 && wide.east - wide.west <= 0.23, "zoomed-out office query stays in frame");

const sf = {
  id: "list:insurance:35.5220:-97.5460:statefarm",
  kind: "insurance",
  name: "State Farm",
  company: "State Farm",
  phone: "",
  lat: 35.522,
  lon: -97.546,
};
const other = {
  id: "list:insurance:35.4800:-97.5100:statefarm",
  kind: "insurance",
  name: "State Farm",
  company: "State Farm",
  phone: "",
  lat: 35.48,
  lon: -97.51,
};
const els = [
  {
    lat: 35.5221,
    lon: -97.5462,
    tags: { name: "State Farm", phone: "+1 405 842 3500", office: "insurance" },
  },
  {
    lat: 35.4798,
    lon: -97.5101,
    tags: { name: "State Farm", phone: "+1 405 290 7108", office: "insurance" },
  },
];
assert(/842.?3500/.test(pickOsmOfficeForInvestor(sf, els)?.tags?.phone || ""), "nearest State Farm keeps its own phone");
const filledOffices = applyOsmOfficesToInvestors([sf, other], els);
assert(/842.?3500/.test(filledOffices[0].phone) && /290.?7108/.test(filledOffices[1].phone), "in-view OSM phones land on the right pin");
assert(
  listedInvestorsFromOsmElements(els).some((inv) => /842.?3500/.test(inv.phone)),
  "OSM elements become drawable offices with phones",
);
assert(investorInBounds(sf, { south: 35.51, west: -97.56, north: 35.53, east: -97.53 }), "office in frame");
assert(!investorInBounds(sf, { south: 36.1, west: -95.9, north: 36.2, east: -95.8 }), "office out of frame stays cold");

console.log("investors ok");
