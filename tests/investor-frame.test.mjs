import { investorPinFrameTarget } from "../www/wx.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

// Fake Leaflet bounds: contains() + pad() like L.latLngBounds.
function fakeBounds({ contains = true } = {}) {
  const b = {
    _contains: contains,
    contains() {
      return b._contains;
    },
    pad() {
      return b;
    },
  };
  return b;
}

const heart = { id: "h1", kind: "insurance", lat: 35.5, lon: -97.6 };
const star = { id: "s1", kind: "realestate", lat: 35.6, lon: -97.5 };

// Pin already on camera → no move.
assert(
  investorPinFrameTarget(heart, fakeBounds({ contains: true }), 15) === null,
  "on-camera pin returns null",
);
// Pin off camera → fly target at current zoom.
{
  const t = investorPinFrameTarget(heart, fakeBounds({ contains: false }), 16);
  assert(t && t.lat === 35.5 && t.lon === -97.6 && t.zoom === 16, "off-camera pin keeps zoom");
}
// Zoomed way out → clamp to a usable 14.
{
  const t = investorPinFrameTarget(star, fakeBounds({ contains: false }), 6);
  assert(t && t.zoom === 14, `zoom clamps to 14, got ${t && t.zoom}`);
}
// No view info → still frame it.
{
  const t = investorPinFrameTarget(heart, null, 12);
  assert(t && t.lat === 35.5 && t.zoom === 14, "null view frames at min zoom");
}
// Bad coords → never frame.
assert(investorPinFrameTarget({ id: "x", lat: null, lon: -97 }, fakeBounds(), 15) === null, "null lat");
assert(investorPinFrameTarget({ id: "x", lat: 35, lon: NaN }, fakeBounds(), 15) === null, "NaN lon");
assert(investorPinFrameTarget(null, fakeBounds(), 15) === null, "null investor");
// Bounds without pad() (older shim) → still works.
{
  const b = { contains: () => false };
  const t = investorPinFrameTarget(heart, b, 15);
  assert(t && t.zoom === 15, "pad-less bounds frames");
}
// contains() throwing → frame rather than crash.
{
  const b = {
    pad() {
      throw new Error("boom");
    },
  };
  const t = investorPinFrameTarget(heart, b, 15);
  assert(t && t.lat === 35.5, "throwing bounds frames");
}

console.log("investor-frame ok");
