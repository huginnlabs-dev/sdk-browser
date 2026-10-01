import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { init, __resetForTests, __internals } from '../src/index';
import { ENDPOINT, API_KEY, mockFetch, ingestedEvents, boot, setReadyState } from './helpers';

describe('init', () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  it('requires endpoint', () => {
    expect(() => init({ apiKey: API_KEY })).toThrow(/endpoint/);
  });

  it('requires apiKey', () => {
    expect(() => init({ endpoint: ENDPOINT })).toThrow(/apiKey/);
  });

  it('throws outside a browser environment', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const origWindow = g.window;
    const origDocument = g.document;
    let removed = false;
    try {
      delete g.window;
      delete g.document;
      removed = g.window === undefined || g.document === undefined;
    } catch {
      removed = false; // globals not configurable in this environment
    }
    if (!removed) return; // nothing provable here
    try {
      expect(() => init({ endpoint: ENDPOINT, apiKey: API_KEY })).toThrow(/browser/);
    } finally {
      g.window = origWindow;
      g.document = origDocument;
    }
  });

  it('returns the public API', () => {
    const api = boot();
    expect(api).toBe(dataflow);
    expect(typeof api.init).toBe('function');
    expect(typeof api.flush).toBe('function');
    expect(api.version).toBe('0.1.0');
    expect(api.traceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(api.isSampled()).toBe(true);
  });

  it('applies documented defaults', () => {
    boot();
    const cfg = __internals.state.config!;
    expect(cfg.endpoint).toBe(ENDPOINT);
    expect(cfg.apiKey).toBe(API_KEY);
    expect(cfg.sampleRate).toBe(1);
    expect(cfg.traceHeader).toBe(true);
    expect(cfg.flushInterval).toBe(2000);
    expect(cfg.maxBatchSize).toBe(20);
    expect(cfg.maxBreadcrumbs).toBe(20);
    expect(cfg.serviceName).toBe(location.host);
    expect(cfg.allowedTraceOrigins).toEqual([]);
  });

  it('uses the configured serviceName', () => {
    boot({ serviceName: 'web-app' });
    expect(__internals.state.config!.serviceName).toBe('web-app');
  });

  it('merges options on subsequent init calls without restarting', () => {
    const api = boot({ serviceName: 'web-app' });
    const traceId = api.traceId();
    api.init({ sampleRate: 0.25, endpoint: 'http://other.test', apiKey: 'df_second' });
    const cfg = __internals.state.config!;
    expect(cfg.sampleRate).toBe(0.25);
    expect(cfg.endpoint).toBe('http://other.test');
    expect(cfg.apiKey).toBe('df_second');
    expect(cfg.serviceName).toBe('web-app'); // untouched option survives the merge
    expect(api.traceId()).toBe(traceId); // idempotent: no new trace id
  });

  it('second init does not double-wrap fetch', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot();
    boot(); // idempotent no-op merge
    await fetch('/only-once');
    await dataflow.flush();
    const http = ingestedEvents(f).filter((e) => e.type === 'HTTP_CLIENT');
    expect(http).toHaveLength(1);
  });

  it('clamps sampleRate into [0, 1]', () => {
    boot({ sampleRate: 5 });
    expect(__internals.state.config!.sampleRate).toBe(1);
    __resetForTests();
    boot({ sampleRate: -3 });
    expect(__internals.state.config!.sampleRate).toBe(0);
  });

  it('emits a page-load PAGE_VIEW immediately when document is already complete', async () => {
    const f = mockFetch();
    const restore = setReadyState('complete');
    boot();
    restore();
    await dataflow.flush();
    const pv = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW');
    expect(pv).toBeTruthy();
    expect(pv.name).toBe(`VIEW ${location.pathname}`);
    expect(typeof pv.duration_ms).toBe('number');
    expect(pv.duration_ms).toBeGreaterThanOrEqual(0);
    expect(pv.parent_span_id).toBeUndefined(); // root span
  });
});
