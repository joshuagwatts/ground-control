/**
 * HomeScope hail load — stream updates until the requested history window is actually filled.
 */
import { ensureWebProxyReady } from "../net.js";
import {
  setWxPin,
  pinDossier,
  collapseHailByDate,
  HOUSE_HAIL_KM,
  HOUSE_ZONE_KM,
  buildHailTraceDayBands,
  fetchIemLsrHailArchive,
  mergeHailRows,
} from "../wx.js";

const HOME_DEEP_KM = 40;
const COVER_NEAR_KM = Math.max(HOUSE_HAIL_KM, HOUSE_ZONE_KM);
/** Max new HailTrace cover checks per summarize while streaming — keeps the list growing without freezing. */
const STREAM_POLY_BUDGET = 24;

function pinKey(lat, lon) {
  return `${Number(lat).toFixed(4)}|${Number(lon).toFixed(4)}`;
}

/** pinKey|YYYY-MM-DD → coversPolygon */
let coverPolyCache = new Map();
let coverPolyCachePin = "";

function resetCoverPolyCache(lat, lon) {
  const key = pinKey(lat, lon);
  if (coverPolyCachePin !== key) {
    coverPolyCache.clear();
    coverPolyCachePin = key;
  }
}

function pointInLatLonRing(lat, lon, ring) {
  if (!ring || ring.length < 3) return false;
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

function polygonCoversHome(day, lat, lon, dayRows = []) {
  try {
    const bands = buildHailTraceDayBands(day, dayRows) || [];
    for (const band of bands) {
      if (band?.ring && pointInLatLonRing(lat, lon, band.ring)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function stormCoversHome(row, lat, lon, dayRows = [], { budget = { left: Infinity } } = {}) {
  const pts = row.zone_pts || [];
  const minDist = Number(row.min_dist);
  const coversNear =
    (Number(row.near_hits) || 0) > 0 ||
    (Number.isFinite(minDist) && minDist <= COVER_NEAR_KM) ||
    pts.some((p) => (Number(p.distance_km) || 999) <= COVER_NEAR_KM);

  if (coversNear) {
    return { coversNear: true, coversPolygon: false, coversHome: true };
  }

  resetCoverPolyCache(lat, lon);
  const cacheKey = `${coverPolyCachePin}|${row.date}`;
  if (coverPolyCache.has(cacheKey)) {
    const coversPolygon = coverPolyCache.get(cacheKey);
    return { coversNear: false, coversPolygon, coversHome: coversPolygon };
  }

  // Defer Trace builds across stream chunks so the UI can paint 1 → 2 → N dates.
  if (budget.left <= 0) {
    return { coversNear: false, coversPolygon: false, coversHome: false, deferred: true };
  }
  budget.left -= 1;
  const coversPolygon = polygonCoversHome(row.date, lat, lon, dayRows);
  coverPolyCache.set(cacheKey, coversPolygon);
  return { coversNear: false, coversPolygon, coversHome: coversPolygon };
}

function sourceLabel(row) {
  const s = String(row.source || "");
  if (/mixed/i.test(s)) return "Radar + spotter";
  if (/swdi|radar/i.test(s)) return "NOAA SWDI radar";
  if (/spc|lsr|iem|spot/i.test(s)) return "SPC / IEM spotter";
  return "Public hail record";
}

function prettyDate(iso) {
  try {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

let pinCache = {
  key: "",
  lat: null,
  lon: null,
  address: "",
  hail: [],
  fetchedDays: 0,
  loadingDeep: false,
  deepTarget: 0,
  loadSeq: 0,
  uiNotify: null,
  deepenPromise: null,
  dossierPromise: null,
};

const hailListeners = new Set();

export function onHomeHailCache(fn) {
  hailListeners.add(fn);
  return () => hailListeners.delete(fn);
}

function emitHailCache() {
  for (const fn of hailListeners) {
    try {
      fn(pinCache);
    } catch {
      /* ignore */
    }
  }
}

export function clearHomeHailCache() {
  coverPolyCache.clear();
  coverPolyCachePin = "";
  pinCache = {
    key: "",
    lat: null,
    lon: null,
    address: "",
    hail: [],
    fetchedDays: 0,
    loadingDeep: false,
    deepTarget: 0,
    loadSeq: (pinCache.loadSeq || 0) + 1,
    uiNotify: null,
    deepenPromise: null,
    dossierPromise: null,
  };
  emitHailCache();
}

export function getHomeHailCache() {
  return pinCache;
}

export function summarizeHailRows(hailRows, lat, lon, { minHailIn = 1, days = 730, years, loading = false, note = null } = {}) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  resetCoverPolyCache(lat, lon);

  const collapsed = collapseHailByDate(hailRows || []).sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")),
  );
  const byDay = new Map();
  for (const h of hailRows || []) {
    const d = String(h?.date || "").slice(0, 10);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(h);
  }

  // While streaming: only spend a few Trace builds per chunk so dates appear 1, 2, 3…
  // Cached results carry forward; when loading finishes, budget is unlimited.
  const budget = { left: loading ? STREAM_POLY_BUDGET : Infinity };
  let deferred = 0;
  const storms = [];
  for (const row of collapsed) {
    const date = String(row.date || "");
    if (!date || date < cutoffIso) continue;
    const maxSizeIn = Number(row.max_size) || parseFloat(row.size_in) || 0;
    if (maxSizeIn + 1e-6 < Number(minHailIn)) continue;
    const cover = stormCoversHome(row, lat, lon, byDay.get(date) || [], { budget });
    if (cover.deferred) {
      deferred += 1;
      continue;
    }
    if (!cover.coversHome) continue;
    storms.push({
      date,
      pretty: prettyDate(date),
      maxSizeIn,
      sources: sourceLabel(row),
      coversHome: true,
      coversNear: cover.coversNear,
      coversPolygon: cover.coversPolygon,
      nearHits: Number(row.near_hits) || 0,
      minDist: Number(row.min_dist) || 999,
      hits: Number(row.hits) || 0,
      zone_pts: row.zone_pts || [],
      raw: row,
    });
  }
  storms.sort((a, b) => b.date.localeCompare(a.date));

  let msg = note;
  if (!msg && deferred && loading) {
    msg = `Checking zone cover… ${storms.length} confirmed, ${deferred} more to verify`;
  } else if (!msg && !storms.length && (hailRows || []).length) {
    msg = `Loaded ${(hailRows || []).length} hail reports nearby — none ≥${minHailIn}″ with near-roof or zone-over-home cover in ~${years || Math.round(days / 365)}y.`;
  } else if (!msg && !storms.length && !(hailRows || []).length && !loading) {
    msg = "No hail rows yet — hard-refresh once so the radar proxy can load.";
  }

  return {
    ok: true,
    address: pinCache.address || "",
    lat,
    lon,
    years: years ?? Math.round(days / 365.25),
    fetchedDays: pinCache.fetchedDays || 0,
    note: msg,
    storms,
    hailRowCount: (hailRows || []).length,
    loading: Boolean(loading || pinCache.loadingDeep || deferred > 0),
    deferredCover: deferred,
  };
}

export function filterCachedHomeStorms({ years = 2, minHailIn = 1 } = {}) {
  if (!pinCache.key || !Number.isFinite(pinCache.lat)) {
    return { ok: false, storms: [], hailRowCount: 0, loading: false, note: "Enter an address first", fetchedDays: 0 };
  }
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  const have = pinCache.fetchedDays || 0;
  // Only treat as "loading" while a deepen job is actually running — not merely because
  // fetchedDays < requested (that used to keep fast-cover forever after a failed deepen).
  const loading = Boolean(pinCache.loadingDeep || pinCache.deepenPromise || pinCache.dossierPromise);
  return summarizeHailRows(pinCache.hail, pinCache.lat, pinCache.lon, {
    minHailIn,
    days,
    years,
    loading,
    note:
      days > have && loading
        ? `Still loading history… ~${Math.max(1, Math.round(have / 365))}y in so far`
        : days > have
          ? `Showing ~${Math.round(have / 365)}y loaded — older years incomplete`
          : null,
  });
}

function pushPartial(onPartial, lat, lon, minHailIn, days, years, loading, note) {
  // Single summarize → notify. Cache listeners re-filter cheaply.
  const result = summarizeHailRows(pinCache.hail, lat, lon, {
    minHailIn,
    days,
    years,
    loading,
    note,
  });
  emitHailCache();
  const fn = onPartial || pinCache.uiNotify;
  if (fn) fn(result);
  return result;
}

/** Finish remaining zone-cover checks in small batches so the list keeps growing. */
async function drainCoverChecks(lat, lon, onPartial, minHailIn, days, years, { maxRounds = 80, final = true } = {}) {
  const key = pinKey(lat, lon);
  for (let i = 0; i < maxRounds; i++) {
    if (pinCache.key !== key) return;
    const result = pushPartial(
      onPartial,
      lat,
      lon,
      minHailIn,
      days,
      years,
      true,
      `Confirming zone cover…`,
    );
    if (!result?.deferredCover) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!final || pinCache.key !== key) return;
  pushPartial(onPartial, lat, lon, minHailIn, days, years, false, null);
}

async function deepenArchive(lat, lon, days, onPartial, minHailIn, years, seq) {
  const key = pinKey(lat, lon);
  pinCache.uiNotify = onPartial || pinCache.uiNotify;
  pinCache.deepTarget = Math.max(pinCache.deepTarget || 0, days);

  // Same pin already deepening — await it instead of aborting / stacking crawls.
  if (pinCache.deepenPromise && pinCache.key === key) {
    await pinCache.deepenPromise;
    if ((pinCache.fetchedDays || 0) >= days) {
      await drainCoverChecks(lat, lon, onPartial, minHailIn, days, years);
      return;
    }
  }

  if ((pinCache.fetchedDays || 0) >= days) {
    await drainCoverChecks(lat, lon, onPartial, minHailIn, days, years);
    return;
  }

  pinCache.loadingDeep = true;
  emitHailCache();

  const run = (async () => {
    try {
      const deep = await fetchIemLsrHailArchive(lat, lon, HOME_DEEP_KM, days, {
        onChunk: async (rows, meta) => {
          if (pinCache.key !== key) return;
          pinCache.hail = mergeHailRows(pinCache.hail, [], rows);
          const covered = Number(meta?.coveredDays) || Number(meta?.offset) || 0;
          if (covered > 0) pinCache.fetchedDays = Math.max(pinCache.fetchedDays, Math.min(days, covered));
          const ySoFar = Math.max(1, Math.round((pinCache.fetchedDays || 0) / 365));
          pushPartial(
            pinCache.uiNotify,
            lat,
            lon,
            minHailIn,
            days,
            years,
            true,
            `Loading… ~${ySoFar}y in · dropping covering dates as they confirm`,
          );
          // Confirm cover for this year's new dates before fetching the next year.
          await drainCoverChecks(lat, lon, pinCache.uiNotify, minHailIn, days, years, {
            maxRounds: 4,
            final: false,
          });
        },
      });
      if (pinCache.key !== key) return;
      pinCache.hail = mergeHailRows(pinCache.hail, [], deep);
      pinCache.fetchedDays = Math.max(pinCache.fetchedDays, days);
    } catch (err) {
      console.warn("[HomeScope] deepen archive", err);
    } finally {
      if (pinCache.key === key) pinCache.loadingDeep = false;
      if (pinCache.deepenPromise === run) pinCache.deepenPromise = null;
    }
  })();

  pinCache.deepenPromise = run;
  await run;
  if (pinCache.key !== key) return;
  await drainCoverChecks(lat, lon, pinCache.uiNotify, minHailIn, days, years);
}

/**
 * Load hail for a home. Streams partials as radar + archive arrive.
 * Awaits deepen for the requested window so we don't pretend 2 dates is “done”.
 */
export async function loadHomeStorms(lat, lon, { address = "", years = 2, minHailIn = 1, onPartial, force = false } = {}) {
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  const key = pinKey(lat, lon);

  await ensureWebProxyReady(8000);
  setWxPin(lat, lon);

  pinCache.uiNotify = onPartial || pinCache.uiNotify;

  // Same pin already loading or cached — join that work instead of aborting it.
  if (!force && pinCache.key === key) {
    if (pinCache.dossierPromise) await pinCache.dossierPromise;
    if (days > (pinCache.fetchedDays || 0) || pinCache.deepenPromise) {
      await deepenArchive(lat, lon, days, onPartial, minHailIn, years, pinCache.loadSeq);
    }
    if (pinCache.hail.length || pinCache.fetchedDays) {
      return filterCachedHomeStorms({ years, minHailIn });
    }
  }

  pinCache = {
    key,
    lat,
    lon,
    address,
    hail: [],
    fetchedDays: 0,
    loadingDeep: false,
    deepTarget: 0,
    loadSeq: (pinCache.loadSeq || 0) + 1,
    uiNotify: onPartial || null,
    deepenPromise: null,
    dossierPromise: null,
  };
  const seq = pinCache.loadSeq;

  const dossierJob = (async () => {
    try {
      return await pinDossier({}, lat, lon, {
        address,
        deep: false,
        onPartial: onPartial
          ? (part) => {
              if (pinCache.key !== key || seq !== pinCache.loadSeq) return;
              const hail = part?.hail || [];
              pinCache.hail = mergeHailRows(pinCache.hail, hail);
              pinCache.fetchedDays = Math.max(
                pinCache.fetchedDays,
                Math.min(730, Number(part?._meta?.fetchedDays) || 400),
              );
              pushPartial(
                onPartial,
                lat,
                lon,
                minHailIn,
                days,
                years,
                true,
                "Loading NOAA radar + spotter reports…",
              );
            }
          : undefined,
      });
    } finally {
      if (pinCache.dossierPromise === dossierJob) pinCache.dossierPromise = null;
    }
  })();
  pinCache.dossierPromise = dossierJob;

  let dossier;
  try {
    dossier = await dossierJob;
  } catch (err) {
    const empty = {
      ok: false,
      address,
      lat,
      lon,
      years,
      fetchedDays: 0,
      note: String(err?.message || err || "Hail fetch failed"),
      storms: [],
      hailRowCount: 0,
      loading: false,
      error: true,
    };
    if (onPartial) onPartial(empty);
    emitHailCache();
    return empty;
  }

  if (pinCache.key !== key || seq !== pinCache.loadSeq) return filterCachedHomeStorms({ years, minHailIn });

  pinCache.hail = mergeHailRows(pinCache.hail, dossier?.hail || []);
  pinCache.fetchedDays = Math.max(pinCache.fetchedDays, Math.min(730, Number(dossier?._meta?.fetchedDays) || 730));
  pinCache.address = dossier?.address || address || pinCache.address;

  pushPartial(
    onPartial,
    lat,
    lon,
    minHailIn,
    days,
    years,
    days > pinCache.fetchedDays,
    days > pinCache.fetchedDays ? "Recent years ready · loading older history…" : null,
  );

  if (days > pinCache.fetchedDays) {
    await deepenArchive(lat, lon, days, onPartial, minHailIn, years, seq);
  }

  return filterCachedHomeStorms({ years, minHailIn });
}

export { HOUSE_HAIL_KM, HOUSE_ZONE_KM, COVER_NEAR_KM, HOME_DEEP_KM };
