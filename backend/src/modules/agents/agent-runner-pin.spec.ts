import { readFileSync } from 'fs';
import { join } from 'path';

import { agentRunnerId, capabilityProblems, normaliseCapabilities } from './agent-capabilities';

/**
 * "Runs on" on the agent page: any of the caller's runners (no pin) or one
 * runner by id (agentConfig.runnerId). The pin has to reach every runner
 * tool call the agent makes, so the wiring is checked here as source: each
 * place that hands the agent's machine labels to a tool call hands the pin
 * along with them.
 */
describe("an agent's pinned runner", () => {
  const RUNNER = '7b0f8d1e-5d7c-4c1e-9a55-2f3e4d5c6b7a';

  it('is read from agentConfig.runnerId, and absent means any runner', () => {
    expect(agentRunnerId({ agentConfig: { runnerId: RUNNER } as any })).toBe(RUNNER);
    expect(agentRunnerId({ agentConfig: {} as any })).toBeNull();
    expect(agentRunnerId({ agentConfig: null as any })).toBeNull();
    expect(agentRunnerId(undefined)).toBeNull();
  });

  it('stores "any of my runners" as no pin at all', () => {
    const cleared: any = { runnerId: null };
    normaliseCapabilities(cleared);
    expect(cleared).not.toHaveProperty('runnerId');
    const emptied: any = { runnerId: '' };
    normaliseCapabilities(emptied);
    expect(emptied).not.toHaveProperty('runnerId');
    const kept: any = { runnerId: RUNNER };
    normaliseCapabilities(kept);
    expect(kept.runnerId).toBe(RUNNER);
  });

  it('must be a runner id', () => {
    expect(capabilityProblems({ runnerId: RUNNER })).toEqual([]);
    expect(capabilityProblems({ runnerId: null })).toEqual([]);
    expect(capabilityProblems({ runnerId: 'my-laptop' })).toEqual(['The runner it runs on must be a runner id']);
    expect(capabilityProblems({ runnerId: 42 })).toEqual(['The runner it runs on must be a runner id']);
  });

  describe('reaches every runner tool call', () => {
    const read = (path: string) => readFileSync(join(__dirname, path), 'utf8');

    it.each([
      ['agent-step-processor.ts', 4],
      ['agent-execution.engine.ts', 1],
    ])('%s passes the pin wherever it passes the labels', (file, sites) => {
      const lines = read(file).split('\n');
      const labelLines = lines.map((l, i) => [l, i] as const).filter(([l]) => /runnerLabels: agent\.agentConfig\?\.runnerLabels,/.test(l));
      expect(labelLines).toHaveLength(sites);
      for (const [, i] of labelLines) {
        expect(lines.slice(i + 1, i + 4).join('\n')).toMatch(/pinnedRunnerId: agentRunnerId\(agent\)/);
      }
    });

    it('the node executor hands it to tool calls and Code steps', () => {
      const src = read('agent-node-executor.ts');
      expect(src).toMatch(/pinnedRunnerId: options\.pinnedRunnerId,/);
      expect(src).toMatch(/options\.pinnedRunnerId \? \{ pinnedRunnerId: options\.pinnedRunnerId \}/);
    });

    it('code mode carries it to each tool call a script makes, and through an approval', () => {
      const src = read('../code-mode/code-mode.service.ts');
      expect((src.match(/pinnedRunnerId/g) ?? []).length).toBeGreaterThanOrEqual(8);
      const gate = read('../tools/tool-approval-gate.service.ts');
      expect(gate).toMatch(/call\.pinnedRunnerId \? \{ pinnedRunnerId: call\.pinnedRunnerId \}/);
    });
  });
});
