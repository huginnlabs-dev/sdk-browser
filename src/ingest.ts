import { state } from './config';
import { INGEST_PATH, REPLAY_PATH } from './version';
import { toURL } from './util';

/**
 * Endpoint URLs: the configured endpoint is a BASE URL — the SDK appends the
 * server's API path. An endpoint that already ends in that path is used as-is.
 */
function endpointUrl(path: string): string {
  const base = (state.config?.endpoint ?? '').replace(/\/+$/, '');
  if (base.endsWith(path)) return base;
  return base + path;
}

export function ingestUrl(): string {
  return endpointUrl(INGEST_PATH);
}

/** Session Replay endpoint (same base URL + auth as the ingest transport). */
export function replayUrl(): string {
  return endpointUrl(REPLAY_PATH);
}

function sameEndpoint(u: URL, path: string): boolean {
  const mine = toURL(endpointUrl(path));
  if (!mine) return false;
  return u.origin === mine.origin && u.pathname === mine.pathname;
}

/** True when the request targets the SDK's own ingest endpoint (never trace those). */
export function isIngestUrl(u: URL): boolean {
  return sameEndpoint(u, INGEST_PATH);
}

/** True when the request targets the SDK's own Session Replay endpoint. */
export function isReplayUrl(u: URL): boolean {
  return sameEndpoint(u, REPLAY_PATH);
}

/** True for ANY SDK-owned beacon endpoint — these are never traced, never counted. */
export function isOwnEndpoint(u: URL): boolean {
  return isIngestUrl(u) || isReplayUrl(u);
}
