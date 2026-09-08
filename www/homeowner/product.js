/**
 * HomeScope product rules (locked from product answers).
 * Field Ground Control must not import this file.
 */

export const PRODUCT = {
  name: "HomeScope",
  path: "/ground-control/homeowner/",
  geography: "Oklahoma",
  brand: {
    company: "High Ground",
    tagline: "Roofing & Construction",
    phone: "(405) 252-0058",
    phoneTel: "+14052520058",
    web: "https://www.highgroundokc.com/",
    webLabel: "highgroundokc.com",
    /** Service area only — do not invent a street address on reports. */
    address: "Edmond, OK & surrounding",
    cta: "Get a Free Inspection",
    ctaUrl: "https://www.highgroundokc.com/",
  },
  disclaimer:
    "HomeScope summarizes public NOAA SWDI / SPC / IEM hail records for Oklahoma addresses. A storm is listed when a near-roof report (≤1.6 km) or a HailTrace / radar zone covers this pin. Soft nearby-only reports are labeled separately and are not treated as hitting your roof. This is informational storm history only, not a roof inspection or damage appraisal.",
  /** Internal CRM intake — set webhookUrl so HomeScope can create the contact and email the report. */
  crm: {
    webhookUrl: "",
    emailReport: true,
  },
};

/** Locked recommendation / CTA rules. */
export const CLAIM_RULES = {
  /** Hail larger than 1″ qualifies for the multi-storm recommendation. */
  minHailInches: 1.0,
  minHailInchesExclusive: false,
  minStormsToConsiderClaim: 2,
  defaultLookbackYearsIfRoofUnknown: 2,
  maxHistoryYears: 10,
  /** Recent roof = repaired/replaced within this many years. */
  recentRoofYears: 2,
  /** Count a storm if near-roof hits OR zone polygon covers the pin — never soft/nearby guesses. */
  coverModes: ["near_roof", "polygon"],
  nearRoofKm: 1.6,
  nearZoneKm: 2.5,
};

/**
 * @typedef {{ date: string, maxSizeIn: number, coversHome: boolean, coversNear?: boolean, coversPolygon?: boolean, sources?: string }} StormHit
 */

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function windowStartDate(roofReplacedOn, asOf, yearsIfUnknown) {
  if (roofReplacedOn) {
    const r = new Date(`${roofReplacedOn}T12:00:00`);
    if (!Number.isNaN(r.getTime())) return r;
  }
  const s = new Date(asOf);
  s.setFullYear(s.getFullYear() - yearsIfUnknown);
  return s;
}

function hailQualifies(sizeIn) {
  const n = Number(sizeIn) || 0;
  return CLAIM_RULES.minHailInchesExclusive ? n > CLAIM_RULES.minHailInches : n >= CLAIM_RULES.minHailInches;
}

/**
 * At-a-glance covering hail for fixed lookbacks (2 / 5 / 10 years).
 * Uses near-roof or zone cover only — same bar as the recommendation.
 */
export function hailWindowSummaries(storms, { asOf = new Date(), windows = [2, 5, 10], loadedYears = 10 } = {}) {
  const end = asOf instanceof Date ? asOf : new Date(asOf);
  const endIso = isoDay(end);
  const covering = (storms || []).filter((s) => s && (s.coversNear || s.coversPolygon));

  return windows.map((years) => {
    const start = new Date(end);
    start.setFullYear(start.getFullYear() - years);
    const startIso = isoDay(start);
    const inWin = covering.filter((s) => {
      const d = String(s.date || "");
      return d >= startIso && d <= endIso;
    });
    const inchPlus = inWin.filter((s) => hailQualifies(s.maxSizeIn));
    const maxSize = inWin.reduce((m, s) => Math.max(m, Number(s.maxSizeIn) || 0), 0);
    const latest = [...inWin].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;
    const biggest = [...inWin].sort((a, b) => (Number(b.maxSizeIn) || 0) - (Number(a.maxSizeIn) || 0))[0] || null;
    const partial = Number(loadedYears) > 0 && Number(loadedYears) + 1e-6 < years;
    return {
      years,
      startIso,
      endIso,
      count: inWin.length,
      inchPlus: inchPlus.length,
      maxSize,
      latestDate: latest?.date || null,
      latestPretty: latest?.pretty || latest?.date || null,
      biggestPretty: biggest?.pretty || biggest?.date || null,
      partial,
      loadedYears: Number(loadedYears) || years,
    };
  });
}

function roofAgeYears(roofReplacedOn, asOf) {
  if (!roofReplacedOn) return null;
  const r = new Date(`${roofReplacedOn}T12:00:00`);
  if (Number.isNaN(r.getTime())) return null;
  return (asOf.getTime() - r.getTime()) / (365.25 * 24 * 3600 * 1000);
}

/**
 * Full HomeScope recommendation — keep claim talk to one short line when relevant.
 * - Always CTA: get a free inspection
 * - Multi-storm 1″+ cover → brief note that a claim may be worth discussing with an inspection
 * - Recent roof + ≥1 qualifying storm → talk to a roofer
 */
