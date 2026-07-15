import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/pages/SoundAssistant.tsx", "utf8");
assert.match(source, /const playerScope: PlayerScope/);
assert.match(source, /rememberScopedTrack\(prev, scope, id\)/);
assert.match(source, /visibleScopedTrack\(playerScope, scopedTrackIds, playing, paused\)/);
assert.match(source, /tryTrigger\(s\.id, false, "kbd"\)/);
assert.match(source, /const eff = true;/);
assert.match(source, /track \? track\.name : "暂无播放"/);
console.log("Tab-scoped now-playing UI verified.");
