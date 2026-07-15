import assert from "node:assert/strict";
import { isEditableShortcutTarget, shouldTriggerDirectShortcut } from "./shortcutInteraction.ts";

const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
const textarea = { tagName: "textarea", isContentEditable: false } as unknown as EventTarget;
const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
const button = { tagName: "BUTTON", isContentEditable: false } as unknown as EventTarget;
assert.equal(isEditableShortcutTarget(input), true);
assert.equal(isEditableShortcutTarget(textarea), true);
assert.equal(isEditableShortcutTarget(editable), true);
assert.equal(shouldTriggerDirectShortcut("listen", input), false);
assert.equal(shouldTriggerDirectShortcut("listen", button), true);
assert.equal(shouldTriggerDirectShortcut("register", input), true);
