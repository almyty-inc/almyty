import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],

    // A test that hangs must fail, not stall. Without these two, a single
    // blocking syscall in one assertion held this package's CI leg for the
    // full fifteen-minute job timeout and reported as CANCELLED rather than
    // failed -- the least legible way for a defect to present itself, and it
    // cost several rounds of wrong diagnosis (#657).
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 5_000,
  },
});
