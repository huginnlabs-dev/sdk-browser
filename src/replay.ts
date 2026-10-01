import { state } from './config';
import { addTeardown } from './patch';
import { replayUrl } from './ingest';

/**
 * Session Replay (opt-in): records DOM mutations with rrweb and batches them
 * to `<endpoint>/api/v1/replay` under the page-load trace id.
 *
 * Design constraints:
 *  - rrweb is loaded with a DYNAMIC import — the core bundle never pays for
 *    it. If the import fails (not bundled / blocked by an extension), replay
 *    degrades silently: the flag stays off for the page and we warn once.
 *  - One stream per page load, keyed by the root trace id (`traceId()`).
 *    Route changes need no special handling: rrweb's full snapshot plus DOM
 *    mutations is enough for the player to reconstruct navigation.
 *  - Replay is LOSSY BY DESIGN: the buffer caps at 3000 events (drop oldest),
 *    flush failures retry exactly once and then drop the batch.
 *  - Beacons go through the same wrapped fetch as ingest, so they are
 *    recognized as SDK-owned endpoints and never create HTTP_CLIENT spans.
 */

/** One rrweb event, passed through verbatim (JSON-serialized on the wire). */
export interface ReplayEvent {
  /** rrweb event type number (DomContentLoaded, FullSnapshot, Mutation, ...). */
  type: number;
  /** rrweb event payload. */
  data: unknown;
  /** Unix epoch milliseconds. */
  timestamp: number;
}

/** Hard cap on the in-memory replay buffer (drop oldest beyond this). */
export const REPLAY_BUFFER_CAP = 3000;
/** Flush when the buffer reaches this many events. */
export const REPLAY_FLUSH_BATCH = 200;
/** Flush interval for replay batches (independent of the ingest flushInterval). */
export const REPLAY_FLUSH_INTERVAL_MS = 3000;
/** Server contract: at most 500 rrweb events per POST. */
export const REPLAY_MAX_BATCH = 500;
/** Browsers cap fetch(keepalive) bodies at 64 KiB — stay under it. */
const KEEPALIVE_MAX_BYTES = 65536;

/**
 * Privacy defaults (rrweb record options). Fixed, not configurable — replay
 * must never be turned on in a less-private configuration by accident.
 * Operators should add `df-block` to sensitive widgets (payment forms, iframes,
 * support chat, ...); text inside `df-mask` elements is replaced with `***`.
 * `inlineImages: false` keeps image bytes out of the payload.
 */
export const REPLAY_PRIVACY = {
  maskAllInputs: true,
  maskTextClass: 'df-mask',
  blockClass: 'df-block',
  inlineImages: false,
} as const;

/** Minimal structural typing — we deliberately do not import rrweb statically. */
interface RrwebRecord {
  (options: {
    emit: (event: ReplayEvent) => void;
    maskAllInputs?: boolean;
    maskTextClass?: string | RegExp;
    blockClass?: string | RegExp;
    inlineImages?: boolean;
  }): (() => void) | undefined;
}

let buffer: ReplayEvent[] = [];
let droppedEvents = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let stopRecording: (() => void) | null = null;
let starting = false;
/** Set when rrweb could not be loaded — replay stays off for the page. */
let degraded = false;

/** Snapshot of the current replay buffer (diagnostics/tests). */
export function replayBufferSnapshot(): ReplayEvent[] {
  return buffer.slice();
}

/** Number of rrweb events dropped by the buffer cap or page-hide trimming. */
export function replayDroppedCount(): number {
  return droppedEvents;
}

/**
 * Start Session Replay if the option is on AND this page load was sampled.
 * Safe to call repeatedly (first init and every re-init merge); recording
 * starts at most once per page load.
 */
export function maybeStartReplay(): void {
  const cfg = state.config;
  if (!cfg || !state.started) return;
  if (!cfg.replay || !state.replaySampled) return;
  if (stopRecording || starting || degraded) return;
  starting = true;
  void startRecording();
}

