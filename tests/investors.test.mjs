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
  osmInvestorKind,
  osmParcelOnly,
  nameReadsLikeInvestor,
  osmTagContext,
  photonBboxParam,
  boundsAround,
  officeSweepWorthIt,
  listingFromPhotonFeature,
  PHOTON_REALESTATE_TERMS,
  PHOTON_INSURANCE_TERMS,
  normalizeListing,
  listingIsExact,
  mappedInvestorListings,
  unmappedInvestorListings,
  listingsForSelectedOffice,
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
  officeOverpassQueryNarrow,
  clampOfficeBounds,
  applyOsmOfficesToInvestors,
  listedInvestorsFromOsmElements,
  isOfficeOsmElement,
  pickOsmOfficeForInvestor,
  listingNearOffice,
  parseZillowDetailParts,
  parseRealtorDetailParts,
  listingAddressParts,
  photonHitPrecision,
  nominatimHitPrecision,
  scoreListingGeoHit,
  parseCensusMatch,
  parseArcGisMatch,
  summarizeAgentAccuracy,
  withDeadline,
  SHALLOW_LOOKUP_MS,
  DEEP_LOOKUP_MS,
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

const office = { lat: 35.4676, lon: -97.5164 };
assert(listingNearOffice(office, { lat: 35.49, lon: -97.53 }), "nearby sale home stays");
assert(!listingNearOffice(office, { lat: 36.15, lon: -95.99 }), "tulsa dump does not pin on an okc star");
assert(!listingNearOffice(office, { lat: 35.4676, lon: -97.5164 }), "office coordinate is not a listing");

/* ── Agents we used to drop on the floor ───────────────────────────────────── */

// OSM tags realty offices half a dozen ways; only two of them used to count.
assert(classifyInvestorKind("Sam J Silver Real Estate", "shop=estate_agent") === "realestate", "shop=estate_agent is a star");
assert(classifyInvestorKind("Cornerstone", "office=property_management") === "realestate", "property_management is a star");
assert(classifyInvestorKind("Paula and Company Realtors", "office=company") === "realestate", "realtors in the name is a star");
assert(classifyInvestorKind("Homeplace", "office=company") === "realestate", "a named brokerage office is a star");
assert(classifyInvestorKind("Homeplace Diner", "amenity=restaurant") === "", "a restaurant is never an agent");
assert(classifyInvestorKind("Goosehead Insurance", "office=company") === "insurance", "insurance brand in the name is a heart");
assert(
  classifyInvestorKind("Chinowth & Cohen", "office=insurance shop=estate_agent") === "realestate",
  "an estate agent that also sells insurance is still a star",
);
assert(osmInvestorKind({ tags: { name: "McGraw Realtors", office: "company" } }) === "realestate", "osm element kind");
assert(classifyInvestorKind("Braden Group", osmTagContext({ office: "estate_agent" })) === "realestate", "office=estate_agent is a star whatever the name reads");
assert(
  osmTagContext({ tags: { office: "estate_agent" } }) === osmTagContext({ office: "estate_agent" }),
  "tag context reads an element or a bare tag bag the same way",
);
assert(osmInvestorKind({ tags: { office: "estate_agent" } }) === "", "an unnamed office is not drawable");
assert(isOfficeOsmElement({ tags: { name: "Metro First Realty", shop: "estate_agent" } }), "shop-tagged office counts");
assert(!isOfficeOsmElement({ tags: { name: "Sonic Drive-In", amenity: "fast_food" } }), "drive-in is not an office");

const sweep = officeOverpassQuery(35.4, -97.6, 35.55, -97.42);
assert(/nwr\["office"\]/.test(sweep), "overpass sweeps every office in frame, not two tag values");
assert(/shop"="estate_agent/.test(sweep), "overpass asks for shop-tagged estate agents");
assert(/State Farm/.test(sweep), "overpass asks for State Farm");
assert(/nwr\["office"="property_management"\]/.test(officeOverpassQueryNarrow(35.4, -97.6, 35.55, -97.42)), "narrow fallback keeps property management");

const shopTagged = listedInvestorsFromOsmElements([
  { lat: 35.5003, lon: -97.5337, tags: { name: "Sam J Silver Real Estate", shop: "estate_agent", phone: "+1 405 521 2481" } },
  { lat: 35.4707, lon: -97.5458, tags: { name: "Paula and Company Realtors" } },
]);
assert(shopTagged.length === 2 && shopTagged.every((i) => i.kind === "realestate"), "both realty offices become stars");

