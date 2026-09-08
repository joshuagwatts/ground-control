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
    "HomeScope summarizes public NOAA SWDI / SPC / IEM hail records for Oklahoma addresses. A storm is listed when a near-roof report (≤1.6 km) or a HailTrace / radar zone covers this pin. Soft nearby-only reports are labeled separately and are not treated as hitting your roof. This is informational storm history to support a professional roof conversation — not a roof inspection, damage appraisal, or insurance claim decision.",
  /** Internal CRM intake — set webhookUrl so HomeScope can create the contact and email the report. */
  crm: {
    webhookUrl: "",
    emailReport: true,
  },
};

/** Locked recommendation / CTA rules. */
export const CLAIM_RULES = {
  /** Hail ≥1″ is the industry “serious impact” bar homeowners hear most often. */
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
 * Plain-language roof / hail facts High Ground can share with homeowners.
 * General industry knowledge — not a guarantee about this specific roof or any claim.
 */
export const ROOF_HAIL_EDUCATION = {
  title: "What homeowners should know about hail",
  bullets: [
    "Hail about 1″ (quarter-size) and larger is widely treated as serious enough to bruise, crack, or knock granules off asphalt shingles — and in many Oklahoma storms, that size of impact is what puts a roof in “replacement conversation” territory after a proper inspection.",
    "Damage is often invisible from the street. Bruises hide under granules; soft spots and fractured mats show up on the roof deck or with drone / on-roof inspection.",
    "Soft metal nearby (vents, gutters, downspouts, AC fins) can show matching impact marks that help corroborate a hail event — useful context, not a substitute for shingle inspection.",
    "One big storm can matter. Several covering storms over a few years can compound wear even when each event looked “fine” from the curb.",
    "A newer roof can still need repair after qualifying hail — full replacement is less automatic, which is why documenting condition early still matters.",
    "Public weather history shows storms that covered this pin. Only a free High Ground inspection can say what happened to these shingles.",
  ],
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
 * Pitch-ready HomeScope recommendation — inspection-first, clear on 1″+ risk.
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
  const maxInWindow = covering.reduce((m, s) => Math.max(m, Number(s.maxSizeIn) || 0), 0);

  const multiInch = qualifying.length >= CLAIM_RULES.minStormsToConsiderClaim;
  const ageY = roofAgeYears(roofReplacedOn, end);
  const recentRoof = ageY != null && ageY >= 0 && ageY <= CLAIM_RULES.recentRoofYears;
  const agingRoof = ageY != null && ageY > 5;
  const talkToRoofer = recentRoof && qualifying.length >= 1;
  const considerClaim = multiInch; // kept for CRM / older callers — means “strong hail pattern”

  const lines = [];
  if (qualifying.length >= 1 && agingRoof) {
    lines.push(
      `Since this roof was last replaced (~${ageY.toFixed(0)} years on), ${qualifying.length} storm date${qualifying.length === 1 ? "" : "s"} brought ${CLAIM_RULES.minHailInches}″+ hail over the home (largest ~${maxInWindow.toFixed(2)}″). Hail that size can total an asphalt roof — the only way to know is an on-roof / drone inspection.`,
    );
  } else if (multiInch) {
    lines.push(
      `${qualifying.length} dates with ${CLAIM_RULES.minHailInches}″+ hail covered this home in the review window (${windowStart} → ${windowEnd}). That is a clear signal to get the roof documented — 1″+ impacts are the ones Oklahoma roofers watch for.`,
    );
  } else if (qualifying.length === 1) {
    lines.push(
      `At least one ${CLAIM_RULES.minHailInches}″+ storm covered this home in the review window. Even a single serious hail day can bruise shingles in ways you cannot see from the yard.`,
    );
  } else if (covering.length) {
    lines.push(
      `${covering.length} covering storm date${covering.length === 1 ? "" : "s"} in the review window (largest ~${maxInWindow.toFixed(2)}″). Smaller hail still strips granules over time — a free inspection separates “weathered” from “impacted.”`,
    );
  } else {
    lines.push(
      `No verified near-roof / zone-cover storms in the review window (${windowStart} → ${windowEnd}). A free inspection can still catch wear that is not obvious from the street.`,
    );
  }

  if (talkToRoofer) {
    lines.push(
      `This roof is still relatively new (~${ageY.toFixed(1)} years) and already has ${CLAIM_RULES.minHailInches}″+ cover history — talk with High Ground before assuming “new” means “untouched.”`,
    );
  } else if (recentRoof && !qualifying.length) {
    lines.push(`Newer roof (~${ageY.toFixed(1)} years) with little qualifying hail in-window — good time for a baseline inspection if you want a clean record.`);
  }

  const roofQuality = estimateRoofQuality({
    ageY,
    qualifyingCount: qualifying.length,
    considerClaim: multiInch,
    maxSizeIn: maxInWindow,
  });

  let headline = PRODUCT.brand.cta;
  if (qualifying.length >= 1 && (agingRoof || multiInch)) {
    headline = "Serious hail over this roof — get a free inspection";
  } else if (talkToRoofer) {
    headline = "Newer roof with hail history — still get it checked";
  } else if (qualifying.length === 1) {
    headline = "Qualifying hail covered this home — document it";
  }

  return {
    considerClaim,
    talkToRoofer,
    recentRoof,
    agingRoof,
    roofAgeYears: ageY,
    roofQuality,
    qualifying,
    covering,
    maxInWindow,
    windowStart,
    windowEnd,
    primaryCta: PRODUCT.brand.cta,
    secondaryCta: talkToRoofer || multiInch || qualifying.length ? "Schedule with High Ground" : null,
    headline,
    reason: lines.join(" "),
    education: ROOF_HAIL_EDUCATION,
  };
}

/** Rough condition read from roof age + covering hail — not an inspection. */
export function estimateRoofQuality({ ageY, qualifyingCount = 0, considerClaim = false, maxSizeIn = 0 } = {}) {
  const maxBit =
    maxSizeIn >= CLAIM_RULES.minHailInches
      ? ` Largest covering hail in review ~${Number(maxSizeIn).toFixed(2)}″ — size that can total shingles after inspection.`
      : "";
  if (ageY == null || !Number.isFinite(ageY) || ageY < 0) {
    return {
      label: "Roof age not confirmed",
      detail:
        "Without a firm roof age we used a short lookback for the recommendation. Confirm when it was last replaced so High Ground can match storms to this roof’s life.",
    };
  }
  if (ageY <= 2) {
    return {
      label: qualifyingCount ? "Newer roof — hail still matters" : "Newer roof",
      detail: `About ${ageY.toFixed(1)} years old. New does not mean immune — qualifying hail can still need repair; replacement is less automatic.${maxBit}`,
    };
  }
  if (ageY <= 5) {
    return {
      label: considerClaim ? "Mid-life roof with multi-storm 1″+ hail" : "Mid-life roof",
      detail: `About ${ageY.toFixed(1)} years old. Mid-life Oklahoma roofs often show cumulative hail wear that curb appeal hides.${maxBit}`,
    };
  }
  if (ageY <= 10) {
    return {
      label: qualifyingCount ? "Aging roof with covering hail history" : "Aging roof",
      detail: `About ${ageY.toFixed(1)} years old. Aging shingles lose resiliency — covering hail history is exactly when a professional look pays off.${maxBit}`,
    };
  }
  return {
    label: qualifyingCount ? "Older roof with covering hail history" : "Older roof",
    detail: `About ${ageY.toFixed(1)} years old. Older roofs plus covering hail is when homeowners most often need documentation and a clear next step.${maxBit}`,
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
