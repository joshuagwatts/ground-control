import {
  detectFormFactor,
  useDesktopChrome,
  usePhoneChrome,
  isAndroid,
  isAppleDevice,
  isSlowBrowserNet,
  listingBrowserHeaders,
  flagNetProfile,
} from "../www/device.js";
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
assert(isRentalPhoneSource("rent-com"), "rent.com rental");
assert(isRentalPhoneSource("realtor"), "realtor rental");

const androidUa =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
const iphoneUa =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const chromeDesktop =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

assert(isAndroid(androidUa, "web"), "android ua");
assert(!isAndroid(iphoneUa, "web"), "iphone not android");
assert(isAndroid("x", "android"), "capacitor android");
assert(isAppleDevice(iphoneUa, "web"), "iphone apple");
assert(!isAppleDevice(androidUa, "web"), "android not apple");
assert(!isSlowBrowserNet(androidUa, "web"), "android chrome stays fast");
assert(!isSlowBrowserNet(chromeDesktop, "web"), "desktop chrome stays fast");
assert(isSlowBrowserNet(iphoneUa, "web"), "safari web is the slow path");
assert(!isSlowBrowserNet(iphoneUa, "ios"), "native ios is not slow");

const aHead = listingBrowserHeaders({ ua: androidUa, cap: "web" });
assert(/Android/i.test(aHead["User-Agent"]), "android listing ua is Chrome");
const zHead = listingBrowserHeaders({ zillow: true, ua: androidUa, cap: "web" });
assert(/iPhone/i.test(zHead["User-Agent"]), "zillow still uses Safari ua");
const iHead = listingBrowserHeaders({ ua: iphoneUa, cap: "web" });
assert(/iPhone/i.test(iHead["User-Agent"]), "apple listing ua is Safari");

const aProf = flagNetProfile({ ua: androidUa, cap: "web" });
assert(aProf.zillowDetails === 22 && aProf.cityChunk === 4 && aProf.paintMax === 260, "android flag profile");
const iProf = flagNetProfile({ ua: iphoneUa, cap: "web" });
assert(iProf.zillowDetails === 14 && iProf.cityChunk === 2 && iProf.paintMax === 450, "safari flag profile");
const dProf = flagNetProfile({ ua: chromeDesktop, cap: "web" });
assert(dProf.zillowDetails === 36 && dProf.cityChunk === 3 && dProf.paintMax === 450, "desktop flag profile");

console.log("device-ui ok");
