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
} from "../www/contacts.js";
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

assert(isRentalPhoneSource("apartments") && !isBusinessPhoneSource("apartments"), "apartments = rental");
assert(classifyFlagPhone({ phone: "(405) 348-9911", source: "apartments" }) === "rental", "apts class");
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

console.log("place-contacts ok");
