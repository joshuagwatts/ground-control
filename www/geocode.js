/** House-level forward geocode. Street centroids and city centroids are last-resort.
 * Almost always scoped to Oklahoma unless the query names another state. */
import { httpGet } from "./net.js";
import { parseStreetAddress, stateAbbr } from "./contacts.js";

const NOM_UA = { "User-Agent": "GroundControl/1.0 (joshuagwatts)", "Accept-Language": "en" };

/** WGS84 extent for Oklahoma (includes panhandle). */
export const OKLAHOMA_EXTENT = { west: -103.05, south: 33.55, east: -94.35, north: 37.05 };

const US_STATE_WORD =
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+hampshire|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oregon|pennsylvania|rhode\s+island|south\s+carolina|south\s+dakota|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming)\b/i;

const US_STATE_ABBR =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;

async function getJson(url, timeoutMs, headers) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      return JSON.parse((await res.text()) || "{}");
    } finally {
      clearTimeout(t);
    }
  } catch {
    const { body } = await httpGet(url, timeoutMs, headers);
    return JSON.parse(body || "{}");
  }
}

function houseOf(s) {
  return String(s || "")
    .trim()
    .replace(/^0+/, "")
    .toLowerCase();
}

const CARD = {
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
};

function geoStreetKey(street) {
  const skip = /^(st|ave|dr|ln|rd|blvd|way|ct|pl|cir|pkwy|hwy|street|avenue|drive|lane|road|court|place|circle)$/i;
  return String(street || "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((b) => CARD[b] || b)
    .filter((b) => !skip.test(b))
    .join(" ");
}

/** True when the user explicitly asked for a non-Oklahoma state. */
export function queryAllowsOutOfState(query) {
  const q = String(query || "");
  const parsed = parseStreetAddress(q);
  const st = stateAbbr(parsed.state || "");
  if (st && st !== "ok") return true;
  if (/\bOK\b|Oklahoma/i.test(q)) return false;
  if (US_STATE_WORD.test(q)) {
    const m = q.match(US_STATE_WORD);
    if (m && !/^oklahoma$/i.test(m[0])) return true;
  }
  const abbr = q.match(US_STATE_ABBR);
  if (abbr && abbr[1].toUpperCase() !== "OK") return true;
  return false;
}

export function inOklahoma(hit) {
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const e = OKLAHOMA_EXTENT;
    if (lat >= e.south && lat <= e.north && lon >= e.west && lon <= e.east) return true;
  }
  const addr = String(hit?.address || "");
  if (/\bOK\b|, Oklahoma\b| Oklahoma,/i.test(addr)) return true;
  const st = stateAbbr(parseStreetAddress(addr).state || "");
  return st === "ok";
}

/**
 * Append Oklahoma when the query has no state — Ground Control is OK-first.
 * Honors an explicit other state (e.g. "Dallas, TX").
 */
export function biasAddressQuery(query, { city = "" } = {}) {
  const raw = String(query || "").trim();
  if (!raw) return raw;
  if (queryAllowsOutOfState(raw)) return raw;
  if (/\bOK\b|Oklahoma/i.test(raw)) return raw;
  const parsed = parseStreetAddress(raw);
  const cityHint = String(parsed.city || city || "").trim();
  if (parsed.house && parsed.street) {
    const bits = [`${parsed.house} ${parsed.street}`.trim(), cityHint || null, "OK", parsed.zip || null].filter(Boolean);
    return bits.join(", ");
  }
  if (cityHint && !new RegExp(cityHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(raw)) {
    return `${raw}, ${cityHint}, OK`;
  }
  return `${raw}, OK`;
}

export function scoreGeocodeHit(hit, query) {
  const want = parseStreetAddress(query);
  const got = parseStreetAddress(hit.address || "");
  const hitHouse = houseOf(hit.house || got.house);
  const wantHouse = houseOf(want.house);
  const hitStreet = geoStreetKey(got.street || hit.street || "");
  const wantStreet = geoStreetKey(want.street);
  let score = 0;
  if (wantHouse) {
    const streetsAgree = Boolean(wantStreet && hitStreet && wantStreet === hitStreet);
    const streetsClash = Boolean(wantStreet && hitStreet && wantStreet !== hitStreet);
    if (hitHouse && hitHouse === wantHouse && streetsAgree) score += 100;
    else if (hitHouse && hitHouse === wantHouse && streetsClash) score -= 80;
    else if (hitHouse && hitHouse === wantHouse) score += 40;
    else if (!hitHouse) score -= 45;
    else score -= 25;
  } else if (wantStreet && hitStreet && wantStreet === hitStreet) {
    score += 25;
  }
  if (wantStreet && hitStreet && wantStreet === hitStreet) score += 25;
  if (hit.addrType === "PointAddress") score += 28;
  else if (hit.addrType === "StreetAddress") score += 12;
  if (hit.source === "arcgis") score += 16;
  else if (hit.source === "census") score += 8;
  else if (hit.source === "nominatim") score += 4;
  else if (hit.source === "open-meteo") score -= 35;
  // Strong OK preference unless the user named another state.
  if (!queryAllowsOutOfState(query)) {
    if (inOklahoma(hit)) score += 55;
    else score -= 120;
  }
  return score;
}

export function pickGeocodeHits(hits, query) {
  const allowOut = queryAllowsOutOfState(query);
  return (hits || [])
    .filter((h) => Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lon)))
    .filter((h) => allowOut || inOklahoma(h))
    .map((h) => ({ ...h, score: scoreGeocodeHit(h, query) }))
    .sort((a, b) => b.score - a.score);
}

