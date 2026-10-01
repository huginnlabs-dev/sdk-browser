import { state } from '../config';
import { addTeardown } from '../patch';
import { META } from '../version';

interface AnyPerformanceObserver {
  observe(options: { type: string; buffered?: boolean }): void;
  disconnect(): void;
}

type POConstructor = new (cb: (list: { getEntries(): unknown[] }) => void) => AnyPerformanceObserver;

interface ShiftEntry {
  value?: number;
  recentInput?: boolean;
}

interface FirstInputEntry {
  startTime?: number;
  processingStart?: number;
}

interface LcpEntry {
  startTime?: number;
}

/**
 * Hand-rolled Web Vitals (no web-vitals dependency), written into the
 * page-load span's metadata as they arrive — the span object is serialized at
 * flush time, so metrics landing between enqueue and send still make it in.
 *
 *  - TTFB: Navigation Timing (responseStart - requestStart)
 *  - LCP:  largest-contentful-paint (last entry wins, buffered)
 *  - CLS:  layout-shift accumulation, ignoring shifts with recentInput
 *  - FID:  first-input processingStart - startTime
 *    (raw first-input delay; INP-style attribution is a roadmap item — when a
 *    page sees no interaction before flush, no FID is reported)
 */
export function startVitals(target: Record<string, unknown>): void {
  const cfg = state.config;
  if (!cfg) return;

  // TTFB from Navigation Timing (available synchronously at start).
  try {
    if (!cfg.disableWebVitals) {
      const list = (
        performance.getEntriesByType as ((t: string) => unknown[]) | undefined
      )?.('navigation');
      const nav = list?.[0] as { responseStart?: number; requestStart?: number } | undefined;
      if (
        nav &&
        typeof nav.responseStart === 'number' &&
        nav.responseStart > 0 &&
        typeof nav.requestStart === 'number'
      ) {
        target[META.vitalTtfb] = Math.max(0, Math.round(nav.responseStart - nav.requestStart));
      }
    }
  } catch {
    /* ignore */
  }

  const PO = (globalThis as { PerformanceObserver?: POConstructor }).PerformanceObserver;
  if (typeof PO !== 'function') return;

  const observe = (type: string, cb: (entries: unknown[]) => void): void => {
    try {
      const po = new PO((list) => {
        try {
          cb(list.getEntries());
        } catch {
          /* ignore */
        }
      });
      po.observe({ type, buffered: true });
      addTeardown(() => {
        try {
          po.disconnect();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* observer type unsupported in this browser */
    }
  };

  observe('largest-contentful-paint', (entries) => {
    if (state.config?.disableWebVitals) return;
    const last = entries[entries.length - 1] as LcpEntry | undefined;
    if (last && typeof last.startTime === 'number') {
      target[META.vitalLcp] = Math.round(last.startTime);
    }
  });

  let cls = 0;
  observe('layout-shift', (entries) => {
    if (state.config?.disableWebVitals) return;
    for (const e of entries as ShiftEntry[]) {
      if (!e.recentInput) cls += e.value ?? 0;
    }
    target[META.vitalCls] = Math.round(cls * 1000) / 1000;
  });

  observe('first-input', (entries) => {
    if (state.config?.disableWebVitals) return;
    const f = entries[0] as FirstInputEntry | undefined;
    if (f && typeof f.processingStart === 'number' && typeof f.startTime === 'number') {
      target[META.vitalFid] = Math.max(0, Math.round(f.processingStart - f.startTime));
    }
  });
}

/** Pure helper (unit-tested): CLS accumulation ignoring input-linked shifts. */
export function accumulateCLS(shifts: ShiftEntry[]): number {
  let cls = 0;
  for (const s of shifts) {
    if (!s.recentInput) cls += s.value ?? 0;
  }
  return Math.round(cls * 1000) / 1000;
}

/** Pure helper (unit-tested): first-input delay from an entry. */
export function fidFromEntry(e: FirstInputEntry): number {
  if (typeof e.processingStart !== 'number' || typeof e.startTime !== 'number') return 0;
  return Math.max(0, Math.round(e.processingStart - e.startTime));
}
