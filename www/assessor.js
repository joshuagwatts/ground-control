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
      "name1,name2,name3,mailingaddress1,city,state,zipcode,location,locationcity,accountno,propertyid,saledate,SalePrice,legal,landvalue,currentmarket,currentassessed,subname",
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
    id: "tulsa",
    source: "Tulsa County",
    south: 35.85,
    north: 36.45,
    west: -96.3,
    east: -95.52,
    url: "https://map11.incog.org/arcgis11wa/rest/services/Parcels_TulsaCo/FeatureServer/0/query",
    situsField: "PropertyAddress",
    outFields:
      "Owner,Name1,Name2,PropertyAddress,PropertyCity,Address1,Address2,City,State,ZIPCode,HomesteadExemption,YearBuilt,YearRemodeled,BuiltAsSF,Baths,SaleDate,SalePrice,TotalImpValue,TotalLandValue,TotalAcctValue",
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

function numVal(raw) {
  const n = Number(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function yearVal(raw) {
  const n = numVal(raw);
  if (n >= 1800 && n <= 2100) return Math.round(n);
  const m = String(raw || "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : 0;
}

function moneyVal(raw) {
  const n = numVal(raw);
  return n >= 100 ? n : 0;
}

/** GIS row → building / sale / valuation facts (public assessor record). */
export function pickBuildingFacts(row = {}) {
  const yearBuilt = yearVal(
    attr(row, "YearBuilt", "Year_Built", "YEAR_BUILT", "yearbuilt", "BuiltYear"),
  );
  const yearRemodel = yearVal(
    attr(row, "YearRemodeled", "Year_Remodel", "YEAR_REMODELED", "yearremodeled"),
  );
  const sqft = numVal(
    attr(row, "BuiltAsSF", "Gross_SqFt", "SQFT", "LIVING_AREA", "Floor_SqFt", "GrossSqFt"),
  );
  const beds = numVal(attr(row, "Bed_Count", "Bedrooms", "Beds"));
  const baths = numVal(attr(row, "Bath_Count", "Baths", "Bathrooms"));
  const saleDate = attr(row, "SaleDate", "saledate", "Sale_Date", "RecordedDate");
  const salePrice = moneyVal(attr(row, "SalePrice", "saleprice", "Sale_Price"));
  const marketValue = moneyVal(
    attr(row, "currentmarket", "Market_Value", "TotalAcctValue", "TotalAcctValue"),
  );
  const assessedValue = moneyVal(
    attr(row, "currentassessed", "Assessed_Value", "TaxableValue", "NetAssessed"),
  );
  const landValue = moneyVal(attr(row, "landvalue", "TotalLandValue", "Land_Value"));
  const impValue = moneyVal(attr(row, "TotalImpValue", "Improvement_Value", "COUNTY_BUILDING_VALUE"));
  const legal = attr(row, "legal", "Legal_Desc", "LEGAL");
  const subdivision = attr(row, "subname", "Subdivision");
  const construction = attr(row, "Construction_Type", "BuiltAsOccCode", "OCCDesc", "CLUDesc");
  return {
    year_built: yearBuilt,
    year_remodel: yearRemodel,
    sqft,
    beds,
    baths,
    sale_date: saleDate,
    sale_price: salePrice,
    market_value: marketValue,
    assessed_value: assessedValue,
    land_value: landValue,
    improvement_value: impValue,
    legal,
    subdivision,
    construction,
  };
}

/** Human-readable one-liner for pin UI. */
export function formatAssessorRecordLine(assessor = {}) {
  const b = assessor.building || {};
  const parts = [];
  if (b.year_built) parts.push(`Built ${b.year_built}`);
  if (b.year_remodel && b.year_remodel !== b.year_built) parts.push(`Remodeled ${b.year_remodel}`);
  if (b.sqft) parts.push(`${b.sqft.toLocaleString()} sf`);
  if (b.beds) parts.push(`${b.beds} bed`);
  if (b.baths) parts.push(`${b.baths} bath`);
  if (b.construction) parts.push(String(b.construction).replace(/\s+/g, " ").trim());
  if (b.sale_date || b.sale_price) {
    const saleBits = [];
    if (b.sale_date) saleBits.push(String(b.sale_date).trim());
    if (b.sale_price) saleBits.push(`$${Math.round(b.sale_price).toLocaleString()}`);
    parts.push(`Sale ${saleBits.join(" · ")}`);
  }
  if (b.market_value) parts.push(`Market $${Math.round(b.market_value).toLocaleString()}`);
  if (Array.isArray(assessor.permits) && assessor.permits.length) {
    const p = assessor.permits[0];
    const plab = [p.date, p.number, p.description].filter(Boolean).join(" ");
    if (plab) parts.push(`Permit ${plab}`);
  }
  if (b.subdivision && parts.length < 4) parts.push(b.subdivision);
  return parts.slice(0, 6).join(" · ");
}

/** Parse Oklahoma County assessor card HTML — buildings + permit history. */
export function parseOkCountyAssessorHtml(html = "") {
  const blob = String(html || "");
  const buildings = [];
  const permits = [];
  const cells = [...blob.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (let i = 0; i < cells.length - 3; i++) {
    if (!/^(Vacant|Improved)$/i.test(cells[i])) continue;
    const status = cells[i];
    let description = "";
    let year = 0;
    let sqft = 0;
    let stories = 0;
    for (let j = i + 1; j < Math.min(i + 8, cells.length); j++) {
      const c = cells[j];
      if (/^(19|20)\d{2}$/.test(c)) {
        year = Number(c);
        continue;
      }
      if (/^\d{1,3}$/.test(c) && !sqft && year) {
        sqft = Number(c);
        continue;
      }
      if (/^\d+\s*Stories?$/i.test(c)) {
        stories = Number(c) || 0;
        break;
      }
      if (!description && c.length > 3 && !/^(Vacant|Improved|\d+)$/.test(c)) description = c;
    }
    if (year || sqft) {
      buildings.push({ status, description, year_built: year, sqft, stories });
    }
  }
  for (let i = 0; i < cells.length - 2; i++) {
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cells[i])) continue;
    const number = cells[i + 1] || "";
    if (!/^[A-Z0-9-]{4,}$/i.test(number)) continue;
    let description = cells[i + 2] || "";
    let costIdx = i + 3;
    if (/^\d{1,2}$/.test(description)) {
      description = cells[i + 3] || "";
      costIdx = i + 4;
    }
    if (/^(Inactive|Active|Issued|Permit|EDMOND|Commercial)$/i.test(description)) continue;
    permits.push({
      date: cells[i],
      number,
      description,
      cost: numVal(String(cells[costIdx] || "").replace(/,/g, "")),
      status: String(cells[costIdx + 1] || "").trim(),
    });
  }
  return { buildings, permits };
}

function mergeBuildingFacts(base = {}, extra = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v == null || v === "" || v === 0) continue;
    if (!out[k] || out[k] === 0) out[k] = v;
  }
  return out;
}

