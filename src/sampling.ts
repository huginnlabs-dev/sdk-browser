/** Clamp a sample rate into the [0, 1] interval (non-finite values become 1). */
export function clampRate(rate: number | undefined): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

/**
 * Roll the per-page-load sampling decision. Called exactly once per page load
 * (at first init) so the whole session is consistently sampled or not.
 */
export function rollSampling(rate: number | undefined): boolean {
  return Math.random() < clampRate(rate);
}
