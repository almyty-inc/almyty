import { describe, it, expect } from 'vitest';

import { ProcessManager, createDefaultAdapterFactory } from '../src/process-manager.js';

/**
 * End-to-end against a real subprocess (no fake adapter). Exercises
 * the actual node-pty / child_process integration, including:
 *
 *   - PTY mode: stdout streamed back as the child writes
 *   - Pipe mode: same, without a TTY
 *   - process.write -> stdin reaches the child; close_input sends EOF;
 *     the child sees the close and exits (verified with `cat`).
 *
 * Skipped when /bin/sh isn't available; the assertion is that on
 * macOS / Linux these always pass.
 */
const HAS_SHELL = process.platform !== 'win32';
const describeIfPosix = HAS_SHELL ? describe : describe.skip;

describeIfPosix('ProcessManager (real subprocess)', () => {
  it('PTY mode: stdout streams as the child writes', async () => {
    const mgr = new ProcessManager(createDefaultAdapterFactory(), 4);
    const h = await mgr.spawn('ws', {
      binary: '/bin/sh',
      args: ['-c', "for i in 1 2 3; do printf 'tick %s\\n' $i; sleep 0.05; done"],
      pty: true,
    });
    // Wait for the process to finish or 1s, whichever first.
    const result = await mgr.waitForIdle('ws', h.processId, { idleMs: 200, maxWaitMs: 1_500 });
    const out = result.data.replace(/\r/g, '');
    expect(out).toContain('tick 1');
    expect(out).toContain('tick 2');
    expect(out).toContain('tick 3');
  });

  it('pipe mode: stdout streams without a TTY', async () => {
    const mgr = new ProcessManager(createDefaultAdapterFactory(), 4);
    const h = await mgr.spawn('ws', {
      binary: '/bin/sh',
      args: ['-c', "printf 'no-tty-line\\n'"],
      pty: false,
    });
    await mgr.wait('ws', h.processId, 2_000);
    const out = mgr.read('ws', h.processId).data;
    expect(out).toContain('no-tty-line');
  });

  it('write delivers stdin and close_input causes cat to exit', async () => {
    const mgr = new ProcessManager(createDefaultAdapterFactory(), 4);
    const h = await mgr.spawn('ws', { binary: '/bin/cat', args: [], pty: false });
    mgr.write('ws', h.processId, 'hello-from-test\n');
    mgr.closeInput('ws', h.processId);
    const exit = await mgr.wait('ws', h.processId, 2_000);
    const out = mgr.read('ws', h.processId).data;
    expect(out).toContain('hello-from-test');
    expect(exit.exitCode).toBe(0);
  });

  it('signal TERM kills a sleeping process', async () => {
    const mgr = new ProcessManager(createDefaultAdapterFactory(), 4);
    const h = await mgr.spawn('ws', {
      binary: '/bin/sh',
      args: ['-c', 'sleep 30'],
      pty: false,
    });
    setTimeout(() => mgr.signal('ws', h.processId, 'TERM'), 50);
    const exit = await mgr.wait('ws', h.processId, 3_000);
    // Either a non-zero exit or a captured signal name; treat both as success.
    expect(exit.exitCode !== 0 || exit.signal).toBeTruthy();
  });
});
