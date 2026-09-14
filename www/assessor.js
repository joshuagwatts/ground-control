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
      "name1,name2,name3,mailingaddress1,city,state,zipcode,location,locationcity,accountno,propertyid,saledate,SalePrice,legal,landvalue,currentmarket,currentassessed,subname,accttype,acres",
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
      "GIS_Owner1,GIS_Owner2,COUNTY_OWNER_1,COUNTY_OWNER_2,COUNTY_MAILING_ADDRESS,COUNTY_ADDRESS,LOCATE_ADDRESS,COUNTY_CITY,COUNTY_STATE,COUNTY_ZIP,GIS_PID,COUNTY_LAND_VALUE,COUNTY_BUILDING_VALUE,COUNTY_TOTAL_VALUE,COUNTY_ACRES",
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
      "Owner,Name1,Name2,PropertyAddress,PropertyCity,Address1,Address2,City,State,ZIPCode,HomesteadExemption,YearBuilt,YearRemodeled,BuiltAsSF,Baths,SaleDate,SalePrice,TotalImpValue,TotalLandValue,TotalAcctValue,Exterior,Foundation,Quality,Condition,Stories,GrossSF,AcctType",
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
  if (sameHouse(pin, site)) return true;
  if (pin.house === site.house) {
    const pKey = streetKey(pin.street);
    const blob = String(situs || "").toLowerCase();
    if (pKey && pKey.length >= 3 && blob.includes(pKey)) return true;
  }
  return false;
}

