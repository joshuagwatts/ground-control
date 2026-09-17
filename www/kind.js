const TYPES = {
  festival_install: {
    label: "Festival install",
    strong: ["art installation", "installation application", "call for installations"],
    needles: ["installation", "footprint", "power", "site-specific", "immersive"],
    anti: ["food vendor", "dj application", "epk"],
    draft:
      "FESTIVAL INSTALLATION. A piece people walk into: day/night, music sync, weather, footprint, power, crew. Not a mural pitch, DJ EPK, or job letter.",
  },
  festival_artist: {
    label: "Mural / festival artist",
    strong: ["mural artist", "live painting", "visual artist application", "festival mural"],
    needles: ["mural", "live paint", "visual artist", "wall", "canvas"],
    anti: ["installation application", "food vendor", "job application"],
    draft:
      "FESTIVAL VISUAL ARTIST / MURAL. Walls, live paint, what a walker sees on a surface. If KIT is live-visuals more than brush, say that honestly. Do not invent a painting practice.",
  },
  city_art: {
    label: "Public art",
    strong: ["public art rfp", "public art rfq", "percent for art", "call for public art"],
    needles: ["public art", "rfp", "rfq", "civic", "municipal", "commission"],
    anti: ["food vendor", "dj application"],
    draft:
      "CITY / PUBLIC ART. Site, community, durability, budget as ESTIMATE, insurance, timeline. Civic tone. Not festival slang.",
  },
  music: {
    label: "Musician",
    strong: ["dj application", "band application", "music artist application", "submit your music", "epk"],
    needles: ["dj application", "band", "live set", "soundcloud", "musician"],
    anti: ["installation", "mural", "public art", "job application"],
    draft:
      "MUSIC ARTIST. Sound, set, draw. If KIT is visual/live-visuals first, be honest — music in the toolkit, not a touring DJ packet.",
  },
  job: {
    label: "Job",
    strong: ["job application", "we're hiring", "full-time", "join our team", "employment"],
    needles: ["resume", "cover letter", "salary", "careers", "3d generalist", "motion designer"],
    anti: ["open call", "festival", "installation application"],
    draft:
      "JOB. Role fit, tools, shipped work, studio (Holowatts if in KIT). Cover-letter tone. No footprint/power. Do not invent employers.",
  },
  vj_booking: {
    label: "VJ / visuals",
    strong: ["vj application", "live visuals application", "visualist"],
    needles: ["vj", "live visuals", "led wall", "stage visuals"],
    anti: ["mural", "food vendor"],
    draft: "VJ / LIVE VISUALS. Rig, content, sync, festivals played. Not a sculpture unless they ask. Not a mural. Not a job resume.",
  },
  other: {
    label: "Open call",
    strong: [],
    needles: ["open call", "call for artists", "application"],
    anti: [],
    draft: "Match each question. Do not assume install, mural, music, or job unless the prompt is that.",
  },
};

export function classify(title, url, questions) {
  const blob = [
    title,
    url,
    ...(questions || []).map((q) => q.prompt || q.q || ""),
  ]
    .join(" ")
    .toLowerCase();
  const scores = {};
  for (const [id, spec] of Object.entries(TYPES)) {
    if (id === "other") continue;
    let n = 0;
    for (const s of spec.strong) if (blob.includes(s)) n += 5;
    for (const s of spec.needles) if (blob.includes(s)) n += 1;
    for (const s of spec.anti) if (blob.includes(s)) n -= 4;
    scores[id] = n;
  }
  if (/wakaan/i.test(blob)) scores.festival_install += 8;
  if (blob.includes("mural")) scores.festival_artist += 3;
  if (blob.includes("public art") || blob.includes(" rfp")) scores.city_art += 3;
  if (blob.includes("musician") || blob.includes("dj application")) scores.music += 3;
  if (blob.includes("hiring") || blob.includes("career")) scores.job += 2;
  if (blob.includes("festival") && scores.job && scores.festival_artist + scores.festival_install >= 3) scores.job = 0;
  let best = "other";
  let top = 2;
  for (const [id, n] of Object.entries(scores)) {
    if (n > top) {
      top = n;
      best = id;
    }
  }
  const spec = TYPES[best] || TYPES.other;
  return { id: best, label: spec.label, draft: spec.draft, score: top };
}

export function draftVoice(kind) {
  return (TYPES[kind] || TYPES.other).draft;
}

export function labelOf(kind) {
  return (TYPES[kind] || TYPES.other).label;
}

export function placeRings({ city, state, country } = {}) {
  let c = String(city || "").trim();
  let s = String(state || "").trim();
  let nat = String(country || "").trim();
  if (!c && !s && !nat) {
    c = "Edmond";
    s = "Oklahoma";
    nat = "United States";
  }
  if (!nat) nat = "United States";
  const rings = [];
  const home = [c, s].filter(Boolean).join(", ");
  if (home) rings.push(home);
  if (s && !rings.some((r) => r.toLowerCase() === s.toLowerCase())) rings.push(s);
  if (nat && !rings.some((r) => r.toLowerCase() === nat.toLowerCase())) rings.push(nat);
  return rings;
}

export const TYPE_QUERIES = [
  ["festival_artist", "mural artist application open call apply"],
  ["city_art", "public art RFP RFQ call for artists apply"],
  ["music", "musician artist application festival apply"],
  ["job", "visual artist motion designer job application studio"],
  ["other", "visual artist open call application apply"],
  ["festival_install", "festival art installation VJ application apply"],
];
