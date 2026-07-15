import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [main, panel, assistant] = await Promise.all([
  readFile("electron/main.js", "utf8"),
  readFile("src/components/FloatSoundPanel.tsx", "utf8"),
  readFile("src/pages/SoundAssistant.tsx", "utf8"),
]);

assert.match(main, /let hotkeyEnabled = false;/);
assert.match(main, /else \{\s*globalShortcut\.unregisterAll\(\);\s*\}/);
assert.match(main, /const _gsHandlers = new Map\(\)/);
assert.match(main, /const _funcGsHandlers = new Map\(\)/);
assert.doesNotMatch(main, /hotkeyEnabled\s*=\s*cfg\.hotkeyEnabled/);
assert.match(main, /loadApiConfig\(\);[\s\S]{0,160}hotkeyEnabled = false;/);
assert.match(panel, /useState<boolean>\(false\)/);
assert.doesNotMatch(panel, /localStorage\.getItem\(FLOAT_SHORTCUTS_KEY\) === "1"/);
assert.match(panel, /getHotkeyStatus\?\.\(\)/);
assert.match(panel, /onHotkeyStatusChanged\?\.\(/);
assert.doesNotMatch(panel, /isInitialHotkeySyncRef|isFromMainHotkeyRef/);
assert.match(panel, /notifyHotkeyStatus\?\.\(next\)/);
assert.match(assistant, /window\.electronAPI\?\.isElectron \? false :/);

console.log("Global sound shortcuts start disabled.");
