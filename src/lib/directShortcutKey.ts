export interface KeyboardShortcutEvent {
  key: string;
  code?: string;
}

const NUMPAD_CODE_TO_SHORTCUT: Record<string, string> = {
  Numpad0: "numpad0",
  Numpad1: "numpad1",
  Numpad2: "numpad2",
  Numpad3: "numpad3",
  Numpad4: "numpad4",
  Numpad5: "numpad5",
  Numpad6: "numpad6",
  Numpad7: "numpad7",
  Numpad8: "numpad8",
  Numpad9: "numpad9",
  NumpadAdd: "numpadadd",
  NumpadSubtract: "numpadsubtract",
  NumpadMultiply: "numpadmultiply",
  NumpadDivide: "numpaddivide",
  NumpadDecimal: "numpaddecimal",
  // Electron has no distinct global Accelerator for numpad Enter.
  NumpadEnter: "",
};

const TOKEN_TO_SHORTCUT: Record<string, string | null> = {
  Space: " ",
  Enter: "enter",
  NumEnt: null,
  NumLk: null,
  "Num+": "numpadadd",
  "Num-": "numpadsubtract",
  "Num*": "numpadmultiply",
  "Num/": "numpaddivide",
  "Num.": "numpaddecimal",
};

const SHORTCUT_TO_ACCELERATOR: Record<string, string> = {
  " ": "Space",
  enter: "Enter",
  numpadadd: "numadd",
  numpadsubtract: "numsub",
  numpadmultiply: "nummult",
  numpaddivide: "numdiv",
  numpaddecimal: "numdec",
};

const SHORTCUT_LABELS: Record<string, string> = {
  " ": "Space",
  enter: "Enter",
  numpadadd: "Num +",
  numpadsubtract: "Num -",
  numpadmultiply: "Num ×",
  numpaddivide: "Num ÷",
  numpaddecimal: "Num .",
};

export function directShortcutFromEvent(event: KeyboardShortcutEvent): string | null {
  if (event.code === "NumpadEnter") return null;
  const byCode = event.code ? NUMPAD_CODE_TO_SHORTCUT[event.code] : undefined;
  if (byCode) return byCode;

  if (event.key === " ") return " ";
  if (event.key === "Enter") return "enter";
  if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) return event.key.toLowerCase();
  if (event.key.length === 1) return event.key.toLowerCase();
  return null;
}

export function keyboardTokenToShortcut(token: string): string | null {
  if (token in TOKEN_TO_SHORTCUT) return TOKEN_TO_SHORTCUT[token];
  const numpadDigit = /^Num([0-9])$/.exec(token);
  if (numpadDigit) return `numpad${numpadDigit[1]}`;
  if (/^F(?:[1-9]|1[0-2])$/.test(token)) return token.toLowerCase();
  if (token.length === 1) return token.toLowerCase();
  return null;
}

export function directShortcutToAccelerator(shortcut: string): string {
  const mapped = SHORTCUT_TO_ACCELERATOR[shortcut];
  if (mapped) return mapped;
  const numpadDigit = /^numpad([0-9])$/.exec(shortcut);
  if (numpadDigit) return `num${numpadDigit[1]}`;
  if (/^f(?:[1-9]|1[0-2])$/.test(shortcut)) return shortcut.toUpperCase();
  return shortcut.length === 1 ? shortcut.toUpperCase() : shortcut;
}

export function directShortcutLabel(shortcut: string): string {
  const mapped = SHORTCUT_LABELS[shortcut];
  if (mapped) return mapped;
  const numpadDigit = /^numpad([0-9])$/.exec(shortcut);
  if (numpadDigit) return `Num ${numpadDigit[1]}`;
  return shortcut.toUpperCase();
}
