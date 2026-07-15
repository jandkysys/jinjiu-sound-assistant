import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const productionOrigin = "https://crystal-clear-prompt.replit.app";
const files = [
  "src/config/backend.ts",
  "electron/main.js",
  "vite.config.electron.ts",
  "vite.electron.config.ts",
];

const contents = await Promise.all(
  files.map(async (file) => [file, await readFile(file, "utf8")]),
);

for (const [file, content] of contents) {
  assert.ok(
    content.includes(productionOrigin),
    `${file} must include the production backend origin`,
  );
}

const rendererFiles = [
  "src/App.tsx",
  "src/components/CloudSyncPanel.tsx",
  "src/components/ServerSetup.tsx",
];

for (const file of rendererFiles) {
  const content = await readFile(file, "utf8");
  assert.ok(
    content.includes('from "@/config/backend"'),
    `${file} must import the shared backend config`,
  );
}

const productionFiles = [
  "src/config/backend.ts",
  "vite.config.electron.ts",
  "vite.electron.config.ts",
  ...rendererFiles,
];
for (const file of productionFiles) {
  const content = await readFile(file, "utf8");
  assert.equal(
    /https?:\/\/(localhost|127\.0\.0\.1)|\.replit\.dev/i.test(content),
    false,
    `${file} contains a forbidden production backend`,
  );
}

const electronMain = await readFile("electron/main.js", "utf8");
assert.ok(
  electronMain.includes('const isDev = process.env.NODE_ENV === "development";'),
  "electron/main.js must gate local URLs behind development mode",
);
assert.ok(
  electronMain.includes('mainWindow.loadFile(path.join(__dirname, "../dist/electron/index.html"))'),
  "electron/main.js must load the packaged production bundle",
);

console.log("Production backend configuration verified.");
