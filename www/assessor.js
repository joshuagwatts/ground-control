/** County assessor parcel lookup — owner of record and mailing address for a pin. */
import { httpGet } from "./net.js";
import { parseStreetAddress, sameHouse, streetKey } from "./contacts.js";

const LAYERS = [
  {
    id: "ok-county",
    source: "Oklahoma County",
    south: 35.32,
    north: 35.73,
    west: -97.68,
    east: -97.12,
    url: "https://services8.arcgis.com/euhkr1dAJeQBIjV0/arcgis/rest/services/TaxParcelsPublics_view/FeatureServer/0/query",
    situsField: "location",
    outFields:
      "name1,name2,name3,mailingaddress1,city,state,zipcode,location,locationcity,accountno,propertyid",
    href: (row) => {
      const id = attr(row, "propertyid");
      return id
        ? `https://docs.oklahomacounty.org/AssessorWP5/AN-R.asp?PropertyID=${encodeURIComponent(id)}`
        : "https://docs.oklahomacounty.org/AssessorWP5/DefaultSearch.asp";
    },
  },
  {
    id: "cleveland",
    source: "Cleveland County",
    south: 34.98,
    north: 35.4,
    west: -97.55,
    east: -97.12,
    url: "https://gis.clevelandcounty.com/arcgis/rest/services/Basemap/Basemap/FeatureServer/2/query",
    situsField: "LOCATE_ADDRESS",
    outFields:
      "GIS_Owner1,GIS_Owner2,COUNTY_OWNER_1,COUNTY_OWNER_2,COUNTY_MAILING_ADDRESS,COUNTY_ADDRESS,LOCATE_ADDRESS,COUNTY_CITY,COUNTY_STATE,COUNTY_ZIP,GIS_PID",
    href: () => "https://www.clevelandcountyassessor.us/",
  },
  {
    id: "okc-tricounty",
    source: "Oklahoma City GIS",
    south: 34.95,
    north: 35.78,
    west: -98.45,
    east: -97.05,
    url: "https://gis.okc.gov/arcgis/rest/services/Public/EncodeOKCWebMap2/MapServer/8/query",
    situsField: "Address",
    outFields:
      "Owner_Name1,Owner_Name2,Address,City,Mail_Address1,Mail_Address2,Mail_City,Mail_State,Mail_Zipcode,PARCEL_HYPERLINK,Owner_Occ,Jurisdiction",
    href: (row) => attr(row, "PARCEL_HYPERLINK"),
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
    href: () => "https://www.assessor.tulsacounty.org/",
  },
  {
    id: "creek",
    source: "Creek County",
    south: 35.7,
    north: 36.22,
    west: -96.72,
    east: -95.95,
    url: "https://map11.incog.org/arcgis11wa/rest/services/Parcels_CreekCo/FeatureServer/0/query",
    situsField: "situs",
    outFields: "ownername,address1,address2,citystate,zipcode,situs,homestead,account",
    href: () => "https://www.creekcountyonline.com/",
  },
  {
    id: "osage",
    source: "Osage County",
    south: 36.16,
    north: 36.72,
    west: -96.9,
    east: -95.97,
    url: "https://map11.incog.org/arcgis11wa/rest/services/Parcels_OsageCo/FeatureServer/0/query",
    situsField: "AdrLabel",
    outFields:
      "OwnerName,MailingAd1,MailingAd2,MailingCty,MailingSt,MailingZip,AdrLabel,AdrNum,PreDir,PstrNam,PstrType,AdrCity",
    href: () => "https://www.osagecounty-ok.gov/",
  },
  {
    id: "rogers",
    source: "Rogers County",
    south: 36.1,
    north: 36.55,
    west: -95.9,
    east: -95.3,
    url: "https://map11.incog.org/arcgis11wa/rest/services/Parcels_RogersCo/FeatureServer/0/query",
    situsField: "SITUS",
    outFields: "OWNERSNAM,SITUS,ACCOUNT",
    href: () => "https://www.rogerscounty.org/assessor",
  },
  {
    id: "wagoner",
    source: "Wagoner County",
    south: 35.75,
    north: 36.15,
    west: -95.85,
    east: -95.25,
    url: "https://map11.incog.org/arcgis11wa/rest/services/Parcels_WagonerCo/FeatureServer/0/query",
    situsField: "Situs",
    outFields: "OwnersName,Situs,Address1,Address2,City,State,ZipCode,MailingInf",
    href: () => "https://www.wagonercounty.ok.gov/",
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

function splitCityState(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?)[,\s]+([A-Z]{2})$/i);
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
  return { city: s, state: "" };
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

export function pickParcel(row, layer = {}) {
  const cs = splitCityState(attr(row, "citystate"));
  const name = formatOwnerName(
    joinNames(
      attr(
        row,
        "name1",
        "Owner_Name1",
        "COUNTY_OWNER_1",
        "GIS_Owner1",
        "ownername",
        "OwnerName",
        "OwnersName",
        "OWNERSNAM",
        "Owner",
        "Name1",
      ),
      attr(row, "name2", "Owner_Name2", "COUNTY_OWNER_2", "GIS_Owner2", "Name2"),
      attr(row, "name3"),
    ),
  );
  const situsNum = attr(row, "AdrNum");
  const situsFromParts = [situsNum, attr(row, "PreDir"), attr(row, "PstrNam"), attr(row, "PstrType"), attr(row, "AdrCity")]
    .filter(Boolean)
    .join(" ");
  const situs = attr(
    row,
    "location",
    "LOCATE_ADDRESS",
    "COUNTY_ADDRESS",
    "Address",
    "PropertyAddress",
    "situs",
    "Situs",
    "SITUS",
    "AdrLabel",
  ) || situsFromParts;
  const city = attr(row, "city", "City", "Mail_City", "MailingCty", "COUNTY_CITY", "PropertyCity") || cs.city;
  const state = attr(row, "state", "State", "Mail_State", "MailingSt", "COUNTY_STATE") || cs.state;
  const zip = attr(row, "zipcode", "ZIPCode", "ZipCode", "Mail_Zipcode", "MailingZip", "COUNTY_ZIP");
  const packedMail = attr(row, "MailingAdd", "MailingInf", "COUNTY_MAILING_ADDRESS");
  let mail = packedMail;
  if (packedMail && !/\b[A-Z]{2}\b.+\d{5}/i.test(packedMail)) {
    const csz = formatMailing("", city, state, zip);
    const head = /^(po|p\.o\.?)/i.test(packedMail)
      ? packedMail.toUpperCase().replace(/\s+/g, " ")
      : formatOwnerName(packedMail);
    mail = [head, csz].filter(Boolean).join(", ");
  }
  if (!mail) {
    mail = formatMailing(
      attr(row, "mailingaddress1", "Mail_Address1", "Address1", "address1", "MailingAd1"),
      city,
      state,
      zip,
      attr(row, "Mail_Address2", "Address2", "address2", "MailingAd2"),
    );
  }
  const occ = attr(row, "Owner_Occ", "HomesteadExemption", "homestead", "Homestead");
  const href = typeof layer.href === "function" ? layer.href(row) : "";
  return {
    name,
    situs,
    mail,
    url: /^https?:\/\//i.test(href) ? href : String(layer.fallbackUrl || href || ""),
    source: layer.source || "",
    homestead: /^(y|yes|1|true|o|owner|h|homestead)$/i.test(occ) || (Number(occ) > 0 && Number(occ) < 9),
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
    const hit = pickParcel(row, layer);
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
