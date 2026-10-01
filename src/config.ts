import { newTraceId } from './ids';
import { rollSampling } from './sampling';
import type { DataflowOptions } from './types';

/** Fully-resolved configuration (defaults applied, values validated). */
export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  sampleRate: number;
  traceHeader: boolean;
  allowedTraceOrigins: string[];
  disablePageViews: boolean;
  disableHttp: boolean;
  disableErrors: boolean;
  disableWebVitals: boolean;
  disableBreadcrumbs: boolean;
  maxBreadcrumbs: number;
  flushInterval: number;
  maxBatchSize: number;
  replay: boolean;
  replaySampleRate: number;
  debug: boolean;
}

/** Singleton runtime state (one per page load). */
export interface RuntimeState {
  config: ResolvedConfig | null;
  started: boolean;
  traceId: string;
  /** Sampling decision — rolled once per page load, never re-rolled. */
  sampled: boolean;
  /**
   * Session Replay sampling decision — rolled once per page load,
   * independently of `sampled` (a page can be traced but not recorded).
   */
  replaySampled: boolean;
  seq: number;
  /** span_id of the current PAGE_VIEW span (parent of http/error spans). */
  currentViewSpanId?: string;
  /** Dedupe key: pathname + search + hash of the current view. */
  currentUrl?: string;
  /** Timestamp of the last route change (duration source for the next view). */
  lastRouteChangeTs: number;
}

export const state: RuntimeState = {
  config: null,
  started: false,
  traceId: '',
  sampled: true,
  replaySampled: false,
  seq: 0,
  lastRouteChangeTs: 0,
};

export function defaultServiceName(): string {
  try {
    if (typeof location !== 'undefined' && location.host) return location.host;
  } catch {
    /* ignore */
  }
  return 'browser';
}

export function resolveConfig(opts: Partial<DataflowOptions>): ResolvedConfig {
  return {
    endpoint: String(opts.endpoint ?? '').trim(),
    apiKey: String(opts.apiKey ?? ''),
    serviceName: opts.serviceName && opts.serviceName.trim() ? opts.serviceName.trim() : defaultServiceName(),
    sampleRate: clampNumber(opts.sampleRate ?? 1, 0, 1, 1),
    traceHeader: opts.traceHeader !== false,
    allowedTraceOrigins: Array.isArray(opts.allowedTraceOrigins) ? opts.allowedTraceOrigins.slice() : [],
    disablePageViews: opts.disablePageViews === true,
    disableHttp: opts.disableHttp === true,
    disableErrors: opts.disableErrors === true,
    disableWebVitals: opts.disableWebVitals === true,
    disableBreadcrumbs: opts.disableBreadcrumbs === true,
    maxBreadcrumbs: Math.max(0, Math.floor(clampNumber(opts.maxBreadcrumbs ?? 20, 0, 1000, 20))),
    flushInterval: Math.max(10, Math.floor(clampNumber(opts.flushInterval ?? 2000, 10, 3_600_000, 2000))),
    maxBatchSize: Math.max(1, Math.floor(clampNumber(opts.maxBatchSize ?? 20, 1, 1000, 20))),
    replay: opts.replay === true,
    replaySampleRate: clampNumber(opts.replaySampleRate ?? 1, 0, 1, 1),
    debug: opts.debug === true,
  };
}

function clampNumber(v: number, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/**
 * Initialize runtime state for a fresh page load. Both sampling decisions are
 * rolled HERE, exactly once each, so every event in this session shares the
 * same decision. Trace sampling and replay sampling are independent rolls.
 */
export function bootstrapState(config: ResolvedConfig): void {
  state.config = config;
  state.started = true;
  state.traceId = newTraceId();
  state.sampled = rollSampling(config.sampleRate);
  state.replaySampled = rollSampling(config.replaySampleRate);
  state.seq = 0;
  state.currentViewSpanId = undefined;
  state.currentUrl = undefined;
  state.lastRouteChangeTs = 0;
}

/** Drop keys whose value is `undefined` so option merges never clobber. */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
