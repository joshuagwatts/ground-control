/** Device location — GPS, IP, kit city. Never silently stick on Denver. */

export const DENVER = { lat: 39.7392, lon: -104.9903, city: "Denver" };

export function isDenverFallback(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return true;
  return Math.abs(la - DENVER.lat) < 0.02 && Math.abs(lo - DENVER.lon) < 0.02;
}

export function validCoord(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
}

export function persistCoords(settings, hit) {
  if (!settings || !hit) return hit;
  settings.lat = String(hit.lat);
  settings.lon = String(hit.lon);
  if (hit.city) settings.city = hit.city;
  return hit;
}

function gpsHit(p) {
  if (!p?.coords) return null;
  const lat = p.coords.latitude;
  const lon = p.coords.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, acc: p.coords.accuracy, city: "", source: "gps" };
}

async function gpsFix(timeoutMs = 12000) {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    const done = (hit) => resolve(hit);
    const timer = setTimeout(() => done(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        done(gpsHit(p));
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { timeout: timeoutMs, maximumAge: 300000, enableHighAccuracy: false },
    );
  });
}

/** Live GPS for the map blue-dot. Does not pan. Returns a stop function. */
export function watchGps(onFix) {
  if (typeof navigator === "undefined" || !navigator.geolocation || typeof onFix !== "function") {
    return () => {};
  }
  const emit = (p) => {
    const hit = gpsHit(p);
    if (hit) onFix(hit);
  };
  navigator.geolocation.getCurrentPosition(emit, () => {}, {
    enableHighAccuracy: false,
    maximumAge: 60000,
    timeout: 8000,
  });
  const id = navigator.geolocation.watchPosition(emit, () => {}, {
    enableHighAccuracy: true,
    maximumAge: 4000,
    timeout: 20000,
  });
  return () => {
    try {
      navigator.geolocation.clearWatch(id);
    } catch {
      /* ignore */
    }
  };
}

async function ipFix(httpGet) {
  const urls = [
    "https://get.geojs.io/v1/ip/geo.json",
    "https://ipapi.co/json/",
  ];
  for (const url of urls) {
    try {
      const { body } = await httpGet(url, 6000);
      const data = JSON.parse(body || "{}");
      const lat = parseFloat(data.latitude || data.lat);
      const lon = parseFloat(data.longitude || data.lon);
      if (!validCoord(lat, lon) || isDenverFallback(lat, lon)) continue;
      const city = String(data.city || data.region || "").trim();
      return { lat, lon, city, source: "ip" };
    } catch {
      /* next */
    }
  }
  return null;
}

async function cityFix(name, httpGet) {
  const q = String(name || "").trim();
  if (q.length < 2) return null;
  try {
    const { body } = await httpGet(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`,
      7000,
    );
    const hit = (JSON.parse(body || "{}").results || [])[0];
    if (!hit) return null;
    const lat = Number(hit.latitude);
    const lon = Number(hit.longitude);
    if (!validCoord(lat, lon)) return null;
    return { lat, lon, city: hit.name || q, source: "city" };
  } catch {
    return null;
  }
}

export async function locateDevice(settings, httpGet, { force = false } = {}) {
  const savedLat = parseFloat(settings?.lat);
  const savedLon = parseFloat(settings?.lon);
  if (!force && validCoord(savedLat, savedLon) && !isDenverFallback(savedLat, savedLon)) {
    return { lat: savedLat, lon: savedLon, city: settings.city || "", source: "saved" };
  }
  const gps = await gpsFix();
  if (gps && validCoord(gps.lat, gps.lon) && !isDenverFallback(gps.lat, gps.lon)) {
    return persistCoords(settings, gps);
  }
  const ip = await ipFix(httpGet);
  if (ip) return persistCoords(settings, ip);
  const place = settings?.city || "";
  const named = await cityFix(place, httpGet);
  if (named && !isDenverFallback(named.lat, named.lon)) return persistCoords(settings, named);
  if (gps && validCoord(gps.lat, gps.lon)) return persistCoords(settings, gps);
  return persistCoords(settings, { ...DENVER, source: "fallback" });
}
