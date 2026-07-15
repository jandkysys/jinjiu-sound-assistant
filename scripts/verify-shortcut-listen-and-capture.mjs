import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/pages/SoundAssistant.tsx", "utf8");
assert.match(source, /shouldTriggerDirectShortcut\(appSettings\.shortcutMode, e\.target\)/);
assert.match(source, /appSettings\.shortcutMode === "register" && s\.shortcut/);
assert.match(source, /按键后不会自动关闭/);
assert.match(source, /已被「\{gsDirectConflict\.name\}」占用/);
assert.match(source, /替换原快捷键/);
assert.match(source, /确认保存/);
console.log("Listening mode and staged global shortcut capture verified.");
