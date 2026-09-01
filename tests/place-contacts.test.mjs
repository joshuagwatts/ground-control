import {
  parseStreetAddress,
  stateAbbr,
  extractPhones,
  extractEmails,
  extractContactsFromHtml,
  mergeContacts,
  formatPhone,
  phoneDigits,
  isJunkPhone,
  publicFacebookUrl,
  publicInstagramUrl,
  sameHouse,
  listingForPin,
  formatZillowUrl,
  formatZillowRentUrl,
  resolveZillowUrl,
  isUsableZillowUrl,
  isOklahomaAddress,
  publicTextFromHtml,
  parseAiContactJson,
  formatApartmentsComSearchUrl,
  formatRealtorRentSearchUrl,
  formatYellowPagesAddressUrl,
  extractSearchResultUrls,
  classifyFlagPhone,
  isRentalPhoneSource,
  isBusinessPhoneSource,
  isOsmBusinessTags,
  formatZillowCityRentUrl,
  formatRentComCityUrl,
  formatApartmentsComCityUrl,
  statePathSlug,
  parseRentComSearchJson,
  parseApartmentsComSearchHtml,
  parseZillowRentSearchJson,
  parseZillowRentDetailPhone,
  isOklahomaLatLon,
  citiesNearPoint,
  inferOkCity,
  mergeRentFlagList,
  persistRentFlags,
  loadPersistedRentFlags,
  persistedRentFlagsAt,
} from "../www/contacts.js";
import { parseOsmXmlNodes } from "../www/net.js";
import { formatOwnerName, formatMailing, parcelMatchesPin, pickParcel } from "../www/assessor.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const parsed = parseStreetAddress("2521 Tredington Way, Edmond, Oklahoma, 73034");
assert(parsed.house === "2521", "house");
assert(/tredington/i.test(parsed.street), "street");
assert(/edmond/i.test(parsed.city), "city");
assert(stateAbbr("Oklahoma") === "ok", "state");
assert(parsed.zip === "73034", "zip");

const z1 = formatZillowUrl("400 S Bryant Ave, Edmond, OK 73034");
assert(z1 === "https://www.zillow.com/homes/400-S-Bryant-Ave-Edmond-OK-73034_rb/", `zillow slug, got ${z1}`);
const zr = formatZillowRentUrl("400 S Bryant Ave, Edmond, OK 73034");
assert(
  zr === "https://www.zillow.com/homes/for_rent/400-S-Bryant-Ave-Edmond-OK-73034_rb/",
  `zillow rent slug, got ${zr}`,
);
assert(isOklahomaAddress("400 S Bryant Ave, Edmond, OK 73034"), "ok address");
assert(isOklahomaAddress("400 S Bryant Ave, Edmond, Oklahoma"), "oklahoma word");
assert(!isOklahomaAddress("100 Main St, Dallas, TX 75201"), "not oklahoma");
assert(isUsableZillowUrl(zr), "for_rent url usable");
const z2 = formatZillowUrl("2521 Tredington Way, Edmond, Oklahoma, 73034");
assert(z2.includes("2521-Tredington") && z2.endsWith("_rb/"), `zillow tredington, got ${z2}`);
assert(formatZillowUrl("35.6521, -97.4783") === "", "coords only, no zillow");
assert(formatZillowUrl("Edmond, Oklahoma, 73034") === "", "city only, no zillow");
assert(formatZillowUrl("Tredington Way, Edmond, Oklahoma, 73034") === "", "street only, no zillow");
assert(
  isUsableZillowUrl("https://www.zillow.com/homedetails/400-S-Bryant-Ave-Edmond-OK-73034/123_zpid/"),
  "homedetails ok",
);
assert(!isUsableZillowUrl("https://www.zillow.com/"), "bare zillow blocked");
assert(
  resolveZillowUrl("400 S Bryant Ave, Edmond, OK 73034", "https://www.zillow.com/") ===
    "https://www.zillow.com/homes/400-S-Bryant-Ave-Edmond-OK-73034_rb/",
  "resolve from address when cached url junk",
);
assert(
  resolveZillowUrl(
    "400 S Bryant Ave, Edmond, OK 73034",
    "https://www.zillow.com/homedetails/400-s-bryant-edmond-ok-73034/999_zpid/",
  ).includes("/homedetails/"),
  "resolve keeps homedetails",
);

