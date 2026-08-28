// Full-pipeline audit: run buildHailSwathRings from www/wx.js at state + close zoom.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../www/wx.js", import.meta.url), "utf8");

function extractFn(name) {
  const idx = src.indexOf(`function ${name}(`);
  if (idx < 0) throw new Error(`function ${name} not found`);
  // Body starts at the "{" following the param list's closing paren.
  let paren = 0;
  let i = src.indexOf("(", idx);
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") {
      paren--;
      if (paren === 0) break;
    }
  }
  i = src.indexOf("{", i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}
function extractConst(name) {
  const m = src.match(new RegExp(`const ${name} = [^;]+;`));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

const fns = [
  "dilateBinary",
  "erodeBinary",
  "morphClose",
  "walkBinaryExterior",
  "traceBinaryExteriorRings",
  "chaikinSmoothRing",
  "convexHullLatLon",
  "padPolygon",
  "hailFootprintM",
  "buildHailSwathRings",
  "nestHailBandPolys",
  "ensureClosedRing",
  "reverseRing",
  "ringCentroidLatLon",
  "pointInLatLonRing",
];
const consts = ["HAIL_SWATH_THRESHOLDS", "HAIL_SWATH_THRESHOLDS_WIDE"];
const code = consts.map(extractConst).join("\n") + "\n" + fns.map(extractFn).join("\n\n");

let ZOOM = 7;
const stubs = {
  map: { getZoom: () => ZOOM },
  hasSelectedStormDates: () => true,
  isSpotterHail: (p) => /spotter|lsr/i.test(String(p?.source || "")),
  ringPolygon: (lat, lon, rM, n = 12) => {
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push([lat + (Math.sin(a) * rM) / 111320, lon + (Math.cos(a) * rM) / 111320]);
    }
    return ring;
  },
  topoZoneRing: () => null,
};
const factory = new Function(
  ...Object.keys(stubs),
  `${code}\nreturn { buildHailSwathRings, nestHailBandPolys };`,
);
const g = factory(...Object.values(stubs));

function ringAreaKm2(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat0 = ring[0][0];
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111.32;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][1] * kx;
    const y1 = ring[i][0] * ky;
    const x2 = ring[i + 1][1] * kx;
    const y2 = ring[i + 1][0] * ky;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}
function boxiness(ring) {
  // Fraction of segments that are exactly axis-aligned — high = boxy.
  let axis = 0;
  let n = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const dLat = Math.abs(ring[i + 1][0] - ring[i][0]);
    const dLon = Math.abs(ring[i + 1][1] - ring[i][1]);
    if (dLat < 1e-12 && dLon < 1e-12) continue;
    n++;
    if (dLat < 1e-9 || dLon < 1e-9) axis++;
  }
  return n ? axis / n : 0;
}

// Storm corridor: SW→NE line of radar hits across ~120km (statewide look), plus spotters.
const corridor = [];
for (let i = 0; i < 30; i++) {
  const t = i / 29;
  corridor.push({
    lat: 35.0 + t * 1.0 + (Math.sin(i * 1.7) * 0.03),
    lon: -98.0 + t * 1.2 + (Math.cos(i * 2.3) * 0.03),
    size_in: i % 5 === 0 ? 1.75 : i % 3 === 0 ? 1.25 : 0.9,
    source: i % 4 === 0 ? "spotter" : "noaa-swdi-radar",
    date: "2026-05-01",
  });
}

let fail = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}  — ${detail}`);
  if (!cond) fail++;
};

for (const z of [7, 10, 12, 14, 16]) {
  ZOOM = z;
  const t0 = performance.now();
  const rings = g.buildHailSwathRings(corridor, { size_in: 1.0, date: "2026-05-01" });
  const ms = (performance.now() - t0).toFixed(1);
  const total = rings.reduce((a, r) => a + ringAreaKm2(r.ring), 0);
  const maxBox = Math.max(0, ...rings.map((r) => boxiness(r.ring)));
  const biggest = Math.max(0, ...rings.map((r) => ringAreaKm2(r.ring)));
  check(
    `z=${z} swath present`,
    rings.length >= 1 && biggest > 20,
    `rings=${rings.length} totalArea=${total.toFixed(0)}km² biggest=${biggest.toFixed(0)}km² boxiness=${(maxBox * 100).toFixed(0)}% ${ms}ms`,
  );
  const bands = g.nestHailBandPolys(rings);
  const holed = bands.filter((b) => b.holes?.length).length;
  console.log(`      bands=${bands.length} withHoles=${holed} sizes=[${bands.map((b) => b.maxSize).join(",")}]`);
}

// Sparse close-zoom case: 3 radar hits near a house (the "zoom close → zones disappear" report)
ZOOM = 16;
const sparse = [
  { lat: 35.5, lon: -97.5, size_in: 1.0, source: "noaa-swdi-radar", date: "2026-05-01" },
  { lat: 35.505, lon: -97.494, size_in: 1.25, source: "noaa-swdi-radar", date: "2026-05-01" },
  { lat: 35.498, lon: -97.505, size_in: 0.75, source: "spotter", date: "2026-05-01" },
];
{
  const rings = g.buildHailSwathRings(sparse, { size_in: 1.0, date: "2026-05-01" });
  const total = rings.reduce((a, r) => a + ringAreaKm2(r.ring), 0);
  check("z=16 sparse hits visible", rings.length >= 1 && total > 1, `rings=${rings.length} totalArea=${total.toFixed(1)}km²`);
}

// Statewide span (~440km of hits): the mesh must cover the WHOLE swath, not clip
// to a grid-sized corner (this was the off-center / boxy-edge / vanishing-zones bug).
ZOOM = 7;
const statewide = [];
for (let i = 0; i < 60; i++) {
  const t = i / 59;
  statewide.push({
    lat: 33.5 + t * 3.5 + Math.sin(i * 1.3) * 0.05,
    lon: -99.5 + t * 3.0 + Math.cos(i * 1.9) * 0.05,
    size_in: i % 6 === 0 ? 2.0 : i % 3 === 0 ? 1.25 : 0.9,
    source: i % 5 === 0 ? "spotter" : "noaa-swdi-radar",
    date: "2026-05-01",
  });
}
{
  const rings = g.buildHailSwathRings(statewide, { size_in: 1.0, date: "2026-05-01" });
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const r of rings) for (const [la, lo] of r.ring) {
    minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
    minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo);
  }
  const latCov = (maxLat - minLat) / 3.5;
  const lonCov = (maxLon - minLon) / 3.0;
  check(
    "statewide coverage (no grid clipping)",
    latCov > 0.85 && lonCov > 0.85,
    `latCoverage=${(latCov * 100).toFixed(0)}% lonCoverage=${(lonCov * 100).toFixed(0)}% rings=${rings.length}`,
  );
}

process.exit(fail ? 1 : 0);
