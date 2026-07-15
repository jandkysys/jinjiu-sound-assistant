import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [assistant, engine] = await Promise.all([
  readFile("src/pages/SoundAssistant.tsx", "utf8"),
  readFile("src/lib/useSoundEngine.ts", "utf8"),
]);

for (const prop of ["bgmMode", "onBgmModeChange", "onPrev", "onNext"]) {
  assert.match(assistant, new RegExp(`${prop}:`), `NowPlayingBar must declare ${prop}`);
}
assert.match(assistant, /"单曲循环"/);
assert.match(assistant, /"随机播放"/);
assert.match(assistant, /"列表循环"/);
assert.equal((assistant.match(/bgmMode=\{bgmMode\}/g) ?? []).length, 2);
assert.equal((assistant.match(/onBgmModeChange=\{setBgmMode\}/g) ?? []).length, 2);
assert.equal((assistant.match(/onPrev=\{bgmPrev\}/g) ?? []).length, 2);
assert.equal((assistant.match(/onNext=\{bgmNext\}/g) ?? []).length, 2);
assert.match(assistant, /track\.type === "bgm" \|\| track\.type === "pk"/);
assert.match(engine, /function loadBgmMode\(\): BgmMode[\s\S]*?return "single";/);

console.log("BGM player mode and track controls verified.");
