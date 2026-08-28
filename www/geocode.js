/** House-level forward geocode. Street centroids and city centroids are last-resort. */
import { httpGet } from "./net.js";
import { parseStreetAddress } from "./contacts.js";

const NOM_UA = { "User-Agent": "GroundControl/1.0 (joshuagwatts)", "Accept-Language": "en" };

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
  return score;
}

export function pickGeocodeHits(hits, query) {
  return (hits || [])
    .filter((h) => Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lon)))
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

async function arcgisWorld(q) {
  const url =
    `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json` +
    `&outFields=Match_addr,Addr_type,StName,AddNum,StAddr,City,RegionAbbr,Postal&maxLocations=5` +
    `&SingleLine=${encodeURIComponent(q)}`;
  const data = await getJson(url, 10000);
  return (data.candidates || [])
    .map((c) => {
      const a = c.attributes || {};
      const stAddr = String(a.StAddr || "").trim();
      const house = String(a.AddNum || "").trim();
      const street = stAddr.replace(/^\d+\s+/, "").trim() || String(a.StName || "").trim();
      return {
        lat: Number(c.location?.y),
        lon: Number(c.location?.x),
        address: a.Match_addr || c.address || q,
        city: String(a.City || "").trim(),
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

async function nominatimSearch(params) {
  const q = new URLSearchParams({ format: "json", addressdetails: "1", limit: "5", countrycodes: "us", ...params });
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
  if (parsed.house && parsed.street) {
    const params = {
      street: `${parsed.house} ${parsed.street}`.trim(),
      city: parsed.city || "",
      state: parsed.state || "",
      postalcode: parsed.zip || "",
    };
    if (!params.city && !params.state) params.q = fallbackQ;
    const hits = await nominatimSearch(params.q ? { q: params.q } : params);
    if (hits.length) return hits;
  }
  return nominatimSearch({ q: fallbackQ });
}

async function fromMeteo(q) {
  const data = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`,
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
export async function geocodeCandidates(query) {
  const q = String(query || "").trim();
  if (q.length < 3) throw new Error("type a longer address");
  const parsed = parseStreetAddress(q);
  const looksStreet = Boolean(parsed.house) || /,/.test(q);
  const hits = [];
  if (looksStreet) {
    try {
      hits.push(...(await arcgisWorld(q)));
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
    if (!hits.length) {
      try {
        hits.push(...(await nominatimSearch({ q })));
      } catch {
        /* empty */
      }
    }
  }
  const ranked = pickGeocodeHits(hits, q);
  if (!ranked.length) throw new Error("address not found");
  return ranked;
}
