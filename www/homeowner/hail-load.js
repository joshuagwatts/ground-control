/**
 * HomeScope hail load — uses Ground Control hail engines without field UI.
 * Registers/waits for the Pages CORS proxy before NOAA fetches.
 */
import { ensureWebProxyReady } from "../net.js";
import {
  setWxPin,
  pinDossier,
  collapseHailByDate,
  HOUSE_HAIL_KM,
  HOUSE_ZONE_KM,
  buildHailSwathRings,
  PIN_FETCH_WIDE_KM,
  fetchIemLsrHailArchive,
  mergeHailRows,
} from "../wx.js";

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

function stormCoversHome(row, lat, lon) {
  const nearKm = Math.max(HOUSE_HAIL_KM, HOUSE_ZONE_KM);
  const pts = row.zone_pts || [];
  const minDist = Number(row.min_dist);
  const coversNear =
    (Number(row.near_hits) || 0) > 0 ||
    (Number.isFinite(minDist) && minDist <= nearKm) ||
    pts.some((p) => (Number(p.distance_km) || 999) <= nearKm);
  let coversPolygon = false;
  try {
    const rings = buildHailSwathRings(pts, row, { includeSpotters: true }) || [];
    for (const band of rings) {
      const ring = band?.ring;
      if (ring && pointInLatLonRing(lat, lon, ring)) {
        coversPolygon = true;
        break;
      }
    }
  } catch {
    coversPolygon = false;
  }
  return {
    coversNear: Boolean(coversNear),
    coversPolygon: Boolean(coversPolygon),
    coversHome: Boolean(coversNear || coversPolygon),
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

/**
 * Load hail near an OK home and return storm days that cover the roof.
 */
export async function loadHomeStorms(lat, lon, { address = "", years = 2, minHailIn = 1, onPartial } = {}) {
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  await ensureWebProxyReady(12000);
  setWxPin(lat, lon);

  const settings = {};
  let dossier;
  try {
    dossier = await pinDossier(settings, lat, lon, {
      address,
      deep: false,
      onPartial: onPartial
        ? (part) => {
            onPartial(summarizeDossier(part, lat, lon, { minHailIn, days, years, loading: true }));
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

  if (onPartial) onPartial(summarizeDossier(dossier, lat, lon, { minHailIn, days, years, loading: days > 730 }));

  // Deepen beyond field 2-year cap with chunked LSR (spotter history).
  if (days > 730 && dossier) {
    try {
      const deep = await Promise.race([
        fetchIemLsrHailArchive(lat, lon, PIN_FETCH_WIDE_KM, days, {
          onChunk: (rows) => {
            const merged = {
              ...dossier,
              hail: mergeHailRows(dossier.hail || [], [], rows),
              _meta: { ...(dossier._meta || {}), fetchedDays: days, deepArchive: true, loading: true },
            };
            if (onPartial) onPartial(summarizeDossier(merged, lat, lon, { minHailIn, days, years, loading: true }));
          },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("deep archive timeout")), 55000)),
      ]);
      dossier = {
        ...dossier,
        hail: mergeHailRows(dossier.hail || [], [], deep),
        _meta: { ...(dossier._meta || {}), fetchedDays: days, deepArchive: true, loading: false },
      };
    } catch (err) {
      dossier = {
        ...dossier,
        _meta: {
          ...(dossier._meta || {}),
          deepArchive: false,
          loading: false,
          deepNote: String(err?.message || "Deep history still loading — showing recent years"),
        },
      };
    }
  }

  return summarizeDossier(dossier, lat, lon, { minHailIn, days, years, loading: false });
}

function summarizeDossier(dossier, lat, lon, { minHailIn = 1, days = 730, years, loading = false } = {}) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const hailRows = dossier?.hail || [];
  const collapsed = collapseHailByDate(hailRows);
  const storms = [];
  const nearMisses = [];
  for (const row of collapsed) {
    const date = String(row.date || "");
    if (!date || date < cutoffIso) continue;
    const maxSizeIn = Number(row.max_size) || parseFloat(row.size_in) || 0;
    if (maxSizeIn + 1e-6 < Number(minHailIn)) continue;
    const cover = stormCoversHome(row, lat, lon);
    const item = {
      date,
      pretty: prettyDate(date),
      maxSizeIn,
      sources: sourceLabel(row),
      coversHome: cover.coversHome,
      coversNear: cover.coversNear,
      coversPolygon: cover.coversPolygon,
      nearHits: Number(row.near_hits) || 0,
      minDist: Number(row.min_dist) || 999,
      hits: Number(row.hits) || 0,
      zone_pts: row.zone_pts || [],
      raw: row,
    };
    if (cover.coversHome) storms.push(item);
    else if ((Number(row.min_dist) || 999) <= 12) nearMisses.push(item);
  }
  storms.sort((a, b) => b.date.localeCompare(a.date));
  nearMisses.sort((a, b) => (a.minDist || 999) - (b.minDist || 999));

  const fetched = Number(dossier?._meta?.fetchedDays) || 0;
  const deep = Boolean(dossier?._meta?.deepArchive);
  let note = null;
  if (dossier?._meta?.deepNote) note = dossier._meta.deepNote;
  else if (days > 730 && loading) note = "Loading deeper spotter history beyond 2 years…";
  else if (days > 730 && deep) note = "Years 3–10 use IEM spotter archives; radar is densest in the recent ~2 years.";
  else if (!storms.length && hailRows.length) {
    note = `Loaded ${hailRows.length} hail reports nearby, but none ≥${minHailIn}″ cover this roof yet. Try lowering hail size.`;
  } else if (!storms.length && !hailRows.length && !loading) {
    note = "No hail rows returned — check connection and hard-refresh once so the radar proxy loads.";
  }

  return {
    ok: Boolean(dossier?.ok !== false),
    address: dossier?.address || "",
    lat,
    lon,
    years: years ?? Math.round(days / 365.25),
    fetchedDays: Math.max(fetched, loading ? 0 : Math.min(days, 730)),
    note,
    storms,
    nearMisses,
    hailRowCount: hailRows.length,
    loading: Boolean(loading),
  };
}

export { HOUSE_HAIL_KM, HOUSE_ZONE_KM, PIN_FETCH_WIDE_KM };