/* ── Listing dots: the house, or no dot at all ─────────────────────────────── */

const zParts = parseZillowDetailParts("2200-Westheimer-Dr-Norman-OK-73069/111_zpid/");
assert(zParts.street === "2200 Westheimer Dr", "zillow slug → street without the city glued on");
assert(zParts.city === "Norman", "zillow slug → city");
assert(zParts.zip === "73069", "zillow slug keeps the zip the geocoder needs");
assert(zParts.house === "2200", "zillow slug → house number");
assert(parseZillowDetailParts("500-S-Broadway-Ave-APT-4-Edmond-OK-73034/12_zpid").city === "Edmond", "unit rides with the street");
assert(parseRealtorDetailParts("123-Main-St_Oklahoma-City_OK_73120_M12345").zip === "73120", "realtor slug keeps the zip");
assert(listingAddressParts("1417 NW 34th St, Oklahoma City, OK 73118").zip === "73118", "free-text address → parts");
assert(!listingAddressParts("Oklahoma City, OK"), "a city is not a listing address");

assert(photonHitPrecision({ type: "street", osm_key: "highway" }) === "street", "road centreline graded as street");
assert(photonHitPrecision({ housenumber: "1417" }) === "rooftop", "house number is a rooftop");
assert(photonHitPrecision({ type: "house", osm_key: "amenity" }) === "approx", "a named POI is not the address we asked for");
assert(photonHitPrecision({ type: "city", osm_key: "place" }) === "area", "city centroid graded as area");
assert(nominatimHitPrecision({ class: "highway", addresstype: "road" }) === "street", "nominatim road graded as street");
assert(nominatimHitPrecision({ address: { house_number: "1417" } }) === "rooftop", "nominatim house number is a rooftop");

const want = { house: "1417", street: "NW 34th St", city: "Oklahoma City", zip: "73118" };
const near = { lat: 35.5, lon: -97.53 };
assert(
  scoreListingGeoHit({ lat: 35.4951, lon: -97.5388, precision: "street", street: "NW 34th St" }, want, near) < 0,
  "a street centreline never wins — this is the dot in the middle of the road",
);
assert(
  scoreListingGeoHit({ lat: 35.5053, lon: -97.5348, precision: "rooftop", housenumber: "9999", street: "NW 34th St" }, want, near) < 0,
  "the wrong house number on the right street is rejected",
);
assert(
  scoreListingGeoHit(
    { lat: 35.5053, lon: -97.5348, precision: "rooftop", housenumber: "1417", street: "NW 34th St", city: "Oklahoma City", postcode: "73118" },
    want,
    near,
  ) > 10,
  "the matching house scores well clear of everything else",
);
assert(
  scoreListingGeoHit({ lat: 36.15, lon: -95.99, precision: "rooftop", housenumber: "1417" }, want, near) < 0,
  "a rooftop in the wrong metro is rejected",
);

const census = parseCensusMatch({
  matchedAddress: "1417 NW 34TH ST, OKLAHOMA CITY, OK, 73118",
  coordinates: { x: -97.534816, y: 35.505303 },
  addressComponents: { preDirection: "NW", streetName: "34TH", suffixType: "ST", city: "OKLAHOMA CITY", zip: "73118" },
});
assert(census.housenumber === "1417" && census.postcode === "73118", "census match → house number + zip");
assert(census.precision === "parcel" && census.geoSource === "census", "census match is parcel-accurate");
assert(scoreListingGeoHit(census, want, near) > 0, "census match is usable");

const arcRooftop = parseArcGisMatch({
  location: { x: -97.5348, y: 35.5053 },
  attributes: {
    Addr_type: "PointAddress",
    AddNum: "1417",
    StAddr: "1417 NW 34th St",
    StName: "34th",
    City: "Oklahoma City",
    Postal: "73118",
  },
});
assert(arcRooftop.precision === "rooftop" && arcRooftop.geoSource === "arcgis", "ArcGIS PointAddress is the house");
assert(arcRooftop.housenumber === "1417" && arcRooftop.postcode === "73118", "ArcGIS match → house + zip");
assert(scoreListingGeoHit(arcRooftop, want, near) > 10, "ArcGIS rooftop scores like a verified house");
const arcRoad = parseArcGisMatch({
  location: { x: -97.53, y: 35.5 },
  attributes: { Addr_type: "StreetName", StName: "NW 34th St", City: "Oklahoma City" },
});
assert(arcRoad.precision === "street", "ArcGIS StreetName is the road, not the house");
assert(scoreListingGeoHit(arcRoad, want, near) < 0, "a road match never becomes a listing dot");

