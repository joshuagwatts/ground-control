/**
 * HomeScope hail load — fast 2y first, optional deepen, client-side filter refresh.
 */
import { ensureWebProxyReady } from "../net.js";
import {
  setWxPin,
  pinDossier,
  collapseHailByDate,
  HOUSE_HAIL_KM,
  HOUSE_ZONE_KM,
  buildHomeHailZoneBands,
  fetchIemLsrHailArchive,
  mergeHailRows,
} from "../wx.js";

/** Homeowner deep archive radius — wide enough for storm days, not a regional dump. */
const HOME_DEEP_KM = 40;
/** Strict near-roof cover — matches field HailScope house zone, not a soft guess. */
const COVER_NEAR_KM = Math.max(HOUSE_HAIL_KM, HOUSE_ZONE_KM);

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

/**
 * Honest cover: near-roof hits and/or HailScope zone polygon over the pin.
 * Soft “nearby” reports are never claimed as covering the home.
 */
function stormCoversHome(row, lat, lon, dayRows = []) {
  const pts = row.zone_pts || [];
  const minDist = Number(row.min_dist);
  const coversNear =
    (Number(row.near_hits) || 0) > 0 ||
    (Number.isFinite(minDist) && minDist <= COVER_NEAR_KM) ||
    pts.some((p) => (Number(p.distance_km) || 999) <= COVER_NEAR_KM);

  let coversPolygon = false;
  try {
    const bands = buildHomeHailZoneBands(row, dayRows) || [];
    for (const band of bands) {
      if (band?.ring && pointInLatLonRing(lat, lon, band.ring)) {
        coversPolygon = true;
        break;
      }
    }
  } catch {
    coversPolygon = false;
  }

  const nearbyEvidence =
    !coversNear &&
    !coversPolygon &&
    Number.isFinite(minDist) &&
    minDist > COVER_NEAR_KM &&
    minDist <= 5.5;

  return {
    coversNear: Boolean(coversNear),
    coversPolygon: Boolean(coversPolygon),
    coversHome: Boolean(coversNear || coversPolygon),
    nearbyEvidence: Boolean(nearbyEvidence),
    softNear: Boolean(nearbyEvidence),
  };
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

/** In-memory hail rows for the current pin — filter changes don't refetch. */
let pinCache = {
  key: "",
  lat: null,
  lon: null,
  address: "",
  hail: [],
  fetchedDays: 0,
  loadingDeep: false,
  deepTarget: 0,
};

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
  };
}

export function getHomeHailCache() {
  return pinCache;
}

function pinKey(lat, lon) {
  return `${Number(lat).toFixed(4)}|${Number(lon).toFixed(4)}`;
}

export function summarizeHailRows(hailRows, lat, lon, { minHailIn = 1, days = 730, years, loading = false, note = null } = {}) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const collapsed = collapseHailByDate(hailRows || []);
  const byDay = new Map();
  for (const h of hailRows || []) {
    const d = String(h?.date || "").slice(0, 10);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(h);
  }
  const storms = [];
  for (const row of collapsed) {
    const date = String(row.date || "");
    if (!date || date < cutoffIso) continue;
    const maxSizeIn = Number(row.max_size) || parseFloat(row.size_in) || 0;
    if (maxSizeIn + 1e-6 < Number(minHailIn)) continue;
    const cover = stormCoversHome(row, lat, lon, byDay.get(date) || []);
    // Only list storms that actually cover the home — nearby-only is noted, not claimed.
    if (!cover.coversHome) continue;
    storms.push({
      date,
      pretty: prettyDate(date),
      maxSizeIn,
      sources: sourceLabel(row),
      coversHome: true,
      coversNear: cover.coversNear,
      coversPolygon: cover.coversPolygon,
      softNear: false,
      nearHits: Number(row.near_hits) || 0,
      minDist: Number(row.min_dist) || 999,
      hits: Number(row.hits) || 0,
      zone_pts: row.zone_pts || [],
      raw: row,
    });
  }
  // Default chronological; UI re-ranks by intense vs recent.
  storms.sort((a, b) => b.date.localeCompare(a.date));

  let msg = note;
  if (!msg && !storms.length && (hailRows || []).length) {
    msg = `Loaded ${(hailRows || []).length} hail reports nearby — none ≥${minHailIn}″ with near-roof or zone-over-home cover in ~${years || Math.round(days / 365)}y. Try a lower hail size or wider history.`;
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
    loading: Boolean(loading),
  };
}

/**
 * Re-filter cached hail without network — year / size chips should feel instant.
 */
