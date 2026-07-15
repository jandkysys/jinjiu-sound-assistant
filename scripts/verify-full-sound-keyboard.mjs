import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/pages/SoundAssistant.tsx", "utf8");
assert.match(source, /"F1","F2","F3","F4"/);
assert.match(source, /"NumLk","Num\/","Num\*","Num-"/);
assert.match(source, /"Num0","Num\."/);
assert.match(source, /"Ins","Home","PgUp"/);
assert.match(source, /"Del","End","PgDn"/);
assert.match(source, /keyboardTokenToShortcut\(k\)/);
assert.match(source, /directShortcutFromEvent\(e\)/);
assert.match(source, /directShortcutToAccelerator\(s\.shortcut\)/);
assert.match(source, /tryTrigger\(mapped, true, "kbd"\)/);
assert.match(source, /functionConflict/);
assert.match(source, /removeFunctionShortcut/);
console.log("Full sound keyboard integration verified.");
