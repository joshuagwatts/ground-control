/** Shingle catalog — manufacturers, lines, colors, discontinued flags.
 * Lens may ONLY assert a product that matches this list uniquely.
 * Visual tells are field cues, not proof by themselves.
 */

function C(names, extra = {}) {
  return names.map((n) => (typeof n === "string" ? { name: n, ...extra } : { ...extra, ...n }));
}

export const SHOTS = [
  {
    id: "granules_close",
    label: "Granule close-up",
    how: "Fill the frame with the color blend. Get close enough to see individual granules.",
    why: "Color blend, granule size, ceramic-coated vs painted, algae-resistant copper specks",
    need: ["color", "manufacturer"],
  },
  {
    id: "tab_pattern",
    label: "Full tab",
    how: "One whole tab and the cutout, square to the camera. No extreme angle.",
    why: "3-tab vs laminate vs designer; cutout shape; overlay drop",
    need: ["construction", "product"],
  },
  {
    id: "overlay_shadow",
    label: "Overlay and shadow line",
    how: "Step back a little. Show how the overlay drops and the shadow line runs.",
    why: "Timberline dual-shadow vs OC Duration vs Landmark overlay geometry",
    need: ["product", "manufacturer"],
  },
  {
    id: "nailing_strip",
    label: "Nailing strip",
    how: "Lift a tab or shoot an exposed strip. Look for pink SureNail, DuraGrip, or a plant stamp.",
    why: "OC SureNail pink/coral strip, GAF Dura Grip, CT oversize zone, plant stamps",
    need: ["manufacturer", "product"],
  },
  {
    id: "thickness_edge",
    label: "Edge / thickness",
    how: "Shoot the butt edge so you can see layers and thickness.",
    why: "Single-layer 3-tab vs laminated dual-layer vs designer thickness",
    need: ["construction"],
  },
  {
    id: "backstamp",
    label: "Back stamp / date code",
    how: "If you have a loose shingle, shoot the back stamp. This is the only honest date.",
    why: "Plant, week/year, brand mold — the only honest path to an exact date",
    need: ["date", "manufacturer"],
  },
  {
    id: "wrapper",
    label: "Bundle wrapper",
    how: "Garage, attic, leftover bundle — printed product, color, lot, date.",
    why: "Printed product, color, lot, date — gold standard if leftover in garage/attic",
    need: ["date", "product", "color", "manufacturer"],
  },
  {
    id: "slope_context",
    label: "Slope context",
    how: "A few feet back. Show the field, weathering, and how many layers if you can.",
    why: "Install era, weathering pattern, hip/ridge, how many layers",
    need: ["era"],
  },
  {
    id: "ridge_cap",
    label: "Hip / ridge cap",
    how: "The cap along the hip or ridge. Often a branded piece.",
    why: "Often a branded cap (Seal-A-Ridge, Duration hip, Landmark hip)",
    need: ["manufacturer"],
  },
];

/** Required sequence before Lens will try to name a product. */
export const SHINGLE_CORE = ["granules_close", "tab_pattern", "overlay_shadow", "nailing_strip"];
export const SHINGLE_EXTRA = ["thickness_edge", "slope_context", "backstamp", "wrapper", "ridge_cap"];

export const CONSTRUCTIONS = ["3-tab", "architectural laminate", "designer", "luxury designer", "metal", "tile", "slate", "wood", "other"];

