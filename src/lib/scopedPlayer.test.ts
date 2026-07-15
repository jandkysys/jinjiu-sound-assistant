import assert from "node:assert/strict";
import { rememberScopedTrack, visibleScopedTrack } from "./scopedPlayer.ts";

const remembered = rememberScopedTrack({ main: "host-1" }, "kbd", "key-1");
assert.deepEqual(remembered, { main: "host-1", kbd: "key-1" });
assert.equal(visibleScopedTrack("kbd", remembered, new Set(["key-1"]), new Set()), "key-1");
assert.equal(visibleScopedTrack("main", remembered, new Set(["key-1"]), new Set()), null);
assert.equal(visibleScopedTrack("main", remembered, new Set(), new Set(["host-1"])), "host-1");
