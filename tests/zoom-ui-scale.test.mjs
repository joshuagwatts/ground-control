import assert from "node:assert/strict";
import { zoomUiScale } from "../www/wx.js";

assert.equal(zoomUiScale(18), 1);
assert.equal(zoomUiScale(20), 1);
assert.ok(zoomUiScale(15) < 1);
assert.equal(zoomUiScale(15), 0.5);
assert.equal(zoomUiScale(9), 0.4);

console.log("zoom-ui-scale: ok");
