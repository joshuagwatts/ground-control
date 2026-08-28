import assert from "node:assert/strict";
import { zoomUiScale } from "../www/wx.js";

assert.equal(zoomUiScale(), 1);
assert.equal(zoomUiScale(12), 1);
assert.equal(zoomUiScale(20), 1);

console.log("zoom-ui-scale: ok");
