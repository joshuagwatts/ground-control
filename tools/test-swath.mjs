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
  "chamferDistKm",
  "closeBinaryKm",
  "blurFloatField",
  "relaxRing",
  "walkBinaryExterior",
  "traceBinaryExteriorRings",
  "slimRingVerts",
  "chaikinSmoothRing",
  "convexHullLatLon",
  "padPolygon",
  "haversineKm",
  "hailFootprintM",
  "isAxisBoxRing",
  "softCircleBands",
  "ringAreaApproxM2",
  "ringBoxiness",
  "ringRadiusCv",
  "stormAxisFromPts",
  "clusterPoints",
  "buildHailSwathRingsCluster",
  "ensureRadarInsideBands",
  "softOrganicEnvelopeRing",
  "buildHailSwathRings",
  "stackHailBandPolys",
  "ensureClosedRing",
  "reverseRing",
  "ringCentroidLatLon",
  "pointInLatLonRing",
];
const consts = ["HAIL_SWATH_THRESHOLDS", "HAIL_CLOSE_KM"];
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
  `${code}\nreturn { buildHailSwathRings, stackHailBandPolys, isAxisBoxRing, ringBoxiness, ringRadiusCv, pointInLatLonRing, softOrganicEnvelopeRing };`,
);
const g = factory(...Object.values(stubs));
g.nestHailBandPolys = g.stackHailBandPolys;

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

