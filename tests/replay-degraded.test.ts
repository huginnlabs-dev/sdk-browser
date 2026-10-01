import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import dataflow, { __resetForTests } from '../src/index';
import { maybeStartReplay } from '../src/replay';
import { boot, mockFetch, sleep } from './helpers';

/**
 * Degradation paths: rrweb must never break the host page. When the dynamic
 * import fails (not bundled / blocked) or rrweb.record is unusable, replay
 * stays off for the page, warns exactly once, and tracing is unaffected.
 */
const { recordMock, importState } = vi.hoisted(() => ({
  recordMock: vi.fn(),
  importState: { mode: 'reject' as 'reject' | 'no-record' },
}));
vi.mock('rrweb', () => {
  if (importState.mode === 'reject') throw new Error('rrweb is not available in this build');
  return { record: undefined }; // record missing / not a function
});

/** Fetch calls that targeted the replay endpoint. */
function replayCalls(f: any): Array<[unknown, RequestInit | undefined]> {
  return (f.mock.calls as Array<[unknown, RequestInit | undefined]>).filter((c) =>
    String(c[0]).includes('/api/v1/replay'),
  );
}

describe('session replay degradation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetForTests();
    vi.resetModules(); // force the rrweb factory to re-run with the current mode
    importState.mode = 'reject';
    recordMock.mockClear();
    document.body.innerHTML = '';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetForTests();
  });

  const replayWarnings = (): number =>
    warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('rrweb')).length;

  it('degrades silently when the rrweb import rejects (warn once, no recording, no posts)', async () => {
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);

    expect(recordMock).not.toHaveBeenCalled();
    expect(replayCalls(f)).toHaveLength(0);
    expect(replayWarnings()).toBe(1);
    // Tracing is unaffected by the failed rrweb import.
    await fetch('/api/after-degradation');
    await dataflow.flush();
    expect(f.mock.calls.some((c: any[]) => String(c[0]).includes('/api/v1/ingest'))).toBe(true);
  });

  it('stays off for the page: re-init merges do not retry the import or warn again', async () => {
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);
    expect(replayWarnings()).toBe(1);

    // A later init() merge re-evaluates the flag but must not retry rrweb.
    boot({ replay: true, serviceName: 'again' });
    maybeStartReplay();
    maybeStartReplay();
    await sleep(10);

    expect(recordMock).not.toHaveBeenCalled();
    expect(replayCalls(f)).toHaveLength(0);
    expect(replayWarnings()).toBe(1);
  });

  it('degrades silently when the rrweb module has no usable record export', async () => {
    importState.mode = 'no-record';
    const f = mockFetch();
    boot({ replay: true });
    await sleep(10);

    expect(recordMock).not.toHaveBeenCalled();
    expect(replayCalls(f)).toHaveLength(0);
    expect(replayWarnings()).toBe(1);
  });

  it('does not warn when replay was never enabled', async () => {
    mockFetch();
    boot();
    await sleep(10);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
