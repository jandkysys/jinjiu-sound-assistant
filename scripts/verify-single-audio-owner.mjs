import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [main, assistant, panel] = await Promise.all([
  readFile("electron/main.js", "utf8"),
  readFile("src/pages/SoundAssistant.tsx", "utf8"),
  readFile("src/components/FloatSoundPanel.tsx", "utf8"),
]);

assert.doesNotMatch(
  main,
  /createFloatPanelWindow\(\);\s*createAudioWindow\(\)/,
  "the production lifecycle must not create a second audio renderer",
);
assert.match(
  main,
  /const handler = \(\) => \{\s*if \(mainWindow && !mainWindow\.isDestroyed\(\)\) \{\s*mainWindow\.webContents\.send\("gs-fire", key\);\s*\}\s*\};/,
  "sound shortcut IPC must target only the main window",
);
assert.doesNotMatch(main, /audioWindow\.webContents\.send\("gs-fire"/);
assert.match(assistant, /s\.shortcut \?\? ""/);
assert.match(assistant, /s\.globalShortcut \?\? ""/);
assert.match(assistant, /directShortcutToAccelerator\(s\.shortcut\)/);
assert.match(assistant, /appSettings\.shortcutMode === "register"/);
assert.doesNotMatch(assistant, /isElectron && !window\.electronAPI\?\.isAudioWorker/);
assert.match(panel, /if \(standalone && window\.electronAPI\?\.isElectron\) return;/);

console.log("Single Electron audio owner verified.");