export function filterCachedHomeStorms({ years = 2, minHailIn = 1 } = {}) {
  if (!pinCache.key || !Number.isFinite(pinCache.lat)) {
    return { ok: false, storms: [], hailRowCount: 0, loading: false, note: "Enter an address first", fetchedDays: 0 };
  }
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  const needDays = days;
  const have = pinCache.fetchedDays || 0;
  const loading = pinCache.loadingDeep && needDays > have;
  return summarizeHailRows(pinCache.hail, pinCache.lat, pinCache.lon, {
    minHailIn,
    days,
    years,
    loading,
    note:
      needDays > have && pinCache.loadingDeep
        ? `Showing what we have · loading older years…`
        : needDays > have
          ? `Showing ~${Math.round(have / 365)}y loaded · older years still catching up`
          : null,
  });
}

async function deepenArchive(lat, lon, days, onPartial, minHailIn, years) {
  if (pinCache.loadingDeep) return;
  if ((pinCache.fetchedDays || 0) >= days) return;
  pinCache.loadingDeep = true;
  pinCache.deepTarget = Math.max(pinCache.deepTarget || 0, days);
  try {
    const deep = await Promise.race([
      fetchIemLsrHailArchive(lat, lon, HOME_DEEP_KM, days, {
        onChunk: (rows, meta) => {
          pinCache.hail = mergeHailRows(pinCache.hail, [], rows);
          const covered = Number(meta?.coveredDays) || Number(meta?.offset) || 0;
          if (covered > 0) pinCache.fetchedDays = Math.max(pinCache.fetchedDays, Math.min(days, covered));
          if (onPartial) {
            onPartial(
              summarizeHailRows(pinCache.hail, lat, lon, {
                minHailIn,
                days,
                years,
                loading: true,
                note: `Loading older storm years… (~${Math.round((pinCache.fetchedDays || 0) / 365)}y so far)`,
              }),
            );
          }
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 45000)),
    ]);
    pinCache.hail = mergeHailRows(pinCache.hail, [], deep);
    pinCache.fetchedDays = Math.max(pinCache.fetchedDays, days);
  } catch {
    /* keep what we have — filters still work */
  } finally {
    pinCache.loadingDeep = false;
  }
  if (onPartial) {
    onPartial(
      summarizeHailRows(pinCache.hail, lat, lon, {
        minHailIn,
        days,
        years,
        loading: false,
        note: pinCache.fetchedDays >= days ? null : "Older years partially loaded — filters still work on what we have.",
      }),
    );
  }
}

/**
 * Load hail for a home. Returns as soon as the ~2y pin dossier is ready.
 * Deeper years continue in the background via onPartial.
 */
export async function loadHomeStorms(lat, lon, { address = "", years = 2, minHailIn = 1, onPartial, force = false } = {}) {
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  const key = pinKey(lat, lon);

  await ensureWebProxyReady(8000);
  setWxPin(lat, lon);

  // Same pin + already have recent window → filter only; deepen in background if needed.
  if (!force && pinCache.key === key && (pinCache.fetchedDays || 0) >= Math.min(days, 730) && pinCache.hail.length) {
    if (days > pinCache.fetchedDays && !pinCache.loadingDeep) {
      void deepenArchive(lat, lon, days, onPartial, minHailIn, years);
    }
    return filterCachedHomeStorms({ years, minHailIn });
  }

  // New pin — reset cache.
  if (pinCache.key !== key) {
    pinCache = {
      key,
      lat,
      lon,
      address,
      hail: [],
      fetchedDays: 0,
      loadingDeep: false,
      deepTarget: 0,
    };
  } else {
    pinCache.address = address || pinCache.address;
    pinCache.lat = lat;
    pinCache.lon = lon;
  }

  let dossier;
  try {
    dossier = await pinDossier({}, lat, lon, {
      address,
      deep: false,
      onPartial: onPartial
        ? (part) => {
            const hail = part?.hail || [];
            pinCache.hail = mergeHailRows(pinCache.hail, hail);
            pinCache.fetchedDays = Math.max(pinCache.fetchedDays, Math.min(730, Number(part?._meta?.fetchedDays) || 400));
            onPartial(
              summarizeHailRows(pinCache.hail, lat, lon, {
                minHailIn,
                days,
                years,
                loading: true,
              }),
            );
          }
        : undefined,
    });
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
    return empty;
  }

  pinCache.hail = mergeHailRows(pinCache.hail, dossier?.hail || []);
  pinCache.fetchedDays = Math.max(pinCache.fetchedDays, Math.min(730, Number(dossier?._meta?.fetchedDays) || 730));
  pinCache.address = dossier?.address || address || pinCache.address;

  const shown = summarizeHailRows(pinCache.hail, lat, lon, {
    minHailIn,
    days,
    years,
    loading: days > pinCache.fetchedDays,
    note: days > pinCache.fetchedDays ? "Recent years ready · loading older history…" : null,
  });
  if (onPartial) onPartial(shown);

  if (days > pinCache.fetchedDays) {
    void deepenArchive(lat, lon, days, onPartial, minHailIn, years);
  }

  return shown;
}

export { HOUSE_HAIL_KM, HOUSE_ZONE_KM, COVER_NEAR_KM, HOME_DEEP_KM };
