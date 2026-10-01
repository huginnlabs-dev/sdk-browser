import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import { boot, mockFetch, ingestedEvents, setReadyState } from './helpers';

describe('click breadcrumbs', () => {
  beforeEach(() => {
    __resetForTests();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  function clickAt(tag: string, id?: string, text?: string): void {
    const el = document.createElement(tag);
    if (id) el.id = id;
    if (text) el.textContent = text;
    document.body.appendChild(el);
    el.click();
  }

  async function errorCrumbs(f: any): Promise<Array<{ label: string; timestamp: number }>> {
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'probe',
      filename: 'a.js',
      lineno: 1,
      colno: 1,
      error: new Error('probe'),
    }));
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    const raw = span?.metadata?.breadcrumbs;
    return (raw ? JSON.parse(raw as unknown as string) : []) as Array<{
      label: string;
      timestamp: number;
    }>;
  }

  it('records clicks as tag#id:text with a timestamp', async () => {
    const f = mockFetch();
    boot();
    clickAt('button', 'submit', 'Buy now');
    const crumbs = await errorCrumbs(f);
    expect(crumbs.some((c) => c.label === 'button#submit:Buy now')).toBe(true);
  });

  it('handles elements without id or text', async () => {
    const f = mockFetch();
    boot();
    clickAt('div');
    const crumbs = await errorCrumbs(f);
    expect(crumbs.some((c) => c.label === 'div:')).toBe(true);
  });

  it('caps the trail at maxBreadcrumbs, keeping the most recent', async () => {
    const f = mockFetch();
    boot({ maxBreadcrumbs: 3 });
    clickAt('button', 'b1');
    clickAt('button', 'b2');
    clickAt('button', 'b3');
    clickAt('button', 'b4');
    clickAt('button', 'b5');
    const crumbs = await errorCrumbs(f);
    expect(crumbs).toHaveLength(3);
    expect(crumbs.map((c) => c.label)).toEqual([
      'button#b3:',
      'button#b4:',
      'button#b5:',
    ]);
  });

  it('disableBreadcrumbs keeps the trail empty', async () => {
    const f = mockFetch();
    boot({ disableBreadcrumbs: true });
    clickAt('button', 'quiet', 'Press');
    const crumbs = await errorCrumbs(f);
    expect(crumbs).toHaveLength(0);
  });

  it('page-load span is emitted on window load', async () => {
    const f = mockFetch();
    const restore = setReadyState('loading');
    boot();
    window.dispatchEvent(new Event('load'));
    restore();
    await dataflow.flush();
    const pv = ingestedEvents(f).find((e) => e.type === 'PAGE_VIEW');
    expect(pv).toBeTruthy();
    expect(pv.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
