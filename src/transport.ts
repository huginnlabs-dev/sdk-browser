import { state } from './config';
import type { DataflowEvent } from './types';
import { addTeardown } from './patch';
import { ingestUrl } from './ingest';

/** Hard cap on the in-memory queue (drop oldest beyond this). */
const MAX_QUEUE = 1000;

let queue: DataflowEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function enqueueEvent(ev: DataflowEvent): void {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(ev);
  const cfg = state.config;
  if (cfg && queue.length >= cfg.maxBatchSize) void flush();
}

export function queueSnapshot(): DataflowEvent[] {
  return queue.slice();
}

export function queueLength(): number {
  return queue.length;
}

/** Move everything out of the queue (new array becomes the live queue). */
function takeAll(): DataflowEvent[] {
  if (queue.length === 0) return [];
  const all = queue;
  queue = [];
  return all;
}

/**
 * Normal batch flush: POST {events:[...]} with X-Api-Key + JSON headers.
 * Never throws — transport failures are swallowed (events are dropped).
 */
export function flush(): Promise<void> {
  const events = takeAll();
  if (events.length === 0) return Promise.resolve();
  return post(events, false);
}

/**
 * Page-hide flush. sendBeacon cannot set X-Api-Key, so we use
 * fetch(keepalive: true) with full headers instead; if the browser cannot
 * keep the request alive the events are silently dropped.
 */
export function flushKeepalive(): void {
  const events = takeAll();
  if (events.length === 0) return;
  void post(events, true);
}

async function post(events: DataflowEvent[], keepalive: boolean): Promise<void> {
  const cfg = state.config;
  if (!cfg || !cfg.endpoint || typeof fetch !== 'function') return;
  try {
    await fetch(ingestUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': cfg.apiKey,
      },
      body: JSON.stringify({ events }),
      keepalive,
      credentials: 'omit',
    });
  } catch {
    /* never throw into the host app; the batch is dropped */
  }
}

export function startTransport(): void {
  stopTransport();
  const cfg = state.config;
  if (!cfg) return;
  timer = setInterval(() => {
    void flush();
  }, cfg.flushInterval);

  const onVisibility = () => {
    try {
      if (document.visibilityState === 'hidden') flushKeepalive();
    } catch {
      /* ignore */
    }
  };
  const onPageHide = () => {
    try {
      flushKeepalive();
    } catch {
      /* ignore */
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  addTeardown(() => {
    stopTransport();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  });
}

function stopTransport(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test/debug helper: stop timers and drop queued events. */
export function resetTransport(): void {
  stopTransport();
  queue = [];
}
