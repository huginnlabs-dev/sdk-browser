import { state } from '../config';
import { addTeardown } from '../patch';
import type { Breadcrumb } from '../types';

let crumbs: Breadcrumb[] = [];

/**
 * Capture-phase click listener. Breadcrumbs are kept in memory (last N) and
 * attached ONLY to error spans — they are never sent on their own.
 */
export function instrumentBreadcrumbs(): void {
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  const handler = (e: Event): void => {
    try {
      recordClick(e);
    } catch {
      /* ignore */
    }
  };
  document.addEventListener('click', handler, opts);
  addTeardown(() => {
    document.removeEventListener('click', handler, { capture: true });
    crumbs = [];
  });
}

export function recordClick(e: Event): void {
  const cfg = state.config;
  if (!cfg || cfg.disableBreadcrumbs) return;
  const t = e.target as HTMLElement | null;
  if (!t || typeof (t as { tagName?: unknown }).tagName !== 'string') return;
  const tag = (t as { tagName: string }).tagName.toLowerCase();
  const id = t.id ? `#${t.id}` : '';
  let text = '';
  try {
    text = (t.textContent ?? '').trim().slice(0, 64);
  } catch {
    /* ignore */
  }
  crumbs.push({ label: `${tag}${id}:${text}`, timestamp: Date.now() });
  const max = cfg.maxBreadcrumbs;
  if (crumbs.length > max) crumbs = crumbs.slice(crumbs.length - max);
}

export function getBreadcrumbs(): Breadcrumb[] {
  return crumbs.slice();
}

export function clearBreadcrumbs(): void {
  crumbs = [];
}
