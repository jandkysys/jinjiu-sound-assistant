import test from "node:test";
import assert from "node:assert/strict";
import {
  findFunctionConflict,
  removeFunctionShortcut,
} from "./shortcutConflictPolicy.ts";

test("finds a function binding that owns the requested sound key", () => {
  assert.deepEqual(
    findFunctionConflict({ bgmNext: "f5" }, "f5"),
    { id: "bgmNext", label: "背景音乐下一首" },
  );
});

test("returns null when no function owns the key", () => {
  assert.equal(findFunctionConflict({ bgmNext: "f5" }, "f6"), null);
});

test("removes only the confirmed conflicting function binding", () => {
  assert.deepEqual(
    removeFunctionShortcut({ bgmNext: "f5", sfxStop: "escape" }, "bgmNext"),
    { sfxStop: "escape" },
  );
});
