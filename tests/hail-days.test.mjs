import {
  collapseHailByDate,
  filterDossier,
  mergeHailRows,
  stormPassesSizeFilter,
  HOUSE_HAIL_KM,
} from "../www/wx.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const near = {
  date: "2026-05-06",
  lat: 35.651,
  lon: -97.481,
  size_in: "0.88",
  source: "noaa-spc",
  distance_km: 0.4,
};
const far = {
  date: "2026-05-06",
  lat: 35.72,
  lon: -97.48,
  size_in: "2.00",
  source: "noaa-swdi-radar",
  distance_km: 7.8,
};

const [roof] = collapseHailByDate([near, far]);
assert(roof.size_in === "0.88", `headline should be hail at this roof, got ${roof.size_in}`);
assert(roof.size_far === "2.00", `far 2" should be a footnote, got ${roof.size_far}`);
assert(roof.near_hits === 1, `near_hits ${roof.near_hits}`);
assert(roof.far_km > HOUSE_HAIL_KM, `far_km ${roof.far_km}`);
assert(Math.abs(roof.lat - near.lat) < 0.002, "zone centroid should sit on the near hit, not the far 2\"");

const [away] = collapseHailByDate([far]);
assert(away.size_in === "2.00", `far-only day should still show nearest size, got ${away.size_in}`);
assert(away.near_hits === 0, "far-only day is not at this roof");

const nearDay = { ...near, date: "2026-06-01", size_in: "1.00" };
const farDay = { ...far, date: "2026-07-01" };
const { hail } = filterDossier({ hail: [farDay, nearDay] }, { km: 10, hailIn: 0.75, windMph: 0, days: 730, year: "all", sort: "date" });
assert(hail[0].date === "2026-06-01", `dates with roof evidence sort first, got ${hail.map((h) => h.date).join(",")}`);
assert(hail[0].near_hits > 0 && hail[1].near_hits === 0, "second row should be the far-only storm");

const spots = Array.from({ length: 300 }, (_, i) => ({
  date: "2026-04-02",
  lat: 35.65 + i * 0.002,
  lon: -97.48,
  size_in: "0.75",
  source: "iem-lsr",
  distance_km: 0.5,
}));
const radar = Array.from({ length: 50 }, (_, i) => ({
  date: "2026-04-02",
  lat: 35.4 + i * 0.002,
  lon: -97.479,
  size_in: "1.25",
  source: "noaa-swdi-radar",
  distance_km: 0.6,
}));
const merged = mergeHailRows(spots, radar);
assert(
  merged.some((h) => h.source === "noaa-swdi-radar"),
  "spotter flood must not drop SWDI radar hits",
);
assert(merged.filter((h) => h.source === "noaa-swdi-radar").length === 50, "keep the radar batch");

const spread = Array.from({ length: 45 }, (_, i) => ({
  date: "2026-03-15",
  lat: 35.5 + i * 0.012,
  lon: -97.4 - i * 0.01,
  size_in: "1.00",
  source: "iem-lsr",
  distance_km: 1 + i * 0.2,
}));
const [monster] = collapseHailByDate(spread);
assert(monster.hits === 45, `hits ${monster.hits}`);
assert(monster.span_km > 15, `span_km should be wide, got ${monster.span_km}`);
assert(stormPassesSizeFilter(monster, { stormSize: "large" }), "large filter should keep mid-size storm");
assert(!stormPassesSizeFilter({ hits: 45, span_km: 20 }, { stormSize: "giant" }), "giant filter should drop mid-size storm");

const { hail: bigOnly } = filterDossier(
  { hail: [...spread, near] },
  { km: 80, hailIn: 0, windMph: 0, days: 730, year: "all", sort: "storm", stormSize: "small" },
);
assert(bigOnly.some((h) => h.date === "2026-03-15"), "small+ filter keeps the 45-hit day");
assert(!bigOnly.some((h) => h.date === near.date), "small+ filter drops single-hit day");

console.log("hail-days ok");
