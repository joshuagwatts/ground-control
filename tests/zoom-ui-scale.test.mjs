import assert from "node:assert/strict";
import { zoomUiScale } from "../www/wx.js";

assert.equal(zoomUiScale(18), 1);
assert.equal(zoomUiScale(20), 1);
assert.ok(zoomUiScale(15) < 1);
assert.ok(zoomUiScale(15) >= 0.55);
assert.equal(zoomUiScale(10), 0.55);

console.log("zoom-ui-scale: ok");