assert(isJunkPhone("(405) 555-1212"), "555 is junk");
assert(phoneDigits("918-582-0001") === "+19185820001", "real phone");
assert(publicFacebookUrl("HighGroundOK") === "https://www.facebook.com/HighGroundOK", "fb handle");
assert(publicFacebookUrl("https://www.facebook.com/profile.php?id=1") === "", "skip personal profile");
assert(publicInstagramUrl("highground.ok") === "https://www.instagram.com/highground.ok", "ig handle");
assert(!publicInstagramUrl("https://www.instagram.com/p/abc123/"), "skip ig post");

const html = `
  <script type="application/ld+json">{"@type":"PostalAddress","streetAddress":"100 Main St"}</script>
  <p>100 Main Street, Tulsa</p>
  <a href="tel:9185820001">(918) 582-0001</a>
  <a href="mailto:office@example-roof.test">office@example-roof.test</a>
`;
const hit = extractContactsFromHtml(html, { house: "100", street: "Main" });
assert(hit && hit.phone.includes("582"), `phone from matching page, got ${JSON.stringify(hit)}`);
assert(hit.email === "office@example-roof.test", "email");

const miss = extractContactsFromHtml(`<a href="tel:9185820001">918-582-0001</a>`, { house: "100", street: "Main" });
assert(!miss, "reject phone on a page that is not this house");

const rentHtml = `
  <p>For rent · 400 S Bryant Ave</p>
  <script>window.__data = {"phoneNumber":"(405) 348-9911","listingType":"FOR_RENT"}</script>
  <a href="tel:4053489911">Call</a>
`;
const rentHit = extractContactsFromHtml(rentHtml, { house: "400", street: "Bryant" }, { requireAddress: false });
assert(rentHit && /348/.test(rentHit.phone || ""), `rent-style phone, got ${JSON.stringify(rentHit)}`);

const captchaNoise = `
  <script>window.cfChallenge = "captcha"; /* are you a robot */</script>
  <p>400 S Bryant Ave, Edmond OK</p>
  <a href="tel:4053489911">(405) 348-9911</a>
`;
const despiteCaptcha = extractContactsFromHtml(captchaNoise, { house: "400", street: "Bryant" });
assert(despiteCaptcha && /348/.test(despiteCaptcha.phone || ""), "parse phones even when page mentions captcha");

const phones = extractPhones("Call (918) 582-0001 or 405-555-0100");
assert(phones.includes("+19185820001"), "extract 918");
assert(!phones.some((p) => p.includes("555")), "skip 555");

const mails = extractEmails("reach us at desk@shop.test please");
assert(mails.includes("desk@shop.test"), "email extract");

const merged = mergeContacts({ phone: "918-582-0001" }, { email: "a@shop.test" });
assert(merged.phone === "(918) 582-0001" && merged.email === "a@shop.test", "merge");

assert(sameHouse("2521 Tredington Way, Edmond, OK", "2521 Tredington Way"), "same house");
assert(!sameHouse("2521 Tredington Way", "2501 Tredington Way"), "different house");
assert(!sameHouse("2521 Tredington Way", "2521 Broadway"), "different street");
assert(!sameHouse("400 S Bryant", "400 S Broadway"), "direction prefix is not the street");

assert(formatOwnerName("CITY OF EDMOND") === "City Of Edmond", "owner caps");
assert(formatOwnerName("SMITH RENTALS LLC") === "Smith Rentals LLC", "keep LLC");
assert(formatMailing("PO BOX 2970", "EDMOND", "OK", "73083-2970").includes("PO BOX 2970"), "mail po box");
assert(parcelMatchesPin("400 S Bryant, Edmond, OK", "400 S BRYANT AVE EDMOND"), "assessor situs");
assert(!parcelMatchesPin("2521 Tredington Way, Edmond, OK", "2501 TREDINGTON WAY EDMOND"), "wrong lot");

const okc = pickParcel({
  name1: "CITY OF EDMOND",
  mailingaddress1: "PO BOX 2970",
  city: "EDMOND",
  state: "OK",
  zipcode: "73083-2970",
  location: "400 S BRYANT AVE EDMOND",
  propertyid: 284860,
}, { source: "Oklahoma County", href: (row) => `https://docs.oklahomacounty.org/AssessorWP5/AN-R.asp?PropertyID=${row.propertyid}` });
assert(okc.name === "City Of Edmond", "ok county name");
assert(okc.mail.includes("PO BOX"), "ok county mail");
assert(/PropertyID=284860/.test(okc.url), "ok county card");

