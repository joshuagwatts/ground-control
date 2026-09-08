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
    "HomeScope summarizes public NOAA SWDI / SPC / IEM hail records for Oklahoma addresses. A storm is listed only when a near-roof report (≤2.5 km) or a radar zone polygon covers this pin — nearby-only reports are not claimed as hitting your roof. Map colors follow hail size. This is not a formal insurance decision, appraisal, or substitute for a licensed adjuster.",
  /** Internal CRM intake — set webhookUrl so HomeScope can create the contact and email the report. */
  crm: {
    webhookUrl: "",
    emailReport: true,
  },
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
  /** Count a storm if near-roof hits OR zone polygon covers the pin — never soft/nearby guesses. */
  coverModes: ["near_roof", "polygon"],
  nearRoofKm: 1.6,
  /** Max distance for “near roof” cover (aligned with field zone paint). */
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
      label: considerClaim || qualifyingCount ? "Newer roof — hail exposure risk" : "Newer roof",
      detail: `About ${ageY.toFixed(1)} years old. Newer roofs can still be totaled by qualifying hail — document early.`,
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
      detail: `About ${ageY.toFixed(1)} years old. Aging roofs lose resiliency; hail history raises the odds of needed repair or replacement.`,
    };
  }
  return {
    label: considerClaim ? "Older roof — strong claim review candidate" : "Older roof",
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
