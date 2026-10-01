import { state } from '../config';
import { emitEvent } from '../events';
import { isIngestUrl } from '../ingest';
import { newSpanId } from '../ids';
import { addTeardown } from '../patch';
import { META, TRACE_HEADER } from '../version';
import { safeLocationHost, toURL, nowMs } from '../util';

interface WrappedFetch {
  __dataflowWrapped?: boolean;
}

/**
 * Trace-header eligibility policy (CORS-safe):
 *  - option `traceHeader` must be on;
 *  - NEVER for the SDK's own ingest endpoint (no self-tracing loops);
 *  - same-origin requests always eligible;
 *  - cross-origin only if the origin is listed in `allowedTraceOrigins`
 *    (injecting custom headers on third-party origins breaks CORS).
 */
export function traceEligible(u: URL): boolean {
  const cfg = state.config;
  if (!cfg || !cfg.traceHeader) return false;
  if (isIngestUrl(u)) return false;
  if (u.origin === location.origin) return true;
  return cfg.allowedTraceOrigins.includes(u.origin);
}

/** Install fetch + XHR wrappers (idempotent). Spans are gated at emit time. */
export function instrumentHttp(): void {
  if (typeof fetch === 'function' && !(fetch as unknown as WrappedFetch).__dataflowWrapped) {
    installFetch();
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    installXhr();
  }
}

function installFetch(): void {
  const original = fetch;

  const wrapped = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const cfg = state.config;
    if (!cfg || cfg.disableHttp || !state.started) {
      return original.call(this === undefined ? globalThis : this, input, init);
    }
    const u = toURL(input instanceof Request ? input.url : String(input));
    if (!u || isIngestUrl(u)) {
      // Never trace (or add spans for) our own beacons — no self-tracing loops.
      return original.call(this === undefined ? globalThis : this, input, init);
    }
    const method = (
      init?.method ||
      (input instanceof Request ? input.method : 'GET') ||
      'GET'
    ).toUpperCase();

    let newInit = init;
    if (traceEligible(u)) {
      try {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        headers.set(TRACE_HEADER, state.traceId);
        newInit = { ...(init ?? {}), headers };
      } catch {
        newInit = init;
      }
    }

    const started = nowMs();
    return original
      .call(this === undefined ? globalThis : this, input, newInit)
      .then(
        (res) => {
          emitHttpSpan(method, u, res.status, nowMs() - started, undefined);
          return res;
        },
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          emitHttpSpan(method, u, 0, nowMs() - started, msg);
          throw err;
        },
      );
  } as typeof fetch;

  (wrapped as unknown as WrappedFetch).__dataflowWrapped = true;
  (globalThis as { fetch: typeof fetch }).fetch = wrapped;
  addTeardown(() => {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  });
}

function emitHttpSpan(
  method: string,
  u: URL,
  status: number,
  duration: number,
  errorMessage: string | undefined,
): void {
  const cfg = state.config;
  if (!cfg || cfg.disableHttp || !state.started) return;
  if (isIngestUrl(u)) return; // central self-tracing guard (covers XHR too)

  emitEvent({
    type: 'HTTP_CLIENT',
    name: `${method} ${u.host}${u.pathname}`,
    caller_package: safeLocationHost(),
    callee_package: u.host,
    duration_ms: Math.max(0, Math.round(duration)),
    status_code: status,
    error_message: errorMessage,
    metadata: {
      [META.httpMethod]: method,
      [META.httpUrl]: u.href,
    },
  });
}

interface PatchedXhrProto {
  __dataflowWrapped?: boolean;
}

interface XhrRequestInfo {
  method: string;
  url: string;
  headerSet?: boolean;
}

function installXhr(): void {
  const proto = XMLHttpRequest.prototype as unknown as Record<string, unknown> &
    PatchedXhrProto & {
      open: (...args: unknown[]) => unknown;
      send: (...args: unknown[]) => unknown;
    };
  if (proto.__dataflowWrapped) return;

  const origOpen = proto.open;
  const origSend = proto.send;

  proto.open = function (this: XMLHttpRequest & { __dataflowReq?: XhrRequestInfo }, ...args: unknown[]) {
    const [method, url] = args as [string, string];
    try {
      this.__dataflowReq = { method: String(method).toUpperCase(), url: String(url) };
    } catch {
      /* ignore */
    }
    return origOpen.apply(this, args);
  };

  proto.send = function (this: XMLHttpRequest & { __dataflowReq?: XhrRequestInfo }, body?: unknown) {
    const info = this.__dataflowReq;
    if (info) {
      const u = toURL(info.url);
      if (u && traceEligible(u) && !info.headerSet) {
        try {
          this.setRequestHeader(TRACE_HEADER, state.traceId);
          info.headerSet = true;
        } catch {
          /* header injection must never break the request */
        }
      }
      const started = nowMs();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const status = typeof this.status === 'number' ? this.status : 0;
        emitHttpSpan(
          info.method,
          u as URL,
          status,
          nowMs() - started,
          status === 0 ? 'XHR network error or aborted' : undefined,
        );
      };
      this.addEventListener('load', finish);
      this.addEventListener('error', finish);
      this.addEventListener('abort', finish);
    }
    return origSend.call(this, body);
  };

  proto.__dataflowWrapped = true;
  addTeardown(() => {
    proto.open = origOpen;
    proto.send = origSend;
    delete proto.__dataflowWrapped;
  });
}

/** Unique span id helper re-exported for tests that build synthetic parents. */
export { newSpanId };
