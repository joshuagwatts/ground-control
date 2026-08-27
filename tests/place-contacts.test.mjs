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
} from "../www/contacts.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const parsed = parseStreetAddress("2521 Tredington Way, Edmond, Oklahoma, 73034");
assert(parsed.house === "2521", "house");
assert(/tredington/i.test(parsed.street), "street");
assert(/edmond/i.test(parsed.city), "city");
assert(stateAbbr("Oklahoma") === "ok", "state");
assert(parsed.zip === "73034", "zip");

assert(isJunkPhone("(405) 555-1212"), "555 is junk");
assert(phoneDigits("918-582-0001") === "+19185820001", "real phone");
assert(formatPhone("9185820001") === "(918) 582-0001", "format");

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

console.log("place-contacts ok");
