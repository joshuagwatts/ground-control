import test from "node:test";
import assert from "node:assert/strict";
import {
  homescopeRecommendation,
  draftClaimRecommendation,
  CLAIM_RULES,
} from "../www/homeowner/product.js";

test("claim: IDK roof uses 2-year window and needs 2+ storms ≥1\"", () => {
  const asOf = new Date("2026-09-08T12:00:00Z");
  const storms = [
    { date: "2025-05-01", maxSizeIn: 1.0, coversHome: true },
    { date: "2024-10-15", maxSizeIn: 1.5, coversHome: true },
    { date: "2023-04-01", maxSizeIn: 2.0, coversHome: true },
  ];
  const rec = homescopeRecommendation({ storms, roofReplacedOn: null, asOf });
  assert.equal(rec.considerClaim, true);
  assert.equal(rec.qualifying.length, 2);
  assert.equal(rec.primaryCta, "Get a free inspection");
  assert.match(rec.windowStart, /^2024-/);
});

test("claim: known roof start truncates older storms", () => {
  const asOf = new Date("2026-09-08T12:00:00Z");
  const storms = [
    { date: "2025-05-01", maxSizeIn: 1.25, coversHome: true },
    { date: "2024-06-15", maxSizeIn: 1.5, coversHome: true },
  ];
  const rec = draftClaimRecommendation({
    storms,
    roofReplacedOn: "2025-01-01",
    asOf,
  });
  assert.equal(rec.considerClaim, false);
  assert.equal(rec.qualifying.length, 1);
  assert.equal(rec.windowStart, "2025-01-01");
});

test("talk to roofer: recent roof + one 1\"+ storm", () => {
  const asOf = new Date("2026-09-08T12:00:00Z");
  const storms = [{ date: "2025-08-01", maxSizeIn: 1.25, coversHome: true }];
  const rec = homescopeRecommendation({
    storms,
    roofReplacedOn: "2025-01-15",
    asOf,
  });
  assert.equal(rec.talkToRoofer, true);
  assert.equal(rec.considerClaim, false);
  assert.equal(rec.secondaryCta, "Talk to a roofer");
  assert.equal(rec.primaryCta, "Get a free inspection");
});

test("no talk-to-roofer when roof older than 2 years", () => {
  const asOf = new Date("2026-09-08T12:00:00Z");
  const storms = [{ date: "2025-08-01", maxSizeIn: 1.25, coversHome: true }];
  const rec = homescopeRecommendation({
    storms,
    roofReplacedOn: "2020-01-01",
    asOf,
  });
  assert.equal(rec.talkToRoofer, false);
  assert.equal(CLAIM_RULES.recentRoofYears, 2);
});

test("storms that miss the home do not count", () => {
  const asOf = new Date("2026-09-08T12:00:00Z");
  const storms = [
    { date: "2025-05-01", maxSizeIn: 2, coversHome: false },
    { date: "2025-06-01", maxSizeIn: 2, coversHome: true },
  ];
  const rec = homescopeRecommendation({ storms, roofReplacedOn: null, asOf });
  assert.equal(rec.considerClaim, false);
});
