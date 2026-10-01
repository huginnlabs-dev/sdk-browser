import { bootstrapState, resolveConfig, state, stripUndefined } from './config';
import { emitEvent } from './events';
import { newSpanId } from './ids';
import { instrumentBreadcrumbs } from './instrument/breadcrumbs';
import { instrumentErrors } from './instrument/errors';
import { instrumentHistory, currentUrlString, onRouteChange } from './instrument/history';
import { instrumentHttp } from './instrument/http';
import { startVitals } from './instrument/vitals';
import { runTeardowns } from './patch';
import { maybeStartReplay, resetReplay } from './replay';
import { flush as flushTransport, flushKeepalive, queueSnapshot, resetTransport, startTransport } from './transport';
import type { DataflowOptions } from './types';
import { VERSION } from './version';
import { nowMs } from './util';

export type { DataflowEvent, DataflowOptions, EventType, Breadcrumb } from './types';

/** Public API surface (also the default export and the script-tag global). */
export interface DataflowApi {
  /** Initialize (idempotent — subsequent calls merge options into the config). */
  init(options: Partial<DataflowOptions>): DataflowApi;
  /** Force a batch flush; resolves when the ingest POST settles. Never rejects. */
  flush(): Promise<void>;
  /** The current page-load trace id (injected as x-dataflow-trace-id). */
  traceId(): string;
  /** The page-load sampling decision. */
  isSampled(): boolean;
  readonly version: string;
}

function start(): void {
  const cfg = state.config;
  if (!cfg) return;

  // Click breadcrumbs first so a route-change click is never missed.
  // All instrumentation is installed unconditionally; every emitter re-checks
  // its disable flag at event time, so re-init merges can toggle features live.
  instrumentBreadcrumbs();
  instrumentHttp();
  instrumentErrors();
  instrumentHistory();

  // Web Vitals write into the page-load span's metadata as they arrive.
  const vitalsMeta: Record<string, unknown> = {};
  try {
    // Environment facts for the session explorer: user agent, locale and
    // viewport ride the page-load span (metadata is string-only).
    vitalsMeta['agent.ua'] = navigator.userAgent;
    vitalsMeta['agent.lang'] = navigator.language || '';
    vitalsMeta['agent.viewport'] = `${window.innerWidth}x${window.innerHeight}`;
  } catch {
    /* metadata is best-effort */
  }
  startVitals(vitalsMeta);

  // Page-load span: opened now, ended on window load (or immediately if the
  // document is already complete). Its metadata may keep growing with vitals
  // until the batch containing it is serialized.
  const pageLoadStart = nowMs();
  const loadSpanId = newSpanId();
  state.currentViewSpanId = loadSpanId;
  state.currentUrl = currentUrlString();
  state.lastRouteChangeTs = pageLoadStart;

  let finalized = false;
  const finalizePageLoad = (): void => {
    if (finalized) return;
    finalized = true;
    const duration = Math.max(0, nowMs() - pageLoadStart);
    state.lastRouteChangeTs = nowMs();
    if (!cfg.disablePageViews && state.sampled) {
      // The name is the INIT pathname: an SPA route change before window
      // load must not rename the page-load span (route changes emit their
      // own PAGE_VIEW spans).
      const initPathname = (state.currentUrl || currentUrlString()).split('#')[0].split('?')[0];
      emitEvent({
        type: 'PAGE_VIEW',
        name: `VIEW ${initPathname}`,
        span_id: loadSpanId,
        parent_span_id: null, // root span of the page-load trace
        duration_ms: duration,
        caller_package: 'browser',
        callee_package: 'browser',
        metadata: vitalsMeta,
      });
    }
  };

  if (document.readyState === 'complete') {
    finalizePageLoad();
  } else {
    const onLoad = () => finalizePageLoad();
    window.addEventListener('load', onLoad, { once: true });
    // finalize is idempotent, so a late double call is harmless
  }

  startTransport();

  // Opt-in Session Replay: starts only when `replay` is on AND this page load
  // was sampled (independent roll). rrweb loads dynamically — a failure here
  // degrades silently and never affects tracing.
  maybeStartReplay();
}

function init(options: Partial<DataflowOptions>): DataflowApi {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('[dataflow] @huginnlabs/dataflow-browser must run in a browser environment');
  }

  if (!state.started) {
    const missing: string[] = [];
    if (!options.endpoint) missing.push('endpoint');
    if (!options.apiKey) missing.push('apiKey');
    if (missing.length > 0) {
      throw new Error(`[dataflow] init: missing required option(s): ${missing.join(', ')}`);
    }
    bootstrapState(resolveConfig(options));
    start();
  } else if (options && Object.keys(options).length > 0) {
    // Idempotent re-init: merge options (undefined values never clobber).
    const merged = resolveConfig({ ...state.config!, ...stripUndefined(options) });
    if (!merged.endpoint || !merged.apiKey) {
      throw new Error('[dataflow] init: "endpoint" and "apiKey" are required');
    }
    state.config = merged;
    // A re-init merge can toggle `replay` on for a running page (the sample
    // was already rolled once at first init — never re-rolled).
    maybeStartReplay();
  }

  return publicApi;
}

export const publicApi: DataflowApi = {
  init,
  flush: () => flushTransport(),
  traceId: () => state.traceId,
  isSampled: () => state.sampled,
  version: VERSION,
};

export default publicApi;
export { init };

/**
 * Internal helpers for tests/diagnostics — not part of the semver-stable
 * public contract.
 */
export const __internals = {
  state,
  queueSnapshot,
  emitEvent,
  onRouteChange,
  flushKeepalive,
};

/** Full teardown: unpatch everything, clear queues and state. Test-only. */
export function __resetForTests(): void {
  runTeardowns();
  resetTransport();
  resetReplay();
  state.config = null;
  state.started = false;
  state.traceId = '';
  state.sampled = true;
  state.replaySampled = false;
  state.seq = 0;
  state.currentViewSpanId = undefined;
  state.currentUrl = undefined;
  state.lastRouteChangeTs = 0;
}
