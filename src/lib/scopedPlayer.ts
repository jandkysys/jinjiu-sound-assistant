export type PlayerScope = "main" | "bg" | "kbd";
export type ScopedTracks = Partial<Record<PlayerScope, string>>;

export function rememberScopedTrack(previous: ScopedTracks, scope: PlayerScope, soundId: string): ScopedTracks {
  return { ...previous, [scope]: soundId };
}

export function visibleScopedTrack(
  scope: PlayerScope,
  remembered: ScopedTracks,
  playing: ReadonlySet<string>,
  paused: ReadonlySet<string>,
): string | null {
  const id = remembered[scope];
  return id && (playing.has(id) || paused.has(id)) ? id : null;
}
