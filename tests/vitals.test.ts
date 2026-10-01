import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import { accumulateCLS, fidFromEntry } from '../src/instrument/vitals';
import { boot, mockFetch, ingestedEvents, setReadyState } from './helpers';

describe('web vitals', () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetForTests();
  });

  it('reports TTFB from Navigation Timing on the page-load span', async () => {
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([
        { responseStart: 120, requestStart: 50 },
      ] as unknown as PerformanceEntry[]);
    const f = mockFetch();
    setReadyState('complete')();
    boot();
    spy.mockRestore();
    await dataflow.flush();
    const pv = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW');
    // metadata values are stringified for the map[string]string ingest contract
    expect(pv.metadata['webvital.ttfb']).toBe('70');
  });

  it('omits TTFB when no navigation entry exists', async () => {
    const spy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    const f = mockFetch();
    setReadyState('complete')();
    boot();
    spy.mockRestore();
    await dataflow.flush();
    const pv = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW');
    expect(pv.metadata?.['webvital.ttfb']).toBeUndefined();
  });

  it('accumulateCLS ignores input-linked shifts', () => {
    const cls = accumulateCLS([
      { value: 0.1 },
      { value: 0.2 },
      { value: 0.5, recentInput: true },
    ]);
    expect(cls).toBe(0.3);
  });

  it('accumulateCLS rounds to 3 decimals', () => {
    expect(accumulateCLS([{ value: 0.1 }, { value: 0.2 }])).toBe(0.3);
    expect(accumulateCLS([{ value: 0.12345 }])).toBe(0.123);
  });

  it('fidFromEntry computes processing delay', () => {
    expect(fidFromEntry({ startTime: 100, processingStart: 115 })).toBe(15);
  });

  it('fidFromEntry clamps negatives to 0', () => {
    expect(fidFromEntry({ startTime: 115, processingStart: 100 })).toBe(0);
    expect(fidFromEntry({})).toBe(0);
  });

  it('does not crash when PerformanceObserver is unavailable', async () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const f = mockFetch();
    setReadyState('complete')();
    expect(() => boot()).not.toThrow();
    await dataflow.flush();
    expect(ingestedEvents(f).some((e) => e.type === 'PAGE_VIEW')).toBe(true);
  });

  it('disableWebVitals keeps vitals off the page-load span', async () => {
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([
        { responseStart: 120, requestStart: 50 },
      ] as unknown as PerformanceEntry[]);
    const f = mockFetch();
    setReadyState('complete')();
    boot({ disableWebVitals: true });
    spy.mockRestore();
    await dataflow.flush();
    const pv = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW');
    expect(pv).toBeTruthy();
    expect(pv.metadata?.['webvital.ttfb']).toBeUndefined();
  });
});
