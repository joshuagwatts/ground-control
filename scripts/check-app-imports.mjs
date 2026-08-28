import fs from "node:fs";

const s = fs.readFileSync("www/app.js", "utf8");
const used = new Set([...s.matchAll(/\b(bindWxMap\w+|setWxMapExpanded)\b/g)].map((m) => m[1]));
const i = s.indexOf('from "./wx.js');
const block = s.slice(s.lastIndexOf("import", i), i + 80);
const imported = new Set([...block.matchAll(/\b(bindWxMap\w+|setWxMapExpanded)\b/g)].map((m) => m[1]));

const missing = [...used].filter((n) => !imported.has(n));
if (missing.length) {
  console.error("Missing wx imports:", missing.join(", "));
  process.exit(1);
}
console.log("wx imports ok:", [...imported].sort().join(", "));