const mixed = normalizeInvestor({
  kind: "realestate",
  name: "Dot Precision Realty",
  lat: 35.47,
  lon: -97.52,
  listings: [
    { address: "1 Roof St, OKC, OK", lat: 35.48, lon: -97.53, precision: "rooftop", geoSource: "census" },
    { address: "2 Block Ave, OKC, OK", lat: 35.481, lon: -97.531, precision: "approx" },
    { address: "3 Centreline Rd, OKC, OK", lat: 35.482, lon: -97.532, precision: "street" },
    { address: "4 Unplaceable Ln, OKC, OK" },
  ],
});
assert(mappedInvestorListings(mixed).length === 2, "rooftop and approximate homes draw; a street centreline does not");
assert(!mappedInvestorListings(mixed).some((h) => /Centreline/.test(h.address)), "the street-centreline home is never drawn");
assert(unmappedInvestorListings(mixed).length === 2, "centreline and un-geocoded homes stay listed as address-only");
const nearFar = normalizeInvestor({
  kind: "realestate",
  name: "Near Far Realty",
  lat: 35.47,
  lon: -97.52,
  listings: [
    { address: "1 Near St, OKC, OK", lat: 35.475, lon: -97.525, precision: "rooftop" },
    { address: "2 Also Near Ave, OKC, OK", lat: 35.48, lon: -97.53, precision: "approx" },
    { address: "3 Across Town, Edmond, OK", lat: 35.65, lon: -97.48, precision: "rooftop" },
    { address: "4 Street only, OKC, OK", lat: 35.471, lon: -97.521, precision: "street" },
  ],
});
const officeDots = listingsForSelectedOffice(nearFar, { maxKm: 12, limit: 36 });
assert(officeDots.length === 2, "gold dots stay near the selected office when nearby homes exist");
assert(
  officeDots.every((h) => /Near/.test(h.address)),
  "a home across town does not steal the selected office's gold-dot set",
);
const farOnly = normalizeInvestor({
  kind: "realestate",
  name: "Spread Realty",
  lat: 35.47,
  lon: -97.52,
  listings: [{ address: "9 Far Rd, Edmond, OK", lat: 35.65, lon: -97.48, precision: "rooftop" }],
});
assert(
  listingsForSelectedOffice(farOnly, { maxKm: 12 }).length === 1,
  "if nothing is nearby, still show the nearest mapped home so a star is never blank",
);
assert(listingsForSelectedOffice(mixed, { limit: 8 }).length === 2, "undrawable rows never become gold dots");
assert(listingIsExact(mixed.listings[0]) && !listingIsExact(mixed.listings[1]), "only a verified home reads as exact");
assert(normalizeListing({ lat: 1, lon: 2 }).precision === "approx", "a listing with no precision is treated as approximate");
const exactBox = investorListingBounds(mixed);
assert(exactBox && exactBox.north < 35.4901, "listing bounds ignore homes we refused to place");

const accBox = { south: 35.46, west: -97.56, north: 35.54, east: -97.48 };
const accRep = summarizeAgentAccuracy(
  [
    mixed,
    normalizeInvestor({
      kind: "insurance",
      name: "Quiet Farm",
      lat: 35.47,
      lon: -97.52,
    }),
    normalizeInvestor({
      kind: "realestate",
      name: "Out of Frame Realty",
      lat: 36.12,
      lon: -95.9,
      listings: [{ address: "1 Far St, Tulsa, OK", lat: 36.13, lon: -95.91, precision: "rooftop" }],
    }),
  ],
  accBox,
);
assert(accRep.offices === 2 && accRep.hearts === 1 && accRep.stars === 1, "accuracy counts only the current frame");
assert(accRep.onMap === 3 && accRep.onMapStars === 2 && accRep.cameraEmpty === false, "accuracy still names what is on the map");
assert(accRep.verified === 1 && accRep.approximate === 1 && accRep.addressOnly === 2, "accuracy splits verified / loose / address-only");
assert(accRep.missingPhone === 2 && accRep.missingPhoneNames.includes("Quiet Farm"), "offices without a phone are named");
assert(!accRep.looseHomes.some((a) => /Far St/.test(a)), "homes outside the frame do not pollute the report");
const emptyCam = summarizeAgentAccuracy(
  [normalizeInvestor({ kind: "realestate", name: "Far Star", lat: 36.12, lon: -95.9 })],
  accBox,
);
assert(emptyCam.cameraEmpty && emptyCam.onMap === 1 && emptyCam.offices === 0, "a loaded office outside the camera is not reported as missing");

