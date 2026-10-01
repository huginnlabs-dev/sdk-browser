export function nowMs(): number {
  return Date.now();
}

export function truncate(s: string | undefined | null, max: number): string | undefined {
  if (s === undefined || s === null) return undefined;
  return s.length <= max ? s : s.slice(0, max);
}

/** Parse a URL relative to the current document; returns undefined on failure. */
export function toURL(url: string | URL, base?: string): URL | undefined {
  try {
    const b = base ?? (typeof location !== 'undefined' ? location.href : undefined);
    return new URL(url as string | URL, b);
  } catch {
    return undefined;
  }
}

export function safeLocationHost(): string {
  try {
    if (typeof location !== 'undefined' && location.host) return location.host;
  } catch {
    /* ignore */
  }
  return 'browser';
}
