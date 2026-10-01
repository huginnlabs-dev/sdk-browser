import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import { boot, mockFetch, ingestedEvents, setReadyState, sleep } from './helpers';

describe('page views (history instrumentation)', () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  it('pushState emits a PAGE_VIEW named VIEW <pathname>', async () => {
    const f = mockFetch();
    boot();
    history.pushState({}, '', '/new-route');
    await dataflow.flush();
    const pv = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW' && e.name === 'VIEW /new-route');
    expect(pv).toBeTruthy();
    expect(pv.trace_id).toBe(dataflow.traceId());
    expect(location.pathname).toBe('/new-route');
  });

  it('replaceState emits a PAGE_VIEW', async () => {
    const f = mockFetch();
    boot();
    history.replaceState({}, '', '/replaced-route');
    await dataflow.flush();
    const pv = ingestedEvents(f).find(
      (e) => e.type === 'PAGE_VIEW' && e.name === 'VIEW /replaced-route',
    );
    expect(pv).toBeTruthy();
  });

  it('does not emit twice for the same URL (dedupe)', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot();
    history.pushState({}, '', '/dup');
    history.pushState({}, '', '/dup'); // same pathname+search+hash -> skipped
    await dataflow.flush();
    const dups = ingestedEvents(f).filter((e) => e.type === 'PAGE_VIEW' && e.name === 'VIEW /dup');
    expect(dups).toHaveLength(1);
  });

  it('first route change measures duration since the page load', async () => {
    const f = mockFetch();
    setReadyState('complete')(); // page-load span finalized synchronously at init
    boot();
    await sleep(30);
    history.pushState({}, '', '/later');
    await dataflow.flush();
    const later = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW' && e.name === 'VIEW /later');
    expect(later).toBeTruthy();
    expect(later.duration_ms).toBeGreaterThanOrEqual(10);
  });

  it('page-load span ends on the window load event when still loading', async () => {
    const f = mockFetch();
    const restore = setReadyState('loading');
    boot();
    await dataflow.flush();
    expect(ingestedEvents(f)).toHaveLength(0); // span open, nothing sent yet

    window.dispatchEvent(new Event('load'));
    restore();
    await dataflow.flush();
    const pv = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW');
    expect(pv).toBeTruthy();
    expect(pv.duration_ms).toBeGreaterThanOrEqual(0);
    expect(pv.parent_span_id).toBeUndefined(); // root span of the trace
  });

  it('popstate listener routes through route-change emission', async () => {
    const f = mockFetch();
    boot();
    location.hash = '#pop-target'; // change the URL, then simulate back/forward
    window.dispatchEvent(new Event('popstate'));
    await dataflow.flush();
    const pvs = ingestedEvents(f).filter((e) => e.type === 'PAGE_VIEW');
    expect(pvs.length).toBeGreaterThanOrEqual(1);
    const last = pvs[pvs.length - 1];
    expect(String(last.name)).toContain('VIEW');
  });

  it('hashchange listener routes through route-change emission', async () => {
    const f = mockFetch();
    boot();
    location.hash = '#hash-target';
    window.dispatchEvent(new Event('hashchange'));
    await dataflow.flush();
    const pvs = ingestedEvents(f).filter((e) => e.type === 'PAGE_VIEW');
    expect(pvs.length).toBeGreaterThanOrEqual(1);
  });

  it('route-change spans parent to the previous view span', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot();
    history.pushState({}, '', '/first-view');
    history.pushState({}, '', '/second-view');
    await dataflow.flush();
    const first = ingestedEvents(f).find((e) => e.name === 'VIEW /first-view');
    const second = ingestedEvents(f).find((e) => e.name === 'VIEW /second-view');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second.parent_span_id).toBe(first.span_id);
  });

  it('disablePageViews suppresses PAGE_VIEW but keeps HTTP spans', async () => {
    const f = mockFetch();
    boot({ disablePageViews: true });
    history.pushState({}, '', '/no-view');
    await fetch('/api/still-traced');
    await dataflow.flush();
    const evs = ingestedEvents(f);
    expect(evs.some((e) => e.type === 'PAGE_VIEW')).toBe(false);
    expect(evs.some((e) => e.type === 'HTTP_CLIENT')).toBe(true);
  });

  it('disabling page views after init stops emission (live merge)', async () => {
    const f = mockFetch();
    setReadyState('complete')();
    boot();
    dataflow.init({ disablePageViews: true });
    history.pushState({}, '', '/suppressed');
    await dataflow.flush();
    expect(ingestedEvents(f).some((e) => e.name === 'VIEW /suppressed')).toBe(false);
  });
});
