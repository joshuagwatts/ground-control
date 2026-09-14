import { teamAlphaLink, TEAM_WEB_URL, TEAM_ALPHA_URL } from "../www/team.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const url = teamAlphaLink("0.2.315");
assert(url.startsWith(TEAM_ALPHA_URL), "alpha origin");
assert(!url.startsWith(TEAM_WEB_URL + "?"), "alpha is not the team root query");
assert(/[?&]v=0\.2\.315/.test(url), "version cache bust");
assert(/\/alpha\//.test(url), "separate /alpha/ path");
assert(!/[?&]alpha=1/.test(url), "no fake alpha query on team app");
assert(!teamAlphaLink("").includes("v="), "omit empty version");
console.log("team ok");
