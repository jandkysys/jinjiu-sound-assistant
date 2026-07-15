import test from "node:test";
import assert from "node:assert/strict";
import {
  directShortcutFromEvent,
  keyboardTokenToShortcut,
  directShortcutLabel,
  directShortcutToAccelerator,
} from "./directShortcutKey.ts";

test("distinguishes top-row digits from numpad digits", () => {
  assert.equal(directShortcutFromEvent({ key: "1", code: "Digit1" }), "1");
  assert.equal(directShortcutFromEvent({ key: "1", code: "Numpad1" }), "numpad1");
});

test("maps function and numpad operator keyboard tokens", () => {
  assert.equal(keyboardTokenToShortcut("F5"), "f5");
  assert.equal(keyboardTokenToShortcut("Num+"), "numpadadd");
  assert.equal(keyboardTokenToShortcut("Num-"), "numpadsubtract");
  assert.equal(keyboardTokenToShortcut("Num*"), "numpadmultiply");
  assert.equal(keyboardTokenToShortcut("Num/"), "numpaddivide");
  assert.equal(keyboardTokenToShortcut("Num."), "numpaddecimal");
  assert.equal(keyboardTokenToShortcut("NumEnt"), null);
});

test("maps real numpad operator events", () => {
  assert.equal(directShortcutFromEvent({ key: "+", code: "NumpadAdd" }), "numpadadd");
  assert.equal(directShortcutFromEvent({ key: "Enter", code: "NumpadEnter" }), null);
});

test("creates Electron-supported accelerators", () => {
  assert.equal(directShortcutToAccelerator("numpad1"), "num1");
  assert.equal(directShortcutToAccelerator("numpaddecimal"), "numdec");
  assert.equal(directShortcutToAccelerator("numpadadd"), "numadd");
  assert.equal(directShortcutToAccelerator("f5"), "F5");
});

test("formats human-readable labels", () => {
  assert.equal(directShortcutLabel("numpad1"), "Num 1");
  assert.equal(directShortcutLabel("numpadadd"), "Num +");
  assert.equal(directShortcutLabel(" "), "Space");
});
