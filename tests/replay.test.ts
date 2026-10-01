import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import {
  REPLAY_BUFFER_CAP,
  REPLAY_FLUSH_BATCH,
  REPLAY_FLUSH_INTERVAL_MS,
  bufferEvent,
  flushReplay,
  maybeStartReplay,
  replayBufferSnapshot,
  replayDroppedCount,
} from '../src/replay';
import { API_KEY, ENDPOINT, boot, ingestedEvents, mockFetch, sleep } from './helpers';

/**
 * rrweb is mocked at the module boundary: the SDK must load it with a dynamic
 * import, and the tests never touch the real recorder.
 */
const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));
vi.mock('rrweb', () => ({ record: recordMock }));

/** Synthetic rrweb event (same shape the real record() emits). */
function fakeEvent(n: number, pad = 0): { type: number; data: Record<string, unknown>; timestamp: number } {
  return { type: 3, data: { source: 0, node: `n-${'x'.repeat(pad)}${n}` }, timestamp: Date.now() };
}

/** The emit callback rrweb.record was started with. */
function rrwebEmit(): (ev: unknown) => void {
  const opts = recordMock.mock.calls[0]?.[0] as { emit?: (ev: unknown) => void } | undefined;
  if (typeof opts?.emit !== 'function') throw new Error('rrweb.record was not started');
  return opts.emit;
}

/** Fetch calls that targeted the replay endpoint. */
function replayCalls(f: any): Array<[unknown, RequestInit | undefined]> {
  return (f.mock.calls as Array<[unknown, RequestInit | undefined]>).filter((c) =>
    String(c[0]).includes('/api/v1/replay'),
  );
}

