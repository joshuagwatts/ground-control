/** County assessor parcel lookup — owner of record and mailing address for a pin. */
import { httpGet } from "./net.js";
import { parseStreetAddress, sameHouse, streetKey } from "./contacts.js";

const LAYERS = [
  {
    id: "ok-county",
    source: "Oklahoma County",
    south: 35.32,
    north: 35.78,
    west: -97.78,
    east: -97.1,
    url: "https://services8.arcgis.com/euhkr1dAJeQBIjV0/arcgis/rest/services/TaxParcelsPublics_view/FeatureServer/0/query",
    situsField: "location",
    outFields:
      "name1,name2,name3,mailingaddress1,city,state,zipcode,location,locationcity,accountno,propertyid",
    pick: pickOkCounty,
  },
  {
    id: "okc-tricounty",
    source: "Oklahoma City GIS",
    south: 35.05,
    north: 35.78,
    west: -98.05,
    east: -97.1,
    url: "https://gis.okc.gov/arcgis/rest/services/Public/EncodeOKCWebMap2/MapServer/8/query",
    situsField: "Address",
    outFields:
      "Owner_Name1,Owner_Name2,Address,City,Mail_Address1,Mail_Address2,Mail_City,Mail_State,Mail_Zipcode,PARCEL_HYPERLINK,Owner_Occ",
    pick: pickTricounty,
  },
  {
    id: "tulsa",
    source: "Tulsa County",
    south: 35.85,
    north: 36.45,
    west: -96.3,
    east: -95.52,
    url: "https://map11.incog.org/arcgis11wa/rest/services/Parcels_TulsaCo/FeatureServer/0/query",
    situsField: "PropertyAddress",
    outFields:
      "Owner,Name1,Name2,PropertyAddress,PropertyCity,Address1,Address2,City,State,ZIPCode,HomesteadExemption",
    pick: pickTulsa,
  },
];

