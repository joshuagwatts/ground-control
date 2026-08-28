import fs from "fs";

const path = new URL("../www/app.js", import.meta.url);
let s = fs.readFileSync(path, "utf8");

function mustReplace(label, old, neu) {
  if (s.includes(neu.trim().slice(0, 40))) return;
  const next = s.replace(old, neu);
  if (next === s) throw new Error(`${label} not found`);
  s = next;
}

mustReplace(
  "import getHailBottomTier",
  "  advanceHailBottomReveal,\r\n  syncHailBottomChrome,",
  "  advanceHailBottomReveal,\r\n  getHailBottomTier,\r\n  syncHailBottomChrome,",
);

mustReplace(
  "loadDoneAddresses auto",
  `async function loadDoneAddresses() {\r\n  if (doneBusy) return;\r\n  const text = $("#hs-done-text")?.value ?? db.done?.text ?? "";\r\n  const parsed = parseDoneList(text);\r\n  if (!parsed.length) {\r\n    setStatus("Paste completed addresses first");\r\n    return;\r\n  }`,
  `function needsDoneGeocode() {\r\n  const text = (db.done?.text || "").trim();\r\n  if (!text) return false;\r\n  const parsed = parseDoneList(text);\r\n  if (!parsed.length) return false;\r\n  const houses = doneHouses();\r\n  if (houses.length !== parsed.length) return true;\r\n  return houses.some((h) => !Number.isFinite(Number(h.lat)));\r\n}\r\n\r\nasync function ensureDoneHousesOnMap() {\r\n  if (doneBusy) return;\r\n  if (!needsDoneGeocode()) {\r\n    if (doneHouses().some((h) => Number.isFinite(Number(h.lat)))) paintFieldMap();\r\n    return;\r\n  }\r\n  await loadDoneAddresses({ auto: true });\r\n}\r\n\r\nasync function loadDoneAddresses({ auto = false } = {}) {\r\n  if (doneBusy) return;\r\n  const text = ($("#hs-done-text")?.value ?? db.done?.text ?? "").trim();\r\n  const parsed = parseDoneList(text);\r\n  if (!parsed.length) {\r\n    if (!auto) setStatus("Paste completed addresses first");\r\n    return;\r\n  }`,
);

mustReplace(
  "finishWxBoot ensure",
  `    if (Number.isFinite(center.lat) && Number.isFinite(center.lon)) {\r\n      flyToPin(center.lat, center.lon, undefined, { stay: true });\r\n    }\r\n  } catch (e) {`,
  `    if (Number.isFinite(center.lat) && Number.isFinite(center.lon)) {\r\n      flyToPin(center.lat, center.lon, undefined, { stay: true });\r\n    }\r\n    void ensureDoneHousesOnMap();\r\n  } catch (e) {`,
);

mustReplace(
  "renderWx live",
  `    syncHailBottomChrome();\n    if (!wxPinSelected()) revealHailAddressPeek();\n    setStatus("");\n    return;\n  }`,
  `    syncHailBottomChrome();\n    if (!wxPinSelected() && getHailBottomTier() === "hidden") setWxMapExpanded(true);\n    void ensureDoneHousesOnMap();\n    setStatus("");\n    return;\n  }`,
);

mustReplace(
  "renderWx mount ensure",
  `    syncHailBottomChrome();\n    setWxMapExpanded(true);\n    refreshMapSize();\n    void finishWxBoot(gen);`,
  `    syncHailBottomChrome();\n    setWxMapExpanded(true);\n    refreshMapSize();\n    void ensureDoneHousesOnMap();\n    void finishWxBoot(gen);`,
);

fs.writeFileSync(path, s);
console.log("ok", s.includes("ensureDoneHousesOnMap"), s.includes("getHailBottomTier"));
