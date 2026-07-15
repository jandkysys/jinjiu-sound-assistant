import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyNameMatch, normalizeCloudHash, validateSaveAsName } from "./syncConflicts.ts";

test("same hash reuses the cloud audio", () => {
  assert.equal(classifyNameMatch("aa11", "sha256:AA11"), "same-file");
});

test("different hash is an explicit content conflict", () => {
  assert.equal(classifyNameMatch("aa11", "bb22"), "different-file");
});

test("missing cloud hash is never treated as equal by size", () => {
  assert.equal(classifyNameMatch("aa11", null), "unknown-cloud-file");
});

test("save-as name must be unique after normalization", () => {
  assert.equal(validateSaveAsName("B-PK欢呼", new Set(["a-欢迎掌声"])), null);
  assert.match(validateSaveAsName("掌声.mp3", new Set(["掌声"])) ?? "", /已经存在/);
});

test("normalizes prefix and case", () => {
  assert.equal(normalizeCloudHash("SHA256:ABCDEF"), "abcdef");
});