export function homescopeRecommendation({ storms, roofReplacedOn, asOf = new Date() } = {}) {
  const end = asOf instanceof Date ? asOf : new Date(asOf);
  const start = windowStartDate(roofReplacedOn, end, CLAIM_RULES.defaultLookbackYearsIfRoofUnknown);
  const windowStart = isoDay(start);
  const windowEnd = isoDay(end);

  const inWindow = (s) => {
    const d = String(s?.date || "");
    return d >= windowStart && d <= windowEnd;
  };

  const covering = (storms || []).filter(
    (s) => s && inWindow(s) && (s.coversNear || s.coversPolygon),
  );
  const qualifying = covering.filter((s) => hailQualifies(s.maxSizeIn));

  const considerClaim = qualifying.length >= CLAIM_RULES.minStormsToConsiderClaim;
  const ageY = roofAgeYears(roofReplacedOn, end);
  const recentRoof = ageY != null && ageY >= 0 && ageY <= CLAIM_RULES.recentRoofYears;
  const talkToRoofer = recentRoof && qualifying.length >= 1;

  const lines = [];
  if (considerClaim) {
    lines.push(
      `${qualifying.length} dates with ${CLAIM_RULES.minHailInches}″+ hail covered this home since ${windowStart}. A free inspection can document the roof; if damage is found, you can discuss whether a claim makes sense.`,
    );
  } else if (qualifying.length === 1) {
    lines.push(
      `One ${CLAIM_RULES.minHailInches}″+ storm covered this home in the review window (${windowStart} → ${windowEnd}). A free inspection can check for damage that isn’t obvious from the ground.`,
    );
  } else {
    lines.push(
      `No multi-storm ${CLAIM_RULES.minHailInches}″+ pattern over the home in the review window (${windowStart} → ${windowEnd}). A free inspection can still catch wear that isn’t obvious from the street.`,
    );
  }

  if (talkToRoofer) {
    lines.push(
      `Your roof is about ${ageY.toFixed(1)} years old (≤${CLAIM_RULES.recentRoofYears} years) with at least one ${CLAIM_RULES.minHailInches}″+ covering storm — talk with a roofer; newer roofs can still need repair.`,
    );
  }

  const roofQuality = estimateRoofQuality({ ageY, qualifyingCount: qualifying.length, considerClaim });

  return {
    considerClaim,
    talkToRoofer,
    recentRoof,
    roofAgeYears: ageY,
    roofQuality,
    qualifying,
    covering,
    windowStart,
    windowEnd,
    primaryCta: PRODUCT.brand.cta,
    secondaryCta: talkToRoofer ? "Talk to a roofer" : null,
    headline: talkToRoofer
      ? "Talk to a roofer — get a free inspection"
      : considerClaim
        ? "Get a free inspection"
        : PRODUCT.brand.cta,
    reason: lines.join(" "),
  };
}

/** Rough condition read from roof age + covering hail — not an inspection. */
export function estimateRoofQuality({ ageY, qualifyingCount = 0, considerClaim = false } = {}) {
  if (ageY == null || !Number.isFinite(ageY) || ageY < 0) {
    return {
      label: "Unknown (roof age not provided)",
      detail:
        "Without a roof age we used a 2-year lookback. Confirm when the roof was last replaced so High Ground can sharpen the estimate.",
    };
  }
  if (ageY <= 2) {
    return {
      label: qualifyingCount ? "Newer roof with hail history" : "Newer roof",
      detail: `About ${ageY.toFixed(1)} years old. Newer roofs can still need repair after qualifying hail — a free inspection documents condition early.`,
    };
  }
  if (ageY <= 5) {
    return {
      label: considerClaim ? "Mid-life roof with multi-storm hail" : "Mid-life roof",
      detail: `About ${ageY.toFixed(1)} years old. Mid-life roofs often show cumulative hail wear after Oklahoma storms.`,
    };
  }
  if (ageY <= 10) {
    return {
      label: considerClaim ? "Aging roof with hail history" : "Aging roof",
      detail: `About ${ageY.toFixed(1)} years old. Aging roofs lose resiliency; covering hail history is a good reason for a professional look.`,
    };
  }
  return {
    label: considerClaim ? "Older roof with hail history" : "Older roof",
    detail: `About ${ageY.toFixed(1)} years old. Older roofs plus covering hail is when homeowners most often need a professional look.`,
  };
}

/** @deprecated alias — tests / older imports */
export const draftClaimRecommendation = (input) => {
  const r = homescopeRecommendation(input);
  return {
    considerClaim: r.considerClaim,
    qualifying: r.qualifying,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    reason: r.reason,
    talkToRoofer: r.talkToRoofer,
    primaryCta: r.primaryCta,
  };
};

export const DRAFT_CLAIM_RULES = CLAIM_RULES;
