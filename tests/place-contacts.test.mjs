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
  resolveZillowUrl,
  isUsableZillowUrl,
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

console.log("place-contacts ok");
