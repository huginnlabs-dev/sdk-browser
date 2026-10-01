import { state } from '../config';
import { emitEvent } from '../events';
import { addTeardown } from '../patch';
import { nowMs } from '../util';

interface PatchedHistory {
  __dataflowPatched?: boolean;
}

/** Full URL key used for route-change dedupe. */
export function currentUrlString(): string {
  return location.pathname + location.search + location.hash;
}

/**
 * SPA page-view instrumentation: patch history.pushState / replaceState and
 * listen for popstate + hashchange. Route changes emit a PAGE_VIEW span named
 * `VIEW <pathname>` whose duration is the time spent on the previous route.
 * The patch is installed unconditionally; emission is gated at event time so
 * `disablePageViews` can be toggled by a later init() merge.
 */
export function instrumentHistory(): void {
  const w = window as unknown as Window;
  const h = w.history as History & PatchedHistory;
  const anyHistory = h as unknown as Record<string, unknown>;

  if (h && !anyHistory.__dataflowPatched) {
    const origPush = h.pushState;
    const origReplace = h.replaceState;

    h.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = origPush.apply(this, args);
      onRouteChange();
      return result;
    } as History['pushState'];

    h.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
      const result = origReplace.apply(this, args);
      onRouteChange();
      return result;
    } as History['replaceState'];

    anyHistory.__dataflowPatched = true;
    addTeardown(() => {
      h.pushState = origPush;
      h.replaceState = origReplace;
      delete anyHistory.__dataflowPatched;
    });
  }

  const onPop = () => {
    try {
      onRouteChange();
    } catch {
      /* ignore */
    }
  };
  const onHash = () => {
    try {
      onRouteChange();
    } catch {
      /* ignore */
    }
  };
  w.addEventListener('popstate', onPop);
  w.addEventListener('hashchange', onHash);
  addTeardown(() => {
    w.removeEventListener('popstate', onPop);
    w.removeEventListener('hashchange', onHash);
  });
}

/** Called on every candidate route change; emits at most one span per unique URL. */
export function onRouteChange(): void {
  const cfg = state.config;
  if (!cfg || cfg.disablePageViews || !state.started) return;
  const url = currentUrlString();
  if (url === state.currentUrl) return;

  const now = nowMs();
  const duration = Math.max(0, now - state.lastRouteChangeTs);
  state.currentUrl = url;
  state.lastRouteChangeTs = now;

  emitEvent({
    type: 'PAGE_VIEW',
    name: `VIEW ${location.pathname}`,
    duration_ms: duration,
    caller_package: 'browser',
    callee_package: 'browser',
    setAsCurrentView: true,
  });
}
