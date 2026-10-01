/** Event types accepted by the Dataflow ingest API (browser-relevant subset). */
export type EventType = 'PAGE_VIEW' | 'HTTP_CLIENT' | 'FUNCTION_CALL';

/** A single event/span in the ingest payload (server wire contract). */
export interface DataflowEvent {
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
export interface Breadcrumb {
  label: string;
  timestamp: number;
}

/** Options accepted by `dataflow.init()`. Only `endpoint` and `apiKey` are required. */
export interface DataflowOptions {
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
  /** Log emitted events to the console. Default false. */
  debug?: boolean;
}
