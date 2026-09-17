import { normalizeMark, parseDamageMarks, hitTest, newCircle, newArrow } from "../www/damage.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const c = newCircle(0.5, 0.5, 0.08, { kind: "bruise", label: "hit" });
assert(c.type === "circle", "circle type");
assert(c.kind === "bruise", "kind");
assert(c.r > 0.07 && c.r < 0.09, "radius");
assert(hitTest(c, 0.5, 0.5) === "move", "center is move");
assert(hitTest(c, 0.5 + 0.08, 0.5) === "scale", "rim is scale");
assert(!hitTest(c, 0.9, 0.9), "far miss");

const a = newArrow(0.2, 0.8, 0.1, -0.1, { kind: "lift" });
assert(a.type === "arrow", "arrow type");
assert(hitTest(a, 0.2, 0.8) === "move", "arrow tail");
assert(hitTest(a, 0.3, 0.7) === "tip", "arrow tip");

const parsed = parseDamageMarks(`{"marks":[{"type":"circle","x":1.4,"y":-0.2,"r":0.5,"kind":"granule_loss","label":"loss"}]}`);
assert(parsed.length === 1, "one mark");
assert(parsed[0].x === 1, "x clamped");
assert(parsed[0].y === 0, "y clamped");
assert(parsed[0].r <= 0.35, "r clamped");
assert(parsed[0].auto === true, "auto flag");
assert(parsed[0].kind === "granule_loss", "kind kept");

const junk = normalizeMark({ type: "circle", x: "nope", kind: "spaceship" });
assert(junk.kind === "other", "unknown kind");
assert(junk.x === 0, "bad x");

const empty = parseDamageMarks("not json");
assert(empty.length === 0, "bad json empty");

console.log("damage-marks ok");