export const MAKERS = [
  {
    id: "gaf",
    name: "GAF",
    aliases: ["gaf", "elk", "gaf-elk"],
    lines: [
      {
        id: "timberline-hdz",
        name: "Timberline HDZ",
        kind: "architectural laminate",
        years: [2020, null],
        discontinued: false,
        replaces: "timberline-hd",
        tells: ["LayerLock", "dual shadow line", "Dura Grip nailing area"],
        colors: C([
          "Charcoal",
          "Weathered Wood",
          "Hickory",
          "Shakewood",
          "Barkwood",
          "Pewter Gray",
          "Slate",
          "Hunter Green",
          "Patriot Red",
          "Birchwood",
          "Fox Hollow Gray",
          "Mission Brown",
          "Oyster Gray",
          "Biscayne Blue",
          "Williamsburg Slate",
        ]),
      },
      {
        id: "timberline-hd",
        name: "Timberline HD",
        kind: "architectural laminate",
        years: [2006, 2021],
        discontinued: true,
        replaced_by: "timberline-hdz",
        mailerShort: "GAF HD",
        tells: ["pre-LayerLock Timberline", "dual shadow", "no HDZ badge"],
        colors: C(
          ["Charcoal", "Weathered Wood", "Hickory", "Shakewood", "Barkwood", "Slate", "Hunter Green", "Patriot Red", "Birchwood"],
          { discontinued: true },
        ),
      },
      {
        id: "timberline-uhdz",
        name: "Timberline UHDZ",
        kind: "architectural laminate",
        years: [2021, null],
        discontinued: false,
        tells: ["thicker than HDZ", "ultra dual shadow"],
        colors: C(["Charcoal", "Weathered Wood", "Barkwood", "Hickory", "Pewter Gray", "Slate"]),
      },
      {
        id: "timberline-ns",
        name: "Timberline Natural Shadow",
        kind: "architectural laminate",
        years: [2004, null],
        discontinued: false,
        tells: ["softer shadow blend than HDZ"],
        colors: C(["Weathered Wood", "Charcoal", "Barkwood", "Hickory", "Slate", { name: "Golden Amber", discontinued: true }]),
      },
      {
        id: "royal-sovereign",
        name: "Royal Sovereign",
        kind: "3-tab",
        years: [1964, null],
        discontinued: false,
        tells: ["single layer", "cutouts between tabs", "thin edge"],
        colors: C(["Charcoal", "Weathered Gray", "Autumn Brown", "Silver Lining", "Nickel Gray"]),
      },
      {
        id: "grand-sequoia",
        name: "Grand Sequoia",
        kind: "designer",
        years: [2001, null],
        discontinued: false,
        tells: ["oversized designer tabs", "wood-shake look"],
        colors: C(["Charcoal", "Weathered Wood", "Mission Brown", "Dusky Gray", "Cedar"]),
      },
      {
        id: "camelot-ii",
        name: "Camelot II",
        kind: "luxury designer",
        years: [2012, null],
        discontinued: false,
        tells: ["sculpted designer", "slate-like cuts"],
        colors: C(["Antique Slate", "Charcoal", "Weathered Wood", "Royal Slate"]),
      },
      {
        id: "camelot",
        name: "Camelot",
        kind: "luxury designer",
        years: [2003, 2014],
        discontinued: true,
        replaced_by: "camelot-ii",
        mailerShort: "CAMELOT",
        tells: ["original Camelot cut", "pre-II"],
        colors: C(["Antique Slate", "Charcoal", "Weathered Wood"], { discontinued: true }),
      },
      {
        id: "slateline",
        name: "Slateline",
        kind: "designer",
        years: [1995, null],
        discontinued: false,
        tells: ["slate-look laminate", "wide tabs"],
        colors: C(["Antique Slate", "English Gray Slate", "Weathered Slate", "Royal Slate"]),
      },
      {
        id: "woodland",
        name: "Woodland",
        kind: "designer",
        years: [2016, null],
        discontinued: false,
        tells: ["wood-shake designer"],
        colors: C(["Cedar", "Driftwood", "Chestnut", "Weathered Wood"]),
      },
    ],
  },
  {
    id: "owens-corning",
    name: "Owens Corning",
    aliases: ["owens corning", "oc", "owens-corning", "trudefinition"],
    lines: [
      {
        id: "duration",
        name: "Duration",
        kind: "architectural laminate",
        years: [2009, null],
        discontinued: false,
        tells: ["SureNail pink/coral nailing strip", "TruDefinition color", "wide nailing zone"],
        colors: C([
          "Estate Gray",
          "Driftwood",
          "Brownwood",
          "Onyx Black",
          "Teak",
          "Sierra Gray",
          "Quarry Gray",
          "Amber",
          "Chateau Green",
          "Desert Tan",
          "Williamsburg Gray",
          "Colonial Slate",
        ]),
      },
      {
        id: "duration-flex",
        name: "Duration FLEX",
        kind: "architectural laminate",
        years: [2018, null],
        discontinued: false,
        tells: ["SureNail", "FLEX impact rating printed on wrapper"],
        colors: C(["Estate Gray", "Driftwood", "Onyx Black", "Brownwood", "Teak"]),
      },
      {
        id: "oakridge",
        name: "Oakridge",
        kind: "architectural laminate",
        years: [1992, null],
        discontinued: false,
        tells: ["NO SureNail strip", "standard laminate nailing", "TruDefinition on newer runs"],
        colors: C(["Estate Gray", "Driftwood", "Brownwood", "Onyx Black", "Teak", "Sierra Gray", "Desert Tan", "Chateau Green"]),
      },
      {
        id: "supreme",
        name: "Supreme",
        kind: "3-tab",
        years: [1977, null],
        discontinued: false,
        tells: ["3-tab cutouts", "single layer", "OC plant stamp on back"],
        colors: C(["Estate Gray", "Driftwood", "Brownwood", "Onyx Black", "Desert Tan"]),
      },
      {
        id: "berkshire",
        name: "Berkshire",
        kind: "luxury designer",
        years: [2005, null],
        discontinued: false,
        tells: ["designer slate-look", "thick overlay"],
        colors: C(["Colonial Slate", "Harvard Slate", "Carbon", "Shadow"]),
      },
      {
        id: "woodcrest",
        name: "Woodcrest",
        kind: "designer",
        years: [2001, null],
        discontinued: false,
        tells: ["shake-look designer"],
        colors: C(["Driftwood", "Teak", "Brownwood", "Estate Gray"]),
      },
      {
        id: "duration-cool",
        name: "Duration COOL",
        kind: "architectural laminate",
        years: [2011, 2020],
        discontinued: true,
        replaced_by: "duration",
        mailerShort: "OC COOL",
        tells: ["SureNail", "cool-roof color line now folded into Duration"],
        colors: C(["White", "Sandcastle", "Surf"], { discontinued: true }),
      },
    ],
  },
  {
    id: "certainteed",
    name: "CertainTeed",
    aliases: ["certainteed", "certain teed", "ct", "saint-gobain"],
    lines: [
      {
        id: "landmark",
        name: "Landmark",
        kind: "architectural laminate",
        years: [1995, null],
        discontinued: false,
        tells: ["Max Def color", "oversize nailing area", "CT nail zone print"],
        colors: C([
          "Moire Black",
          "Weathered Wood",
          "Burnt Sienna",
          "Georgetown Gray",
          "Resawn Shake",
          "Colonial Slate",
          "Cobblestone Gray",
          "Heather Blend",
          "Hunter Green",
          "Granite Gray",
        ]),
      },
      {
        id: "landmark-pro",
        name: "Landmark Pro",
        kind: "architectural laminate",
        years: [2008, null],
        discontinued: false,
        tells: ["thicker than Landmark", "Max Def", "StreakFighter"],
        colors: C(["Moire Black", "Weathered Wood", "Burnt Sienna", "Georgetown Gray", "Resawn Shake", "Colonial Slate"]),
      },
      {
        id: "landmark-premium",
        name: "Landmark Premium",
        kind: "architectural laminate",
        years: [2014, null],
        discontinued: false,
        tells: ["highest Landmark weight", "Max Def"],
        colors: C(["Moire Black", "Weathered Wood", "Georgetown Gray", "Burnt Sienna", "Colonial Slate"]),
      },
      {
        id: "xt25",
        name: "XT 25",
        kind: "3-tab",
        years: [1980, null],
        discontinued: false,
        tells: ["3-tab", "CT backstamp"],
        colors: C(["Moire Black", "Weathered Wood", "Nickel Gray", "Burnt Sienna"]),
      },
      {
        id: "presidential-shake",
        name: "Presidential Shake",
        kind: "luxury designer",
        years: [1997, null],
        discontinued: false,
        tells: ["two-piece designer", "wood-shake silhouette"],
        colors: C(["Weathered Wood", "Charcoal Black", "Autumn Blend", "Shadow Gray", "Chestnut"]),
      },
      {
        id: "presidential-tl",
        name: "Presidential Shake TL",
        kind: "luxury designer",
        years: [2004, null],
        discontinued: false,
        tells: ["triple-layer Presidential"],
        colors: C(["Weathered Wood", "Charcoal Black", "Autumn Blend", "Shadow Gray"]),
      },
      {
        id: "independence",
        name: "Independence",
        kind: "architectural laminate",
        years: [1988, 2012],
        discontinued: true,
        replaced_by: "landmark",
        mailerShort: "INDEP",
        tells: ["older CT laminate", "pre-Landmark overlay"],
        colors: C(["Weathered Wood", "Moire Black", "Burnt Sienna", "Colonial Slate"], { discontinued: true }),
      },
      {
        id: "hatteras",
        name: "Hatteras",
        kind: "designer",
        years: [1999, 2016],
        discontinued: true,
        replaced_by: "landmark-pro",
        mailerShort: "HATTRS",
        tells: ["discontinued CT designer"],
        colors: C(["Weathered Wood", "Moire Black", "Colonial Slate"], { discontinued: true }),
      },
      {
        id: "grand-manor",
        name: "Grand Manor",
        kind: "luxury designer",
        years: [1995, null],
        discontinued: false,
        tells: ["super-heavy designer", "slate/shake hybrid"],
        colors: C(["Gatehouse Slate", "Brownstone", "Stonegate Gray", "Sherwood Forest"]),
      },
      {
        id: "belmont",
        name: "Belmont",
        kind: "luxury designer",
        years: [2004, null],
        discontinued: false,
        mailer: true,
        mailerShort: "BELMONT",
        tells: ["CT slate-look luxury", "large 18x36 tab", "8 inch exposure"],
        colors: C(["Weathered Wood", "Moire Black", "Colonial Slate", "Heather Blend", "Gatehouse Slate"]),
      },
    ],
  },
  {
    id: "tamko",
    name: "TAMKO",
    aliases: ["tamko", "tamko building products"],
    lines: [
      {
        id: "heritage",
        name: "Heritage",
        kind: "architectural laminate",
        years: [1994, null],
        discontinued: false,
        tells: ["TAMKO backstamp", "laminate overlay", "no SureNail"],
        colors: C(["Antique Wood", "Thunderstorm Grey", "Oxford Grey", "Rustic Black", "Weathered Wood", "Natural Timber", "Olde English Pewter"]),
      },
      {
        id: "heritage-vintage",
        name: "Heritage Vintage",
        kind: "designer",
        years: [2008, null],
        discontinued: false,
        tells: ["vintage cut designer"],
        colors: C(["Antique Wood", "Rustic Black", "Weathered Wood", "Thunderstorm Grey"]),
      },
      {
        id: "elite-glass-seal",
        name: "Elite Glass-Seal",
        kind: "3-tab",
        years: [1976, null],
        discontinued: false,
        tells: ["3-tab TAMKO", "Glass-Seal"],
        colors: C(["Antique Wood", "Oxford Grey", "Rustic Black", "Weathered Wood"]),
      },
      {
        id: "titan-xt",
        name: "Titan XT",
        kind: "architectural laminate",
        years: [2016, null],
        discontinued: false,
        tells: ["impact-rated TAMKO laminate"],
        colors: C(["Antique Wood", "Thunderstorm Grey", "Rustic Black", "Oxford Grey"]),
      },
    ],
  },
  {
    id: "atlas",
    name: "Atlas",
    aliases: ["atlas", "atlas roofing"],
    lines: [
      {
        id: "pinnacle-pristine",
        name: "Pinnacle Pristine",
        kind: "architectural laminate",
        years: [2013, null],
        discontinued: false,
        tells: ["Scotchgard algae", "Atlas laminate"],
        colors: C(["Pewter", "Black Bark", "Weathered Wood", "Burnt Sienna", "Desert Shake", "Pristine Black", "Storm Gray"]),
      },
      {
        id: "stormmaster-shake",
        name: "StormMaster Shake",
        kind: "designer",
        years: [2010, null],
        discontinued: false,
        tells: ["impact designer shake"],
        colors: C(["Weathered Wood", "Black Bark", "Pewter", "Desert Shake"]),
      },
      {
        id: "glassmaster",
        name: "GlassMaster",
        kind: "3-tab",
        years: [1980, 2018],
        discontinued: true,
        replaced_by: "pinnacle-pristine",
        mailerShort: "ATLAS",
        tells: ["Atlas 3-tab", "discontinued in most markets"],
        colors: C(["Weathered Wood", "Black", "Gray"], { discontinued: true }),
      },
    ],
  },
  {
    id: "iko",
    name: "IKO",
    aliases: ["iko"],
    lines: [
      {
        id: "cambridge",
        name: "Cambridge",
        kind: "architectural laminate",
        years: [1995, null],
        discontinued: false,
        tells: ["IKO laminate", "ArmourZone on newer"],
        colors: C(["Dual Black", "Weatherwood", "Harvard Slate", "Driftwood", "Dual Gray", "Earthtone Cedar", "Charcoal Grey"]),
      },
      {
        id: "dynasty",
        name: "Dynasty",
        kind: "architectural laminate",
        years: [2012, null],
        discontinued: false,
        tells: ["ArmourZone nailing", "thicker Cambridge-class"],
        colors: C(["Granite Black", "Cornerstone", "Shadow Brown", "Pacific Drift", "Appalachian"]),
      },
      {
        id: "marathon",
        name: "Marathon",
        kind: "3-tab",
        years: [1979, null],
        discontinued: false,
        tells: ["IKO 3-tab"],
        colors: C(["Dual Black", "Weatherwood", "Dual Gray"]),
      },
      {
        id: "armourshake",
        name: "Armourshake",
        kind: "designer",
        years: [2006, null],
        discontinued: false,
        tells: ["shake-look IKO designer"],
        colors: C(["Shadow Black", "Weatherwood", "Granite"]),
      },
    ],
  },
  {
    id: "malarkey",
    name: "Malarkey",
    aliases: ["malarkey", "nze"],
    lines: [
      {
        id: "highlander",
        name: "Highlander",
        kind: "architectural laminate",
        years: [2004, null],
        discontinued: false,
        tells: ["rubberized asphalt", "NZE", "Scotchgard"],
        colors: C(["Black Oak", "Weathered Wood", "Storm Grey", "Natural Wood", "Slate"]),
      },
      {
        id: "vista",
        name: "Vista",
        kind: "architectural laminate",
        years: [2010, null],
        discontinued: false,
        tells: ["Malarkey mid laminate"],
        colors: C(["Black Oak", "Weathered Wood", "Storm Grey"]),
      },
      {
        id: "legacy",
        name: "Legacy",
        kind: "designer",
        years: [2006, null],
        discontinued: false,
        tells: ["thicker Malarkey designer"],
        colors: C(["Black Oak", "Weathered Wood", "Midnight Black", "Natural Wood"]),
      },
      {
        id: "windsor",
        name: "Windsor",
        kind: "luxury designer",
        years: [2014, null],
        discontinued: false,
        tells: ["luxury Malarkey"],
        colors: C(["Midnight Black", "Storm Grey", "Weathered Wood"]),
      },
    ],
  },
  {
    id: "pabco",
    name: "PABCO",
    aliases: ["pabco"],
    lines: [
      {
        id: "premier",
        name: "Premier",
        kind: "architectural laminate",
        years: [1998, null],
        discontinued: false,
        tells: ["West-coast PABCO laminate"],
        colors: C(["Charcoal", "Weathered Wood", "Barkwood", "Slate Blend", "Forest Green"]),
      },
      {
        id: "paramount",
        name: "Paramount Advantage",
        kind: "architectural laminate",
        years: [2012, null],
        discontinued: false,
        tells: ["PABCO thicker laminate"],
        colors: C(["Charcoal", "Weathered Wood", "Slate Blend"]),
      },
    ],
  },
];

