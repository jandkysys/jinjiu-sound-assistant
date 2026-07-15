# Windows Hotkeys and Scoped Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver verified Windows-wide sound/function shortcuts, synchronized controls, scoped playback UI, compact floating window, full PC keyboard binding, and a packaged installer.

**Architecture:** Electron main owns the runtime enable state and Windows registrations. Renderer code persists bindings and UI preferences, while the sound engine enforces one active host sound and one active BGM. Pure policy modules carry normalization, collision, and scoped-player behavior so they can be tested without Electron UI.

**Tech Stack:** Electron 33, React 19, TypeScript, Vite, Node test runner, electron-builder.

## Global Constraints

- Shortcut bindings persist, but every Electron process starts with sound and function shortcuts disabled.
- Numpad Enter is not bindable; top-row digits and numpad digits remain distinct.
- Re-triggering the same sound or BGM restarts it from the beginning.
- Host sounds and BGM are independently exclusive and may play together.
- Package only after verification.

---

### Task 1: Unified shortcut runtime and conflict policy

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `electron/preload-float.js`
- Modify: `src/lib/funcShortcuts.ts`
- Modify: `src/lib/directShortcutKey.ts`
- Modify: `src/lib/shortcutConflictPolicy.ts`
- Test: `src/lib/directShortcutKey.test.ts`
- Test: `src/lib/shortcutConflictPolicy.test.ts`
- Test: `scripts/verify-hotkeys-start-disabled.mjs`
- Test: `scripts/verify-hotkey-window-sync.mjs`

- [ ] Add failing tests for one runtime switch controlling sound and function registrations, true unregister-on-disable, F1-F12, distinct Digit1/Numpad1, numpad operators, and rejected NumpadEnter.
- [ ] Run `npm.cmd run test:direct-shortcut-key`, `npm.cmd run test:shortcut-conflict-policy`, and verification scripts; confirm failures describe missing policy.
- [ ] Implement normalized binding ownership and main-process registration/unregistration with status broadcast.
- [ ] Re-run the focused tests and confirm zero failures.

### Task 2: Playback scopes and deterministic replay

**Files:**
- Modify: `src/lib/scopedPlayer.ts`
- Modify: `src/lib/useSoundEngine.ts`
- Modify: `src/pages/SoundAssistant.tsx`
- Test: `src/lib/scopedPlayer.test.ts`
- Test: `scripts/verify-single-audio-owner.mjs`
- Test: `scripts/verify-scoped-player-ui.mjs`

- [ ] Add failing tests proving host replacement, BGM replacement, cross-scope coexistence, same-item restart, and per-board current item selection.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement scope ownership and force-replay for mouse and shortcut paths; bind each board player to its own scope.
- [ ] Re-run focused tests and confirm zero failures.

### Task 3: Compact synchronized floating panel and window defaults

**Files:**
- Modify: `electron/main.js`
- Modify: `src/components/FloatSoundPanel.tsx`
- Modify: `src/pages/SoundAssistant.tsx`
- Test: `scripts/verify-standalone-float-window.mjs`
- Test: `scripts/verify-hotkey-window-sync.mjs`

- [ ] Add failing assertions for 1280×820 main defaults, approximately 150×78 floating content, removed count strip, drag support, and shared main-process toggle.
- [ ] Run verification scripts and confirm expected failures.
- [ ] Apply compact layout, synchronized toggle, persisted position, and resizable main-window defaults.
- [ ] Re-run focused verification and confirm zero failures.

### Task 4: Full PC keyboard UI

**Files:**
- Modify: `src/pages/SoundAssistant.tsx`
- Modify: `src/lib/directShortcutKey.ts`
- Test: `src/lib/directShortcutKey.test.ts`
- Test: `scripts/verify-full-sound-keyboard.mjs`
- Test: `scripts/verify-shortcut-listen-and-capture.mjs`

- [ ] Add failing assertions for full function row, navigation cluster, numpad keys, disabled NumpadEnter, contrast classes, and replace-confirmation behavior.
- [ ] Run focused tests and confirm expected failures.
- [ ] Render the complete keyboard and route capture through the unified conflict policy.
- [ ] Re-run focused tests and confirm zero failures.

### Task 5: Full verification and Windows package

**Files:**
- Modify only files required by failures discovered during verification.
- Create: `outputs/Jinjiu-Sound-Assistant-1.0.4-verified.zip`
- Create: Windows installer output copied under `outputs/`.

- [ ] Run all shortcut/audio tests and all relevant verification scripts.
- [ ] Run `npm.cmd run typecheck` and `npm.cmd run build:electron`; require exit code 0.
- [ ] Launch Electron and inspect window creation and runtime logs; perform all desktop interactions available in the environment.
- [ ] Run `npm.cmd run dist:win`; require electron-builder exit code 0.
- [ ] Report each acceptance item as pass, fail, or manual-only with evidence; do not convert manual-only items into passes.
