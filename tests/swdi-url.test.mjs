import assert from "node:assert/strict";
import { needsBrowserCorsProxy, rewriteNoaaSwdiUrl } from "../www/net.js";

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
assert.equal(needsBrowserCorsProxy("https://api.weather.gov/alerts"), true, "weather.gov still needs a proxy");
assert.equal(needsBrowserCorsProxy("https://example.com/x"), false, "plain hosts stay direct");

console.log("swdi-url ok");
