import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, panel, css, main, preload] = await Promise.all([
  readFile("src/App.tsx", "utf8"),
  readFile("src/components/FloatSoundPanel.tsx", "utf8"),
  readFile("src/index.css", "utf8"),
  readFile("electron/main.js", "utf8"),
  readFile("electron/preload.js", "utf8"),
]);

assert.match(app, /Route path="\/float-sound-panel"/);
assert.match(app, /<FloatSoundPanel standalone/);
assert.doesNotMatch(
  app,
  /!isSettings\s*&&\s*!isManage\s*&&\s*<FloatSoundPanel/,
  "main pages must not render a duplicate floating panel",
);
assert.match(panel, /standalone\??:\s*boolean/);
assert.match(css, /-webkit-app-region:\s*drag/);
assert.match(css, /-webkit-app-region:\s*no-drag/);
assert.match(main, /function\s+createFloatPanelWindow\s*\(/);
assert.match(main, /createFloatPanelWindow\(\)/);
assert.match(main, /#\/float-sound-panel|hash:\s*["']\/float-sound-panel["']/);
assert.match(main, /hotkeyFloatWindow\.on\(["']close["']/);
assert.match(main, /hotkeyFloatWindow\.on\(["']move["']/);
assert.match(main, /显示悬浮快捷键|隐藏悬浮快捷键/);
assert.match(preload, /isFloatPanel:\s*process\.argv\.includes\(["']--float-panel["']\)/);

console.log("Standalone floating shortcut window verified.");