describe('session replay', () => {
  beforeEach(() => {
    __resetForTests();
    document.body.innerHTML = '';
    recordMock.mockClear();
    // record() returns a stop function; capture the options it was given.
    recordMock.mockImplementation(() => vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetForTests();
  });

  it('does not touch rrweb or the replay endpoint when the flag is off (default)', async () => {
    const f = mockFetch();
    boot();
    await sleep(10);
    expect(recordMock).not.toHaveBeenCalled();
    expect(replayCalls(f)).toHaveLength(0);

    __resetForTests();
    recordMock.mockClear();
    const f2 = mockFetch();
    boot({ replay: false });
    await sleep(10);
    expect(recordMock).not.toHaveBeenCalled();
    expect(replayCalls(f2)).toHaveLength(0);
  });

  it('rolls replaySampleRate once per page load, independently of trace sampling', async () => {
    const f = mockFetch();
    boot({ replay: true, replaySampleRate: 0 }); // never sampled
    await sleep(10);
    expect(recordMock).not.toHaveBeenCalled();
    expect(replayCalls(f)).toHaveLength(0);

    __resetForTests();
    recordMock.mockClear();
    const f2 = mockFetch();
    boot({ replay: true, replaySampleRate: 1 }); // always sampled
    await sleep(10);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(replayCalls(f2)).toHaveLength(0); // nothing buffered yet, nothing posted
  });

  it('starts rrweb.record with the privacy defaults', async () => {
    mockFetch();
    boot({ replay: true });
    await sleep(10);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const opts = recordMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.maskAllInputs).toBe(true);
    expect(opts.maskTextClass).toBe('df-mask');
    expect(opts.blockClass).toBe('df-block');
    expect(opts.inlineImages).toBe(false);
    expect(typeof opts.emit).toBe('function');
  });

  it('starts at most one rrweb stream per page load (re-init merges never double-start)', async () => {
    mockFetch();
    boot({ replay: true });
    await sleep(10);
    boot({ replay: true, serviceName: 'again' }); // re-init merge
    maybeStartReplay();
    maybeStartReplay();
    await sleep(10);
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('caps the buffer at 3000 events, dropping the OLDEST (counted)', () => {
    const total = REPLAY_BUFFER_CAP + 200;
    for (let i = 0; i < total; i++) bufferEvent(fakeEvent(i));
    const snap = replayBufferSnapshot();
    expect(snap).toHaveLength(REPLAY_BUFFER_CAP);
    expect(replayDroppedCount()).toBe(200);
    expect(String((snap[0].data as { node: string }).node)).toContain('200'); // first 200 gone
    expect(String((snap[snap.length - 1].data as { node: string }).node)).toContain(String(total - 1));
  });

  it('flushes batches to /api/v1/replay with X-Api-Key, JSON headers and the trace_id body shape', async () => {
    const f = mockFetch();
    boot({ replay: true, serviceName: 'web-app' });
    await sleep(10);
    const emit = rrwebEmit();
    for (let i = 0; i < REPLAY_FLUSH_BATCH; i++) emit(fakeEvent(i)); // threshold -> auto flush

    await vi.waitFor(() => expect(replayCalls(f)).toHaveLength(1));
    const [url, reqInit] = replayCalls(f)[0];
    expect(String(url)).toBe(`${ENDPOINT}/api/v1/replay`);
    expect(reqInit!.method).toBe('POST');
    const headers = new Headers(reqInit!.headers as HeadersInit);
    expect(headers.get('X-Api-Key')).toBe(API_KEY);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('x-dataflow-trace-id')).toBeNull(); // own beacons carry no trace header
    expect(reqInit!.keepalive).toBe(false);

    const body = JSON.parse(String(reqInit!.body)) as { trace_id: string; events: any[] };
    expect(body.trace_id).toBe(dataflow.traceId()); // the ROOT page-load trace id
    expect(body.events).toHaveLength(REPLAY_FLUSH_BATCH);
    expect(body.events[0].data).toEqual(fakeEvent(0).data);
    for (const ev of body.events) {
      expect(typeof ev.type).toBe('number');
      expect(ev.data).toBeTruthy();
      expect(typeof ev.timestamp).toBe('number');
    }
  });

  it('flushes on the 3s replay interval when below the batch threshold', async () => {
    vi.useFakeTimers();
    const f = mockFetch();
    boot({ replay: true });
    await vi.advanceTimersByTimeAsync(1); // let the dynamic rrweb import settle
    const emit = rrwebEmit();
    for (let i = 0; i < 5; i++) emit(fakeEvent(i));
    expect(replayCalls(f)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(REPLAY_FLUSH_INTERVAL_MS);
    expect(replayCalls(f)).toHaveLength(1);
    const body = JSON.parse(String(replayCalls(f)[0][1]!.body));
    expect(body.events).toHaveLength(5);
  });

  it('flushes buffered events on pagehide via fetch keepalive', async () => {
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);
    const emit = rrwebEmit();
    for (let i = 0; i < 10; i++) emit(fakeEvent(i));
    expect(replayCalls(f)).toHaveLength(0);
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(replayCalls(f)).toHaveLength(1));
    const [url, reqInit] = replayCalls(f)[0];
    expect(String(url)).toBe(`${ENDPOINT}/api/v1/replay`);
    expect(reqInit!.keepalive).toBe(true);
    const headers = new Headers(reqInit!.headers as HeadersInit);
    expect(headers.get('X-Api-Key')).toBe(API_KEY);
    const body = JSON.parse(String(reqInit!.body));
    expect(body.trace_id).toBe(dataflow.traceId());
    expect(body.events).toHaveLength(10);
    expect(replayBufferSnapshot()).toHaveLength(0);
  });

  it('drops oldest events on pagehide when the keepalive payload exceeds 64 KiB', async () => {
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);
    const emit = rrwebEmit();
    for (let i = 0; i < 150; i++) emit(fakeEvent(i, 600)); // ~100 KiB of JSON
    expect(replayCalls(f)).toHaveLength(0);
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(replayCalls(f)).toHaveLength(1));
    const [, reqInit] = replayCalls(f)[0];
    expect(reqInit!.keepalive).toBe(true);
    const bodyStr = String(reqInit!.body);
    expect(new TextEncoder().encode(bodyStr).length).toBeLessThanOrEqual(65536);
    const body = JSON.parse(bodyStr) as { events: any[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.length).toBeLessThan(150);
    expect(replayDroppedCount()).toBe(150 - body.events.length);
  });

  it('retries a failed flush exactly once, then drops the batch (lossy by design)', async () => {
    const f = mockFetch(async () => {
      throw new TypeError('network down');
    });
    boot({ replay: true });
    await sleep(10);
    const emit = rrwebEmit();
    for (let i = 0; i < 5; i++) emit(fakeEvent(i));
    await flushReplay();
    expect(replayCalls(f)).toHaveLength(2); // 1 attempt + 1 retry
    expect(replayBufferSnapshot()).toHaveLength(0); // dropped, not re-queued
  });

  it('treats non-ok responses as failures: one retry, then drop', async () => {
    const f = mockFetch(async () => new Response('server error', { status: 500 }));
    boot({ replay: true });
    await sleep(10);
    rrwebEmit()(fakeEvent(1));
    await flushReplay();
    expect(replayCalls(f)).toHaveLength(2);
    expect(replayBufferSnapshot()).toHaveLength(0);
  });

  it('does not retry a successful POST', async () => {
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);
    rrwebEmit()(fakeEvent(1));
    await flushReplay();
    expect(replayCalls(f)).toHaveLength(1);
  });

  it('chunks flushes to at most 500 events per POST (server contract)', async () => {
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);
    for (let i = 0; i < 1200; i++) bufferEvent(fakeEvent(i));
    await flushReplay();
    const calls = replayCalls(f);
    expect(calls).toHaveLength(3);
    const sizes = calls.map(([, r]) => (JSON.parse(String(r!.body)) as { events: any[] }).events.length);
    expect(sizes).toEqual([500, 500, 200]);
    for (const [, r] of calls) {
      expect((JSON.parse(String(r!.body)) as { trace_id: string }).trace_id).toBe(dataflow.traceId());
    }
  });

  it('replay beacons never create HTTP_CLIENT spans (same pristine fetch path as ingest)', async () => {
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);
    const emit = rrwebEmit();
    for (let i = 0; i < REPLAY_FLUSH_BATCH; i++) emit(fakeEvent(i, 40));
    await vi.waitFor(() => expect(replayCalls(f)).toHaveLength(1));
    await dataflow.flush(); // drain whatever the ingest transport queued
    const spans = ingestedEvents(f).filter((e) => e.type === 'HTTP_CLIENT');
    for (const span of spans) {
      expect(String(span.metadata?.['http.url'] ?? '')).not.toContain('/api/v1/replay');
    }
  });
});