/* ── Photon has to be frame-bounded or the whole sweep is thrown away ──────── */

const okcBox = { south: 35.46, west: -97.56, north: 35.54, east: -97.48 };
assert(photonBboxParam(okcBox) === "-97.56000,35.46000,-97.48000,35.54000", "bbox is lon,lat,lon,lat for photon");
assert(!photonBboxParam({ south: 35.5, west: -97.5, north: 35.4, east: -97.4 }), "an inside-out box is not a bbox");
assert(!photonBboxParam(null), "no bounds, no bbox");
const around = boundsAround(35.5, -97.52, 0.06);
assert(around.south < 35.5 && around.north > 35.5 && around.west < -97.52 && around.east > -97.52, "a centre becomes a frame");
assert(photonBboxParam(boundsAround(35.5, -97.52)), "the one-shot hunt still gets a bbox");
assert(PHOTON_REALESTATE_TERMS.includes("realty") && PHOTON_REALESTATE_TERMS.includes("property management"), "star terms");
assert(PHOTON_INSURANCE_TERMS.includes("insurance"), "heart terms");
assert(
  !PHOTON_REALESTATE_TERMS.some((t) => /keller|re\/max|century/i.test(t)),
  "brand terms cost a request and found nothing the trade words missed",
);

/* ── Places OSM calls an estate agent that plainly are not ─────────────────── */

const osmEl = (tags) => ({ type: "way", tags });

// A surveyed amenity beats a stale office tag — nobody brokers houses from the kitchen.
assert(!osmInvestorKind(osmEl({ name: "Culberson Center", landuse: "retail", amenity: "restaurant", office: "estate_agent" })), "a restaurant is not an agent, office tag or not");
assert(!osmInvestorKind(osmEl({ name: "Corner Cafe", shop: "coffee", office: "estate_agent" })), "a coffee shop is not an agent");

// The name names another trade. "Realty" in the name does not make a storage yard an office.
assert(!osmInvestorKind(osmEl({ name: "Eureka Water", landuse: "industrial", office: "estate_agent" })), "a bottled-water plant is not an agent");
assert(!osmInvestorKind(osmEl({ name: "Naifco Realty Central Storage", landuse: "industrial" })), "a storage yard is not an agent even with Realty in the name");
assert(!osmInvestorKind(osmEl({ name: "Brent Gibson Classic Home Design", building: "yes", office: "estate_agent", "addr:housenumber": "415" })), "a home designer is not an agent");
assert(!osmInvestorKind(osmEl({ name: "Faith Chapel", office: "estate_agent" })), "a chapel is not an agent");
assert(!osmInvestorKind(osmEl({ name: "Insurance Repair Specialists", office: "company", "addr:housenumber": "9" })), "a restoration contractor is not an insurance agency");
assert(!osmInvestorKind(osmEl({ name: "Sooner Towing", office: "estate_agent" })), "a wrecker yard is not an agent");

// Ground with an office tag and nothing else has to earn the pin on its name.
assert(osmParcelOnly({ landuse: "commercial", office: "estate_agent" }), "a landuse polygon with no door and no phone is just ground");
assert(!osmParcelOnly({ landuse: "commercial", office: "estate_agent", "addr:housenumber": "3101" }), "a door number makes it a place");
assert(!osmParcelOnly({ landuse: "commercial", office: "estate_agent", phone: "+1 405 555 0100" }), "a phone makes it a place");
assert(!osmParcelOnly({ building: "commercial", office: "estate_agent" }), "a building is not a landuse parcel");
assert(!osmInvestorKind(osmEl({ name: "3101 Treat Building", landuse: "commercial", office: "estate_agent" })), "an office block is not the agency inside it");
assert(!osmInvestorKind(osmEl({ name: "York Investment Loans", landuse: "industrial", office: "insurance" })), "a loan office tagged insurance on bare ground is dropped");

