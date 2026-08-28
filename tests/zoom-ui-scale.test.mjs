import assert from "node:assert/strict";
import { zoomUiScale } from "../www/wx.js";

const ref = zoomUiScale(18);
assert(Math.abs(ref - 1) < 0.01, "reference zoom should be ~1.0");

const out = zoomUiScale(12);
const inn = zoomUiScale(20);
assert(out < ref, "zoomed out should shrink icons");
assert(inn > ref, "zoomed in should grow icons slightly");
assert(out >= 0.2, "minimum scale floor");
assert(inn <= 1.1, "maximum scale cap");

console.log("zoom-ui-scale: ok");
