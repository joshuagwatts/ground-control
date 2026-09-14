import { teamAlphaLink, TEAM_WEB_URL } from "../www/team.js";

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}

const url = teamAlphaLink("0.2.313");
assert(url.startsWith(TEAM_WEB_URL), "pages origin");
assert(/[?&]v=0\.2\.313/.test(url), "version cache bust");
assert(/[?&]alpha=1/.test(url), "alpha flag");
assert(!teamAlphaLink("").includes("v="), "omit empty version");
console.log("team ok");
