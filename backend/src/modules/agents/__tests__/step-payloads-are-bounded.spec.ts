import { AgentStepProcessor } from '../agent-step-processor';

/**
 * A run's `steps` column is rewritten whole on every commit.
 *
 * So a run that grows it linearly writes O(n^2) bytes of TOAST and WAL,
 * and the push sites carry untruncated tool results — the HTTP executor
 * allows 10MB responses and the default ceiling is 100 tool calls, with
 * a hard ceiling of 200. A single row could reach tens of megabytes, and
 * every step rewrote all of it.
 *
 * The array the current tick reasons over is untouched; only what goes
 * to Postgres is bounded, which is the trade the request logger already
 * makes with request and response bodies.
 */
describe('persisted step payloads are bounded', () => {
  // Only the pure helper is under test, so the collaborators are not needed.
  const processor = new AgentStepProcessor({} as any, {} as any, {} as any, {} as any);
  const bound = (steps: any) => (processor as any).boundStepsForPersist(steps);

  it('truncates a huge tool result and says it did', () => {
    const huge = 'x'.repeat(200_000);

    const [step] = bound([{ type: 'tool_call', output: huge }]);

    expect(step.output.length).toBeLessThan(huge.length);
    expect(step.output).toMatch(/truncated from 200000 characters/);
  });

  it('leaves a normal step exactly as it was', () => {
    const steps = [{ type: 'llm_call', input: 'hello', output: 'hi there', cost: 0.01 }];

    expect(bound(steps)).toEqual(steps);
  });

  it('truncates the input side too, which tool arguments can fill', () => {
    const [step] = bound([{ type: 'tool_call', input: { blob: 'y'.repeat(200_000) } }]);

    expect(String(step.input)).toMatch(/truncated from/);
  });

  it('keeps null and undefined as themselves rather than stringifying them', () => {
    const [step] = bound([{ type: 'output', input: null, output: undefined }]);

    expect(step.input).toBeNull();
    expect(step.output).toBeUndefined();
  });

  it('passes a non-array through untouched', () => {
    expect(bound(undefined)).toBeUndefined();
  });
});
