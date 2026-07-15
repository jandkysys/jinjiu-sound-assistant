import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [main, panel, assistant] = await Promise.all([
  readFile("electron/main.js", "utf8"),
  readFile("src/components/FloatSoundPanel.tsx", "utf8"),
  readFile("src/pages/SoundAssistant.tsx", "utf8"),
]);

assert.match(main, /width:\s*1280,[\s\S]{0,120}height:\s*820,/);
assert.match(main, /minWidth:\s*860,[\s\S]{0,120}minHeight:\s*620,/);
assert.match(main, /resizable:\s*true,/);
assert.match(main, /const width = 150;[\s\S]{0,80}const height = 78;/);

const notifyHandler = main.match(/ipcMain\.handle\("notify-hotkey-status"[\s\S]*?\n  \}\);/)?.[0] ?? "";
assert.match(notifyHandler, /syncOsShortcuts\(\);[\s\S]*broadcastHotkeyStatus\(\);/);

assert.match(panel, /<span className="fsp-title">金玖<\/span>/);
assert.doesNotMatch(panel, /已设置 \{withKey\}/);
assert.doesNotMatch(panel, /isFromMainHotkeyRef/);
assert.match(panel, /notifyHotkeyStatus\?\.\(next\)/);
assert.doesNotMatch(panel, /withKey|withoutKey|å·²è®¾ç½®.*å¿«æ·é”®/);
assert.doesNotMatch(assistant, /minWidth:\s*960/);

console.log("Hotkey toggle synchronization and compact window geometry verified.");
