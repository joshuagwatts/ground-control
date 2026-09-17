import assert from "node:assert/strict";
import {
  needsBrowserCorsProxy,
  rewriteNoaaSwdiUrl,
  proxyLooksDown,
  noteProxyResult,
  resetProxyOutages,
} from "../www/net.js";

const ncdc = "https://www.ncdc.noaa.gov/swdiws/json/nx3hail/20260501:20260502?bbox=-98,35,-97,36";
const ncei = rewriteNoaaSwdiUrl(ncdc);
assert.equal(
  ncei,
  "https://www.ncei.noaa.gov/swdiws/json/nx3hail/20260501:20260502?bbox=-98,35,-97,36",
  "rewrite ncdc SWDI to ncei",
);
assert.equal(
  rewriteNoaaSwdiUrl("https://ncdc.noaa.gov/swdiws/json/nx3hail/20260501:20260502"),
  "https://www.ncei.noaa.gov/swdiws/json/nx3hail/20260501:20260502",
  "rewrite host without www",
);
assert.equal(rewriteNoaaSwdiUrl(ncei), ncei, "ncei URL is left alone");

assert.equal(needsBrowserCorsProxy(ncei), false, "ncei SWDI is fetched directly");
assert.equal(needsBrowserCorsProxy(ncdc), true, "legacy ncdc still needs a proxy");
assert.equal(needsBrowserCorsProxy("https://api.weather.gov/alerts"), false, "api.weather.gov is CORS-open");
assert.equal(
  needsBrowserCorsProxy("https://www.spc.noaa.gov/climo/reports/240520_rpts_filtered.csv"),
  false,
  "SPC reports are CORS-open",
);
assert.equal(
  needsBrowserCorsProxy("https://mesonet.agron.iastate.edu/cgi-bin/request/gis/lsr.py?type=HAIL"),
  false,
  "IEM LSR is CORS-open",
);
assert.equal(needsBrowserCorsProxy("https://example.com/x"), false, "plain hosts stay direct");
assert.equal(needsBrowserCorsProxy("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"), true, "census sends no CORS header, so it needs a relay");

/* ── Dead relays must not be paid for twice ────────────────────────────────── */

resetProxyOutages();
const relay = "https://api.allorigins.win/raw?url=x";
assert.equal(proxyLooksDown(relay), false, "an untried relay is fair game");
noteProxyResult(relay, false);
assert.equal(proxyLooksDown(relay), false, "one failure could be the request, not the relay");
noteProxyResult(relay, false);
assert.equal(proxyLooksDown(relay), true, "twice is an outage — stop paying its timeout");

// Host-level, so every later URL through the same relay is skipped too.
assert.equal(proxyLooksDown("https://api.allorigins.win/get?url=other"), true, "the whole relay is cooling down");
assert.equal(proxyLooksDown("https://proxy.cors.sh/whatever"), false, "a different relay is unaffected");

// It has to come back on its own, and a success must clear the mark.
assert.equal(proxyLooksDown(relay, Date.now() + 6 * 60 * 1000), false, "the cooldown expires");
noteProxyResult(relay, true);
assert.equal(proxyLooksDown(relay), false, "a success wipes the strikes");

// The service-worker leg is keyed on the target: it can never carry the Census
// geocoder, but that must not stop it carrying NOAA.
resetProxyOutages();
noteProxyResult("sw:geocoding.geo.census.gov", false);
noteProxyResult("sw:geocoding.geo.census.gov", false);
assert.equal(proxyLooksDown("sw:geocoding.geo.census.gov"), true, "census is written off on the service-worker leg");
assert.equal(proxyLooksDown("sw:www.ncei.noaa.gov"), false, "NOAA still goes through the service worker");
resetProxyOutages();

console.log("swdi-url ok");
