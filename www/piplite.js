/**
 * Pip Lite — pocket Hitchhiker's Guide for the phone.
 * No model download. Instant. Survival + encyclopedia + crew voice.
 * Don't Panic.
 */

import { SHOTS } from "./crew.js";

/** Condensed field entries — sourced from Fable knowledge, voiced for Pip. */
export const ENTRIES = [
  {
    id: "cover",
    title: "THE PIP GUIDE",
    tags: [
      "help",
      "topics",
      "guide",
      "encyclopedia",
      "hitchhiker",
      "hitchhikers",
      "don't panic",
      "dont panic",
      "what can you",
      "menu",
      "index",
    ],
    lead: "Don't Panic. You're holding Pip Lite — the little field book that lives on this phone.",
    body: `Entries worth knowing:
• WATER · FIRE / SHELTER · FIRST AID · FOOD
• GRID DOWN (storms / outages) · LOST / NAV
• PIP · OPP · MEALS · BRAINS

Ask by topic — "water", "tornado", "bleeding", "what are you".
Desktop GPU and LIVE API keys still handle the heavy thinking. Lite handles the pocket truth.`,
  },
  {
    id: "pip",
    title: "PIP",
    tags: ["what are you", "who are you", "what is pip", "about pip", "yourself", "pip lite"],
    lead: "I'm Pip — mentor, friend, agent. Lite mode is the book in your pocket.",
    body: `I keep keys on this device, mark cloud turns LEAKED, and prefer your desktop GPU when paired.
Lite answers from the field guide — survival, storms, and how this app works — without waking a model.
For deep drafts, code, or long reasoning: CONNECT desktop or paste LIVE keys in DATA. For the essentials: ask the Guide.`,
  },
  {
    id: "brains",
    title: "BRAINS",
    tags: ["brain", "brains", "api", "keys", "desktop", "gpu", "leaky", "secure", "qwen", "model"],
    lead: "Chain of command, short form.",
    body: `Keys pasted = cloud hierarchy speaks as Pip (LIVE preferred).
Desktop = private GPU fallback.
PIP LITE = Guide only (PIN=lite) — not general chat when keys exist.
COMPARE: type "compare: …" for parallel tabs.
DATA → paste keys — green LIVE / red KEY BAD. Chat bubble shows which brain answered.`,
  },
  {
    id: "opp",
    title: "OPP",
    tags: ["opp", "apply", "application", "open call", "grant", "festival", "opportunity"],
    lead: "That's the fun part.",
    body: `Hunt a call or drop a URL. I draft. You paste. We don't submit forms.
Keep KIT filled (bio, links, city). OPP is the desk — classify the call, answer in that voice.
Pair desktop if you want GPU help on long applications.`,
  },
  {
    id: "meals",
    title: "MEALS",
    tags: ["meal", "meals", "food plan", "grocery", "breakfast", "lunch", "dinner", "macros"],
    lead: "Eat like it counts.",
    body: `In CHAT say what you want — breakfast oats, lunch bowl, dinner stir fry — or REPLAN.
Shopping list lives under MEALS. Desktop sync merges; it won't wipe a good local plan.
Survival food stores are under FOOD in this Guide.`,
  },
  {
    id: "lens",
    title: "LENS · POCKET ID",
    tags: ["lens", "rock", "shingle", "identify", "photo", "picture", "google lens", "roof", "mineral"],
    lead: "Pocket lens. Flip LEAKY, keep a Gemini or OpenRouter key LIVE, then tap LENS — auto-detects rock vs roof vs anything. Staple attaches one or more photos to your message (gallery multi-select, or tap again to add).",
    body: `Modes: rock · shingle · general identify.
Vision leaves the device (marked LEAKED). Don't Panic — say when the photo is unclear.
Heavy chat still prefers desktop GPU / LIVE APIs. Lite stays the field book.`,
  },
  {
    id: "water",
    title: "WATER",
    tags: ["water", "thirst", "purify", "purification", "bleach", "boil", "drink", "dehydration"],
    lead: "Water before food. Always. Don't Panic — purify first.",
    body: `Rule of threes: ~3 days without water. Need ~1 gal/person/day (more in heat). Store 2 weeks if you can.

FIND: downhill, green vegetation, dawn/dusk bird paths. Rain on a clean tarp is good. Melt snow — don't eat it. Avoid chemical sheen, carcasses, floodwater.

PURIFY (best → last resort):
1) Rolling boil 1 min (3 min above 6500 ft)
2) Filter sediment, then boil or treat
3) Unscented 5–6% bleach: 2 drops/L (8/gal), wait 30 min; faint chlorine smell or repeat
4) Tablets per label · SODIS: clear PET bottle, full sun 6+ hrs

STORE: food-grade only. Water heater tank is a reservoir — kill power/gas, drain bottom. Toilet tank (not bowl) usable after purifying if no chemical pucks.`,
  },
  {
    id: "fire",
    title: "FIRE · SHELTER · WARMTH",
    tags: [
      "fire",
      "shelter",
      "warmth",
      "warm",
      "cold",
      "hypothermia",
      "heat stroke",
      "heatstroke",
      "tinder",
      "debris hut",
    ],
    lead: "Exposure kills faster than thirst. Get dry, get out of wind, get off the ground.",
    body: `COLD ORDER: dry clothes → block wind → 4+ inches insulation under you.

FIRE: heat + fuel + oxygen. Tinder (fluffy/dry) → pencil kindling → wrist-thick fuel. Dead standing wood beats wet ground wood. Split wet logs for dry core. Carry lighter + ferro rod.

SHELTER: small is warm. Debris hut or tarp lean-to with fire + reflector. In a car: stay with it, engine 10 min/hr max, window cracked, exhaust clear of snow.

HYPOTHERMIA: stumbles/mumbles/fumbles; shivering that stops is an emergency. Dry + insulated + warm sweet drink if conscious. Never rub limbs or give alcohol.

HEAT: shade, sip water + pinch of salt. Hot dry skin + confusion + no sweat = cool hard now (wet cloths / immersion) — life threat.`,
  },
  {
    id: "first-aid",
    title: "FIRST AID",
    tags: [
      "first aid",
      "firstaid",
      "bleeding",
      "tourniquet",
      "cpr",
      "choking",
      "burn",
      "burns",
      "sprain",
      "fracture",
      "wound",
      "injury",
    ],
    lead: "Keep them alive until real help. MARCH first.",
    body: `MARCH: Massive bleeding → Airway → Respiration → Circulation → Hypothermia/Head.

BLEEDING: hard direct pressure 10 min without peeking. Add layers — don't pull the first cloth. Arterial limb bleed pressure can't stop: tourniquet 2–3" above wound, not on a joint, note the time. Proper TQ hurts. Don't loosen.

WOUNDS: irrigate with drinkable water under pressure. Pack dirty/deep/bite wounds — don't tape shut. Red streaks or fever → urgent care.

BURNS: cool running water 10–20 min (not ice). Loose clean cover. Palm-size+, face/hands/groin, or painless char → pro care.

SPRINT/FRACTURE: RICE for sprains. Splint fractures as they lie; joints above+below; check toes/fingers stay pink.

CHOKING (silent): 5 back blows, 5 abdominal thrusts, repeat.
CPR (unresponsive, not breathing): hands-only, center chest, 2" deep, 100–120/min, full recoil.

KIT: gloves, gauze, tape, TQ, elastic wrap, ointment, pain+antihistamine, electrolytes, tweezers, shears, blanket, spare meds.`,
  },
  {
    id: "food",
    title: "FOOD",
    tags: ["food", "pantry", "forage", "foraging", "hungry", "calories", "rice", "beans", "spoiled"],
    lead: "Food is last priority — weeks, not days. Morale still runs on calories.",
    body: `PANTRY: white rice, beans/lentils, oats, pasta, salt, sugar, honey, oil (rotate), peanut butter, canned meat/veg/fruit. Target 2 weeks @ 2000+ kcal/day. Manual can opener. Cool/dark/dry.

NO POWER COOK: camp stove/grill outdoors only (CO kills indoors). Thermal cook: boil 10 min, wrap in blankets 2–4 hrs.

FRIDGE DOWN: doors shut — fridge ~4h, full freezer ~48h. Eat fridge → thawing freezer → canned. Above 40°F for 2+ hrs on meat/dairy/leftovers: toss it.

FORAGE: never eat what you can't positively ID. Skip mushrooms unless expert. Safer common plants (learn local): dandelion, cattail, leached acorns, pine-needle tea, clover, plantain. Avoid white/yellow berries, carrot look-alikes (hemlock), milky sap, almond smell, three leaflets.`,
  },
  {
    id: "grid",
    title: "GRID DOWN · STORMS",
    tags: [
      "grid",
      "outage",
      "power out",
      "blackout",
      "storm",
      "tornado",
      "ice storm",
      "flood",
      "lightning",
      "generator",
      "emergency",
    ],
    lead: "Most survival is boring: 3 hours to 2 weeks at home. Prepare for that first.",
    body: `CORE KIT: water×14 days, 2 weeks food, headlamp+batteries, phone bank + car charger, sleeping bags, NOAA radio, small bills + ID copies, 2-week meds + first aid. Generator outdoors only, 20+ ft from windows.

POWER DIES: check breakers vs neighbors → unplug gear, leave one lamp on for restore surge → fridge discipline → winter: drip faucets / open cabinets; shut main if freeze is certain. Never cook indoors with camp fuel.

TORNADO: lowest floor, interior, no windows, under sturdy cover, helmets on kids. Leave mobile homes.
ICE: stay off roads 24–48h. Downed lines energize ground 30+ ft — shuffle away, feet together.
FLOOD: turn around. 6" knocks you down; 12" moves a car.
LIGHTNING: building or hard-top car. 30-30 rule (thunder <30s → shelter; wait 30 min after last).

PLAN: meet point if home unreachable, out-of-state check-in, car above half tank.`,
  },
  {
    id: "lost",
    title: "LOST · NAV · SIGNAL",
    tags: [
      "lost",
      "lost in woods",
      "navigation",
      "nav",
      "signal",
      "rescue",
      "compass",
      "gps",
      "wilderness",
      "hiking",
    ],
    lead: "STOP. Searchers find the still. Panic walking hides you.",
    body: `STOP: Stop · Think (last known point) · Observe (light, weather, gear) · Plan — usually stay put, get visible, get warm.

FINDABLE: tell someone your route first. 3 of anything = distress (whistle, fires, flashes). Mirror/phone flash for miles. Ground-to-air: big X (medical) or V (help), high contrast. Phone: airplane mode, check ridgelines; know satellite SOS if you have it.

DIRECTION: sun east→west; midday shadow points north (N hemisphere). Big Dipper pointers → Polaris. Skip moss folklore.

MOVE only if staying is wrong: gentle downhill/downstream toward people; follow handrails (streams, fences). Stop with 2 hours of light left for shelter/fire.

CAR TROUBLE: stay with the car unless you can see help. Hood up + bright cloth. Engine 10 min/hr, exhaust clear, window cracked.`,
  },
];

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreEntry(entry, q) {
  let score = 0;
  for (const tag of entry.tags || []) {
    const t = norm(tag);
    if (!t) continue;
    if (q === t) score += 40;
    else if (q.includes(t)) score += 18;
    else if (t.length > 3 && t.split(" ").every((w) => q.includes(w))) score += 12;
  }
  const title = norm(entry.title);
  if (title && q.includes(title.split("·")[0].trim())) score += 10;
  for (const word of q.split(" ")) {
    if (word.length < 4) continue;
    if ((entry.tags || []).some((t) => norm(t).includes(word))) score += 3;
  }
  return score;
}

