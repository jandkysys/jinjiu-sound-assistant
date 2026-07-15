import React from "react";

/** Returns true if ch would be stripped during normalization (punctuation / separators / digits). */
export function isIgnoredChar(ch: string): boolean {
  return /[()（）[\]【】{}<>]/.test(ch)
    || /[\s_\-—–·.,，。、!！?？:：;；'"`~]/.test(ch)
    || /\d/.test(ch);
}

/**
 * Normalize a string to lowercase, strip ignored chars, and keep a map from
 * each normalized-string index back to the original string index.
 */
export function normWithMap(s: string): { norm: string; map: number[] } {
  const lower = s.toLowerCase();
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    if (isIgnoredChar(lower[i])) continue;
    norm += lower[i];
    map.push(i);
  }
  return { norm, map };
}

/** Longest common contiguous substring (in normalized space). Returns start index in `a` and length. */
export function longestCommonSubstr(a: string, b: string): { aStart: number; len: number } {
  let best = { aStart: 0, len: 0 };
  if (!a.length || !b.length) return best;
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prevDiag + 1;
        if (dp[j] > best.len) best = { aStart: i - dp[j], len: dp[j] };
      } else {
        dp[j] = 0;
      }
      prevDiag = tmp;
    }
  }
  return best;
}

/**
 * Render `self` as a span array where characters that share the longest common
 * substring with `peer` (both normalized) are highlighted green+bold, ignored
 * chars are dimmed, and the rest are normal.
 */
export function renderMatchName(self: string, peer: string): React.ReactNode {
  const a = normWithMap(self);
  const b = normWithMap(peer);
  const lcs = longestCommonSubstr(a.norm, b.norm);
  const matched = new Set<number>();
  for (let k = 0; k < lcs.len; k++) matched.add(a.map[lcs.aStart + k]);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < self.length; i++) {
    const ch = self[i];
    const style: React.CSSProperties = matched.has(i)
      ? { color: "rgba(70,140,80,0.95)", fontWeight: 600 }
      : isIgnoredChar(ch)
        ? { opacity: 0.4 }
        : {};
    out.push(<span key={i} style={style}>{ch}</span>);
  }
  return out;
}
