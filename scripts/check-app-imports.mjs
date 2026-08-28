/** Lists names imported by www/app.js that never appear in the module body. */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "www/app.js"), "utf8");
const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)"/g;
let m;
let unused = 0;
while ((m = importRe.exec(src))) {
  const body = src.slice(importRe.lastIndex);
  for (const raw of m[1].split(",")) {
    const name = raw.trim().split(/\s+as\s+/).pop();
    if (!name) continue;
    const re = new RegExp(`\\b${name}\\b`);
    if (!re.test(body)) {
      console.log(`UNUSED: ${name} (from ${m[2]})`);
      unused += 1;
    }
  }
}
console.log(unused ? `${unused} unused import(s)` : "all imports used");
