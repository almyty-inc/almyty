import { describe, it, expect } from 'vitest';

import { ProcessManager, createDefaultAdapterFactory } from '../src/process-manager.js';
import {
  classifyStatus,
  detectCodingAgents,
  getCodingAgent,
  stripVtEscapes,
} from '../src/coding-agents/index.js';
import { realExec } from '../src/binaries.js';

/**
 * End-to-end against REAL subprocesses (real node-pty, no fakes) — proving the
 * coding-agent machinery works against the OS, not just against stubs.
 *
 * Part A (always-on, POSIX): the status classifier reads a real PTY's output
 * after the runner has captured it — real spawn → real stdout → snapshot →
 * stripVtEscapes → classify.
 *
 * Part B (gated behind RUN_AGENT_SMOKE=1): actually detect and launch the real
 * coding CLIs installed on this host (claude, codex, gemini, …). Skipped by
 * default so CI without those binaries / auth stays green; run locally with
 * `RUN_AGENT_SMOKE=1 npx vitest run agent-e2e` to exercise the real thing.
 */
const POSIX = process.platform !== 'win32';
const describeIfPosix = POSIX ? describe : describe.skip;

describeIfPosix('agent status over a real PTY', () => {
  it('classifies a real process emitting an idle prompt as idle', async () => {
    const mgr = new ProcessManager(createDefaultAdapterFactory(), 4);
    const h = await mgr.spawn('ws', {
      binary: '/bin/sh',
      // emit some output then a bold prompt with real VT escapes
      args: ['-c', "printf 'ready\\n\\033[1m> \\033[0m'; sleep 0.3"],
      pty: true,
    });
    await mgr.waitForIdle('ws', h.processId, { idleMs: 150, maxWaitMs: 1_000 });
    const snap = mgr.snapshot('ws', h.processId);
    expect(classifyStatus(getCodingAgent('claude')!.status, stripVtEscapes(snap.tail))).toBe('idle');
    await mgr.killWorkspace('ws');
  });

  it('classifies a real process emitting a busy marker as busy', async () => {
    const mgr = new ProcessManager(createDefaultAdapterFactory(), 4);
    const h = await mgr.spawn('ws', {
      binary: '/bin/sh',
      args: ['-c', "printf 'thinking hard... esc to interrupt'; sleep 0.3"],
      pty: true,
    });
    await mgr.waitForIdle('ws', h.processId, { idleMs: 150, maxWaitMs: 1_000 });
    const snap = mgr.snapshot('ws', h.processId);
    expect(classifyStatus(getCodingAgent('claude')!.status, stripVtEscapes(snap.tail))).toBe('busy');
    await mgr.killWorkspace('ws');
  });
});

const SMOKE = process.env.RUN_AGENT_SMOKE === '1';
const describeSmoke = SMOKE && POSIX ? describe : describe.skip;

describeSmoke('real coding-CLI smoke (RUN_AGENT_SMOKE=1)', () => {
  it('detects the coding agents actually installed on this host', async () => {
    const found = await detectCodingAgents(realExec);
    // We can only assert structure (CI hosts vary); log what we found.
    console.log('detected coding agents:', found.map((f) => `${f.id}@${f.version}`).join(', ') || '(none)');
    for (const f of found) {
      expect(f.version.length).toBeGreaterThan(0);
      expect(getCodingAgent(f.id)).toBeTruthy();
    }
  });

  it('runs a real coding-CLI binary through the runner (version probe via PTY)', async () => {
    const found = await detectCodingAgents(realExec);
    if (found.length === 0) {
      console.warn('no coding CLIs installed — nothing to drive');
      return;
    }
    const target = found[0];
    const mgr = new ProcessManager(createDefaultAdapterFactory(), 4);
    // Execute the REAL binary under the runner and capture its output. --version
    // is side-effect-free (no auth, no network, no session), so this proves the
    // runner executes the actual coding CLI end-to-end and streams its output.
    const h = await mgr.spawn('ws', { binary: target.resolvedBinary, args: ['--version'], pty: false });
    const out = await mgr.waitForIdle('ws', h.processId, { idleMs: 300, maxWaitMs: 5_000 });
    console.log(`${target.id} --version →`, out.data.trim().slice(0, 80));
    expect(out.data.trim().length).toBeGreaterThan(0);
    await mgr.killWorkspace('ws');
  });
});
