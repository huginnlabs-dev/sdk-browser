import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import { TRACE_HEADER } from '../src/version';
import {
  ENDPOINT,
  API_KEY,
  boot,
  mockFetch,
  ingestedEvents,
  ingestCalls,
  headerOf,
} from './helpers';

class FakeXHR {
  status = 0;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  private listeners: Record<string, Array<(e?: unknown) => void>> = {};

  open(m: string, u: string): void {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  addEventListener(t: string, fn: (e?: unknown) => void): void {
    (this.listeners[t] ??= []).push(fn);
  }
  send(): void {
    /* the test decides when the request completes */
  }
  respond(status: number): void {
    this.status = status;
    this.fire('load');
  }
  fail(): void {
    this.status = 0;
    this.fire('error');
  }
  private fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn({ type });
  }
}

describe('HTTP instrumentation (fetch)', () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetForTests();
  });

  it('emits an HTTP_CLIENT span for a same-origin fetch', async () => {
    const f = mockFetch();
    boot();
    await fetch('/api/users');
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(span).toBeTruthy();
    expect(span.name).toBe(`GET ${location.host}/api/users`);
    expect(span.callee_package).toBe(location.host);
    expect(span.status_code).toBe(200);
    expect(span.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('carries http.method / http.url metadata', async () => {
    const f = mockFetch();
    boot();
    await fetch('/api/users?active=1');
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(span.metadata['http.method']).toBe('GET');
    expect(span.metadata['http.url']).toBe(`${location.origin}/api/users?active=1`);
  });

  it('injects the trace header on same-origin requests', async () => {
    const f = mockFetch();
    boot();
    await fetch('/api/users');
    const call = (f.mock.calls as Array<[unknown, RequestInit]>).find((c) =>
      String(c[0]).includes('/api/users'),
    );
    expect(headerOf(call, TRACE_HEADER)).toBe(dataflow.traceId());
  });

  it('does NOT inject the trace header cross-origin (CORS safety)', async () => {
    const f = mockFetch();
    boot();
    await fetch('https://third-party.example.com/v1/data');
    const call = (f.mock.calls as Array<[unknown, RequestInit]>).find((c) =>
      String(c[0]).includes('third-party.example.com'),
    );
    expect(headerOf(call, TRACE_HEADER)).toBeNull();
  });

  it('injects the header cross-origin when the origin is allowed', async () => {
    const f = mockFetch();
    boot({ allowedTraceOrigins: ['https://api.partner.com'] });
    await fetch('https://api.partner.com/v1/data');
    const call = (f.mock.calls as Array<[unknown, RequestInit]>).find((c) =>
      String(c[0]).includes('api.partner.com'),
    );
    expect(headerOf(call, TRACE_HEADER)).toBe(dataflow.traceId());
    // and the span still records it
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(span.callee_package).toBe('api.partner.com');
  });

  it('traceHeader: false disables injection everywhere', async () => {
    const f = mockFetch();
    boot({ traceHeader: false });
    await fetch('/api/no-header');
    const call = (f.mock.calls as Array<[unknown, RequestInit]>).find((c) =>
      String(c[0]).includes('/api/no-header'),
    );
    expect(headerOf(call, TRACE_HEADER)).toBeNull();
  });

  it('uses the request method in the span name', async () => {
    const f = mockFetch();
    boot();
    await fetch('/api/save', { method: 'POST', body: '{"a":1}' });
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(span.name).toBe(`POST ${location.host}/api/save`);
    expect(span.metadata['http.method']).toBe('POST');
  });

  it('records network failures with status 0 and rethrows to the caller', async () => {
    const f = mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    boot();
    await expect(fetch('/api/broken')).rejects.toBeTruthy();
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(span.status_code).toBe(0);
    expect(span.error_message).toContain('Failed to fetch');
  });

  it('passes the response through untouched', async () => {
    mockFetch(async () => new Response('hello-body', { status: 201 }));
    boot();
    const res = await fetch('/api/text');
    expect(res.status).toBe(201);
    await expect(res.text()).resolves.toBe('hello-body');
  });

  it('never traces or headers the SDK ingest beacon itself', async () => {
    const f = mockFetch();
    boot();
    await fetch(`${ENDPOINT}/api/v1/ingest`, { method: 'POST', body: '{}' });
    await dataflow.flush();

    // The synthetic beacon call got no trace header...
    const selfCall = (f.mock.calls as Array<[unknown, RequestInit]>).find(
      (c) => String(c[0]).includes('/api/v1/ingest') && c[1]?.body === '{}',
    );
    expect(selfCall).toBeTruthy();
    expect(headerOf(selfCall, TRACE_HEADER)).toBeNull();

    // ...and produced no HTTP_CLIENT span (only the page-load span + flushes remain).
    const evs = ingestedEvents(f);
    expect(evs.some((e) => e.type === 'HTTP_CLIENT')).toBe(false);
    expect(evs.every((e) => e.trace_id !== '' || e.trace_id === dataflow.traceId())).toBe(true);
  });
});

describe('HTTP instrumentation (XMLHttpRequest)', () => {
  beforeEach(() => {
    __resetForTests();
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetForTests();
  });

  it('emits an HTTP_CLIENT span when the request completes', async () => {
    const f = mockFetch();
    boot();
    const xhr = new FakeXHR();
    xhr.open('GET', '/api/xhr-users');
    xhr.send();
    xhr.respond(200);
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(span).toBeTruthy();
    expect(span.name).toBe(`GET ${location.host}/api/xhr-users`);
    expect(span.status_code).toBe(200);
    expect(span.metadata['http.method']).toBe('GET');
  });

  it('injects the trace header same-origin', () => {
    mockFetch();
    boot();
    const xhr = new FakeXHR();
    xhr.open('GET', '/api/xhr');
    xhr.send();
    expect(xhr.headers[TRACE_HEADER]).toBe(dataflow.traceId());
  });

  it('does not inject the header cross-origin', () => {
    mockFetch();
    boot();
    const xhr = new FakeXHR();
    xhr.open('GET', 'https://elsewhere.example.net/api');
    xhr.send();
    expect(xhr.headers[TRACE_HEADER]).toBeUndefined();
  });

  it('records XHR network errors with status 0', async () => {
    const f = mockFetch();
    boot();
    const xhr = new FakeXHR();
    xhr.open('GET', '/api/never-answers');
    xhr.send();
    xhr.fail();
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(span.status_code).toBe(0);
    expect(span.error_message).toBeTruthy();
  });

  it('respects the ingest self-exclusion on XHR too', async () => {
    const f = mockFetch();
    boot();
    const xhr = new FakeXHR();
    xhr.open('POST', `${ENDPOINT}/api/v1/ingest`);
    xhr.send();
    expect(xhr.headers[TRACE_HEADER]).toBeUndefined();
    xhr.respond(200);
    await dataflow.flush();
    expect(ingestedEvents(f).some((e) => e.type === 'HTTP_CLIENT')).toBe(false);
  });
});

describe('HTTP span parenting', () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  it('http spans parent to the current view span', async () => {
    const f = mockFetch();
    boot();
    history.pushState({}, '', '/spa-page');
    await fetch('/api/under-page');
    await dataflow.flush();
    const view = ingestedEvents(f).find((e) => e.name === 'VIEW /spa-page');
    const http = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(view).toBeTruthy();
    expect(http.parent_span_id).toBe(view.span_id);
  });

  it('disableHttp stops spans but keeps page views', async () => {
    const f = mockFetch();
    boot({ disableHttp: true });
    await fetch('/api/untraced');
    history.pushState({}, '', '/still-viewed');
    await dataflow.flush();
    const evs = ingestedEvents(f);
    expect(evs.some((e) => e.type === 'HTTP_CLIENT')).toBe(false);
    expect(evs.some((e) => e.name === 'VIEW /still-viewed')).toBe(true);
  });

  it('flush posts with X-Api-Key and JSON content type', async () => {
    const f = mockFetch();
    boot({ serviceName: 'web-app' });
    await fetch('/api/anything');
    await dataflow.flush();
    const calls = ingestCalls(f);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [, reqInit] = calls[0];
    const headers = new Headers(reqInit!.headers as HeadersInit);
    expect(headers.get('X-Api-Key')).toBe(API_KEY);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(String(calls[0][0])).toBe(`${ENDPOINT}/api/v1/ingest`);
  });
});
