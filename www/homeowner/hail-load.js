/**
 * HomeScope hail load — stream covering dates as each archive year lands.
 * List cover uses near-roof + fast swath hull (not HailTrace mesh — that froze UI).
 */
import { ensureWebProxyReady } from "../net.js";
import {
  setWxPin,
  pinDossier,
  collapseHailByDate,
  HOUSE_HAIL_KM,
  HOUSE_ZONE_KM,
  fetchIemLsrHailArchive,
  mergeHailRows,
} from "../wx.js";

const HOME_DEEP_KM = 40;
const COVER_NEAR_KM = Math.max(HOUSE_HAIL_KM, HOUSE_ZONE_KM);
/** Multi-hit storm days: home within this of any report counts as swath-over-home for the list. */
const COVER_SWATH_KM = 4.0;

function pinKey(lat, lon) {
  return `${Number(lat).toFixed(4)}|${Number(lon).toFixed(4)}`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

/** Fast convex hull (lat/lon) — polygon-over-home without HailTrace mesh cost. */
function convexHullLatLon(points) {
  const pts = (points || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => [p.lat, p.lon]);
  if (pts.length < 3) return null;
  const uniq = [];
  const seen = new Set();
  for (const p of pts) {
    const k = `${p[0].toFixed(5)}|${p[1].toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  if (uniq.length < 3) return null;
  uniq.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const ring = lower.concat(upper);
  if (ring.length < 3) return null;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
  return ring;
}

/**
 * List cover — near-roof OR home in/near the day's hail swath.
 * Map drawing still uses HailTrace; this stays cheap so dates stream in.
 *
 * Multi-hit days use a 4km swath radius (not a lone soft 5.5km spotter claim).
 */
function stormCoversHome(row, lat, lon, dayRows = []) {
  const pts = [];
  for (const p of row.zone_pts || []) {
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) pts.push(p);
  }
  for (const p of dayRows || []) {
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) pts.push(p);
  }
  const dists = pts.map((p) => {
    const d = Number(p.distance_km);
    if (Number.isFinite(d) && d < 900) return d;
    return haversineKm(lat, lon, p.lat, p.lon);
  });
  const nearest = dists.length ? Math.min(...dists) : Number(row.min_dist);
  const coversNear =
    (Number(row.near_hits) || 0) > 0 ||
    (Number.isFinite(nearest) && nearest <= COVER_NEAR_KM);

  if (coversNear) {
    return { coversNear: true, coversPolygon: false, coversHome: true };
  }

  const hull = convexHullLatLon(pts);
  if (hull && pointInLatLonRing(lat, lon, hull)) {
    return { coversNear: false, coversPolygon: true, coversHome: true };
  }
  // Sparse LSR lines often miss the pin with a raw hull — if the day has multiple
  // reports and one is within swath range, treat as zone-over-home for the list.
  if (pts.length >= 2 && Number.isFinite(nearest) && nearest <= COVER_SWATH_KM) {
    return { coversNear: false, coversPolygon: true, coversHome: true };
  }
  return { coversNear: false, coversPolygon: false, coversHome: false };
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

  const collapsed = collapseHailByDate(hailRows || []).sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")),
  );

  const storms = [];
  for (const row of collapsed) {
    const date = String(row.date || "");
    if (!date || date < cutoffIso) continue;
    const maxSizeIn = Number(row.max_size) || parseFloat(row.size_in) || 0;
    if (maxSizeIn + 1e-6 < Number(minHailIn)) continue;
    // zone_pts from collapse is enough for hull cover — skip rebuilding per-day maps each chunk.
    const cover = stormCoversHome(row, lat, lon, row.zone_pts || []);
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
  if (!msg && !storms.length && (hailRows || []).length) {
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
    loading: Boolean(loading || pinCache.loadingDeep),
  };
}

export function filterCachedHomeStorms({ years = 2, minHailIn = 1 } = {}) {
  if (!pinCache.key || !Number.isFinite(pinCache.lat)) {
    return { ok: false, storms: [], hailRowCount: 0, loading: false, note: "Enter an address first", fetchedDays: 0 };
  }
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  const have = pinCache.fetchedDays || 0;
  const loading = Boolean(pinCache.loadingDeep || pinCache.deepenPromise || pinCache.dossierPromise);
  return summarizeHailRows(pinCache.hail, pinCache.lat, pinCache.lon, {
    minHailIn,
    days,
    years,
    loading,
    note:
      days > have && loading
        ? `Still loading history… ~${Math.max(1, Math.round(have / 365))}y in · ${pinCache.hail?.length || 0} reports`
        : days > have
          ? `Showing ~${Math.round(have / 365)}y loaded — older years incomplete`
          : null,
  });
}

function pushPartial(onPartial, lat, lon, minHailIn, days, years, loading, note) {
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

async function deepenArchive(lat, lon, days, onPartial, minHailIn, years, seq) {
  const key = pinKey(lat, lon);
  pinCache.uiNotify = onPartial || pinCache.uiNotify;
  pinCache.deepTarget = Math.max(pinCache.deepTarget || 0, days);

  if (pinCache.deepenPromise && pinCache.key === key) {
    await pinCache.deepenPromise;
    if ((pinCache.fetchedDays || 0) >= days) {
      pushPartial(onPartial, lat, lon, minHailIn, days, years, false, null);
      return;
    }
  }

  if ((pinCache.fetchedDays || 0) >= days) {
    pushPartial(onPartial, lat, lon, minHailIn, days, years, false, null);
    return;
  }

  pinCache.loadingDeep = true;
  emitHailCache();

  const run = (async () => {
    try {
      const deep = await fetchIemLsrHailArchive(lat, lon, HOME_DEEP_KM, days, {
        onChunk: (rows, meta) => {
          if (pinCache.key !== key) return;
          pinCache.hail = mergeHailRows(pinCache.hail, [], rows || []);
          const covered = Number(meta?.coveredDays) || Number(meta?.offset) || 0;
          if (covered > 0) pinCache.fetchedDays = Math.max(pinCache.fetchedDays, Math.min(days, covered));
          const ySoFar = Math.max(1, Math.round((pinCache.fetchedDays || 0) / 365));
          // Do not await UI work — archive workers must keep fetching older years.
          pushPartial(
            pinCache.uiNotify,
            lat,
            lon,
            minHailIn,
            days,
            years,
            true,
            `Loading… ~${ySoFar}y in · ${pinCache.hail.length} reports`,
          );
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
  pushPartial(
    pinCache.uiNotify,
    lat,
    lon,
    minHailIn,
    days,
    years,
    false,
    pinCache.fetchedDays >= days ? null : "Older years partially loaded — keep this tab open to retry.",
  );
}

/**
 * Load hail for a home. Archive years start immediately (parallel with dossier)
 * so covering dates appear without waiting on SWDI first.
 */
export async function loadHomeStorms(lat, lon, { address = "", years = 2, minHailIn = 1, onPartial, force = false } = {}) {
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  const key = pinKey(lat, lon);

  // Don't block the whole load on a slow service-worker handshake.
  await Promise.race([
    ensureWebProxyReady(8000).catch(() => false),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
  setWxPin(lat, lon);

  pinCache.uiNotify = onPartial || pinCache.uiNotify;

  if (!force && pinCache.key === key) {
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

  pushPartial(onPartial, lat, lon, minHailIn, days, years, true, "Starting hail history…");

  // PRIMARY: 10y LSR archive right away — this fills the storm date list.
  const deepenP = deepenArchive(lat, lon, days, onPartial, minHailIn, years, seq);

  // SECONDARY: dossier/SWDI in parallel for map detail — must never gate the archive.
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

  const dossierWait = dossierJob
    .then((dossier) => {
      if (pinCache.key !== key || seq !== pinCache.loadSeq) return;
      pinCache.hail = mergeHailRows(pinCache.hail, dossier?.hail || []);
      pinCache.address = dossier?.address || address || pinCache.address;
      pushPartial(
        onPartial,
        lat,
        lon,
        minHailIn,
        days,
        years,
        Boolean(pinCache.loadingDeep || pinCache.deepenPromise),
        "Radar dossier merged…",
      );
    })
    .catch((err) => {
      console.warn("[HomeScope] dossier", err);
    });

  await deepenP;
  await dossierWait;
  if (pinCache.key !== key || seq !== pinCache.loadSeq) {
    return filterCachedHomeStorms({ years, minHailIn });
  }
  return filterCachedHomeStorms({ years, minHailIn });
}

export { HOUSE_HAIL_KM, HOUSE_ZONE_KM, COVER_NEAR_KM, HOME_DEEP_KM };
