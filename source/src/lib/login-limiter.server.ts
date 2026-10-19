/** A bounded per-process guard; the reverse proxy and Supabase also enforce rate limits. */
export function createLoginLimiter(limit = 20, windowMs = 60_000, capacity = 2048) {
  const entries = new Map<string, { attempts: number; expiresAt: number }>();
  return (key: string, now = Date.now()): boolean => {
    const previous = entries.get(key);
    if (previous && previous.expiresAt > now) {
      if (previous.attempts >= limit) return false;
      previous.attempts++;
      return true;
    }
    if (entries.size >= capacity) {
      for (const [storedKey, value] of entries)
        if (value.expiresAt <= now) entries.delete(storedKey);
      if (!entries.has(key) && entries.size >= capacity) return false;
    }
    entries.set(key, { attempts: 1, expiresAt: now + windowMs });
    return true;
  };
}

export const canAttemptLogin = createLoginLimiter();
