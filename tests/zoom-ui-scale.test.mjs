import assert from "node:assert/strict";
import { zoomUiScale, hailDotZoomScale } from "../www/wx.js";

assert.equal(zoomUiScale(18), 1);
assert.equal(zoomUiScale(20), 1);
assert.ok(zoomUiScale(15) < 1);
assert.equal(zoomUiScale(15), 0.5);
assert.equal(zoomUiScale(9), 0.4);

assert.equal(hailDotZoomScale(18), 1);
assert.ok(hailDotZoomScale(15) < zoomUiScale(15));
assert.ok(hailDotZoomScale(9) <= 0.12);
assert.ok(hailDotZoomScale(12) < hailDotZoomScale(15));

console.log("zoom-ui-scale: ok");
