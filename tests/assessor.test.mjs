import assert from "node:assert";
import { ownerSearchTokens, ownerSearchWhere, geometryCentroid } from "../www/assessor.js";

// ownerSearchTokens
assert.deepStrictEqual(ownerSearchTokens("John Smith"), ["JOHN", "SMITH"]);
assert.deepStrictEqual(ownerSearchTokens("  smith, john a.  "), ["SMITH", "JOHN"]);
assert.deepStrictEqual(ownerSearchTokens("ABC Holdings LLC"), ["ABC", "HOLDINGS", "LLC"]);
assert.deepStrictEqual(ownerSearchTokens("O'Brien"), ["BRIEN"]); // apostrophe stripped, 1-letter drop
assert.deepStrictEqual(ownerSearchTokens(""), []);
assert.deepStrictEqual(ownerSearchTokens("a"), []);

// ownerSearchWhere — every token ANDed, fields ORed, SQL-escaped
const w = ownerSearchWhere("ok-county", "John Smith");
assert.ok(w.includes("UPPER(name1) LIKE '%JOHN%'"), `token in fields: ${w}`);
assert.ok(w.includes("UPPER(name3) LIKE '%SMITH%'"), `second token: ${w}`);
assert.ok(w.includes(" OR ") && w.includes(" AND "), `boolean shape: ${w}`);
const w2 = ownerSearchWhere("rogers", "O''Brien");
assert.ok(w2.includes("O''''BRIEN") || w2.includes("BRIEN"), `escaped: ${w2}`);
assert.ok(!w2.includes("'''"), "no triple-quote injection");
assert.strictEqual(ownerSearchWhere("ok-county", ""), "");
assert.strictEqual(ownerSearchWhere("nope", "John Smith"), "");

// geometryCentroid — ArcGIS rings are [x=lon, y=lat]
const c = geometryCentroid({ rings: [[[-97.6, 35.3], [-97.5, 35.3], [-97.5, 35.4], [-97.6, 35.4], [-97.6, 35.3]]] });
assert.ok(Math.abs(c.lon - -97.56) < 1e-9 && Math.abs(c.lat - 35.34) < 1e-9, `centroid: ${JSON.stringify(c)}`);
assert.strictEqual(geometryCentroid({}), null);
assert.strictEqual(geometryCentroid({ rings: [] }), null);
assert.strictEqual(geometryCentroid({ rings: [[[NaN, 1]]] }), null);

console.log("assessor ok");
