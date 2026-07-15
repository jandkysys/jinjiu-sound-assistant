import assert from "node:assert/strict";
import test from "node:test";

import { createTriggerDeduper } from "./triggerDeduper";

test("rejects the same sound inside the 80 ms delivery window", () => {
  const deduper = createTriggerDeduper(80);

  assert.equal(deduper.shouldRun("sound-a", 1_000), true);
  assert.equal(deduper.shouldRun("sound-a", 1_080), false);
  assert.equal(deduper.shouldRun("sound-a", 1_081), true);
});

test("tracks different sound ids independently", () => {
  const deduper = createTriggerDeduper(80);

  assert.equal(deduper.shouldRun("sound-a", 2_000), true);
  assert.equal(deduper.shouldRun("sound-b", 2_001), true);
});
