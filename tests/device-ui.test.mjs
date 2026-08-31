import { detectFormFactor, useDesktopChrome, usePhoneChrome } from "../www/device.js";
import { isBusinessPhoneSource, isRentalPhoneSource } from "../www/contacts.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const f = detectFormFactor({ refresh: true });
assert(f === "phone" || f === "tablet" || f === "desktop", `form factor, got ${f}`);
assert(useDesktopChrome() === (f === "desktop"), "desktop chrome");
assert(usePhoneChrome() === (f !== "desktop"), "phone chrome");

assert(isBusinessPhoneSource("chamber"), "chamber biz");
assert(isBusinessPhoneSource("yellowpages"), "yp biz");
assert(isBusinessPhoneSource("osm-business"), "osm biz");
assert(!isBusinessPhoneSource("apartments"), "apts are rentals, not biz");
assert(!isBusinessPhoneSource("realtor"), "realtor apartments are rentals");
assert(!isBusinessPhoneSource("ok-phonebook"), "phonebook home");
assert(!isBusinessPhoneSource("zillow"), "zillow sale home");
assert(isRentalPhoneSource("apartments"), "apts rental");
assert(isRentalPhoneSource("zillow-rent"), "zillow rent source");
assert(isRentalPhoneSource("realtor"), "realtor rental");

console.log("device-ui ok");
