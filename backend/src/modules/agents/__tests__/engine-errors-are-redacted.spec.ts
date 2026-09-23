import { readFileSync } from 'fs';
import { join } from 'path';

import { safeErrorMessage } from '../../llm-providers/llm-providers.service';

/**
 * The secret redactor was wired into one of the engine's error paths.
 *
 * `safeErrorMessage` / `safeErrorBody` exist for a stated reason -- an
 * upstream 401 can echo the Authorization header back in its body -- and the
 * node executor applied them to LLM errors. The tool path did not: a failing
 * `tool_call` node's raw message became `nodeResults[id].error`, was
 * concatenated into `execution.error`, and from there reached the compat
 * controllers, the A2A task status message, the agent's outbound webhook and
 * the run-failed email. The crash path assigned `error.message` raw as well.
 *
 * `execution.error` is a `text` column and the concatenation had no cap, so
 * a hundred-node pipeline could also write an unbounded string to every one
 * of those surfaces.
 */
const engine = readFileSync(join(__dirname, '..', 'agent-execution.engine.ts'), 'utf8');

describe('engine error strings go through the redactor', () => {
  it('the per-node catch redacts instead of taking err.message raw', () => {
    expect(engine).toContain('error: safeErrorMessage(err),');
    expect(engine).not.toContain("error: err.message || 'Unknown node error'");
  });

  it('the crash catch redacts instead of taking error.message raw', () => {
    expect(engine).toContain('execution.error = safeErrorMessage(error);');
    expect(engine).not.toContain("execution.error = error.message || 'Unknown error'");
  });

  it('the run-level failure string is capped', () => {
    expect(engine).toContain('MAX_EXECUTION_ERROR_CHARS');
    expect(engine).toMatch(/Pipeline failed: \$\{failedNodes\}`\.slice\(0, MAX_EXECUTION_ERROR_CHARS\)/);
  });

  it('the redactor actually removes a bearer token and caps length', () => {
    const leaked = safeErrorMessage(
      new Error('401 from upstream: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789'),
    );
    expect(leaked).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(leaked).toContain('[REDACTED]');
    expect(safeErrorMessage(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(500);
  });
});
