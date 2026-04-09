/**
 * E2E test setup.
 *
 * Previously this file mocked isolated-vm because it was a native
 * C++ module that didn't exist in worktrees / CI. That dependency
 * has been removed — the sandbox is now a Node worker thread with
 * --permission + a net-guard monkey-patch instead — so the mock
 * is no longer needed.
 */
export {};
