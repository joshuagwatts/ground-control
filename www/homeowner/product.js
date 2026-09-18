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
 * Items render as an accordion: short summary up front, full detail on tap.
 */
export const ROOF_HAIL_EDUCATION = {
  title: "What homeowners should know about hail",
  blurb: "The short version up front — tap any point for the full story.",
  items: [
    {
      summary: "Hail around 1″ and up is the serious-damage line.",
      detail:
        "Hail about 1″ (quarter-size) and larger is widely treated as serious enough to bruise, crack, or knock granules off asphalt shingles — and in many Oklahoma storms, that size of impact is what puts a roof in “replacement conversation” territory after a proper inspection.",
    },
    {
      summary: "Damage is often invisible from the street.",
      detail:
        "Bruises hide under granules; soft spots and fractured mats show up on the roof deck or with drone / on-roof inspection.",
    },
    {
      summary: "Soft metal tells the story too.",
      detail:
        "Soft metal nearby (vents, gutters, downspouts, AC fins) can show matching impact marks that help corroborate a hail event — useful context, not a substitute for shingle inspection.",
    },
    {
      summary: "One big storm can matter — and small ones add up.",
      detail:
        "One big storm can matter. Several covering storms over a few years can compound wear even when each event looked “fine” from the curb.",
    },
    {
      summary: "Even a newer roof can need repair after serious hail.",
      detail:
        "A newer roof can still need repair after serious hail — full replacement is less automatic, which is why documenting condition early still matters.",
    },
    {
      summary: "The weather history is public. The shingles need eyes.",
      detail:
        "Public weather history shows storms with verified cover at this pin. Only a free High Ground inspection can say what happened to these shingles.",
    },
  ],
};

/**
 * Homeowner FAQ — roofing and insurance basics in plain language.
 * General information, not legal or policy advice; homeowners should confirm
 * specifics with their agent or carrier.
 */
export const HOMEOWNER_FAQ = {
  title: "Homeowner FAQ",
  blurb: "Roofing and insurance basics, plain and simple. Tap any question.",
  groups: [
    {
      label: "Roofing basics",
      items: [
        {
          q: "How can I tell if my roof has hail damage?",
          a: "Usually you can't — not from the ground. That's the trap. Hail bruises hide under the granules, and a roof can look perfectly fine from the curb while the shingles are fractured underneath. The only way to know is getting on the roof (or flying a drone) and checking. That's why our inspections are free.",
        },
        {
          q: "How long does a roof replacement take?",
          a: "Most Oklahoma homes are done in a single day. Bigger, steeper, or more complex roofs can run two. We show up early, tear off, replace any bad decking, and you're watertight by evening.",
        },
        {
          q: "Will it be a mess?",
          a: "There's no pretty way to tear off a roof — but we tarp the landscaping, run magnets across the yard for nails, and leave the place cleaner than we found it. If we ever miss a nail, call us and we'll come sweep again.",
        },
        {
          q: "What kind of shingles should I get?",
          a: "Architectural (dimensional) shingles are what most Oklahoma homeowners land on — they look good and hold up to our weather. Impact-resistant (Class 4) shingles cost more up front but can earn you a discount on your homeowner's insurance. We'll walk you through both, no pressure.",
        },
        {
          q: "How long will a new roof last?",
          a: "In Oklahoma weather, a quality architectural shingle roof typically runs 15–20 years. The wind rating and the quality of the install matter more than the number on the brochure.",
        },
        {
          q: "Do I need to be home during the install?",
          a: "No — most folks aren't. We just need driveway access and pets kept inside. We'll text you photos as the work progresses.",
        },
      ],
    },
    {
      label: "Insurance basics",
      items: [
        {
          q: "Will filing a claim raise my rates?",
          a: "A hail claim is a weather claim — an “act of God” — not an at-fault claim, so it doesn't count against you the way a car wreck would. In Oklahoma, insurers can't single you out with a surcharge just for filing a catastrophe claim. Your agent can confirm exactly how your carrier handles it.",
        },
        {
          q: "How does the insurance process work?",
          a: "Simple version: we inspect and document the damage, you file the claim, the adjuster comes out (we meet them on the roof so nothing gets missed), the claim gets approved, and we build. You pay your deductible; insurance covers the rest of the approved amount.",
        },
        {
          q: "What is a deductible?",
          a: "The part you pay out of pocket before insurance kicks in. It's usually a flat dollar amount or a percentage of your home's insured value — you'll find it on your policy's declarations page.",
        },
        {
          q: "How long do I have to file after a storm?",
          a: "Most Oklahoma policies give you around a year from the date of loss, but it varies by carrier — check your policy or ask your agent. Either way, the sooner the damage is documented, the cleaner the claim.",
        },
        {
          q: "What if the adjuster says there's no damage?",
          a: "It happens — a quick look from a ladder can miss what's really there. We can walk the roof with the adjuster and show our drone and AI documentation. When the damage is real, a re-inspection usually tells a different story.",
        },
        {
          q: "Should I call my insurance company or a roofer first?",
          a: "A roofer — and the inspection should be free. Nothing goes on your record until you file a claim, so get the facts and the documentation first, then decide with proof in hand.",
        },
      ],
    },
  ],
};

