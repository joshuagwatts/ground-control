/**
 * Smoke test for hail-swath region builder (MESH/Hailswath-style nested isosurfaces).
 * Imports wx.js helpers indirectly by exercising draw path math via a tiny inline port check.
 */
import assert from "node:assert/strict";
import { buildHailSwathRings } from "../www/wx.js";

// Morph close should fill a 1-cell gap
const HAIL_SWATH_THRESHOLDS = [0.75, 1.0, 1.5, 2.0, 2.5];
assert.ok(HAIL_SWATH_THRESHOLDS.every((t, i) => i === 0 || t > HAIL_SWATH_THRESHOLDS[i - 1]));
assert.equal(HAIL_SWATH_THRESHOLDS[0], 0.75);

// Morph close should fill a 1-cell gap
function dilateBinary(grid, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (grid[yy * w + xx]) on = 1;
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}
function erodeBinary(grid, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 1;
      for (let dy = -1; dy <= 1 && on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !grid[yy * w + xx]) on = 0;
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

const w = 5;
const h = 3;
// Gap at (1,1) between two hail footprint cells — close should fill it
const g = new Uint8Array(w * h);
g[1 * w + 0] = 1;
g[1 * w + 2] = 1;
const closed = erodeBinary(dilateBinary(g, w, h), w, h);
assert.equal(closed[1 * w + 1], 1, "morph close fills one-cell hailswath gap");

// Nested bands: weaker ring should cut a hole for the stronger core (no opacity stack).
function pointInLatLonRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    const denom = yj - yi || 1e-12;
    const intersect = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
const outer = [
  [0, 0],
  [0, 4],
  [4, 4],
  [4, 0],
  [0, 0],
];
const inner = [
  [1, 1],
  [1, 3],
  [3, 3],
  [3, 1],
  [1, 1],
];
assert.equal(pointInLatLonRing(2, 2, outer), true);
assert.equal(pointInLatLonRing(2, 2, inner), true);
assert.equal(pointInLatLonRing(0.5, 0.5, inner), false);

const swdiRing = [
  [35.5, -97.52],
  [35.53, -97.49],
  [35.51, -97.46],
  [35.48, -97.48],
  [35.49, -97.51],
  [35.5, -97.52],
];
const swdiPts = [
  {
    lat: 35.51,
    lon: -97.49,
    size_in: "1.25",
    source: "noaa-swdi-radar",
    swdi_ring: swdiRing,
  },
  {
    lat: 35.505,
    lon: -97.495,
    size_in: "1.00",
    source: "noaa-swdi-radar",
  },
];
const swdiBands = buildHailSwathRings(swdiPts, {});
assert.ok(swdiBands.some((b) => b.source === "radar-poly"), "SWDI polygon band");
assert.ok(!swdiBands.some((b) => b.source === "mesh-swath"), "no stacked mesh on SWDI polygon");

console.log("hail-swath ok");
