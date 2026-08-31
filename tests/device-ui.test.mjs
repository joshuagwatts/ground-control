import { detectFormFactor, useDesktopChrome, usePhoneChrome } from "../www/device.js";
import { isBusinessPhoneSource } from "../www/contacts.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const f = detectFormFactor({ refresh: true });
assert(f === "phone" || f === "tablet" || f === "desktop", `form factor, got ${f}`);
assert(useDesktopChrome() === (f === "desktop"), "desktop chrome");
assert(usePhoneChrome() === (f !== "desktop"), "phone chrome");

assert(isBusinessPhoneSource("chamber"), "chamber biz");
assert(isBusinessPhoneSource("apartments"), "apts biz");
assert(isBusinessPhoneSource("yellowpages"), "yp biz");
assert(!isBusinessPhoneSource("ok-phonebook"), "phonebook home");
assert(!isBusinessPhoneSource("zillow"), "zillow home");

console.log("device-ui ok");