/** Minimal HTML escape used by the accordion/FAQ builders. */
function escAcc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Normalize education content to { title, body } items.
 * Accepts the current { items: [{ summary, detail }] } shape and the legacy
 * { bullets: [strings] } shape so older recommendation payloads still render.
 */
export function educationItems(edu = ROOF_HAIL_EDUCATION) {
  if (Array.isArray(edu?.items) && edu.items.length) {
    return edu.items
      .filter((it) => it && String(it.summary ?? "").trim())
      .map((it) => ({ title: String(it.summary), body: String(it.detail ?? "") }));
  }
  if (Array.isArray(edu?.bullets) && edu.bullets.length) {
    return edu.bullets
      .filter((b) => String(b ?? "").trim())
      .map((b) => ({ title: String(b), body: "" }));
  }
  return [];
}

/** Normalize FAQ content to [{ label, items: [{ title, body }] }]. */
export function faqGroups(faq = HOMEOWNER_FAQ) {
  const groups = Array.isArray(faq?.groups) ? faq.groups : [];
  return groups
    .map((g) => ({
      label: String(g?.label ?? ""),
      items: (Array.isArray(g?.items) ? g.items : [])
        .filter((it) => it && String(it.q ?? "").trim())
        .map((it) => ({ title: String(it.q), body: String(it.a ?? "") })),
    }))
    .filter((g) => g.items.length);
}

/**
 * Generic accordion item list. Pure HTML string — the page binds one delegated
 * click handler for [data-acc]; pass expanded=true for print/download output
 * where there is no JS to toggle with.
 */
export function accordionItemsHtml(items, { expanded = false, esc = escAcc } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(
    (it) => it && String(it.title ?? "").trim(),
  );
  if (!list.length) return "";
  return list
    .map((it) => {
      const body = String(it.body ?? "");
      const open = Boolean(expanded) || !body.trim();
      return (
        `<div class="hg-acc-item${open ? " open" : ""}">` +
        `<button type="button" class="hg-acc-btn" data-acc aria-expanded="${open ? "true" : "false"}">` +
        `<span class="hg-acc-title">${esc(it.title)}</span>` +
        `<span class="hg-acc-chev" aria-hidden="true"></span>` +
        `</button>` +
        `<div class="hg-acc-panel">${esc(body)}</div>` +
        `</div>`
      );
    })
    .join("");
}

/** Hail-education accordion for the report document. */
export function educationAccordionHtml(edu = ROOF_HAIL_EDUCATION, opts = {}) {
  const items = educationItems(edu);
  if (!items.length) return "";
  return `<div class="hg-accordion" data-accordion="education">${accordionItemsHtml(items, opts)}</div>`;
}