export const KNOW = 0.92;
export const NARROW = 0.72;

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function allRows() {
  const rows = [];
  for (const maker of MAKERS) {
    for (const line of maker.lines) {
      for (const color of line.colors || [{ name: "" }]) {
        rows.push({
          makerId: maker.id,
          maker: maker.name,
          aliases: maker.aliases,
          lineId: line.id,
          line: line.name,
          kind: line.kind,
          years: line.years,
          discontinued: Boolean(line.discontinued || color.discontinued),
          lineDiscontinued: Boolean(line.discontinued),
          colorDiscontinued: Boolean(color.discontinued),
          replacedBy: line.replaced_by || "",
          tells: line.tells || [],
          color: color.name || "",
        });
      }
    }
  }
  return rows;
}

function scoreName(needle, hay, aliases = []) {
  const n = norm(needle);
  if (!n || n === "unknown" || n === "unsure") return 0;
  let best = 0;
  for (const cand of [hay, ...aliases]) {
    const h = norm(cand);
    if (!h) continue;
    if (n === h) return 1;
    const nt = n.split(" ").filter(Boolean);
    const ht = h.split(" ").filter(Boolean);
    const hset = new Set(ht);
    const nset = new Set(nt);
    if (nt.every((t) => hset.has(t)) && ht.every((t) => nset.has(t))) {
      best = Math.max(best, 0.98);
      continue;
    }
    // Require at least two shared tokens so "HD" cannot swallow "HDZ".
    if (nt.length >= 2 && nt.every((t) => hset.has(t))) best = Math.max(best, 0.86);
    if (ht.length >= 2 && ht.every((t) => nset.has(t))) best = Math.max(best, 0.86);
  }
  return best;
}

