import { state } from './config';
import { INGEST_PATH } from './version';
import { toURL } from './util';

/**
 * Ingest URL: the configured endpoint is a BASE URL — the SDK appends the
 * server's ingest path. An endpoint that already ends in the ingest path is
 * used as-is.
 */
export function ingestUrl(): string {
  const base = (state.config?.endpoint ?? '').replace(/\/+$/, '');
  if (base.endsWith(INGEST_PATH)) return base;
  return base + INGEST_PATH;
}

/** True when the request targets the SDK's own ingest endpoint (never trace those). */
export function isIngestUrl(u: URL): boolean {
  const mine = toURL(ingestUrl());
  if (!mine) return false;
  return u.origin === mine.origin && u.pathname === mine.pathname;
}
