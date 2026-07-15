import { pinyin } from "pinyin-pro";

// 拼音匹配辅助：把一段文本（场景名/分类名/话术）转换为「逐字拼音」，
// 用于在搜索时支持「拼音全拼（youhui）」与「首字母（yh）」命中中文。
// 设计要点：
// - pinyin-pro 以「码点」为单位返回数组（与 [...text] 对齐，含 emoji），
//   每个中文字 → 其拼音；非中文字符 → 字符本身。
// - 命中返回的 span 用「UTF-16 字符串下标」表达，与现有 highlight()
//   的 substring 高亮保持一致，从而高亮始终指向原始中文字符。

type CharInfo = {
  // 原文按码点拆分后的字符数组
  chars: string[];
  // 每个字符的全拼（小写）；非中文为字符本身
  full: string[];
  // 每个字符的拼音首字母（小写）
  init: string[];
  // chars[i] 在原 UTF-16 字符串中的起始下标；offsets[n] = text.length
  offsets: number[];
};

const cache = new Map<string, CharInfo>();
const MAX_CACHE = 4000;

function getInfo(text: string): CharInfo {
  const cached = cache.get(text);
  if (cached) return cached;
  const chars = [...text];
  let full: string[];
  try {
    full = pinyin(text, { type: "array", toneType: "none" }).map((p) =>
      String(p).toLowerCase(),
    );
  } catch {
    full = chars.map((c) => c.toLowerCase());
  }
  // 保险：长度不一致时回退到逐字符（避免 span 越界）
  if (full.length !== chars.length) {
    full = chars.map((c, i) => (full[i] ?? c).toLowerCase());
  }
  const init = full.map((p) => (p ? p[0] : ""));
  const offsets: number[] = new Array(chars.length + 1);
  let acc = 0;
  for (let i = 0; i < chars.length; i++) {
    offsets[i] = acc;
    acc += chars[i].length;
  }
  offsets[chars.length] = acc;
  const info: CharInfo = { chars, full, init, offsets };
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(text, info);
  return info;
}

// token 是否「适合走拼音匹配」：纯 a-z 字母（已小写）。
// 含中文/数字/符号的 token 仍走原有字面 includes 匹配。
export function isPinyinToken(token: string): boolean {
  return /^[a-z]+$/.test(token);
}

// 返回 token 在 text 中通过「拼音全拼 / 首字母」命中的字符 span（UTF-16 下标）。
// 每个起始位置至多产出一个 span（贪心匹配到能覆盖整个 token 的最短结束位置）。
export function pinyinSpans(
  text: string,
  token: string,
): { start: number; end: number }[] {
  if (!isPinyinToken(token)) return [];
  const { chars, full, init, offsets } = getInfo(text);
  const n = chars.length;
  if (n === 0) return [];
  const tok = token;
  const out: { start: number; end: number }[] = [];

  // 从字符下标 ci 起，尝试消费完 token（从 ti 起的剩余部分）。
  // 返回成功时的结束字符下标（exclusive），失败返回 -1。
  function matchFrom(ci: number, ti: number): number {
    if (ti >= tok.length) return ci;
    if (ci >= n) return -1;
    const f = full[ci];
    const rem = tok.slice(ti);
    // 1) 该字全拼是剩余 token 的前缀 → 整段消费该字全拼，继续下一字
    if (f && rem.startsWith(f)) {
      const r = matchFrom(ci + 1, ti + f.length);
      if (r >= 0) return r;
    }
    // 2) 剩余 token 是该字全拼的前缀 → token 在该字内结束（部分全拼）
    if (f && f.startsWith(rem)) {
      return ci + 1;
    }
    // 3) 首字母匹配 → 消费一个首字母，继续下一字
    const it = init[ci];
    if (it && rem[0] === it) {
      const r = matchFrom(ci + 1, ti + 1);
      if (r >= 0) return r;
    }
    return -1;
  }

  for (let i = 0; i < n; i++) {
    const endChar = matchFrom(i, 0);
    if (endChar > i) {
      out.push({ start: offsets[i], end: offsets[endChar] });
    }
  }
  return out;
}

// token 是否通过拼音命中 text（任意位置）。
export function pinyinMatches(text: string, token: string): boolean {
  if (!isPinyinToken(token)) return false;
  return pinyinSpans(text, token).length > 0;
}
