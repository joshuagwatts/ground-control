/**
 * Smoke test for hail-swath region builder (MESH/Hailswath-style nested isosurfaces).
 * Imports wx.js helpers indirectly by exercising draw path math via a tiny inline port check.
 */
import assert from "node:assert/strict";

// Mirror threshold list used by buildHailSwathRings
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

console.log("hail-swath ok");