/** Fetch OK County assessor card for building + permit tables. */
export async function enrichAssessorPublicRecord(assessor) {
  if (!assessor?.url || !/oklahomacounty\.org/i.test(assessor.url)) return assessor;
  try {
    const { body } = await httpGet(assessor.url, 12000);
    const parsed = parseOkCountyAssessorHtml(body || "");
    const building = mergeBuildingFacts(assessor.building || {}, {});
    const top = parsed.buildings[0];
    if (top) {
      if (top.year_built) building.year_built = top.year_built;
      if (top.sqft) building.sqft = top.sqft;
      if (top.stories) building.stories = top.stories;
      if (top.description) building.construction = top.description;
    }
    const permits = parsed.permits.length ? parsed.permits.slice(0, 4) : assessor.permits || [];
    const next = { ...assessor, building, permits };
    next.record_line = formatAssessorRecordLine(next);
    next.public_text = [
      formatAssessorRecordLine(next),
      permits.map((p) => [p.date, p.number, p.description, p.cost ? `$${p.cost}` : ""].filter(Boolean).join(" ")).join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
    return next;
  } catch {
    return assessor;
  }
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
  const building = pickBuildingFacts(row);
  const base = {
    name,
    situs,
    mail,
    url: /^https?:\/\//i.test(href) ? href : String(layer.fallbackUrl || href || ""),
    source: layer.source || "",
    homestead: /^(y|yes|1|true|o|owner|h|homestead)$/i.test(occ) || (Number(occ) > 0 && Number(occ) < 9),
    building,
    permits: [],
    record_line: formatAssessorRecordLine({ building, permits: [] }),
  };
  return base;
}

function inBbox(lat, lon, layer) {
  return lat >= layer.south && lat <= layer.north && lon >= layer.west && lon <= layer.east;
}

function addressWhere(field, parts) {
  const house = String(parts.house || "").replace(/[^0-9A-Za-z]/g, "");
  const key = streetKey(parts.street).replace(/[^a-z0-9]/g, "");
  if (!house || key.length < 3 || !/^[A-Za-z][\w]*$/.test(field)) return "";
  // Wildcard before the street key so directional prefixes match ("1122 N BOULEVARD ST").
  return `UPPER(${field}) LIKE '${house} %${key.toUpperCase()}%'`;
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
  let hit = hits.find(Boolean) || null;
  if (!hit) return null;
  if (hit.url && /oklahomacounty\.org/i.test(hit.url)) {
    hit = await enrichAssessorPublicRecord(hit);
  } else if (!hit.record_line) {
    hit.record_line = formatAssessorRecordLine(hit);
  }
  return hit;
}