// Zoom invariance: identical data at z=7 vs z=16 must produce the SAME geometry —
// zooming may only refine resolution, never re-merge or warp shapes.
{
  const at = (z) => {
    ZOOM = z;
    return g.buildHailSwathRings(corridor, { size_in: 1.0, date: "2026-05-01" });
  };
  const a = at(7);
  const b = at(16);
  const areaA = a.reduce((s, r) => s + ringAreaKm2(r.ring), 0);
  const areaB = b.reduce((s, r) => s + ringAreaKm2(r.ring), 0);
  const drift = Math.abs(areaA - areaB) / Math.max(areaA, areaB, 1);
  check(
    "zoom invariance z7 vs z16",
    a.length === b.length && drift < 0.02,
    `rings ${a.length} vs ${b.length}, area ${areaA.toFixed(0)} vs ${areaB.toFixed(0)} km² (drift ${(drift * 100).toFixed(2)}%)`,
  );
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

// Sparse city hits must NOT become axis-aligned rectangles (the OKC screenshot bug).
{
  ZOOM = 14;
  const sparse = [
    { lat: 35.467, lon: -97.516, size_in: 1.0, source: "noaa-swdi-radar", date: "2026-05-01" },
    { lat: 35.47, lon: -97.51, size_in: 0.85, source: "spotter", date: "2026-05-01" },
  ];
  // Far statewide points (well outside the metro cluster) that used to coarsen one mesh into boxes.
  for (let i = 0; i < 20; i++) {
    sparse.push({
      lat: 33.2 + i * 0.08,
      lon: -101.2 + i * 0.06,
      size_in: 0.9,
      source: "noaa-swdi-radar",
      date: "2026-05-01",
    });
  }
  const rings = g.buildHailSwathRings(sparse, { size_in: 1.0, date: "2026-05-01" });
  const okc = rings.filter((r) => {
    const c = r.ring.reduce(
      (a, p) => ({ lat: a.lat + p[0], lon: a.lon + p[1], n: a.n + 1 }),
      { lat: 0, lon: 0, n: 0 },
    );
    const lat = c.lat / c.n;
    const lon = c.lon / c.n;
    return Math.abs(lat - 35.47) < 0.25 && Math.abs(lon + 97.51) < 0.25;
  });
  const boxed = okc.filter((r) => g.isAxisBoxRing(r.ring) || boxiness(r.ring) > 0.55);
  check(
    "OKC sparse + statewide day → no axis boxes",
    okc.length >= 1 && boxed.length === 0,
    `okcRings=${okc.length} boxed=${boxed.length} maxBoxiness=${(
      Math.max(0, ...okc.map((r) => boxiness(r.ring))) * 100
    ).toFixed(0)}%`,
  );
}

// Densified SWDI radar rectangles must not paint as rounded boxes (the chunky look).
{
  ZOOM = 13;
  const box = [
    [35.46, -97.52],
    [35.46, -97.50],
    [35.48, -97.50],
    [35.48, -97.52],
    [35.46, -97.52],
  ];
  // Densify each edge so the old ≤12-vertex detector would miss it.
  const densified = [];
  for (let i = 0; i < box.length - 1; i++) {
    const a = box[i];
    const b = box[i + 1];
    for (let t = 0; t < 8; t++) {
      const u = t / 8;
      densified.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
  }
  densified.push(densified[0]);
  check("densified SWDI rectangle detected", g.isAxisBoxRing(densified), `verts=${densified.length}`);
  const rings = g.buildHailSwathRings(
    [
      {
        lat: 35.47,
        lon: -97.51,
        size_in: 1.25,
        source: "noaa-swdi-radar",
        date: "2026-05-01",
        swdi_ring: densified,
      },
      {
        lat: 35.475,
        lon: -97.505,
        size_in: 0.9,
        source: "spotter",
        date: "2026-05-01",
      },
    ],
    { size_in: 1.0, date: "2026-05-01" },
  );
  const maxBox = Math.max(0, ...rings.map((r) => boxiness(r.ring)));
  const anyAxis = rings.some((r) => g.isAxisBoxRing(r.ring));
  check(
    "densified SWDI → smooth mesh not boxes",
    rings.length >= 1 && !anyAxis && maxBox < 0.35,
    `rings=${rings.length} maxBoxiness=${(maxBox * 100).toFixed(0)}%`,
  );
}

// Green radar dots must sit inside the outermost zone fill (corridor guarantee).
{
  ZOOM = 13;
  const greens = [
    { lat: 35.45, lon: -97.55, size_in: 0.85, source: "noaa-swdi-radar", date: "2026-05-01" },
    { lat: 35.47, lon: -97.48, size_in: 1.1, source: "noaa-swdi-radar", date: "2026-05-01" },
    { lat: 35.50, lon: -97.42, size_in: 0.9, source: "noaa-swdi-radar", date: "2026-05-01" },
    { lat: 35.52, lon: -97.36, size_in: 1.25, source: "noaa-swdi-radar", date: "2026-05-01" },
    { lat: 35.49, lon: -97.45, size_in: 0.75, source: "spotter", date: "2026-05-01" },
  ];
  const rings = g.buildHailSwathRings(greens, { size_in: 1.0, date: "2026-05-01" });
  const outerThr = rings.reduce((m, r) => Math.min(m, Number(r.maxSize) || 9), 9);
  const radar = greens.filter((p) => !/spotter|lsr/i.test(String(p.source || "")));
  let missed = 0;
  for (const p of radar) {
    const ok = rings.some(
      (r) => Number(r.maxSize) <= outerThr + 0.05 && g.pointInLatLonRing(p.lat, p.lon, r.ring),
    );
    if (!ok) missed++;
  }
  check(
    "all green radar dots inside outer zone",
    rings.length >= 1 && missed === 0,
    `rings=${rings.length} outer=${outerThr} missed=${missed}/${radar.length}`,
  );
  const outer = rings.filter((r) => Number(r.maxSize) <= outerThr + 0.05);
  const maxCv = Math.max(0, ...outer.map((r) => g.ringRadiusCv(r.ring)));
  // Elongated corridor: radius CV high enough that it is not a soft disk.
  check(
    "green corridor is unique not a circle",
    maxCv >= 0.12,
    `outerBands=${outer.length} maxRadiusCv=${maxCv.toFixed(3)}`,
  );
}

// Convex-hull envelopes made fake right angles — organic remesh must stay rounded.
{
  const pts = [
    { lat: 35.45, lon: -97.75 },
    { lat: 35.48, lon: -97.65 },
    { lat: 35.52, lon: -97.55 },
    { lat: 35.55, lon: -97.48 },
    { lat: 35.50, lon: -97.70 },
  ];
  const ring = g.softOrganicEnvelopeRing(pts, 3.2);
  check("organic envelope exists", ring && ring.length >= 8, `verts=${ring?.length || 0}`);
  let sharp = 0;
  if (ring) {
    const open =
      ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1)
        : ring.slice();
    for (let i = 0; i < open.length; i++) {
      const a = open[(i - 1 + open.length) % open.length];
      const b = open[i];
      const c = open[(i + 1) % open.length];
      const ux = a[1] - b[1];
      const uy = a[0] - b[0];
      const vx = c[1] - b[1];
      const vy = c[0] - b[0];
      const lu = Math.hypot(ux, uy) || 1e-12;
      const lv = Math.hypot(vx, vy) || 1e-12;
      const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
      const deg = (Math.acos(cos) * 180) / Math.PI;
      if (Math.abs(deg - 90) < 18) sharp++;
    }
  }
  check("organic envelope has no fake right angles", sharp <= 2, `sharp90≈${sharp}`);
}

process.exit(fail ? 1 : 0);
