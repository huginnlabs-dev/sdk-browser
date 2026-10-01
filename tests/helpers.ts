import { vi } from 'vitest';
import { init } from '../src/index';

export const ENDPOINT = 'http://ingest.test';
export const API_KEY = 'df_test_key';
export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Boot the SDK with test defaults. */
export function boot(opts: Record<string, unknown> = {}): ReturnType<typeof init> {
  return init({ endpoint: ENDPOINT, apiKey: API_KEY, ...opts });
}

/** Replace global fetch with a vi.fn mock (call BEFORE init so the wrapper wraps the mock). */
export function mockFetch(impl?: (...args: unknown[]) => Promise<Response>): any {
  const f = vi.fn(
    impl ??
      (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
  (globalThis as { fetch: unknown }).fetch = f;
  return f;
}

/** All fetch calls that targeted the ingest endpoint, flattened into event arrays. */
export function ingestedEvents(f: any): any[] {
  const events: any[] = [];
  for (const call of f.mock.calls as Array<[unknown, RequestInit | undefined]>) {
    const [url, reqInit] = call;
    if (String(url).includes('/api/v1/ingest') && reqInit?.body) {
      const parsed = JSON.parse(String(reqInit.body)) as { events?: any[] };
      events.push(...(parsed.events ?? []));
    }
  }
  return events;
}

/** Fetch calls that targeted the ingest endpoint. */
export function ingestCalls(f: any): Array<[unknown, RequestInit | undefined]> {
  return (f.mock.calls as Array<[unknown, RequestInit | undefined]>).filter((c) =>
    String(c[0]).includes('/api/v1/ingest'),
  );
}

/** Header of a specific fetch call, or null. */
export function headerOf(
  call: [unknown, RequestInit | undefined] | undefined,
  name: string,
): string | null {
  if (!call) return null;
  const headers = new Headers((call[1]?.headers as HeadersInit | undefined) ?? undefined);
  return headers.get(name);
}

/** Force document.readyState (happy-dom may not allow direct assignment). Returns a restore fn. */
export function setReadyState(v: DocumentReadyState): () => void {
  const doc = document as unknown as Record<string, unknown>;
  Object.defineProperty(doc, 'readyState', { value: v, configurable: true });
  return () => {
    delete doc.readyState;
  };
}
