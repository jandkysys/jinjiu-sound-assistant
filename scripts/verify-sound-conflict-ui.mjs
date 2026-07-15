import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dialog = await readFile("src/components/SoundConflictDialog.tsx", "utf8");
const sync = await readFile("src/components/SyncModal.tsx", "utf8");
const cloud = await readFile("src/components/CloudManageTab.tsx", "utf8");
assert.match(dialog, /保留云端/);
assert.match(dialog, /另存为新音效/);
assert.match(dialog, /覆盖云端/);
assert.match(dialog, /disabled/);
assert.match(dialog, /A-欢迎掌声/);
assert.match(dialog, /场景-用途-名称/);
assert.match(sync, /prepareFullSync/);
assert.match(sync, /executePreparedSync/);
assert.match(cloud, /SoundConflictDialog/);
assert.match(cloud, /<SyncModal/, "legacy cloud-manage sync must use the same preflight modal");
assert.doesNotMatch(cloud, /async function syncLocalSounds/, "cloud-manage must not keep a bypass sync implementation");
console.log("Sound conflict UI verified.");
