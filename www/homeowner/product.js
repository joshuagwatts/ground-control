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
    address: "449 NE 144th Pl, Edmond, OK 73013",
    cta: "Get a Free Inspection",
    ctaUrl: "https://www.highgroundokc.com/",
  },
  disclaimer:
    "HomeScope summarizes public NOAA / SPC / IEM hail records for Oklahoma addresses. In Oklahoma, severe hail regularly totals roofs — insurers often call it an act of God. This report helps you see what hit your property and decide next steps with High Ground. It is not a formal insurance decision, appraisal, or substitute for a licensed adjuster.",
};

/** Locked claim / CTA rules. */
export const CLAIM_RULES = {
  /** Hail larger than 1″ qualifies. */
  minHailInches: 1.0,
  /** Strictly greater than 1.0″ for claim multi-storm trigger (spotter 1.00 still counts as ≥1). */
  minHailInchesExclusive: false,
  minStormsToConsiderClaim: 2,
  defaultLookbackYearsIfRoofUnknown: 2,
  maxHistoryYears: 10,
  /** Recent roof = repaired/replaced within this many years. */
  recentRoofYears: 2,
  /** Count a storm if near-roof hits OR zone polygon covers the pin. */
  coverModes: ["near_roof", "polygon"],
  nearRoofKm: 1.6,
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

function roofAgeYears(roofReplacedOn, asOf) {
  if (!roofReplacedOn) return null;
  const r = new Date(`${roofReplacedOn}T12:00:00`);
  if (Number.isNaN(r.getTime())) return null;
  return (asOf.getTime() - r.getTime()) / (365.25 * 24 * 3600 * 1000);
}

/**
 * Full HomeScope recommendation.
 * - Always CTA: get a free inspection
 * - Consider claim when ≥2 qualifying storms cover the home in the review window
 * - Talk to a roofer when roof is ≤2 years old AND ≥1 qualifying storm covered the home
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

  const covering = (storms || []).filter((s) => s?.coversHome && inWindow(s));
  const qualifying = covering.filter((s) => hailQualifies(s.maxSizeIn));

  const considerClaim = qualifying.length >= CLAIM_RULES.minStormsToConsiderClaim;
  const ageY = roofAgeYears(roofReplacedOn, end);
  const recentRoof = ageY != null && ageY >= 0 && ageY <= CLAIM_RULES.recentRoofYears;
  const talkToRoofer = recentRoof && qualifying.length >= 1;

  const lines = [];
  if (considerClaim) {
    lines.push(
      `${qualifying.length} storm dates with ${CLAIM_RULES.minHailInches}″+ hail covered this home since ${windowStart}. In Oklahoma that pattern is exactly when homeowners should look into whether a claim makes sense.`,
    );
  } else if (qualifying.length === 1) {
    lines.push(
      `One storm with ${CLAIM_RULES.minHailInches}″+ hail covered this home in the review window (${windowStart} → ${windowEnd}). One hit can still matter — especially on a newer roof.`,
    );
  } else {
    lines.push(
      `No multi-storm ${CLAIM_RULES.minHailInches}″+ pattern over the home in the review window (${windowStart} → ${windowEnd}). Visible damage can still exist — get eyes on the roof.`,
    );
  }

  if (talkToRoofer) {
    lines.push(
      `Your roof is about ${ageY.toFixed(1)} years old (≤${CLAIM_RULES.recentRoofYears} years) and at least one ${CLAIM_RULES.minHailInches}″+ storm covered it — talk with a roofer; a newer roof can still be totaled.`,
    );
  }

  return {
    considerClaim,
    talkToRoofer,
    recentRoof,
    roofAgeYears: ageY,
    qualifying,
    covering,
    windowStart,
    windowEnd,
    /** Always the primary CTA. */
    primaryCta: PRODUCT.brand.cta,
    secondaryCta: talkToRoofer ? "Talk to a roofer" : null,
    headline: considerClaim
      ? "Look into a claim — and get a free inspection"
      : talkToRoofer
        ? "Talk to a roofer — and get a free inspection"
        : PRODUCT.brand.cta,
    reason: lines.join(" "),
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
