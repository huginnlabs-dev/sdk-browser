import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import { API_KEY, ENDPOINT, boot, ingestCalls, ingestedEvents, mockFetch, setReadyState, sleep } from './helpers';

describe('batch transport', () => {
  beforeEach(() => {
    __resetForTests();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  it('auto-flushes when the queue reaches maxBatchSize', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot({ maxBatchSize: 4 }); // queue starts with the page-load span (1 event)
    await fetch('/api/a'); // 2
    await fetch('/api/b'); // 3 -> still below the batch threshold
    expect(ingestCalls(f)).toHaveLength(0);
    await fetch('/api/c'); // 4 -> threshold reached, auto flush
    expect(ingestCalls(f).length).toBeGreaterThanOrEqual(1);
    await dataflow.flush(); // drain whatever the auto flush left behind
    expect(ingestedEvents(f).filter((e) => e.type === 'HTTP_CLIENT')).toHaveLength(3);
  });

  it('flushes on the flush interval', async () => {
    const f = mockFetch();
    boot({ flushInterval: 10 });
    await fetch('/api/slow-batch');
    expect(ingestCalls(f)).toHaveLength(0);
    await sleep(60);
    expect(ingestCalls(f).length).toBeGreaterThanOrEqual(1);
  });

  it('pagehide triggers a keepalive flush with auth headers', async () => {
    const f = mockFetch();
    boot({ serviceName: 'web-app' });
    await fetch('/api/last-thing');
    const before = ingestCalls(f).length;
    window.dispatchEvent(new Event('pagehide'));
    const calls = ingestCalls(f);
    expect(calls.length).toBeGreaterThan(before);
    const [, reqInit] = calls[calls.length - 1];
    expect(reqInit!.keepalive).toBe(true);
    const headers = new Headers(reqInit!.headers as HeadersInit);
    expect(headers.get('X-Api-Key')).toBe(API_KEY);
    expect(headers.get('Content-Type')).toBe('application/json');
    const body = JSON.parse(String(reqInit!.body)) as { events: any[] };
    expect(body.events.some((e) => e.type === 'HTTP_CLIENT')).toBe(true);
  });

  it('visibilitychange to hidden triggers a keepalive flush', async () => {
    const f = mockFetch();
    boot();
    await fetch('/api/hiding');
    const before = ingestCalls(f).length;
    const doc = document as unknown as Record<string, unknown>;
    Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete doc.visibilityState;
    }
    expect(ingestCalls(f).length).toBeGreaterThan(before);
    const [, reqInit] = ingestCalls(f)[ingestCalls(f).length - 1];
    expect(reqInit!.keepalive).toBe(true);
  });

  it('visibilitychange to visible does not flush', async () => {
    const f = mockFetch();
    boot();
    await fetch('/api/staying');
    const before = ingestCalls(f).length;
    const doc = document as unknown as Record<string, unknown>;
    Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete doc.visibilityState;
    }
    expect(ingestCalls(f).length).toBe(before);
  });

  it('never rejects when the ingest endpoint fails', async () => {
    mockFetch(async () => {
      throw new TypeError('network down');
    });
    boot();
    await expect(fetch('/api/fail-while-sending')).rejects.toBeTruthy(); // caller still sees the error
    await expect(dataflow.flush()).resolves.toBeUndefined(); // but the transport never rejects
    window.dispatchEvent(new Event('pagehide')); // keepalive path also must not throw
  });

  it('drains the queue on flush (nothing sent twice)', async () => {
    const f = mockFetch();
    boot();
    await fetch('/api/once');
    await dataflow.flush();
    const afterFirst = ingestCalls(f).length;
    await dataflow.flush();
    expect(ingestCalls(f).length).toBe(afterFirst);
  });

  it('empty flush performs no request', async () => {
    const f = mockFetch();
    boot(); // page-load span queued (readyState is complete in tests)
    await dataflow.flush(); // drain it
    const afterDrain = ingestCalls(f).length;
    await dataflow.flush(); // nothing left to send
    expect(ingestCalls(f).length).toBe(afterDrain);
  });

  it('payload matches the server wire contract', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot({ serviceName: 'web-app' });
    await fetch('/api/contract');
    await dataflow.flush();
    const events = ingestedEvents(f);
    expect(events.length).toBeGreaterThanOrEqual(2);

    let prevSeq = 0;
    for (const ev of events) {
      expect(ev.event_id).toMatch(/^[0-9a-f]{32}$/);
      expect(ev.seq).toBeGreaterThan(prevSeq);
      prevSeq = ev.seq;
      expect(typeof ev.timestamp).toBe('number');
      expect(ev.trace_id).toBe(dataflow.traceId());
      expect(ev.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(ev.service_name).toBe('web-app');
      expect(['PAGE_VIEW', 'HTTP_CLIENT', 'FUNCTION_CALL']).toContain(ev.type);
      // browser spans never carry payloads
      expect(ev.payload).toBeUndefined();
      // server contract: metadata is map[string]string — any non-string value
      // makes the server reject the entire batch
      if (ev.metadata) {
        for (const v of Object.values(ev.metadata)) {
          expect(typeof v).toBe('string');
        }
      }
    }

    const root = events.find((e) => e.type === 'PAGE_VIEW');
    expect(root.parent_span_id).toBeUndefined();
    const http = events.find((e) => e.type === 'HTTP_CLIENT');
    expect(http.parent_span_id).toBe(root.span_id);
    expect(String(ingestCalls(f)[0][0])).toBe(`${ENDPOINT}/api/v1/ingest`);
  });
});
