/**
 * HomeScope hail load — uses Ground Control hail engines without field UI.
 * Prefer setWxPin → pinDossier → collapseHailByDate so near_hits stay accurate.
 */
import {
  setWxPin,
  pinDossier,
  collapseHailByDate,
  HOUSE_HAIL_KM,
  buildHailSwathRings,
  PIN_FETCH_WIDE_KM,
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

function stormCoversHome(row, lat, lon, nearKm = HOUSE_HAIL_KM) {
  const pts = row.zone_pts || [];
  const coversNear = pts.some((p) => (Number(p.distance_km) || 999) <= nearKm) || (Number(row.near_hits) || 0) > 0;
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
 * Load hail near an OK home and return only storm days that cover the roof
 * (near-roof hits and/or zone polygon over the pin).
 */
export async function loadHomeStorms(lat, lon, { address = "", years = 2, minHailIn = 1, onPartial } = {}) {
  const days = Math.min(Math.max(Math.round(Number(years) * 365.25), 30), 3650);
  setWxPin(lat, lon);

  const settings = {};
  const dossier = await pinDossier(settings, lat, lon, {
    address,
    deep: false,
    onPartial: onPartial
      ? (part) => {
          onPartial(summarizeDossier(part, lat, lon, { minHailIn, days }));
        }
      : undefined,
  });

  return summarizeDossier(dossier, lat, lon, { minHailIn, days, years });
}

function summarizeDossier(dossier, lat, lon, { minHailIn = 1, days = 730, years } = {}) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const collapsed = collapseHailByDate(dossier?.hail || []);
  const storms = [];
  for (const row of collapsed) {
    const date = String(row.date || "");
    if (!date || date < cutoffIso) continue;
    const maxSizeIn = Number(row.max_size) || parseFloat(row.size_in) || 0;
    if (maxSizeIn + 1e-6 < Number(minHailIn)) continue;
    const cover = stormCoversHome(row, lat, lon);
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
      hits: Number(row.hits) || 0,
      zone_pts: row.zone_pts || [],
      raw: row,
    });
  }
  storms.sort((a, b) => b.date.localeCompare(a.date));

  return {
    ok: Boolean(dossier?.ok !== false),
    address: dossier?.address || "",
    lat,
    lon,
    years: years ?? Math.round(days / 365.25),
    fetchedDays: Number(dossier?._meta?.fetchedDays) || days,
    note:
      days > 730
        ? "Deep history beyond ~2 years is still expanding — first pass uses the live 2-year archive; older years follow in a later build."
        : null,
    storms,
    hailRowCount: (dossier?.hail || []).length,
  };
}

export { HOUSE_HAIL_KM, PIN_FETCH_WIDE_KM };
