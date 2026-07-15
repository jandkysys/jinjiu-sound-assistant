import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const service = await readFile("src/lib/syncService.ts", "utf8");
assert.match(service, /export\s+async\s+function\s+prepareFullSync/);
assert.match(service, /export\s+async\s+function\s+executePreparedSync/);
assert.match(service, /sha256Hex/);
assert.match(service, /classifyNameMatch/);
const preflight = service.slice(service.indexOf("export async function prepareFullSync"), service.indexOf("export async function executePreparedSync"));
assert.doesNotMatch(preflight, /method:\s*["'](?:POST|PATCH|DELETE)["']/);
console.log("Sync conflict preflight verified.");