const cle = pickParcel({
  COUNTY_OWNER_1: "CITY OF NORMAN",
  COUNTY_MAILING_ADDRESS: "PO BOX 370",
  COUNTY_CITY: "NORMAN",
  COUNTY_STATE: "OK",
  COUNTY_ZIP: "73070",
  LOCATE_ADDRESS: "201 W GRAY ST",
}, { source: "Cleveland County", href: () => "https://www.clevelandcountyassessor.us/" });
assert(/Norman/i.test(cle.name), "cleveland name");
assert(cle.mail.includes("PO BOX 370") && /Norman/i.test(cle.mail), "cleveland packed mail");

const crk = pickParcel({
  ownername: "CITY OF SAPULPA",
  situs: "511 E LEE AVE",
  address1: "PO BOX 1130",
  citystate: "SAPULPA OK",
  zipcode: "74067",
});
assert(/Sapulpa/i.test(crk.name), "creek name");
assert(/Sapulpa/i.test(crk.mail), "creek citystate mail");

const pin = "2521 Tredington Way, Edmond, OK 73034";
const keep = listingForPin({ address: pin, phone: "918-582-0001", name: "Shop" }, pin);
assert(keep.phone.includes("582"), "keep listing at this house");
const drop = listingForPin(
  { address: "2501 Tredington Way, Edmond, OK 73034", phone: "918-582-0001", name: "Neighbor" },
  pin,
);
assert(!drop.phone && !drop.name, "drop neighbor listing");
assert(!extractContactsFromHtml(`<a href="tel:9185820001">918-582-0001</a>`, {}), "no house, no harvest");

const plain = publicTextFromHtml(`<script>evil()</script><style>.x{}</style><p>Owner: Jane Doe</p><a href="tel:9185820001">(918) 582-0001</a>`);
assert(!/script|style|<|>/i.test(plain), "strip tags/scripts");
assert(/Jane Doe/.test(plain) && /918/.test(plain), "keep public listing text");

const aiHit = parseAiContactJson('Sure\n{"name":"Jane Doe","phone":"(918) 582-0001","email":"office@example-roof.test"}\n');
assert(aiHit.name === "Jane Doe", "ai name");
assert(/582/.test(aiHit.phone), "ai phone");
assert(aiHit.email === "office@example-roof.test", "ai email");
assert(parseAiContactJson("not json").name === "", "ai empty on junk");

const apt = formatApartmentsComSearchUrl("400 S Bryant Ave, Edmond, OK 73034");
assert(/apartments\.com\/400-s-bryant-ave-edmond-ok-73034/i.test(apt), `apartments slug, got ${apt}`);
const rtr = formatRealtorRentSearchUrl("400 S Bryant Ave, Edmond, OK 73034");
assert(/realtor\.com\/apartments\/edmond_ok\/400-S-Bryant-Ave/i.test(rtr), `realtor rent, got ${rtr}`);
const yp = formatYellowPagesAddressUrl("400 S Bryant Ave, Edmond, OK 73034");
assert(/yellowpages\.com\/search/i.test(yp) && /400/i.test(yp), `yp url, got ${yp}`);
const chamberHits = extractSearchResultUrls(
  `<a href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.woodwardokchamber.com/list/acme-roofing")}">x</a>
   <a href="https://www.edmondchamber.com/directory/member">y</a>
   <a href="https://www.zillow.com/homes/foo">skip</a>`,
  { allowHostRe: /chamber/i, limit: 6 },
);
assert(chamberHits.some((u) => /woodwardokchamber/i.test(u)), "extract chamber uddg");
assert(chamberHits.some((u) => /edmondchamber/i.test(u)), "extract chamber href");
assert(!chamberHits.some((u) => /zillow/i.test(u)), "skip zillow in chamber extract");
assert(parseAiContactJson('{"owner_name":"Bob","owner_phone":"405-555-1212"}').name === "Bob", "ai owner_* keys");

assert(statePathSlug("OK") === "oklahoma", "ok state slug");
assert(formatZillowCityRentUrl("Edmond", "OK") === "https://www.zillow.com/edmond-ok/rentals/", "zillow city rent url");
assert(
  formatRentComCityUrl("Oklahoma City", "OK") === "https://www.rent.com/oklahoma/oklahoma-city-apartments",
  "rent.com city url",
);
assert(
  formatRentComCityUrl("Edmond", "OK", { kind: "houses", page: 2 }) ===
    "https://www.rent.com/oklahoma/edmond-houses?page=2",
  "rent.com houses page 2",
);
assert(isOklahomaLatLon(35.65, -97.48), "edmond is oklahoma");
assert(!isOklahomaLatLon(45.6, -118.7), "oregon is not oklahoma");

const rentNextHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      pageData: {
        location: {
          listingSearch: {
            listings: [
              {
                name: "Plaza East",
                address: "1600 Chelsea Dr",
                phoneMobile: "4057098424",
                phoneDesktop: "4057098424",
                urlPathname: "/apartment/plaza-east-edmond-ok-lc5911042",
                location: { lat: 35.637553, lng: -97.47956, city: "Edmond", stateAbbr: "OK", zip: "73013" },
              },
              {
                name: "No Phone Place",
                address: "1 Missing Ave",
                location: { lat: 35.65, lng: -97.48, city: "Edmond", stateAbbr: "OK" },
              },
            ],
          },
        },
      },
    },
  },
})}</script>`;
const rentFlags = parseRentComSearchJson(rentNextHtml);
assert(rentFlags.length === 1 && rentFlags[0].source === "rent-com", "rent.com skips phoneless");
assert(rentFlags[0].phone.includes("405") && rentFlags[0].name === "Plaza East", "rent.com phone+name");
assert(rentFlags[0].lat === 35.637553 && /rent\.com\/apartment\//.test(rentFlags[0].listingUrl), "rent.com coord+url");

const aptCityUrl = formatApartmentsComCityUrl("Edmond", "OK");
assert(aptCityUrl === "https://www.apartments.com/edmond-ok/", `apts city url, got ${aptCityUrl}`);
assert(
  formatApartmentsComCityUrl("Edmond", "OK", { page: 2 }) === "https://www.apartments.com/edmond-ok/2/",
  "apts city page 2",
);
const aptHtml = `<script>window.startup = ${JSON.stringify({
  listing: {
    placards: [
      {
        propertyName: "Covell Creek",
        phone: "(405) 348-2200",
        url: "/covell-creek-edmond-ok/abc123/",
        geography: { latitude: 35.6521, longitude: -97.4611 },
        addressInfo: { address: "100 N Broadway", city: "Edmond", state: "OK", zip: "73034" },
      },
      {
        propertyName: "No Phone Flats",
        geography: { latitude: 35.65, longitude: -97.47 },
        addressInfo: { address: "1 Missing Ave", city: "Edmond", state: "OK" },
      },
    ],
  },
})};</script>
<script type="application/ld+json">${JSON.stringify({
  "@type": "ApartmentComplex",
  name: "JSON-LD Arms",
  telephone: "(405) 341-8800",
  url: "https://www.apartments.com/json-ld-arms-edmond-ok/xyz/",
  address: { streetAddress: "200 N Boulevard", addressLocality: "Edmond", addressRegion: "OK", postalCode: "73034" },
  geo: { latitude: 35.66, longitude: -97.48 },
})}</script>`;
const aptFlags = parseApartmentsComSearchHtml(aptHtml);
assert(aptFlags.length === 2, `apts flags count ${aptFlags.length}`);
assert(aptFlags.some((r) => r.source === "apartments" && /348-2200/.test(r.phone) && r.name === "Covell Creek"), "apts startup placard");
assert(aptFlags.some((r) => /341-8800/.test(r.phone) && /JSON-LD/.test(r.name)), "apts json-ld");
assert(!aptFlags.some((r) => /No Phone/i.test(r.name)), "apts skips phoneless");

const zillowHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      searchPageState: {
        cat1: {
          searchResults: {
            listResults: [
              {
                statusType: "FOR_RENT",
                buildingName: "The Oaks at Covell",
                addressStreet: "3100 N Sooner Rd",
                addressCity: "Edmond",
                addressState: "OK",
                detailUrl: "/apartments/edmond-ok/the-oaks-at-covell/9ShCCW/",
                latLong: { latitude: 35.685337, longitude: -97.42201 },
              },
            ],
          },
        },
      },
    },
  },
})}</script>`;
const zSearch = parseZillowRentSearchJson(zillowHtml);
assert(zSearch.length === 1 && zSearch[0].source === "zillow-rent", "zillow city search row");
assert(!zSearch[0].phone && /zillow\.com\/apartments\//.test(zSearch[0].listingUrl), "zillow search has url, no phone");
assert(parseZillowRentDetailPhone(`<a href="tel:4052813307">Call</a>`) === "(405) 281-3307", "zillow detail tel");

assert(isRentalPhoneSource("apartments") && !isBusinessPhoneSource("apartments"), "apartments = rental");
assert(isRentalPhoneSource("rent-com") && !isBusinessPhoneSource("rent-com"), "rent.com = rental");
assert(classifyFlagPhone({ phone: "(405) 348-9911", source: "apartments" }) === "rental", "apts class");
assert(classifyFlagPhone({ phone: "4053489911", source: "rent-com" }) === "rental", "rent.com class");
assert(classifyFlagPhone({ phone: "4053489911", source: "zillow-rent", zillow_rent: true }) === "rental", "zillow rent class");
assert(
  classifyFlagPhone({ phone: "4053489911", zillow_url: "https://www.zillow.com/homes/for_rent/400-S-Bryant_rb/" }) ===
    "rental",
  "for_rent url class",
);
assert(classifyFlagPhone({ phone: "4053489911", source: "chamber" }) === "business", "chamber class");
assert(classifyFlagPhone({ phone: "4053489911", source: "yellowpages" }) === "business", "yp class");
assert(classifyFlagPhone({ phone: "4053489911", source: "osm-business" }) === "business", "osm class");
assert(classifyFlagPhone({ phone: "4053489911", source: "ok-phonebook" }) === "", "phone book is not a flag");
assert(classifyFlagPhone({ phone: "4053489911", source: "zillow" }) === "", "sale listing is not a flag");
assert(classifyFlagPhone({ source: "apartments" }) === "", "rental without phone is not a flag");
assert(isOsmBusinessTags({ amenity: "cafe" }), "amenity is business");
assert(!isOsmBusinessTags({ building: "house", phone: "1" }), "house phone is not a business");

const osmNodes = parseOsmXmlNodes(`
  <osm>
    <node id="1" lat="35.65928" lon="-97.47879">
      <tag k="name" v="Bondi Bowls"/>
      <tag k="shop" v="health_food"/>
      <tag k="phone" v="+1-405-982-8606"/>
    </node>
    <node id="2" lat="35.65" lon="-97.48"/>
  </osm>`);
assert(osmNodes.length === 1 && osmNodes[0].tags.name === "Bondi Bowls", "parse osm xml node");
assert(osmNodes[0].tags.phone.includes("405"), "parse osm xml phone");

assert(citiesNearPoint(35.6528, -97.4778)[0] === "Edmond", "viewport nearest Edmond");
assert(citiesNearPoint(35.2226, -97.4395)[0] === "Norman", "viewport nearest Norman");
assert(citiesNearPoint(36.154, -95.9928)[0] === "Tulsa", "viewport nearest Tulsa");
assert(citiesNearPoint(36.4337, -99.3904)[0] === "Woodward", "viewport nearest Woodward");
assert(citiesNearPoint(36.4337, -99.3904).length >= 150, "statewide OK municipality list");
assert(inferOkCity(36.4337, -99.3904) === "Woodward", "inferOkCity Woodward not OKC");
assert(inferOkCity(36.6828, -101.4816) === "Guymon", "inferOkCity Guymon");
assert(inferOkCity(35.6528, -97.4778) === "Edmond", "inferOkCity Edmond");
assert(!/oklahoma\s*city/i.test(inferOkCity(36.8, -102.5)), "panhandle not forced to OKC");

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(String(k), String(v)),
  removeItem: (k) => store.delete(k),
};
const rowA = { phone: "(405) 348-0001", lat: 35.6528, lon: -97.4778, city: "Edmond", source: "rent-com" };
const rowB = { phone: "(405) 348-0001", lat: 35.6528, lon: -97.4778, city: "Edmond", source: "rent-com" };
const rowC = { phone: "(405) 321-0002", lat: 35.2226, lon: -97.4395, city: "Norman", source: "rent-com" };
assert(mergeRentFlagList([], [rowA, rowB, rowC]).length === 2, "merge rent flags dedupes phone+coord");
persistRentFlags([rowA, rowC]);
const cached = loadPersistedRentFlags();
assert(cached.length === 2 && cached[0].city === "Edmond", "persist rent flags");
assert(persistedRentFlagsAt() > 0, "persist stamp");
persistRentFlags([rowA]);
assert(loadPersistedRentFlags().length === 2, "persist merge keeps prior cities");

console.log("place-contacts ok");
