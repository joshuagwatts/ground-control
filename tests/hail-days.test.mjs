import {
  collapseHailByDate,
  filterDossier,
  filterHailRaw,
  hailRowsForZones,
  mapHailRows,
  mergeHailRows,
  resolvedStormDrawPools,
  selectStormDate,
  setWxPin,
  stormPassesSizeFilter,
  HOUSE_HAIL_KM,
  PIN_FETCH_FAST_KM,
  PIN_FETCH_WIDE_KM,
  PIN_FETCH_MIN_KM,
  dossierFetchKm,
  dossierWideKm,
  spcLookbackDays,
  lsrFirstDays,
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
assert(hail[0].date === "2026-07-01", `newest sort is pure date order, got ${hail.map((h) => h.date).join(",")}`);
assert(hail[1].date === "2026-06-01", "older roof-near day stays second in newest mode");

const { hail: sizeSorted } = filterDossier(
  { hail: [farDay, nearDay] },
  { km: 10, hailIn: 0.75, windMph: 0, days: 730, year: "all", sort: "size" },
);
assert(sizeSorted[0].near_hits > 0, "size sort still prefers roof-near first");

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
assert(merged.filter((h) => h.source === "iem-lsr").length === 300, "spotters stay after radar priority");

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

assert(dossierFetchKm({ km: 10 }) === PIN_FETCH_FAST_KM, "first paint uses fast center radius");
assert(dossierWideKm({ km: 10 }) === PIN_FETCH_WIDE_KM, "background widen uses wide radius");
assert(PIN_FETCH_FAST_KM <= 50, "fast ring stays snappy");
assert(PIN_FETCH_WIDE_KM >= 100, "wide ring still covers regional footprints");
assert(PIN_FETCH_MIN_KM === PIN_FETCH_FAST_KM, "PIN_FETCH_MIN_KM aliases fast ring");
const nearRow = { date: "2025-05-01", lat: 35.47, lon: -97.52, size_in: "1.00" };
const farRow = { date: "2025-06-01", lat: 35.58, lon: -97.516, size_in: "1.25" };
const pinData = { lat: 35.467, lon: -97.516, hail: [nearRow, farRow] };
assert(filterHailRaw(pinData, { km: 10, hailIn: 0, days: 730, year: "all" }).length === 1, "NEAR filters cached pin list");
assert(filterHailRaw(pinData, { km: 40, hailIn: 0, days: 730, year: "all" }).length === 2, "wider NEAR shows more cached storms");
const vpData = { viewport: true, hail: [nearRow, farRow], _meta: { viewport: true, listLocked: true } };
assert(filterHailRaw(vpData, { km: 10, hailIn: 0, days: 730, year: "all" }).length === 2, "viewport list ignores NEAR km");

const smallRadar = {
  date: "2025-05-01",
  lat: 35.47,
  lon: -97.52,
  size_in: "0.55",
  source: "noaa-swdi-radar",
  distance_km: 2,
};
const pinSmall = { lat: 35.467, lon: -97.516, hail: [smallRadar] };
assert(
  filterHailRaw(pinSmall, { km: 10, hailIn: 0.75, days: 730, year: "all" }).length === 0,
  "sheet list drops sub-0.75 hail",
);
assert(
  filterHailRaw(pinSmall, { km: 10, hailIn: 0.75, days: 730, year: "all" }, { forMap: true }).length === 1,
  "map paint keeps SWDI radar below sheet hailMin",
);

setWxPin(35.467, -97.516);
selectStormDate("2025-06-01", { requireDate: true, hailRows: [], toggle: false });
const spotNear = {
  date: "2025-06-01",
  lat: 35.467,
  lon: -97.516,
  size_in: "1.00",
  source: "iem-lsr",
  distance_km: 0.4,
};
const radarFar = {
  date: "2025-06-01",
  lat: 35.55,
  lon: -97.516,
  size_in: "1.25",
  source: "noaa-swdi-radar",
  distance_km: 55,
};
const zonePack = {
  lat: 35.467,
  lon: -97.516,
  hail: [spotNear, radarFar],
  _meta: { fetchedKm: PIN_FETCH_WIDE_KM },
};
const zoneRows = hailRowsForZones(zonePack, { km: 16, hailIn: 0.75, days: 730, year: "all" });
assert(zoneRows.some((h) => h.source === "noaa-swdi-radar"), "zone paint keeps SWDI beyond NEAR km when storm day is on");

assert(spcLookbackDays(90) <= 16, "SPC never walks 90 daily CSVs");
assert(spcLookbackDays(90) === 16, "desktop/Android keep a 16-day SPC walk");
assert(lsrFirstDays(730) === 400, "first LSR window is wider off Safari");

setWxPin(35.467, -97.516);
selectStormDate("2026-04-02", { requireDate: true, toggle: false });
const spotOnly = {
  date: "2026-04-02",
  lat: 35.467,
  lon: -97.516,
  size_in: "1.00",
  source: "iem-lsr",
  distance_km: 0.3,
};
const partial = { lat: 35.467, lon: -97.516, hail: [spotOnly], _meta: { fetchedKm: PIN_FETCH_WIDE_KM } };
let pools = resolvedStormDrawPools(mapHailRows(partial, { km: 16, hailIn: 1, days: 730, year: "all" }));
assert(!pools.zoneRows.some((h) => h.source === "noaa-swdi-radar"), "partial without SWDI has no radar rows");
const swdiHit = {
  date: "2026-04-02",
  lat: 35.52,
  lon: -97.516,
  size_in: "1.25",
  source: "noaa-swdi-radar",
  distance_km: 48,
};
pools = resolvedStormDrawPools([...partial.hail, swdiHit]);
assert(
  pools.zoneRows.some((h) => h.source === "noaa-swdi-radar"),
  "cached SWDI survives when sheet passes spotter-only rows",
);

console.log("hail-days ok");
