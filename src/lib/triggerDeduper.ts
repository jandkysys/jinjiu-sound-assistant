export function createTriggerDeduper(windowMs = 80) {
  const lastTriggerById = new Map<string, number>();

  return {
    shouldRun(id: string, now = Date.now()): boolean {
      const lastTrigger = lastTriggerById.get(id);
      if (lastTrigger !== undefined && now - lastTrigger <= windowMs) return false;
      lastTriggerById.set(id, now);
      return true;
    },
  };
}
