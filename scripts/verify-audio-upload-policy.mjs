import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const store = await readFile("src/lib/audioStore.ts", "utf8");
const sync = await readFile("src/lib/syncService.ts", "utf8");
const cloud = await readFile("src/components/CloudManageTab.tsx", "utf8");
const assistant = await readFile("src/pages/SoundAssistant.tsx", "utf8");
const manage = await readFile("src/pages/ManagePage.tsx", "utf8");

for (const [name, source] of [["audioStore", store], ["syncService", sync], ["CloudManageTab", cloud]]) {
  assert.match(source, /audioUploadPolicy/, `${name} must use the shared audio policy`);
}
assert.doesNotMatch(sync, /function\s+blobExtension/);
assert.doesNotMatch(cloud, /blob\.type\.split\(["']\/["']\)/);
assert.doesNotMatch(store, /return\s+MIME_TO_EXT\[[^\]]+\]\s*\?\?\s*["']mp3["']/);
assert.match(assistant, /putAudioBlob\(newId, file, undefined, file\.name\)/);
assert.match(manage, /putAudioBlob\(id, f, undefined, f\.name\)/);
console.log("Shared audio upload policy verified.");
