import {
  LIVE_WINDOW_HOURS,
  STORM_LIST_PAGE_SIZE,
  assembleRainViewerRadarFrames,
  buildLiveTimelineSteps,
  liveWindowBounds,
  liveWindowStepSec,
  setLiveWindowHrs,
  getLiveWindowHrs,
  stormListPageSlice,
} from "../www/wx.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

assert(LIVE_WINDOW_HOURS.join(",") === "2,6,12,24", "window choices");
assert(setLiveWindowHrs(6) === 6, "set 6");
assert(getLiveWindowHrs() === 6, "get 6");
assert(setLiveWindowHrs(99) === 6, "invalid window falls back to 6");
assert(setLiveWindowHrs(24) === 24, "set 24");
assert(liveWindowStepSec(2) === 600, "2h step");
assert(liveWindowStepSec(6) === 900, "6h step");
assert(liveWindowStepSec(12) === 1500, "12h step");
assert(liveWindowStepSec(24) === 2400, "24h step");

const { t0, t1 } = liveWindowBounds(1_000_000, 6);
assert(t1 - t0 === 12 * 3600, `6h window span ${t1 - t0}`);
assert(t0 === 1_000_000 - 6 * 3600, "6h start");

const now = 2_000_000;
const radar = [
  { time: now - 3600, path: "/a" },
  { time: now, path: "/b" },
  { time: now + 3600, path: "/c" },
];
const wind = [
  { time: now - 7200, speed: 8 },
  { time: now, speed: 12 },
  { time: now + 7200, speed: 10 },
];
const steps = buildLiveTimelineSteps({
  t0: now - 6 * 3600,
  t1: now + 6 * 3600,
  dt: 900,
  radar,
  wind,
});
assert(steps.length >= 40, `6h/15min steps ${steps.length}`);
assert(steps[0].radarIdx === 0, "first step nearest first radar");
assert(steps.some((s) => s.windIdx === 2), "timeline reaches last wind frame");

const past = Array.from({ length: 12 }, (_, i) => ({ time: 100 + i * 600, path: `/p${i}` }));
const nowcast = Array.from({ length: 6 }, (_, i) => ({ time: 100 + 12 * 600 + i * 600, path: `/n${i}` }));
const assembled = assembleRainViewerRadarFrames(past, nowcast);
assert(assembled.frames.length === 18, `keep all past+nowcast, got ${assembled.frames.length}`);
assert(assembled.presentIdx === 11, `present at last past frame, got ${assembled.presentIdx}`);
assert(assembled.frames[0].path === "/p0", "oldest past kept");

assert(STORM_LIST_PAGE_SIZE === 20, "page size 20");
const days = Array.from({ length: 47 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}` }));
const p0 = stormListPageSlice(days, 0);
assert(p0.items.length === 20 && p0.pages === 3 && p0.page === 0, "page 1");
const p2 = stormListPageSlice(days, 2);
assert(p2.items.length === 7 && p2.page === 2, "last page remainder");
const pOver = stormListPageSlice(days, 99);
assert(pOver.page === 2, "page clamps to last");
assert(stormListPageSlice([], 0).pages === 1, "empty list still one page");

console.log("live-window ok");