// …but the parcel rule must not cost us the agents that only live on a polygon.
assert(osmInvestorKind(osmEl({ name: "Dean Fleshmans Real Estate", landuse: "industrial", office: "estate_agent" })) === "realestate", "a parcel whose name says real estate keeps its star");
assert(osmInvestorKind(osmEl({ name: "Paula and Company Realtors", landuse: "retail" })) === "realestate", "a parcel whose name says realtors keeps its star");
assert(osmInvestorKind(osmEl({ name: "Don A Boyington Properties", landuse: "industrial", office: "estate_agent" })) === "realestate", "an X Properties firm is a star");
assert(osmInvestorKind(osmEl({ name: "Livingston Properties, LLC", office: "estate_agent", "addr:housenumber": "800" })) === "realestate", "an X Properties, LLC firm is a star");
assert(
  osmInvestorKind(osmEl({ name: "Gallaggher Risk Management Services", landuse: "commercial", office: "insurance" })) === "insurance",
  "risk management is the insurance trade",
);
assert(nameReadsLikeInvestor("Abercrombie Properties") && !nameReadsLikeInvestor("3101 Treat Building"), "name-only agency test");
assert(!nameReadsLikeInvestor("Property Damage Restoration"), "properties must be the trade, not a passing word");

// A leasing office still manages property — those stay.
assert(
  osmInvestorKind(osmEl({ name: "Sooner Crossing Apartments", building: "apartments", office: "estate_agent", "addr:housenumber": "2" })) === "realestate",
  "an apartment leasing office is still a property manager",
);

assert(officeSweepWorthIt(okcBox), "a real frame over OKC is worth sweeping");
// A map that has not laid out yet reports a frame metres wide, in the wrong state.
assert(!officeSweepWorthIt({ south: 45.83983, west: -119.70529, north: 45.84037, east: -119.70471 }), "no sweep before the map lays out");
assert(!officeSweepWorthIt({ south: 35.5, west: -97.53, north: 35.5005, east: -97.5295 }), "a sixty-metre frame is not worth seven round trips");
assert(!officeSweepWorthIt({ south: 40.6, west: -74.1, north: 40.8, east: -73.9 }), "no sweep outside Oklahoma");
assert(officeSweepWorthIt({ south: 33.0, west: -104.0, north: 38.0, east: -94.0 }), "a frame that overlaps the state still sweeps");
assert(!officeSweepWorthIt(null), "no frame, no sweep");

// Photon labels an office with osm_key/osm_value; that has to classify like an OSM tag.
const photonOffice = listingFromPhotonFeature({
  geometry: { coordinates: [-97.5337, 35.5003] },
  properties: { name: "Braden Group", osm_key: "office", osm_value: "estate_agent", state: "Oklahoma", city: "Oklahoma City" },
});
assert(photonOffice && photonOffice.kind === "realestate", "a photon estate agent is a star");
assert(
  !listingFromPhotonFeature({
    geometry: { coordinates: [-97.5337, 35.5003] },
    properties: { name: "Homeplace Diner", osm_key: "amenity", osm_value: "restaurant", state: "Oklahoma" },
  }),
  "a photon restaurant is not an agent",
);
assert(
  !listingFromPhotonFeature({
    geometry: { coordinates: [-93.29, 44.98] },
    properties: { name: "Realtor Association of Southern Minnesota", osm_key: "office", osm_value: "estate_agent" },
  }),
  "an out-of-state hit from an unbounded query is dropped",
);

/* ── One slow office must not hold the queue ───────────────────────────────── */

const never = new Promise(() => {});
const t0 = Date.now();
assert((await withDeadline(never, 60, "gave up")) === "gave up", "a hung lookup resolves to the fallback");
assert(Date.now() - t0 < 1500, "and it gives up on time");
assert((await withDeadline(Promise.reject(new Error("boom")), 500, "fell back")) === "fell back", "a failed lookup falls back");
assert(SHALLOW_LOOKUP_MS < DEEP_LOOKUP_MS, "the in-view sweep is cheaper than a tapped office");

console.log("investors ok");
