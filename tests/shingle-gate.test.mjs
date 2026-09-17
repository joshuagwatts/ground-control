import { gateVerdict, matchCatalog, discontinuedFor } from "../www/catalog.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const onePhoto = gateVerdict(
  {
    manufacturer: { value: "GAF", conf: 0.99 },
    product: { value: "Timberline HDZ", conf: 0.99 },
    color: { value: "Charcoal", conf: 0.99 },
  },
  1,
  ["granules_close"],
);
assert(onePhoto.status === "NEED_SHOTS", `one photo must not KNOW, got ${onePhoto.status}`);

const guessNotInCatalog = gateVerdict(
  {
    manufacturer: { value: "FakeRoofCo", conf: 0.99 },
    product: { value: "MagicShingle 9000", conf: 0.99 },
    color: { value: "Unicorn", conf: 0.99 },
  },
  4,
  ["granules_close", "tab_pattern", "overlay_shadow", "nailing_strip"],
);
assert(guessNotInCatalog.status !== "KNOW", "invented product must not KNOW");
assert(guessNotInCatalog.invented, "invented flag");

const durationNoStrip = gateVerdict(
  {
    construction: { value: "architectural laminate", conf: 0.95 },
    manufacturer: { value: "Owens Corning", conf: 0.8 },
    product: { value: "Duration", conf: 0.7 },
    color: { value: "Estate Gray", conf: 0.7 },
  },
  3,
  ["granules_close", "tab_pattern"],
);
assert(durationNoStrip.status !== "KNOW", "Duration without SureNail shot must not KNOW");

const locked = gateVerdict(
  {
    construction: { value: "architectural laminate", conf: 0.96 },
    manufacturer: { value: "GAF", conf: 0.96 },
    product: { value: "Timberline HDZ", conf: 0.95 },
    color: { value: "Charcoal", conf: 0.95 },
  },
  4,
  ["granules_close", "tab_pattern", "overlay_shadow", "nailing_strip"],
);
assert(locked.status === "KNOW", `unique catalog + shots should KNOW, got ${locked.status}`);
assert(locked.known.manufacturer === "GAF", "maker");
assert(locked.known.product === "Timberline HDZ", "line");
assert(locked.known.color === "Charcoal", "color");
assert(!locked.known.date, "date still unproven");
assert(locked.pct === 95, `product lock is 95, got ${locked.pct}`);
assert(onePhoto.pct < 95, `one photo must stay under 95, got ${onePhoto.pct}`);
assert(guessNotInCatalog.pct < 30, "invented name stays low on the meter");

const disc = matchCatalog({ manufacturer: "GAF", product: "Timberline HD", color: "Charcoal" });
assert(disc.top && disc.top.discontinued, "Timberline HD is discontinued");

const hd = gateVerdict(
  {
    manufacturer: { value: "GAF", conf: 0.96 },
    product: { value: "Timberline HD", conf: 0.95 },
    color: { value: "Charcoal", conf: 0.95 },
  },
  4,
  ["granules_close", "tab_pattern", "wrapper", "overlay_shadow"],
);
assert(hd.status === "KNOW", "discontinued HD can KNOW");
assert(hd.known.discontinued === true, "discontinued flag on KNOW");
assert(/HDZ/i.test(hd.known.replacedBy), "points at HDZ");

assert(discontinuedFor("gaf").length > 0, "GAF discontinued rows exist");

const dated = gateVerdict(
  {
    manufacturer: { value: "GAF", conf: 0.96 },
    product: { value: "Timberline HDZ", conf: 0.95 },
    color: { value: "Charcoal", conf: 0.95 },
    date_code: { value: "W12 2019", conf: 0.97 },
  },
  5,
  ["granules_close", "tab_pattern", "overlay_shadow", "backstamp", "wrapper"],
);
assert(dated.knowDate, "date code + backstamp/wrapper is KNOW date");
assert(dated.known.date === "W12 2019", "date value");
assert(dated.pct === 100, `date lock is 100, got ${dated.pct}`);

const wrapperLowConf = gateVerdict(
  {
    manufacturer: { value: "GAF", conf: 0.58 },
    product: { value: "Timberline HDZ", conf: 0.55 },
    color: { value: "Charcoal", conf: 0.52 },
  },
  5,
  ["granules_close", "tab_pattern", "overlay_shadow", "nailing_strip", "wrapper"],
);
assert(wrapperLowConf.pct >= 78, `wrapper branding should raise meter above 34, got ${wrapperLowConf.pct}`);

console.log("shingle-gate ok");
