import { state } from '../config';
import { emitEvent } from '../events';
import { getBreadcrumbs } from './breadcrumbs';
import { addTeardown } from '../patch';
import { META } from '../version';
import { truncate } from '../util';

const MAX_MESSAGE = 500;
const MAX_STACK = 8192;

/**
 * JS error capture: window 'error' (equivalent to window.onerror) and
 * 'unhandledrejection'. Each error becomes a FUNCTION_CALL span named
 * `browser.error` with status 500, truncated message/stack, a file:line:col
 * source and (if enabled) the click breadcrumbs.
 */
export function instrumentErrors(): void {
  const onError = (e: Event): void => {
    try {
      if (!(e instanceof ErrorEvent)) return; // ignore resource-error events
      const stack = e.error instanceof Error ? e.error.stack : undefined;
      const msg = e.message || (e.error instanceof Error ? e.error.message : 'Unknown error');
      handleError(msg, stack, 'window.onerror', `${e.filename}:${e.lineno}:${e.colno}`);
    } catch {
      /* ignore */
    }
  };

  const onRejection = (e: Event): void => {
    try {
      const reason = (e as PromiseRejectionEvent).reason;
      const stack = reason instanceof Error ? reason.stack : undefined;
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : String(reason ?? 'Unhandled rejection');
      handleError(msg, stack, 'unhandledrejection', 'promise');
    } catch {
      /* ignore */
    }
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  addTeardown(() => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  });
}

function handleError(msg: string, stack: string | undefined, fn: string, source: string): void {
  const cfg = state.config;
  if (!cfg || cfg.disableErrors || !state.started) return;

  const metadata: Record<string, unknown> = {
    [META.errorMessage]: truncate(msg, MAX_MESSAGE) ?? '',
  };
  const st = truncate(stack, MAX_STACK);
  if (st) metadata[META.errorStack] = st;
  metadata[META.errorSource] = source;

  // Breadcrumbs are attached to error spans only.
  if (!cfg.disableBreadcrumbs && cfg.maxBreadcrumbs > 0) {
    metadata[META.breadcrumbs] = getBreadcrumbs();
  }

  emitEvent({
    type: 'FUNCTION_CALL',
    name: 'browser.error',
    function_name: fn,
    caller_package: 'browser',
    callee_package: 'browser',
    status_code: 500,
    error_message: truncate(msg, MAX_MESSAGE),
    metadata,
  });
}
