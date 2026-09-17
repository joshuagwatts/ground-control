// Audit harness: extracts geometry functions from www/wx.js and tests them standalone.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../www/wx.js", import.meta.url), "utf8");

function extractFn(name) {
  const idx = src.indexOf(`function ${name}(`);
  if (idx < 0) throw new Error(`function ${name} not found`);
  let i = src.indexOf("{", idx);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const names = [
  "chamferDistKm",
  "closeBinaryKm",
  "blurFloatField",
  "relaxRing",
  "walkBinaryExterior",
  "traceBinaryExteriorRings",
  "slimRingVerts",
  "chaikinSmoothRing",
  "convexHullLatLon",
];
const code = names.map(extractFn).join("\n\n");
const factory = new Function(`${code}\nreturn { ${names.join(", ")} };`);
const g = factory();

const xy = (xKm, yKm) => [yKm, xKm]; // fake lat/lon: lat=y, lon=x (km)

function gridFrom(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const grid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) grid[y * w + x] = rows[h - 1 - y][x] === "#" ? 1 : 0;
  return { grid, w, h };
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][1] * ring[i + 1][0] - ring[i + 1][1] * ring[i][0];
  return Math.abs(a / 2);
}

let fail = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) fail++;
}

// 1. Simple 4x4 block: perimeter ring should enclose ~16 km² (cell=1km)
{
  const { grid, w, h } = gridFrom([
    "......",
    ".####.",
    ".####.",
    ".####.",
    ".####.",
    "......",
  ]);
  const rings = g.traceBinaryExteriorRings(grid, w, h, 1, xy, 8);
  const area = rings.length ? ringArea(rings[0]) : 0;
  check("solid 4x4 block", rings.length === 1 && area > 10 && area < 22, `rings=${rings.length} area=${area.toFixed(1)}`);
}

// 2. Diagonal corridor (touching corners) — the storm-swath case.
//    Expect ring(s) covering most of the 12 on-cells, not a tiny fragment.
{
  const { grid, w, h } = gridFrom([
    "........",
    "......##",
    ".....##.",
    "....##..",
    "...##...",
    "..##....",
    ".##.....",
    "##......",
  ]);
  const rings = g.traceBinaryExteriorRings(grid, w, h, 1, xy, 8);
  const total = rings.reduce((a, r) => a + ringArea(r), 0);
  check("diagonal corridor", total > 8, `rings=${rings.length} totalArea=${total.toFixed(1)} (14 on-cells)`);
}

// 3. L-shape / concave — contour must follow concavity (area ≈ 20, hull would be ~30)
{
  const { grid, w, h } = gridFrom([
    "........",
    ".####...",
    ".####...",
    ".####...",
    ".#######",
    ".#######",
    "........",
  ]);
  const rings = g.traceBinaryExteriorRings(grid, w, h, 1, xy, 8);
  const area = rings.length ? ringArea(rings[0]) : 0;
  check("L-shape concave", rings.length === 1 && area > 18 && area < 30, `rings=${rings.length} area=${area.toFixed(1)} (26 cells)`);
}

// 4. Two separate blobs → two rings
{
  const { grid, w, h } = gridFrom([
    "..........",
    ".##.......",
    ".##.......",
    "..........",
    ".......##.",
    ".......##.",
    "..........",
  ]);
  const rings = g.traceBinaryExteriorRings(grid, w, h, 1, xy, 8);
  check("two blobs → two rings", rings.length === 2, `rings=${rings.length}`);
}

// 5. Single cell — should still yield a drawable ring
{
  const { grid, w, h } = gridFrom(["...", ".#.", "..."]);
  const rings = g.traceBinaryExteriorRings(grid, w, h, 1, xy, 8);
  const area = rings.length ? ringArea(rings[0]) : 0;
  check("single cell", rings.length === 1 && area > 0.3, `rings=${rings.length} area=${area.toFixed(2)}`);
}

// 6. Blob with interior hole (ring of cells) — exterior should be the outer boundary
{
  const { grid, w, h } = gridFrom([
    ".......",
    ".#####.",
    ".#...#.",
    ".#...#.",
    ".#####.",
    ".......",
  ]);
  const rings = g.traceBinaryExteriorRings(grid, w, h, 1, xy, 8);
  const maxArea = Math.max(0, ...rings.map(ringArea));
  check("donut exterior", maxArea > 15, `rings=${rings.length} maxArea=${maxArea.toFixed(1)} (outer=25)`);
}

// 7. km-based close: bridges gaps below closeKm, leaves bigger gaps open —
//    and does the SAME at half the cell size (resolution independence).
{
  const { grid, w, h } = gridFrom(["#...#"]);
  const closed = g.closeBinaryKm(grid, w, h, 1, 4.5); // 3km gap, close 4.5km
  const open = g.closeBinaryKm(grid, w, h, 1, 1.5); // close 1.5km — must NOT bridge
  check("closeBinaryKm bridges 3km gap @1km cells", closed[2] === 1, `mid=${closed[2]}`);
  check("closeBinaryKm keeps 3km gap open when closeKm=1.5", open[2] === 0, `mid=${open[2]}`);
  // Same geography at 0.5km cells: "#" spans 2 cells, gap 6 cells = 3km
  const fine = gridFrom(["##......##"]);
  const closedF = g.closeBinaryKm(fine.grid, fine.w, fine.h, 0.5, 4.5);
  const openF = g.closeBinaryKm(fine.grid, fine.w, fine.h, 0.5, 1.5);
  check("closeBinaryKm bridges same gap @0.5km cells", closedF[5] === 1, `mid=${closedF[5]}`);
  check("closeBinaryKm keeps gap open @0.5km cells", openF[5] === 0, `mid=${openF[5]}`);
}

process.exit(fail ? 1 : 0);
