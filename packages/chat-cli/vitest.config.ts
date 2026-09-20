import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],

    // The .tsx files here call ink-testing-library's `render()` about twenty
    // times and never `unmount()`. Ink keeps a render loop and a stdout
    // stream alive per instance, so the run finishes, all 135 tests pass,
    // and the process then sits holding those handles until something kills
    // it. In CI that is the fifteen-minute job timeout, reported as a
    // CANCELLED leg rather than a failure -- the least legible way for a
    // defect to present itself.
    //
    // I first tried the forks pool, on the assumption the leak was in a
    // worker. It is not: the run hangs identically with forks, because the
    // handles are held in the main process. Recording that so nobody spends
    // the same hour on it.
    //
    // The fix is to unmount each render. Until then the CI leg skips the
    // .tsx files (see #657) and keeps the other 96 tests running.
    teardownTimeout: 2_000,
  },
});
