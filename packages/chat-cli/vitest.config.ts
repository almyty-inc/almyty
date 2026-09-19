import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],

    // The component tests call ink-testing-library's `render()` about
    // twenty times and never `unmount()`. Ink keeps a render loop and its
    // stdout stream alive per instance, so the run finishes, every test
    // passes, and the process then sits there holding those handles --
    // in CI it passed 73 tests in eight seconds and was killed by the
    // fifteen-minute job timeout, reported as a cancelled leg rather than
    // a failure, which is the least legible way for this to surface.
    //
    // Forks put each file in a child process that is terminated when the
    // run ends, so a leaked handle cannot hold the suite open. That is a
    // containment, not a cure: the right fix is unmounting each render,
    // and this keeps `npm test` usable until someone does that.
    pool: 'forks',
    teardownTimeout: 2_000,
  },
});
