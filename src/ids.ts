function randomBytes(n: number): Uint8Array {
  const g = (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const out = new Uint8Array(n);
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(out);
    return out;
  }
  // Last-resort fallback for very old browsers.
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function hex(bytes: number): string {
  let s = '';
  const arr = randomBytes(bytes);
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

/** 32 hex chars — W3C trace id shape. */
export function newTraceId(): string {
  return hex(16);
}

/** 16 hex chars — W3C span id shape. */
export function newSpanId(): string {
  return hex(8);
}

/** 32 hex chars — unique per ingested event. */
export function newEventId(): string {
  return hex(16);
}
