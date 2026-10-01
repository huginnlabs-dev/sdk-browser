import { state } from './config';
import { newEventId, newSpanId } from './ids';
import { enqueueEvent } from './transport';
import type { DataflowEvent, EventType } from './types';

export interface EmitInput {
  type: EventType;
  name?: string;
  /** Provide an explicit span id (page-load span) — otherwise one is generated. */
  span_id?: string;
  /** `null` forces no parent (root span); default parents to the current view span. */
  parent_span_id?: string | null;
  duration_ms?: number;
  status_code?: number;
  error_message?: string;
  caller_package?: string;
  callee_package?: string;
  function_name?: string;
  metadata?: Record<string, unknown>;
  /** Mark this span as the new "current view" (parents future http/error spans). */
  setAsCurrentView?: boolean;
}

/**
 * The ingest API's metadata field is map[string]string — every value MUST be
 * a string or the server rejects the whole batch. Strings pass through
 * untouched; everything else is JSON-encoded (numbers -> "42", arrays ->
 * '[{"label":...}, ...]').
 */
function normalizeMetadata(meta: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      out[k] = v;
      continue;
    }
    try {
      const s = JSON.stringify(v);
      out[k] = s === undefined ? String(v) : s;
    } catch {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build a contract-conforming event and hand it to the transport.
 * Respects the page-load sampling decision (unsampled page loads emit nothing)
 * and never throws.
 */
export function emitEvent(input: EmitInput): void {
  const st = state;
  if (!st.started || !st.config) return;
  if (!st.sampled) return;

  const spanId = input.span_id ?? newSpanId();
  const parent =
    input.parent_span_id === null ? undefined : (input.parent_span_id ?? st.currentViewSpanId);

  const ev: DataflowEvent = {
    event_id: newEventId(),
    seq: ++st.seq,
    timestamp: Date.now(),
    trace_id: st.traceId,
    span_id: spanId,
    type: input.type,
    service_name: st.config.serviceName,
    name: input.name,
    caller_package: input.caller_package,
    callee_package: input.callee_package,
    function_name: input.function_name,
    duration_ms: input.duration_ms,
    status_code: input.status_code,
    error_message: input.error_message,
    metadata: input.metadata ? normalizeMetadata(input.metadata) : undefined,
  };
  if (parent !== undefined) ev.parent_span_id = parent;

  if (input.setAsCurrentView) st.currentViewSpanId = spanId;

  enqueueEvent(ev);

  if (st.config.debug) {
    try {
      // eslint-disable-next-line no-console
      console.debug('[dataflow]', ev.type, ev.name, ev.duration_ms);
    } catch {
      /* ignore */
    }
  }
}