function bestEntry(text) {
  const q = norm(text);
  if (!q) return ENTRIES[0];
  let best = null;
  let bestScore = 0;
  for (const e of ENTRIES) {
    const s = scoreEntry(e, q);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  if (bestScore < 8) return null;
  return best;
}

function shotReply(text) {
  const q = norm(text);
  if (!q) return null;
  // Exact-ish match against few-shot user lines
  let best = null;
  let bestScore = 0;
  for (let i = 0; i < SHOTS.length; i += 2) {
    const u = SHOTS[i];
    const a = SHOTS[i + 1];
    if (!u || !a || u.role !== "user") continue;
    const needle = norm(u.content);
    let s = 0;
    if (q === needle) s = 100;
    else if (q.includes(needle) || needle.includes(q)) s = 60;
    else {
      const words = needle.split(" ").filter((w) => w.length > 2);
      const hits = words.filter((w) => q.includes(w)).length;
      s = hits * 12;
    }
    if (s > bestScore) {
      bestScore = s;
      best = a.content;
    }
  }
  if (bestScore >= 36) return best;
  // Tiny talk heuristics
  if (/^(hey|hi|hello|yo|sup)\b/.test(q)) return "Pip is happy to help. What's on the bench?";
  if (/\b(thanks|thank you|thx)\b/.test(q)) return "Anytime. Don't Panic — next move when you're ready.";
  if (/\b(tired|exhausted|burnt?\s*out)\b/.test(q)) return "Then rest like it counts. After that, one small thing. The days compound.";
  if (/\b(motivat|inspire|pump)\b/.test(q)) return "You already opened the phone. Hunt or draft. That's the whole religion.";
  if (/\b(love you|miss you)\b/.test(q)) return "Crew stays. What's the next real move?";
  return null;
}

function formatEntry(entry) {
  return `${entry.lead}\n\n【 ${entry.title} 】\n${entry.body}`;
}

/**
 * Instant Pip Lite reply. Returns { text, provider, model, leaked } or null if empty input.
 */
export function liteComplete(text, extras = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const shot = shotReply(raw);
  const entry = bestEntry(raw);
  const entryScore = entry ? scoreEntry(entry, norm(raw)) : 0;

  const guideAsk =
    /\b(guide|encyclopedia|survival|how (do|to)|what (should|do) i|help me|tell me about|explain)\b/i.test(
      raw,
    ) || Boolean(entry && entryScore >= 15);

  let out = "";
  let weak = false;
  if (guideAsk && entry && entryScore >= 12) {
    out = formatEntry(entry);
  } else if (shot && (!entry || entryScore < 20)) {
    out = shot;
  } else if (entry && entryScore >= 18) {
    out = formatEntry(entry);
  } else if (shot) {
    out = shot;
  } else {
    weak = true;
    out = formatEntry(ENTRIES[0]);
    out += `\n\nNothing exact matched "${raw.slice(0, 48)}". Name a topic — water, fire, first aid, food, storm, lost — or CONNECT desktop / paste keys for the heavy brain.`;
  }

  const name = extras.operator || "";
  if (name && /\b(hey|hi|hello)\b/i.test(raw) && !out.includes(name)) {
    out = `${name}. ${out}`;
  }

  return {
    text: out.trim(),
    provider: "lite",
    model: "pip-lite",
    leaked: false,
    weak,
  };
}

export function liteTopics() {
  return ENTRIES.map((e) => e.title);
}
