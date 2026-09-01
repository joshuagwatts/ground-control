import {
  parseStormDay,
  calendarWeeks,
  renderStormCalendar,
  defaultCalendarMonth,
  HAIL_EXTREME_IN,
  HAIL_PIN_CALENDAR_IN,
} from "../www/hail-calendar.js";
import {
  collapseHailByDate,
  hailCalendarHighlightDays,
  setWxPin,
  clearWxPin,
} from "../www/wx.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

assert(parseStormDay("2024-05-15") === "2024-05-15", "iso day");
assert(parseStormDay("2024-05-15T18:30:00Z") === "2024-05-15", "iso datetime");
assert(parseStormDay("202405151230") === "2024-05-15", "compact SWDI ZTIME");
assert(parseStormDay("2024/05/15 12:30") === "2024-05-15", "slash date");
assert(parseStormDay("") === "", "empty");

const weeks = calendarWeeks(2024, 4);
assert(weeks.length >= 4 && weeks[0].length === 7, "may 2024 grid");
const mayFifteen = weeks.flat().find((c) => c.inMonth && c.day === 15);
assert(mayFifteen?.iso === "2024-05-15", "may 15 cell");

const html = renderStormCalendar({
  year: 2024,
  month: 4,
  highlightDays: new Set(["2024-05-15"]),
  selectedDays: new Set(["2024-05-15"]),
  esc: (s) => String(s),
});
assert(/hs-cal-hail/.test(html) && /2024-05-15/.test(html), "render highlights");

const def = defaultCalendarMonth(new Set(["2023-08-02", "2024-05-15"]));
assert(def.year === 2024 && def.month === 4, "default month from latest hail");

const compactRow = {
  date: "2024051512",
  lat: 35.47,
  lon: -97.52,
  size_in: "1.25",
  source: "noaa-swdi-radar",
  distance_km: 1,
};
const [collapsed] = collapseHailByDate([compactRow]);
assert(collapsed?.date === "2024-05-15", `compact row collapses to calendar day, got ${collapsed?.date}`);

setWxPin(35.467, -97.516);
const pinData = {
  lat: 35.467,
  lon: -97.516,
  hail: [
    {
      date: "2026-05-15",
      lat: 35.468,
      lon: -97.516,
      size_in: "1.25",
      source: "iem-lsr",
      distance_km: 0.2,
    },
    {
      date: "2026-06-01",
      lat: 35.55,
      lon: -97.516,
      size_in: "2.50",
      source: "noaa-swdi-radar",
      distance_km: 8,
    },
  ],
};
const pinDays = hailCalendarHighlightDays(pinData, { viewport: false });
assert(pinDays.has("2026-05-15"), "pin calendar includes ≥1″ at roof");
assert(!pinDays.has("2026-06-01"), "pin calendar skips far 2.5″ day");

const vpData = {
  viewport: true,
  hail: [
    { date: "2026-05-15", lat: 35.47, lon: -97.52, size_in: "2.25", source: "noaa-spc", distance_km: 2 },
    { date: "2026-06-01", lat: 35.47, lon: -97.52, size_in: "1.25", source: "noaa-spc", distance_km: 2 },
  ],
};
const vpDays = hailCalendarHighlightDays(vpData, { viewport: true });
assert(vpDays.has("2026-05-15"), "map view extreme day");
assert(!vpDays.has("2026-06-01"), "map view skips sub-extreme");

assert(HAIL_EXTREME_IN === 2 && HAIL_PIN_CALENDAR_IN === 1, "threshold constants");

console.log("hail-calendar ok");