function attr(row, ...keys) {
  const map = {};
  for (const [k, v] of Object.entries(row || {})) map[String(k).toLowerCase()] = v;
  for (const k of keys) {
    const v = map[String(k).toLowerCase()];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function joinNames(...bits) {
  const seen = [];
  for (const b of bits) {
    const t = String(b || "").replace(/\s+/g, " ").trim();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen.join(" ");
}

export function formatOwnerName(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const keep = /^(LLC|LP|LLP|LLLP|INC|CO|NA|USA|OK|TRUST|LTD|PC|PA|DBA)$/i;
  return s
    .split(/(\s+)/)
    .map((w) => {
      if (/^\s+$/.test(w)) return w;
      if (keep.test(w)) return w.toUpperCase();
      if (w === w.toUpperCase() && /[A-Z]/.test(w)) {
        return w.charAt(0) + w.slice(1).toLowerCase();
      }
      return w;
    })
    .join("");
}

export function formatMailing(line1, city, state, zip, line2 = "") {
  const street = [line1, line2].map((s) => String(s || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  const st = String(state || "").trim();
  const z = String(zip || "").trim();
  const csz = [formatOwnerName(city), [st.toUpperCase(), z].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const head = /^(po|p\.o\.?)/i.test(street) ? street.toUpperCase().replace(/\s+/g, " ") : formatOwnerName(street);
  return [head, csz].filter(Boolean).join(", ");
}

export function parcelMatchesPin(pinAddress, situs) {
  const pin = pinAddress && typeof pinAddress === "object" && pinAddress.house != null ? pinAddress : parseStreetAddress(pinAddress);
  if (!pin.house) return true;
  const site = parseStreetAddress(String(situs || "").replace(/,/g, " "));
  if (!site.house) return true;
  return sameHouse(pin, site);
}

function pickOkCounty(row) {
  const id = attr(row, "propertyid");
  return {
    name: formatOwnerName(joinNames(attr(row, "name1"), attr(row, "name2"), attr(row, "name3"))),
    situs: attr(row, "location"),
    mail: formatMailing(attr(row, "mailingaddress1"), attr(row, "city"), attr(row, "state"), attr(row, "zipcode")),
    url: id
      ? `https://docs.oklahomacounty.org/AssessorWP5/AN-R.asp?PropertyID=${encodeURIComponent(id)}`
      : "https://docs.oklahomacounty.org/AssessorWP5/DefaultSearch.asp",
    source: "Oklahoma County",
    homestead: false,
  };
}

function pickTricounty(row) {
  const href = attr(row, "PARCEL_HYPERLINK");
  const occ = attr(row, "Owner_Occ");
  return {
    name: formatOwnerName(joinNames(attr(row, "Owner_Name1"), attr(row, "Owner_Name2"))),
    situs: [attr(row, "Address"), attr(row, "City")].filter(Boolean).join(" "),
    mail: formatMailing(
      attr(row, "Mail_Address1"),
      attr(row, "Mail_City"),
      attr(row, "Mail_State"),
      attr(row, "Mail_Zipcode"),
      attr(row, "Mail_Address2"),
    ),
    url: /^https?:\/\//i.test(href) ? href : "",
    source: "Oklahoma City GIS",
    homestead: /^(y|yes|1|true|o|owner)/i.test(occ),
  };
}

function pickTulsa(row) {
  const occ = attr(row, "HomesteadExemption");
  return {
    name: formatOwnerName(joinNames(attr(row, "Owner"), attr(row, "Name1"), attr(row, "Name2"))),
    situs: [attr(row, "PropertyAddress"), attr(row, "PropertyCity")].filter(Boolean).join(" "),
    mail: formatMailing(attr(row, "Address1"), attr(row, "City"), attr(row, "State"), attr(row, "ZIPCode"), attr(row, "Address2")),
    url: "https://www.assessor.tulsacounty.org/",
    source: "Tulsa County",
    homestead: /^(y|yes|1|true|h|homestead)/i.test(occ),
  };
}

function inBbox(lat, lon, layer) {
  return lat >= layer.south && lat <= layer.north && lon >= layer.west && lon <= layer.east;
}

function addressWhere(field, parts) {
  const house = String(parts.house || "").replace(/[^0-9A-Za-z]/g, "");
  const key = streetKey(parts.street).replace(/[^a-z0-9]/g, "");
  if (!house || key.length < 4 || !/^[A-Za-z][\w]*$/.test(field)) return "";
  return `UPPER(${field}) LIKE '${house} ${key.toUpperCase()}%'`;
}

async function arcgisQuery(url, params) {
  const q = new URLSearchParams({ f: "json", returnGeometry: "false", resultRecordCount: "4", ...params });
  const { body } = await httpGet(`${url}?${q}`, 12000);
  const data = JSON.parse(body || "{}");
  if (data.error) return [];
  return (data.features || []).map((f) => f.attributes).filter(Boolean);
}

function chooseRow(rows, layer, pin) {
  for (const row of rows) {
    const hit = layer.pick(row);
    if (!hit.name && !hit.mail) continue;
    if (!parcelMatchesPin(pin, hit.situs)) continue;
    return hit;
  }
  return null;
}

async function queryLayer(layer, lat, lon, pin) {
  const point = {
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: layer.outFields,
  };
  let rows = await arcgisQuery(layer.url, point);
  let hit = chooseRow(rows, layer, pin);
  if (hit) return hit;
  rows = await arcgisQuery(layer.url, { ...point, distance: "25", units: "esriSRUnit_Meter" });
  hit = chooseRow(rows, layer, pin);
  if (hit) return hit;
  const where = addressWhere(layer.situsField, pin);
  if (!where) return null;
  rows = await arcgisQuery(layer.url, { where, outFields: layer.outFields });
  return chooseRow(rows, layer, pin);
}

export async function lookupAssessorParcel(lat, lon, address = "") {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const y = Number(lat);
  const x = Number(lon);
  const pin = parseStreetAddress(address);
  const layers = LAYERS.filter((l) => inBbox(y, x, l));
  if (!layers.length) return null;
  const hits = await Promise.all(layers.map((l) => queryLayer(l, y, x, pin).catch(() => null)));
  return hits.find(Boolean) || null;
}