/** Match a vision guess against the catalog. Unique high match required to KNOW. */
export function matchCatalog({ manufacturer = "", product = "", color = "" } = {}) {
  const rows = allRows();
  const scored = rows.map((r) => {
    const m = scoreName(manufacturer, r.maker, r.aliases);
    const p = scoreName(product, r.line, [r.lineId, r.line.replace(/shingles?/i, "")]);
    const c = color ? scoreName(color, r.color, []) : 0;
    const score = m * 0.45 + p * 0.4 + (color ? c * 0.15 : 0);
    return { ...r, score, m, p, c };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  const uniqueLine =
    top &&
    top.m >= 0.88 &&
    top.p >= 0.88 &&
    !scored.some((r) => r !== top && r.m >= 0.88 && r.p >= 0.88 && (r.maker !== top.maker || r.line !== top.line) && Math.abs(r.score - top.score) < 0.08);
  const colorUnique = Boolean(uniqueLine && top.c >= 0.88);
  return {
    top: top && top.score >= 0.5 ? top : null,
    unique: Boolean(uniqueLine),
    colorUnique,
    candidates: scored.filter((r) => r.score >= 0.55).slice(0, 8),
  };
}

export function discontinuedFor(makerId, lineId = "") {
  return allRows().filter((r) => r.discontinued && (!makerId || r.makerId === makerId) && (!lineId || r.lineId === lineId));
}

const MAKER_TINT = {
  gaf: "#f97316",
  atlas: "#c4b5fd",
  certainteed: "#67e8f9",
  "owens-corning": "#fb7185",
  tamko: "#fbbf24",
};

function lineShort(maker, line) {
  if (line.mailerShort) return String(line.mailerShort).slice(0, 10);
  const n = String(line.name || "").replace(/shingles?/i, "").trim();
  if (n.length <= 8) return n.toUpperCase();
  return n.slice(0, 8).toUpperCase();
}

/** Drive-by mailer chips: discontinued lines plus anything flagged mailer (e.g. Belmont). */
export function mailerProducts() {
  const out = [];
  for (const maker of MAKERS) {
    for (const line of maker.lines || []) {
      if (!line.discontinued && !line.mailer) continue;
      out.push({
        id: `${maker.id}-${line.id}`,
        makerId: maker.id,
        maker: maker.name,
        lineId: line.id,
        line: line.name,
        short: lineShort(maker, line),
        label: `${maker.name} ${line.name}`,
        discontinued: Boolean(line.discontinued),
        color: MAKER_TINT[maker.id] || "#fb923c",
      });
    }
  }
  return out;
}

export function mailerProduct(id) {
  const key = String(id || "");
  if (!key) return null;
  return mailerProducts().find((p) => p.id === key) || null;
}

export function yearRange(years) {
  if (!years) return "";
  const [a, b] = years;
  if (a && b) return `${a}–${b}`;
  if (a && !b) return `${a}–present`;
  return "";
}

/**
 * Certainty gate. Vision guesses are evidence, not answers.
 * KNOW is only returned when catalog uniquely matches AND confidence + shots are enough.
 */
export function gateVerdict(analysis, photoCount, shotIds = []) {
  const shots = new Set(shotIds);
  const has = (id) => shots.has(id);
  const n = Number(photoCount) || 0;
  const a = analysis || {};
  const field = (k) => {
    const x = a[k] || {};
    return { value: String(x.value || "").trim(), conf: Number(x.conf) || 0 };
  };
  const construction = field("construction");
  const manufacturer = field("manufacturer");
  const product = field("product");
  const color = field("color");
  const dateCode = field("date_code");
  const era = field("era");

  const needed = [];
  const pushShot = (id) => {
    const spec = SHOTS.find((s) => s.id === id);
    if (spec && !has(id) && !needed.some((x) => x.id === id)) needed.push({ id, label: spec.label, why: spec.how || spec.why });
  };

  for (const id of SHINGLE_CORE) {
    if (!has(id)) pushShot(id);
  }
  if (n < SHINGLE_CORE.length) {
    for (const id of SHINGLE_CORE) pushShot(id);
  }
  if (color.conf < KNOW) pushShot("granules_close");
  if (dateCode.conf < KNOW) {
    pushShot("backstamp");
    pushShot("wrapper");
  }

  const hit = matchCatalog({
    manufacturer: manufacturer.value,
    product: product.value,
    color: color.value,
  });

  const invented =
    (manufacturer.value && manufacturer.conf >= NARROW && !hit.top) ||
    (product.value && product.conf >= NARROW && hit.top && hit.top.p < 0.7);

  const coreIn =
    has("granules_close") &&
    has("tab_pattern") &&
    has("overlay_shadow") &&
    (has("nailing_strip") || has("wrapper")) &&
    n >= SHINGLE_CORE.length;
  const knowMaker = manufacturer.conf >= KNOW && hit.top && hit.top.m >= 0.88 && coreIn;
  const knowLine = knowMaker && product.conf >= KNOW && hit.unique;
  const knowColor = knowLine && color.conf >= KNOW && hit.colorUnique && has("granules_close");
  const knowDate = dateCode.conf >= KNOW && (has("backstamp") || has("wrapper")) && String(dateCode.value).match(/\d{4}|\b\d{1,2}\/\d{2,4}\b|\bweek\s*\d+/i);

  let status = "NEED_SHOTS";
  if (invented) status = "NEED_SHOTS";
  else if (knowLine && (knowColor || !color.value || color.conf < NARROW)) {
    status = knowColor || knowDate ? "KNOW" : "NARROWED";
    if (knowLine && knowColor) status = "KNOW";
    else if (knowLine && !color.value) status = "NARROWED";
  } else if (knowMaker || (hit.top && manufacturer.conf >= NARROW && coreIn)) {
    status = "NARROWED";
  } else {
    status = "NEED_SHOTS";
  }

  // Color-only KNOW is not allowed without line. Date-only KNOW is not a product ID.
  if (status === "KNOW" && !knowLine) status = "NARROWED";
  if (status === "KNOW" && invented) status = "NEED_SHOTS";

  const known = {
    construction: construction.conf >= KNOW ? construction.value : "",
    manufacturer: knowMaker ? hit.top.maker : "",
    product: knowLine ? hit.top.line : "",
    color: knowColor ? hit.top.color : "",
    date: knowDate ? dateCode.value : "",
    discontinued: knowLine ? hit.top.discontinued : null,
    replacedBy: knowLine && hit.top.replacedBy ? replacedLineName(hit.top.replacedBy) : "",
    years: knowLine ? yearRange(hit.top.years) : "",
  };

  const narrowed = {
    construction: construction.conf >= NARROW ? construction.value : "",
    manufacturer: hit.top && hit.top.m >= NARROW ? hit.top.maker : "",
    product: hit.top && hit.top.p >= NARROW ? hit.top.line : "",
    color: hit.top && hit.top.c >= NARROW ? hit.top.color : "",
    candidates: (hit.candidates || []).slice(0, 5).map((c) => ({
      maker: c.maker,
      line: c.line,
      color: c.color,
      discontinued: c.discontinued,
      years: yearRange(c.years),
    })),
  };

  if (status === "KNOW") needed.length = 0;
  if (status === "NARROWED" && knowLine && !knowColor) {
    needed.length = 0;
    pushShot("granules_close");
    if (!has("wrapper")) pushShot("wrapper");
  }

  return {
    status,
    known,
    narrowed,
    needed,
    invented: Boolean(invented),
    catalog: hit,
    knowMaker,
    knowLine,
    knowColor,
    knowDate,
  };
}

function replacedLineName(id) {
  for (const m of MAKERS) {
    const line = m.lines.find((l) => l.id === id);
    if (line) return `${m.name} ${line.name}`;
  }
  return id;
}

export function catalogBrief() {
  return MAKERS.map((m) => {
    const lines = m.lines
      .map((l) => {
        const flag = l.discontinued ? " DISCONTINUED" : "";
        const yrs = yearRange(l.years);
        const cols = (l.colors || []).map((c) => c.name + (c.discontinued ? " (disc.)" : "")).join(", ");
        return `  - ${l.name}${flag} [${l.kind}] ${yrs}\n    colors: ${cols}\n    tells: ${(l.tells || []).join("; ")}`;
      })
      .join("\n");
    return `${m.name}:\n${lines}`;
  }).join("\n\n");
}

export function nextShotPrompt(needed) {
  if (!needed.length) return "";
  const first = needed[0];
  return `Need ${first.label}. ${first.why}. Do not name a product until that shot is in.`;
}