function numVal(raw) {
  const n = Number(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function stripHtml(s) {
  return String(s || "")
    .replace(/&#189;/gi, "½")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHtmlTables(html) {
  const tables = [];
  const blobs = String(html || "").match(/<table\b[\s\S]*?<\/table>/gi) || [];
  for (const blob of blobs) {
    const rows = [];
    for (const rowM of blob.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells = [...rowM[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripHtml(c[1]));
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push({ caption: stripHtml(blob).slice(0, 80), rows });
  }
  return tables;
}

function labeledValues(html) {
  const text = String(html || "")
    .replace(/&#189;/gi, "½")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " | ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
  const out = {};
  const re = /([A-Za-z#][A-Za-z0-9 #/().-]{2,40}?)\s*:\s*(?:\|\s*)+([^|]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[1].replace(/\s+/g, " ").trim().toLowerCase();
    const val = m[2].replace(/\s+/g, " ").trim();
    if (!key || !val || val === ":" || /^[A-Za-z#].{0,40}:$/.test(val)) continue;
    if (!out[key]) out[key] = val;
  }
  return out;
}

function grabLabel(labels, ...names) {
  for (const n of names) {
    const v = labels[String(n).toLowerCase()];
    if (v) return v;
  }
  return "";
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
    attr(row, "BuiltAsSF", "GrossSF", "Gross_SqFt", "SQFT", "LIVING_AREA", "Floor_SqFt", "GrossSqFt"),
  );
  const beds = numVal(attr(row, "Bed_Count", "Bedrooms", "Beds"));
  const baths = numVal(attr(row, "Bath_Count", "Baths", "Bathrooms"));
  const stories = numVal(attr(row, "Stories", "StoryHeight", "stories"));
  const saleDate = attr(row, "SaleDate", "saledate", "Sale_Date", "RecordedDate");
  const salePrice = moneyVal(attr(row, "SalePrice", "saleprice", "Sale_Price"));
  const marketValue = moneyVal(
    attr(row, "currentmarket", "Market_Value", "TotalAcctValue", "COUNTY_TOTAL_VALUE"),
  );
  const assessedValue = moneyVal(
    attr(row, "currentassessed", "Assessed_Value", "TaxableValue", "NetAssessed"),
  );
  const landValue = moneyVal(attr(row, "landvalue", "TotalLandValue", "Land_Value", "COUNTY_LAND_VALUE"));
  const impValue = moneyVal(attr(row, "TotalImpValue", "Improvement_Value", "COUNTY_BUILDING_VALUE"));
  const legal = attr(row, "legal", "Legal_Desc", "LEGAL");
  const subdivision = attr(row, "subname", "Subdivision", "Neighborhood");
  const construction = attr(row, "Construction_Type", "BuiltAsOccCode", "OCCDesc", "CLUDesc");
  const acres = numVal(attr(row, "acres", "COUNTY_ACRES", "GIS_Deeded_Acres", "GrossAcre"));
  return {
    year_built: yearBuilt,
    year_remodel: yearRemodel,
    sqft,
    beds,
    baths,
    stories,
    sale_date: saleDate,
    sale_price: salePrice,
    market_value: marketValue,
    assessed_value: assessedValue,
    land_value: landValue,
    improvement_value: impValue,
    legal,
    subdivision,
    construction,
    acres,
    exterior: attr(row, "Exterior", "Bldg Exterior"),
    foundation: attr(row, "Foundation"),
    quality: attr(row, "Quality"),
    condition: attr(row, "Condition"),
    roof_cover: attr(row, "RoofCover", "Roof Cover"),
    roof_type: attr(row, "RoofType", "Roof Type"),
    hvac: attr(row, "HVAC", "HVAC Type"),
    acct_type: attr(row, "accttype", "AcctType", "PAR_TYPE"),
  };
}

export function ownerEntityKind(name) {
  const s = String(name || "");
  if (/CITY OF|COUNTY OF|UNITED STATES|POSTAL SERVICE|SCHOOL DIST|BOARD OF EDUC|CHURCH|STATE OF/i.test(s)) {
    return "public";
  }
  if (/\bLLC\b|L\.L\.C/i.test(s)) return "llc";
  if (/\bTRUST\b|\bTRS\b|REV TR/i.test(s)) return "trust";
  if (/\bINC\b|\bCORP\b|COMPANY|HOLDINGS|INVESTMENT/i.test(s)) return "corp";
  return "person";
}

export function mailingLooksAbsentee(mail, situs) {
  const m = String(mail || "").replace(/\s+/g, " ").trim();
  const s = String(situs || "").replace(/\s+/g, " ").trim();
  if (!m) return false;
  if (/po box|p\.o\.?\s*box/i.test(m)) return true;
  const mailParts = parseStreetAddress(m);
  const siteParts = parseStreetAddress(s);
  if (mailParts.house && siteParts.house) {
    if (mailParts.house === siteParts.house) {
      const mKey = streetKey(mailParts.street);
      const siteBlob = `${siteParts.street} ${siteParts.city} ${s}`.toLowerCase();
      if (mKey && siteBlob.includes(mKey)) return false;
      if (sameHouse(mailParts, siteParts)) return false;
    } else {
      return true;
    }
  }
  const mailCity = streetKey(mailParts.city);
  const siteCity = streetKey(siteParts.city);
  if (mailCity && siteCity && mailCity !== siteCity) return true;
  if (mailCity && mailCity.length >= 4 && !s.toLowerCase().includes(mailCity) && mailCity !== siteCity) return true;
  return false;
}

export function isRoofPermit(p = {}) {
  return /roof|shingle|hail|reroof|re-roof|comp\b|tear.?off|gutter/i.test(`${p.description || ""} ${p.number || ""}`);
}

export function formatRoofPermitLine(permits = []) {
  const list = Array.isArray(permits) ? permits : [];
  const roof = list.filter(isRoofPermit);
  const pick = (roof.length ? roof : list).slice(0, 2);
  return pick
    .map((p) => [p.date, p.description || p.number].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" · ");
}

/** Human-readable one-liner for pin UI. */
export function formatAssessorRecordLine(assessor = {}) {
  const b = assessor.building || {};
  const parts = [];
  const roof = [b.roof_cover, b.roof_type].map((s) => String(s || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (roof.length) parts.push(roof.join(" · "));
  if (b.year_built) parts.push(`Built ${b.year_built}`);
  if (b.year_remodel && b.year_remodel !== b.year_built) parts.push(`Remodeled ${b.year_remodel}`);
  if (b.sqft) parts.push(`${Number(b.sqft).toLocaleString()} sf`);
  if (b.stories) parts.push(`${b.stories} story`);
  if (b.beds) parts.push(`${b.beds} bed`);
  if (b.baths) parts.push(`${b.baths} bath`);
  if (b.exterior) parts.push(String(b.exterior).replace(/\s+/g, " ").trim());
  if (b.condition) parts.push(String(b.condition).replace(/\s+/g, " ").trim());
  if (b.construction && parts.length < 6) parts.push(String(b.construction).replace(/\s+/g, " ").trim());
  if (b.sale_date || b.sale_price) {
    const saleBits = [];
    if (b.sale_date) saleBits.push(String(b.sale_date).trim());
    if (b.sale_price) saleBits.push(`$${Math.round(b.sale_price).toLocaleString()}`);
    parts.push(`Sale ${saleBits.join(" · ")}`);
  }
  if (b.market_value) parts.push(`Market $${Math.round(b.market_value).toLocaleString()}`);
  const roofLine = formatRoofPermitLine(assessor.permits);
  if (roofLine) parts.push((assessor.permits || []).some(isRoofPermit) ? `Roof ${roofLine}` : `Permit ${roofLine}`);
  if (b.subdivision && parts.length < 5) parts.push(b.subdivision);
  return parts.slice(0, 8).join(" · ");
}

function headerIndex(headers, ...names) {
  const norm = headers.map((h) => String(h || "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim());
  for (const name of names) {
    const want = String(name).toLowerCase();
    const i = norm.findIndex((h) => h === want || h.includes(want));
    if (i >= 0) return i;
  }
  return -1;
}

function parsePermitTable(tables) {
  const out = [];
  for (const t of tables) {
    let headers = null;
    let start = 0;
    for (let i = 0; i < t.rows.length; i++) {
      if (headerIndex(t.rows[i], "permit #") >= 0 && headerIndex(t.rows[i], "issued", "date") >= 0) {
        headers = t.rows[i];
        start = i + 1;
        break;
      }
    }
    if (!headers) continue;
    const iDate = headerIndex(headers, "issued", "date");
    const iNum = headerIndex(headers, "permit #", "permit");
    const iDesc = headerIndex(headers, "description");
    const iCost = headerIndex(headers, "est construction cost", "cost");
    const iStatus = headerIndex(headers, "status");
    for (const row of t.rows.slice(start)) {
      const date = row[iDate] || "";
      if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(date)) continue;
      const number = row[iNum] || "";
      if (!/^[A-Z0-9-]{3,}$/i.test(number)) continue;
      out.push({
        date,
        number,
        description: (iDesc >= 0 ? row[iDesc] : "") || "",
        cost: iCost >= 0 ? numVal(row[iCost]) : 0,
        status: iStatus >= 0 ? row[iStatus] || "" : "",
      });
    }
  }
  return out;
}

function parseBuildingTable(tables) {
  const out = [];
  for (const t of tables) {
    let headers = null;
    let start = 0;
    for (let i = 0; i < t.rows.length; i++) {
      if (headerIndex(t.rows[i], "year built") >= 0 && headerIndex(t.rows[i], "sqft", "sq ft") >= 0) {
        headers = t.rows[i];
        start = i + 1;
        break;
      }
    }
    if (!headers) continue;
    const iStatus = headerIndex(headers, "vacant/improved land", "vacant");
    const iDesc = headerIndex(headers, "bldg description", "description");
    const iYear = headerIndex(headers, "year built");
    const iSqft = headerIndex(headers, "sqft", "sq ft");
    const iStories = headerIndex(headers, "# stories", "stories");
    for (const row of t.rows.slice(start)) {
      const year = iYear >= 0 ? yearVal(row[iYear]) : 0;
      const sqft = iSqft >= 0 ? numVal(row[iSqft]) : 0;
      if (!year && !sqft) continue;
      if (/year built/i.test(row[iYear] || "")) continue;
      out.push({
        status: iStatus >= 0 ? row[iStatus] || "" : "",
        description: iDesc >= 0 ? row[iDesc] || "" : "",
        year_built: year,
        sqft,
        stories: iStories >= 0 ? numVal(row[iStories]) : 0,
      });
    }
  }
  return out;
}

/** Parse Oklahoma County assessor card HTML — buildings + permit history. */
export function parseOkCountyAssessorHtml(html = "") {
  const tables = extractHtmlTables(html);
  let buildings = parseBuildingTable(tables);
  let permits = parsePermitTable(tables);
  if (buildings.length || permits.length) return { buildings, permits };

  const blob = String(html || "");
  const cells = [...blob.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter(Boolean);
  buildings = [];
  permits = [];
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
      if (/^[\d,]+$/.test(c) && !sqft && year) {
        sqft = numVal(c);
        continue;
      }
      if (/\dstories?/i.test(c)) {
        stories = numVal(c);
        break;
      }
      if (!description && c.length > 3 && !/^(Vacant|Improved|\d+)$/.test(c)) description = c;
    }
    if (year || sqft) buildings.push({ status, description, year_built: year, sqft, stories });
  }
  for (let i = 0; i < cells.length - 2; i++) {
    if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cells[i])) continue;
    const number = cells[i + 1] || "";
    if (!/^[A-Z0-9-]{4,}$/i.test(number)) continue;
    let description = cells[i + 2] || "";
    let costIdx = i + 3;
    if (/^(EDMOND|OKC|OKLAHOMA CITY|TULSA|MOORE|NORMAN|YUKON|MIDWEST CITY)$/i.test(description)) {
      if (/^\d{1,2}$/.test(cells[i + 3] || "")) {
        description = cells[i + 4] || "";
        costIdx = i + 5;
      } else {
        description = cells[i + 3] || "";
        costIdx = i + 4;
      }
    } else if (/^\d{1,2}$/.test(description)) {
      description = cells[i + 3] || "";
      costIdx = i + 4;
    }
    if (/^(Inactive|Active|Issued|Permit)$/i.test(description)) continue;
    permits.push({
      date: cells[i],
      number,
      description,
      cost: numVal(cells[costIdx] || ""),
      status: String(cells[costIdx + 1] || "").trim(),
    });
  }
  return { buildings, permits };
}

export function parseOkCountyBuildingDetailHtml(html = "") {
  const labels = labeledValues(html);
  const bathsRaw = grabLabel(labels, "# of baths", "baths");
  const bedsRaw = grabLabel(labels, "# of units w/bedrooms", "bedrooms");
  const bedHit = String(bedsRaw).match(/(\d+)\s*bed/i);
  return {
    roof_cover: grabLabel(labels, "roof cover"),
    roof_type: grabLabel(labels, "roof type"),
    exterior: grabLabel(labels, "bldg exterior"),
    foundation: grabLabel(labels, "foundation desc"),
    quality: grabLabel(labels, "quality desc"),
    condition: grabLabel(labels, "physical condition"),
    construction: grabLabel(labels, "built as"),
    year_built: yearVal(grabLabel(labels, "year built")),
    year_remodel: yearVal(grabLabel(labels, "remodel year")),
    sqft: numVal(grabLabel(labels, "square feet")),
    stories: numVal(grabLabel(labels, "# of stories")),
    hvac: grabLabel(labels, "hvac type"),
    baths: (() => {
      const n = numVal(bathsRaw);
      return n >= 1 && n <= 20 ? n : 0;
    })(),
    beds: bedHit ? Number(bedHit[1]) : 0,
  };
}

function mergeBuildingFacts(base = {}, extra = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v == null || v === "" || v === 0) continue;
    if (!out[k] || out[k] === 0) out[k] = v;
  }
  return out;
}

function okCountyPropertyId(url) {
  const m = String(url || "").match(/PropertyID=(\d+)/i);
  return m ? m[1] : "";
}

function finishAssessor(hit) {
  if (!hit) return hit;
  hit.record_line = formatAssessorRecordLine(hit);
  hit.roof_permits = formatRoofPermitLine(hit.permits);
  hit.absentee = mailingLooksAbsentee(hit.mail, hit.situs);
  hit.owner_kind = ownerEntityKind(hit.name);
  hit.acct_type = hit.acct_type || hit.building?.acct_type || "";
  hit.public_text = [
    hit.record_line,
    hit.absentee && hit.mail ? `Mailing ${hit.mail}` : "",
    (hit.permits || [])
      .map((p) => [p.date, p.number, p.description, p.cost ? `$${p.cost}` : ""].filter(Boolean).join(" "))
      .join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
  return hit;
}

/** Fetch OK County assessor card + building detail for roof / remodel / permits. */
export async function enrichAssessorPublicRecord(assessor) {
  if (!assessor?.url || !/oklahomacounty\.org/i.test(assessor.url)) return finishAssessor(assessor);
  const pid = okCountyPropertyId(assessor.url);
  const bldgUrl = pid
    ? `https://docs.oklahomacounty.org/AssessorWP5/BLDG_Detail.asp?PropertyID=${encodeURIComponent(pid)}&BuildingSequence=1`
    : "";
  try {
    const [cardHit, bldgHit] = await Promise.all([
      httpGet(assessor.url, 12000).catch(() => null),
      bldgUrl ? httpGet(bldgUrl, 12000).catch(() => null) : Promise.resolve(null),
    ]);
    const parsed = parseOkCountyAssessorHtml(cardHit?.body || "");
    let building = { ...(assessor.building || {}) };
    const top = parsed.buildings[0];
    if (top) {
      building = mergeBuildingFacts(building, {
        year_built: top.year_built,
        sqft: top.sqft,
        stories: top.stories,
        construction: top.description,
      });
    }
    if (bldgHit?.body) {
      building = mergeBuildingFacts(building, parseOkCountyBuildingDetailHtml(bldgHit.body));
    }
    const permits = parsed.permits.length ? parsed.permits.slice(0, 6) : assessor.permits || [];
    return finishAssessor({ ...assessor, building, permits, building_url: bldgUrl || "" });
  } catch {
    return finishAssessor(assessor);
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
  return finishAssessor({
    name,
    situs,
    mail,
    url: /^https?:\/\//i.test(href) ? href : String(layer.fallbackUrl || href || ""),
    source: layer.source || "",
    homestead: /^(y|yes|1|true|o|owner|h|homestead)$/i.test(occ) || (Number(occ) > 0 && Number(occ) < 9),
    building,
    permits: [],
    acct_type: building.acct_type || attr(row, "accttype", "AcctType", "PAR_TYPE"),
    account: attr(row, "accountno", "account", "AccountNo", "ACCOUNT"),
  });
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
  rows = await arcgisQuery(layer.url, { ...point, distance: "80", units: "esriSRUnit_Meter" });
  hit = chooseRow(rows, layer, pin);
  if (hit) return hit;
  const where = addressWhere(layer.situsField, pin);
  if (!where) return null;
  rows = await arcgisQuery(layer.url, { where, outFields: layer.outFields });
  return chooseRow(rows, layer, pin);
}

export async function lookupAssessorParcel(lat, lon, address = "", { enrich = true } = {}) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const y = Number(lat);
  const x = Number(lon);
  const pin = parseStreetAddress(address);
  const layers = LAYERS.filter((l) => inBbox(y, x, l));
  if (!layers.length) return null;
  const hits = await Promise.all(layers.map((l) => queryLayer(l, y, x, pin).catch(() => null)));
  let hit = hits.find(Boolean) || null;
  if (!hit) return null;
  hit = finishAssessor(hit);
  if (enrich && hit.url && /oklahomacounty\.org/i.test(hit.url)) {
    hit = await enrichAssessorPublicRecord(hit);
  }
  return hit;
}