export function geoCacheOk(hit, query) {
  if (!hit || !Number.isFinite(Number(hit.lat)) || !Number.isFinite(Number(hit.lon))) return false;
  if (Number(hit.v) !== 2) return false;
  const want = parseStreetAddress(query);
  if (!want.house) return true;
  return Boolean(hit.houseOk);
}

async function arcgisWorld(q, { lat, lon } = {}) {
  const e = OKLAHOMA_EXTENT;
  const okOnly = !queryAllowsOutOfState(q);
  let url =
    `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json` +
    `&outFields=Match_addr,Addr_type,StName,AddNum,StAddr,City,RegionAbbr,Postal&maxLocations=8` +
    `&sourceCountry=USA&category=Address&SingleLine=${encodeURIComponent(q)}`;
  if (okOnly) {
    url += `&searchExtent=${e.west},${e.south},${e.east},${e.north}`;
  }
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    url += `&location=${Number(lon)},${Number(lat)}&distance=80000`;
  } else if (okOnly) {
    // Bias toward metro OKC when no map center is passed.
    url += `&location=-97.5164,35.4676&distance=120000`;
  }
  const data = await getJson(url, 10000);
  return (data.candidates || [])
    .map((c) => {
      const a = c.attributes || {};
      const stAddr = String(a.StAddr || "").trim();
      const house = String(a.AddNum || "").trim();
      const street = stAddr.replace(/^\d+\s+/, "").trim() || String(a.StName || "").trim();
      const region = String(a.RegionAbbr || "").trim();
      const city = String(a.City || "").trim();
      const postal = String(a.Postal || "").trim();
      const match = a.Match_addr || c.address || q;
      const address =
        match.includes(",") || !city
          ? match
          : [match, city, region || "OK", postal].filter(Boolean).join(", ");
      return {
        lat: Number(c.location?.y),
        lon: Number(c.location?.x),
        address,
        city,
        house,
        street,
        addrType: String(a.Addr_type || ""),
        source: "arcgis",
      };
    })
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
}

async function censusOneline(q) {
  const url =
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}` +
    `&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
  const data = await getJson(url, 10000);
  const matches = data?.result?.addressMatches || [];
  return matches
    .map((m) => {
      const coords = m.coordinates || {};
      const parts = m.addressComponents || {};
      const house = String(parts.fromAddress || parts.toAddress || "").trim();
      const street = [parts.preDirection, parts.streetName, parts.suffixType, parts.suffixDirection].filter(Boolean).join(" ");
      const city = String(parts.city || "").trim();
      const state = String(parts.state || "").trim();
      const zip = String(parts.zip || "").trim();
      const address = m.matchedAddress || [house, street, city, state, zip].filter(Boolean).join(", ");
      return {
        lat: Number(coords.y),
        lon: Number(coords.x),
        address,
        city: city || address.split(",")[0],
        house,
        street,
        source: "census",
      };
    })
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
}

