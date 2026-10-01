import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import { META } from '../src/version';
import { boot, mockFetch, ingestedEvents } from './helpers';

function dispatchWindowError(init: ErrorEventInit): void {
  window.dispatchEvent(new ErrorEvent('error', init));
}

describe('JS error capture', () => {
  beforeEach(() => {
    __resetForTests();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  it('window error events become FUNCTION_CALL spans named browser.error', async () => {
    const f = mockFetch();
    boot();
    dispatchWindowError({
      message: 'Boom',
      filename: 'app.js',
      lineno: 12,
      colno: 34,
      error: new Error('Boom'),
    });
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    expect(span).toBeTruthy();
    expect(span.name).toBe('browser.error');
    expect(span.function_name).toBe('window.onerror');
    expect(span.status_code).toBe(500);
    expect(span.error_message).toBe('Boom');
    expect(span.metadata[META.errorMessage]).toBe('Boom');
  });

  it('records error.source as file:line:col', async () => {
    const f = mockFetch();
    boot();
    dispatchWindowError({
      message: 'Oops',
      filename: 'app.js',
      lineno: 12,
      colno: 34,
      error: new Error('Oops'),
    });
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    expect(span.metadata[META.errorSource]).toBe('app.js:12:34');
  });

  it('records error.stack when available', async () => {
    const f = mockFetch();
    boot();
    const err = new Error('with stack');
    expect(err.stack).toBeTruthy();
    dispatchWindowError({ message: 'with stack', filename: 'a.js', lineno: 1, colno: 1, error: err });
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    expect(span.metadata[META.errorStack]).toBe(err.stack);
  });

  it('truncates long messages to 500 chars', async () => {
    const f = mockFetch();
    boot();
    dispatchWindowError({
      message: 'M'.repeat(600),
      filename: 'a.js',
      lineno: 1,
      colno: 1,
      error: new Error('M'.repeat(600)),
    });
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    expect(span.error_message!.length).toBe(500);
    expect(span.metadata[META.errorMessage].length).toBe(500);
  });

  it('truncates long stacks to 8192 chars', async () => {
    const f = mockFetch();
    boot();
    const err = new Error('big stack');
    err.stack = 'S'.repeat(9000);
    dispatchWindowError({ message: 'big stack', filename: 'a.js', lineno: 1, colno: 1, error: err });
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    expect((span.metadata[META.errorStack] as string).length).toBe(8192);
  });

  it('unhandledrejection becomes a browser.error span', async () => {
    const f = mockFetch();
    boot();
    const ev = new Event('unhandledrejection') as Event & { reason: unknown; promise: Promise<unknown> };
    ev.reason = new Error('Async boom');
    ev.promise = Promise.resolve();
    window.dispatchEvent(ev);
    await dataflow.flush();
    const span = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    expect(span).toBeTruthy();
    expect(span.function_name).toBe('unhandledrejection');
    expect(span.error_message).toBe('Async boom');
  });

  it('attaches click breadcrumbs to error spans only', async () => {
    const f = mockFetch();
    boot();
    const btn = document.createElement('button');
    btn.id = 'submit';
    btn.textContent = 'Buy now';
    document.body.appendChild(btn);
    btn.click();

    await fetch('/api/plain-request'); // regular span for contrast
    dispatchWindowError({ message: 'E', filename: 'a.js', lineno: 1, colno: 1, error: new Error('E') });
    await dataflow.flush();

    const errSpan = ingestedEvents(f).find((e) => e.type === 'FUNCTION_CALL');
    // metadata values are strings on the wire (map[string]string) — breadcrumbs are JSON-encoded
    const crumbs = JSON.parse(errSpan.metadata[META.breadcrumbs] as string) as Array<{
      label: string;
      timestamp: number;
    }>;
    expect(Array.isArray(crumbs)).toBe(true);
    expect(crumbs.some((c) => c.label === 'button#submit:Buy now')).toBe(true);
    expect(typeof crumbs[0].timestamp).toBe('number');

    const httpSpan = ingestedEvents(f).find((e) => e.type === 'HTTP_CLIENT');
    expect(httpSpan.metadata[META.breadcrumbs]).toBeUndefined();
  });

  it('disableErrors suppresses error spans', async () => {
    const f = mockFetch();
    boot({ disableErrors: true });
    dispatchWindowError({ message: 'quiet', filename: 'a.js', lineno: 1, colno: 1, error: new Error('quiet') });
    await dataflow.flush();
    expect(ingestedEvents(f).some((e) => e.type === 'FUNCTION_CALL')).toBe(false);
  });
});
