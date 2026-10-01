export const VERSION = '0.2.1';

/** Header injected on eligible outgoing requests so browser + backend join one trace. */
export const TRACE_HEADER = 'x-dataflow-trace-id';

/** Server ingest path appended to the configured endpoint (base URL). */
export const INGEST_PATH = '/api/v1/ingest';

/** Server Session Replay path appended to the configured endpoint (base URL). */
export const REPLAY_PATH = '/api/v1/replay';

/** Metadata keys (follow the server contract's dotted attribute style). */
export const META = {
  httpMethod: 'http.method',
  httpUrl: 'http.url',
  errorMessage: 'error.message',
  errorStack: 'error.stack',
  errorSource: 'error.source',
  breadcrumbs: 'breadcrumbs',
  vitalLcp: 'webvital.lcp',
  vitalFid: 'webvital.fid',
  vitalCls: 'webvital.cls',
  vitalTtfb: 'webvital.ttfb',
} as const;
