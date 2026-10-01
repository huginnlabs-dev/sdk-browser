import { describe, expect, it } from 'vitest';
import { newEventId, newSpanId, newTraceId } from '../src/ids';
import { clampRate, rollSampling } from '../src/sampling';

describe('ids', () => {
  it('trace ids are 32 lowercase hex chars', () => {
    const id = newTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('span ids are 16 lowercase hex chars', () => {
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('event ids are 32 lowercase hex chars', () => {
    expect(newEventId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('ids are unique across many samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(newTraceId());
      seen.add(newSpanId());
      seen.add(newEventId());
    }
    expect(seen.size).toBe(600);
  });
});

describe('sampling helpers', () => {
  it('clamps non-finite and out-of-range rates', () => {
    expect(clampRate(undefined)).toBe(1);
    expect(clampRate(Number.NaN)).toBe(1);
    expect(clampRate(5)).toBe(1);
    expect(clampRate(-1)).toBe(0);
    expect(clampRate(0.42)).toBe(0.42);
  });

  it('returns a strict boolean decision for any rate', () => {
    const r = rollSampling(0.5);
    expect(typeof r).toBe('boolean');
    expect(rollSampling(1)).toBe(true); // random() < 1 always holds
    expect(rollSampling(0)).toBe(false); // random() < 0 never holds
  });
});
