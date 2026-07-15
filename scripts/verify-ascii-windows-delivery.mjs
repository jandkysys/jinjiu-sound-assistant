import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const builder = await readFile("electron-builder.yml", "utf8");

assert.equal(pkg.version, "1.0.5");
assert.match(
  builder,
  /artifactName:\s*Jinjiu-Sound-Assistant-Setup-\$\{version\}\.\$\{ext\}/,
);
assert.match(builder, /productName:\s*金玖音效助手/);

console.log("ASCII Windows delivery naming verified.");
