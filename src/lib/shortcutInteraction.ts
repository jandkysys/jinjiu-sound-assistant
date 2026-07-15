export type ShortcutMode = "register" | "listen";

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || !!element?.isContentEditable;
}

export function shouldTriggerDirectShortcut(mode: ShortcutMode, target: EventTarget | null): boolean {
  return mode === "register" || !isEditableShortcutTarget(target);
}
