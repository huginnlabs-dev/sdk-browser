/** Event types accepted by the Dataflow ingest API (browser-relevant subset). */
type EventType = 'PAGE_VIEW' | 'HTTP_CLIENT' | 'FUNCTION_CALL';
/** A single event/span in the ingest payload (server wire contract). */
interface DataflowEvent {
    event_id: string;
    seq: number;
    /** Unix epoch milliseconds. */
    timestamp: number;
    trace_id: string;
    span_id: string;
    parent_span_id?: string;
    type: EventType;
    service_name?: string;
    name?: string;
    caller_package?: string;
    callee_package?: string;
    function_name?: string;
    duration_ms?: number;
    status_code?: number;
    error_message?: string;
    /** All values are strings (the ingest API's metadata is map[string]string). */
    metadata?: Record<string, string>;
}
/** One click breadcrumb ("tag#id:text" + timestamp). */
interface Breadcrumb {
    label: string;
    timestamp: number;
}
/** Options accepted by `dataflow.init()`. Only `endpoint` and `apiKey` are required. */
interface DataflowOptions {
    /** Base URL of the Dataflow server, e.g. "https://dataflow.example.com". The SDK posts to `<endpoint>/api/v1/ingest`. */
    endpoint: string;
    /** Project API key ("df_..."), sent as the X-Api-Key header. */
    apiKey: string;
    /** Logical name of this web app; becomes `service_name` on every event. Defaults to `location.host`. */
    serviceName?: string;
    /** 0..1 fraction of page loads that are traced (rolled once per page load). Default 1. */
    sampleRate?: number;
    /** Inject `x-dataflow-trace-id` on eligible outgoing requests. Default true. */
    traceHeader?: boolean;
    /** Additional (cross-origin) request origins that may receive the trace header. Default []. */
    allowedTraceOrigins?: string[];
    /** Disable automatic PAGE_VIEW instrumentation (history API / popstate / hashchange). */
    disablePageViews?: boolean;
    /** Disable automatic HTTP_CLIENT instrumentation (fetch + XMLHttpRequest). */
    disableHttp?: boolean;
    /** Disable automatic JS error capture (window error + unhandledrejection). */
    disableErrors?: boolean;
    /** Disable Web Vitals collection (LCP/FID/CLS/TTFB). */
    disableWebVitals?: boolean;
    /** Disable click breadcrumbs. */
    disableBreadcrumbs?: boolean;
    /** Maximum number of click breadcrumbs retained (attached to error spans only). Default 20. */
    maxBreadcrumbs?: number;
    /** Batch flush interval in ms. Default 2000. */
    flushInterval?: number;
    /** Flush when the queue reaches this many events. Default 20. */
    maxBatchSize?: number;
    /**
     * Opt-in Session Replay (rrweb). Default false. When enabled, rrweb is
     * loaded dynamically (never part of the core bundle) and rrweb events are
     * batched to `<endpoint>/api/v1/replay` under the page-load trace id.
     * Inputs are masked and `df-block` / `df-mask` elements are redacted —
     * see the README "Session Replay" section before enabling.
     */
    replay?: boolean;
    /**
     * Fraction of page loads recorded when `replay` is on, 0..1 (clamped).
     Rolled once per page load, independently of `sampleRate`. Default 1.
     */
    replaySampleRate?: number;
    /** Log emitted events to the console. Default false. */
    debug?: boolean;
}

/** Fully-resolved configuration (defaults applied, values validated). */
interface ResolvedConfig {
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
interface RuntimeState {
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

interface EmitInput {
    type: EventType;
    name?: string;
    /** Provide an explicit span id (page-load span) — otherwise one is generated. */
    span_id?: string;
    /** `null` forces no parent (root span); default parents to the current view span. */
    parent_span_id?: string | null;
    duration_ms?: number;
    status_code?: number;
    error_message?: string;
    caller_package?: string;
    callee_package?: string;
    function_name?: string;
    metadata?: Record<string, unknown>;
    /** Mark this span as the new "current view" (parents future http/error spans). */
    setAsCurrentView?: boolean;
}
/**
 * Build a contract-conforming event and hand it to the transport.
 * Respects the page-load sampling decision (unsampled page loads emit nothing)
 * and never throws.
 */
declare function emitEvent(input: EmitInput): void;

/** Called on every candidate route change; emits at most one span per unique URL. */
declare function onRouteChange(): void;

declare function queueSnapshot(): DataflowEvent[];
/**
 * Page-hide flush. sendBeacon cannot set X-Api-Key, so we use
 * fetch(keepalive: true) with full headers instead; if the browser cannot
 * keep the request alive the events are silently dropped.
 */
declare function flushKeepalive(): void;

/** Public API surface (also the default export and the script-tag global). */
interface DataflowApi {
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
declare function init(options: Partial<DataflowOptions>): DataflowApi;
declare const publicApi: DataflowApi;

/**
 * Internal helpers for tests/diagnostics — not part of the semver-stable
 * public contract.
 */
declare const __internals: {
    state: RuntimeState;
    queueSnapshot: typeof queueSnapshot;
    emitEvent: typeof emitEvent;
    onRouteChange: typeof onRouteChange;
    flushKeepalive: typeof flushKeepalive;
};
/** Full teardown: unpatch everything, clear queues and state. Test-only. */
declare function __resetForTests(): void;

export { type Breadcrumb, type DataflowApi, type DataflowEvent, type DataflowOptions, type EventType, __internals, __resetForTests, publicApi as default, init, publicApi };
