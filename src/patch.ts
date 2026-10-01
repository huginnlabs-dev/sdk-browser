/**
 * Registry of undo functions for every monkey-patch / event listener the SDK
 * installs. `__resetForTests()` (and any future teardown path) runs them all.
 */
const teardowns: Array<() => void> = [];

export function addTeardown(fn: () => void): void {
  teardowns.push(fn);
}

export function runTeardowns(): void {
  for (const fn of teardowns) {
    try {
      fn();
    } catch {
      /* never throw during teardown */
    }
  }
  teardowns.length = 0;
}