/** Homeowner FAQ accordion for the report document. */
export function homeownerFaqHtml(faq = HOMEOWNER_FAQ, opts = {}) {
  const groups = faqGroups(faq);
  if (!groups.length) return "";
  return groups
    .map(
      (g) =>
        `<h3 class="hg-faq-group">${escAcc(g.label)}</h3>` +
        `<div class="hg-accordion" data-accordion="faq">${accordionItemsHtml(g.items, opts)}</div>`,
    )
    .join("");
}

/** Force every accordion item in an HTML string open (download/print output). */
export function expandAccordionsHtml(html) {
  return String(html || "")
    .replace(/class="hg-acc-item"/g, 'class="hg-acc-item open"')
    .replace(/aria-expanded="false"/g, 'aria-expanded="true"');
}

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
  const stormN = Math.max(covering.length, qualifying.length);
  const sizeBit =
    maxInWindow > 0 ? ` Largest size in the review window ~${formatSize(maxInWindow)}″.` : "";

  if (stormN >= 2 || qualifying.length >= 1) {
    lines.push(
      `Over ${stormN} storm${stormN === 1 ? "" : "s"} with verified near-roof or zone cover at this address${
        qualifying.length
          ? ` — including ${qualifying.length} at ${CLAIM_RULES.minHailInches}″+`
          : ""
      }. That kind of hail history carries a high probability of significant functional damage to the roof.${sizeBit} A free High Ground inspection is how you confirm what the shingles actually show.`,
    );
  } else if (covering.length === 1) {
    lines.push(
      `One verified covering storm is on record for this address in the review window.${sizeBit} Even a single serious hail day can leave functional damage that is hard to see from the street — a free inspection documents the condition.`,
    );
  } else {
    lines.push(
      `No verified near-roof or zone-cover storms in the review window (${windowStart} → ${windowEnd}). A free inspection can still catch wear that is not obvious from the curb.`,
    );
  }

  if (talkToRoofer) {
    lines.push(
      `This roof is still relatively new (~${ageY.toFixed(1)} years) with serious hail dates already in its life — talk with High Ground before assuming “new” means untouched.`,
    );
  } else if (recentRoof && !qualifying.length && !covering.length) {
    lines.push(
      `Newer roof (~${ageY.toFixed(1)} years) with little covering hail in-window — a baseline inspection still gives you a clean record.`,
    );
  }

  const roofQuality = estimateRoofQuality({
    ageY,
    qualifyingCount: qualifying.length,
    considerClaim: multiInch,
    maxSizeIn: maxInWindow,
  });

  let headline = PRODUCT.brand.cta;
  if (stormN >= 2 || qualifying.length >= 1) {
    headline =
      stormN >= 3
        ? `${stormN} storms over this home — high chance of functional damage`
        : `Hail storms over this home — get it inspected`;
  } else if (talkToRoofer) {
    headline = "Newer roof with hail history — still get it checked";
  }

  return {
    considerClaim,
    talkToRoofer,
    recentRoof,
    agingRoof,
    roofAgeConfirmed: ageY != null && Number.isFinite(ageY) && ageY >= 0,
    roofAgeYears: ageY,
    roofQuality,
    qualifying,
    covering,
    maxInWindow,
    windowStart,
    windowEnd,
    primaryCta: PRODUCT.brand.cta,
    secondaryCta: talkToRoofer || multiInch || qualifying.length || covering.length ? "Schedule with High Ground" : null,
    headline,
    reason: lines.join(" "),
    education: ROOF_HAIL_EDUCATION,
  };
}

function formatSize(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  let s = (Math.round(x * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  if (s.startsWith("0.")) s = s.slice(1);
  return s;
}

/** Rough condition read from roof age + covering hail — not an inspection. */
export function estimateRoofQuality({ ageY, qualifyingCount = 0, considerClaim = false, maxSizeIn = 0 } = {}) {
  const maxBit =
    maxSizeIn >= CLAIM_RULES.minHailInches
      ? ` Largest covering hail in review ~${formatSize(maxSizeIn)}″ — size that can leave serious functional damage after inspection.`
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
      detail: `About ${ageY.toFixed(1)} years old. New does not mean immune — serious hail can still leave functional damage; full replacement is less automatic.${maxBit}`,
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