async function nominatimSearch(params, { boundOk = true } = {}) {
  const e = OKLAHOMA_EXTENT;
  const base = {
    format: "json",
    addressdetails: "1",
    limit: "6",
    countrycodes: "us",
    ...params,
  };
  if (boundOk && !queryAllowsOutOfState(String(params.q || params.street || ""))) {
    base.viewbox = `${e.west},${e.north},${e.east},${e.south}`;
    base.bounded = "1";
  }
  const q = new URLSearchParams(base);
  const data = await getJson(`https://nominatim.openstreetmap.org/search?${q}`, 9000, NOM_UA);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((h) => {
    const a = h.address || {};
    const house = String(a.house_number || "").trim();
    const street = String(a.road || a.pedestrian || a.residential || "").trim();
    return {
      lat: Number(h.lat),
      lon: Number(h.lon),
      address: h.display_name || "",
      city: String(a.city || a.town || a.village || a.hamlet || "").trim(),
      house,
      street,
      source: "nominatim",
    };
  });
}

async function nominatimStructured(parsed, fallbackQ) {
  const okOnly = !queryAllowsOutOfState(fallbackQ);
  if (parsed.house && parsed.street) {
    const params = {
      street: `${parsed.house} ${parsed.street}`.trim(),
      city: parsed.city || "",
      state: parsed.state || (okOnly ? "Oklahoma" : ""),
      postalcode: parsed.zip || "",
    };
    if (!params.city && !params.state) params.q = fallbackQ;
    const hits = await nominatimSearch(params.q ? { q: params.q } : params, { boundOk: okOnly });
    if (hits.length) return hits;
  }
  return nominatimSearch({ q: fallbackQ }, { boundOk: okOnly });
}

async function fromMeteo(q) {
  const data = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json&countryCode=US`,
    9000,
  );
  return (data.results || []).map((h) => ({
    lat: Number(h.latitude),
    lon: Number(h.longitude),
    address: [h.name, h.admin1, h.country].filter(Boolean).join(", "),
    city: h.name || q,
    house: "",
    street: "",
    source: "open-meteo",
  }));
}

/** Ranked house-level candidates. Caller may snap the winner onto a rooftop. */
export async function geocodeCandidates(query, { city = "", lat, lon } = {}) {
  const raw = String(query || "").trim();
  if (raw.length < 3) throw new Error("type a longer address");
  const q = biasAddressQuery(raw, { city });
  const parsed = parseStreetAddress(q);
  const looksStreet = Boolean(parsed.house) || /,/.test(q) || /^\d/.test(q);
  const loc = { lat: Number(lat), lon: Number(lon) };
  const hits = [];
  if (looksStreet) {
    try {
      hits.push(...(await arcgisWorld(q, loc)));
    } catch {
      /* census next */
    }
    try {
      hits.push(...(await censusOneline(q)));
    } catch {
      /* nominatim next */
    }
    try {
      hits.push(...(await nominatimStructured(parsed, q)));
    } catch {
      /* open-meteo last */
    }
    if (!hits.length) {
      try {
        hits.push(...(await fromMeteo(q)));
      } catch {
        /* empty */
      }
    }
  } else {
    try {
      hits.push(...(await fromMeteo(q)));
    } catch {
      /* nominatim next */
    }
    try {
      hits.push(...(await arcgisWorld(q, loc)));
    } catch {
      /* ignore */
    }
    if (!hits.length) {
      try {
        hits.push(...(await nominatimSearch({ q }, { boundOk: !queryAllowsOutOfState(q) })));
      } catch {
        /* empty */
      }
    }
  }
  let ranked = pickGeocodeHits(hits, q);
  // Prefer hits closer to the map center when scores are close.
  if (Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    ranked = [...ranked].sort((a, b) => {
      const ds = (b.score || 0) - (a.score || 0);
      if (Math.abs(ds) >= 12) return ds;
      const da = (a.lat - loc.lat) ** 2 + (a.lon - loc.lon) ** 2;
      const db = (b.lat - loc.lat) ** 2 + (b.lon - loc.lon) ** 2;
      return da - db || ds;
    });
  }
  // If OK filter wiped everything (rare), retry without hard filter but keep score bias.
  if (!ranked.length && hits.length && !queryAllowsOutOfState(q)) {
    ranked = (hits || [])
      .filter((h) => Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lon)))
      .map((h) => ({ ...h, score: scoreGeocodeHit(h, q) }))
      .sort((a, b) => b.score - a.score);
  }
  if (!ranked.length) throw new Error("address not found");
  return ranked;
}