async function startRecording(): Promise<void> {
  try {
    let record: RrwebRecord;
    try {
      const mod = (await import('rrweb')) as unknown as { record?: RrwebRecord };
      if (typeof mod?.record !== 'function') throw new TypeError('rrweb.record is not a function');
      record = mod.record;
    } catch (err) {
      // Not bundled / blocked — degrade silently (warn once, flag stays off).
      degraded = true;
      warnOnce(err);
      return;
    }

    // Re-check after the async import: the config (or test state) may have
    // changed while rrweb was loading.
    const cfg = state.config;
    if (!cfg || !cfg.replay || !state.replaySampled || stopRecording) return;

    let stop: (() => void) | undefined;
    try {
      stop = record({ ...REPLAY_PRIVACY, emit: onRrwebEvent });
    } catch (err) {
      degraded = true;
      warnOnce(err);
      return;
    }
    if (typeof stop !== 'function') {
      degraded = true;
      warnOnce(new Error('rrweb.record did not return a stop function'));
      return;
    }

    stopRecording = stop;
    timer = setInterval(() => {
      void flushReplay();
    }, REPLAY_FLUSH_INTERVAL_MS);

    const onVisibility = () => {
      try {
        if (document.visibilityState === 'hidden') flushReplayOnHide();
      } catch {
        /* ignore */
      }
    };
    const onPageHide = () => {
      try {
        flushReplayOnHide();
      } catch {
        /* ignore */
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    addTeardown(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      stopReplay();
    });
  } finally {
    starting = false;
  }
}

function warnOnce(err: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(
      '[dataflow] replay: rrweb could not be loaded — Session Replay stays off for this page.',
      err instanceof Error ? err.message : err,
    );
  } catch {
    /* ignore */
  }
}

/** Buffer one rrweb event, dropping the OLDEST beyond the cap (counted). */
export function bufferEvent(ev: ReplayEvent): void {
  if (buffer.length >= REPLAY_BUFFER_CAP) {
    buffer.shift();
    droppedEvents++;
  }
  buffer.push({ type: ev.type, data: ev.data, timestamp: ev.timestamp });
}

function onRrwebEvent(ev: ReplayEvent): void {
  bufferEvent(ev);
  if (buffer.length >= REPLAY_FLUSH_BATCH) void flushReplay();
}

/** Move everything out of the buffer (the new array becomes the live buffer). */
function takeBuffer(): ReplayEvent[] {
  if (buffer.length === 0) return [];
  const all = buffer;
  buffer = [];
  return all;
}

function replayBody(events: ReplayEvent[]): string {
  // trace_id is the CURRENT page-load trace id — the same one traceId() returns.
  return JSON.stringify({ trace_id: state.traceId, events });
}

/**
 * Batched flush: POST rrweb events to /api/v1/replay with X-Api-Key + JSON
 * headers (chunks of <= REPLAY_MAX_BATCH per the server contract). Each chunk
 * is retried exactly once on failure, then dropped — replay is lossy by
 * design. Never throws.
 */
export function flushReplay(): Promise<void> {
  const events = takeBuffer();
  if (events.length === 0) return Promise.resolve();
  return (async () => {
    for (let i = 0; i < events.length; i += REPLAY_MAX_BATCH) {
      const chunk = events.slice(i, i + REPLAY_MAX_BATCH);
      const body = replayBody(chunk);
      if (await postReplay(body, false)) continue;
      await postReplay(body, false); // one retry, then the chunk is dropped
    }
  })();
}

/**
 * Page-hide flush. sendBeacon cannot set X-Api-Key, so we use
 * fetch(keepalive: true). Keepalive bodies are capped by the browser, so:
 * keep the NEWEST <= 500 events, then drop OLDEST ones until the payload
 * fits; what still doesn't fit is silently lost (lossy by design). No retry
 * on the hide path — the page is going away.
 */
function flushReplayOnHide(): void {
  const cfg = state.config;
  if (!cfg || !cfg.endpoint || typeof fetch !== 'function') return;
  let events = takeBuffer();
  if (events.length === 0) return;
  if (events.length > REPLAY_MAX_BATCH) {
    droppedEvents += events.length - REPLAY_MAX_BATCH;
    events = events.slice(events.length - REPLAY_MAX_BATCH);
  }
  let body = replayBody(events);
  while (events.length > 0 && byteLength(body) > KEEPALIVE_MAX_BYTES) {
    const cut = Math.max(1, Math.floor(events.length / 4));
    droppedEvents += cut;
    events = events.slice(cut);
    body = replayBody(events);
  }
  if (events.length > 0) void postReplay(body, true);
}

async function postReplay(body: string, keepalive: boolean): Promise<boolean> {
  const cfg = state.config;
  if (!cfg || !cfg.endpoint || typeof fetch !== 'function') return false;
  try {
    const res = await fetch(replayUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': cfg.apiKey,
      },
      body,
      keepalive,
      credentials: 'omit',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

/** Stop recording + timers + listeners (teardown path). Keeps degraded state. */
function stopReplay(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  try {
    stopRecording?.();
  } catch {
    /* ignore */
  }
  stopRecording = null;
}

/** Test/debug helper: stop everything and reset module state (incl. degraded). */
export function resetReplay(): void {
  stopReplay();
  buffer = [];
  droppedEvents = 0;
  starting = false;
  degraded = false;
}
