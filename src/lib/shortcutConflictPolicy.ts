export interface FunctionShortcutConflict {
  id: string;
  label: string;
}

const FUNCTION_SHORTCUT_LABELS: Record<string, string> = {
  sfxStop: "音效停止",
  sfxPause: "音效暂停",
  sfxVolUp: "音效音量增大",
  sfxVolDown: "音效音量减小",
  toggleLoop: "切换音效循环播放开启状态",
  duck: "闪避 / 压音",
  bgmPlayPause: "背景音乐播放 / 暂停",
  bgmPrev: "背景音乐上一首",
  bgmNext: "背景音乐下一首",
  bgmVolUp: "背景音乐音量增大",
  bgmVolDown: "背景音乐音量减小",
  toggleShortcuts: "切换快捷键开启状态",
  toggleWindow: "打开 / 缩小窗口",
};

export function findFunctionConflict(
  bindings: Record<string, string>,
  shortcut: string,
): FunctionShortcutConflict | null {
  const entry = Object.entries(bindings).find(([, bound]) => bound === shortcut);
  if (!entry) return null;
  const [id] = entry;
  return { id, label: FUNCTION_SHORTCUT_LABELS[id] ?? id };
}

export function removeFunctionShortcut(
  bindings: Record<string, string>,
  id: string,
): Record<string, string> {
  if (!(id in bindings)) return bindings;
  const next = { ...bindings };
  delete next[id];
  return next;
}
