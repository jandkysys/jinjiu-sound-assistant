import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const service = await readFile("src/lib/syncService.ts", "utf8");
const modal = await readFile("src/components/SyncModal.tsx", "utf8");

assert.doesNotMatch(
  service,
  /const\s+toDelete\s*=/,
  "sync must not plan cloud deletions",
);
assert.doesNotMatch(
  service,
  /sounds\/\$\{cloudId\}[\s\S]{0,120}method:\s*["']DELETE["']/,
  "sync must not call the cloud sound DELETE endpoint",
);
assert.doesNotMatch(
  service,
  /deleted:\s*number|stats\.deleted|删除云端旧音效/,
  "sync result must not expose automatic deletion",
);
assert.doesNotMatch(
  modal,
  /stats\.deleted|删除旧音效/,
  "sync modal must not report automatic deletion",
);
assert.match(service, /cloudSoundByNormName/, "preflight must index existing cloud names");
assert.match(service, /classifyNameMatch/, "same names must be compared by hash");
assert.match(service, /keep-cloud/, "conflicts must support keeping the cloud row");
assert.match(service, /save-as/, "conflicts must support uploading with a unique name");
assert.match(service, /prepareFullSync/, "sync must expose a read-only preflight phase");
assert.match(service, /executePreparedSync/, "sync must expose a separate write phase");

console.log("Non-destructive sync verified.");
