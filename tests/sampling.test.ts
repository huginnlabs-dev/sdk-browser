import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests, __internals } from '../src/index';
import { boot, mockFetch, ingestedEvents, ingestCalls, setReadyState } from './helpers';

describe('sampling', () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  it('sampleRate 0 sends nothing', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot({ sampleRate: 0 });
    await fetch('/api/anything');
    await dataflow.flush();
    expect(ingestCalls(f)).toHaveLength(0);
    expect(ingestedEvents(f)).toHaveLength(0);
  });

  it('sampleRate 1 sends events', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot({ sampleRate: 1 });
    await fetch('/api/anything');
    await dataflow.flush();
    const evs = ingestedEvents(f);
    expect(evs.length).toBeGreaterThanOrEqual(2); // page-load span + http span
  });

  it('is one roll per page load — consistent even when Math.random changes later', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9); // >= 0.5 -> unsampled
    const f = mockFetch();
    setReadyState('complete')();
    boot({ sampleRate: 0.5 });
    expect(dataflow.isSampled()).toBe(false);
    spy.mockRestore(); // from now on Math.random is honest again

    await fetch('/api/anything');
    history.pushState({}, '', '/page');
    await dataflow.flush();

    // Still nothing: the page-load decision is never re-rolled.
    expect(ingestedEvents(f)).toHaveLength(0);
    expect(__internals.state.sampled).toBe(false);
  });

  it('rolls sampled when Math.random is below the rate', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const f = mockFetch();
    setReadyState('complete')();
    boot({ sampleRate: 0.5 });
    expect(dataflow.isSampled()).toBe(true);
    spy.mockRestore();
    await fetch('/api/anything');
    await dataflow.flush();
    expect(ingestedEvents(f).some((e) => e.type === 'HTTP_CLIENT')).toBe(true);
  });

  it('clamped rates behave as 1 and 0', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    setReadyState('complete')();
    boot({ sampleRate: 5 }); // clamp -> 1: sampled even with a high roll
    expect(dataflow.isSampled()).toBe(true);
    __resetForTests();

    spy.mockReturnValue(0.01);
    const f2 = mockFetch();
    boot({ sampleRate: -1 }); // clamp -> 0: never sampled
    expect(dataflow.isSampled()).toBe(false);
    spy.mockRestore();
    await fetch('/api/anything');
    await dataflow.flush();
    expect(ingestCalls(f2)).toHaveLength(0);
  });
});
