/**
 * A `render` that cleans up after itself.
 *
 * ink-testing-library's `render()` starts an Ink render loop and a fake
 * stdout stream per instance, and tears down neither on its own. The .tsx
 * suites here call it about twenty times and never unmounted any of them.
 *
 * To be clear about what this does and does not fix: it is NOT the cause of
 * the fifteen-minute CI hang in #657 -- that was a blocking mkdir under
 * /proc in input.test.ts, and these suites report clean with or without this
 * helper. This is ordinary hygiene, kept because leaving twenty render loops
 * running for the rest of the process is worth not doing, and because it
 * removes the most obvious red herring for whoever debugs the next stall.
 */
import { render as inkRender } from 'ink-testing-library';
import { afterEach } from 'vitest';

type Instance = ReturnType<typeof inkRender>;

const mounted: Instance[] = [];

export function render(...args: Parameters<typeof inkRender>): Instance {
  const instance = inkRender(...args);
  mounted.push(instance);
  return instance;
}

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount();
  }
});
