import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentVerifierHelper, runEvidence } from '../agent-verifier.helper';

/**
 * Found on staging with a real npm check: the final-answer checker saw only
 * the answer, judged "lodash latest 4.18.1" from its own stale knowledge
 * ("actual latest is 4.17.21"), failed a correct answer three times and
 * sent it back for revision. The checker must judge against what the run
 * was asked and what its tools returned.
 */
describe('a final-answer checker sees the run evidence', () => {
  const run = {
    input: { message: '{"dependencies":{"lodash":"^4.17.21"}}' },
    steps: [
      { type: 'llm_call', output: 'thinking' },
      { type: 'tool_call', input: { tool: 'npm_get_package_latest', parameters: { package: 'lodash' } }, output: { name: 'lodash', version: '4.18.1' } },
      { type: 'tool_call', input: { tool: 'npm_get_package_latest', parameters: { package: 'left-pad' } }, error: 'HTTP 503' },
    ],
  };

  it('collects the request and every tool result, errors included', () => {
    const evidence = runEvidence(run);
    expect(evidence).toContain('REQUEST:\n{"dependencies":{"lodash":"^4.17.21"}}');
    expect(evidence).toContain('npm_get_package_latest {"package":"lodash"}:\n{"name":"lodash","version":"4.18.1"}');
    expect(evidence).toContain('npm_get_package_latest {"package":"left-pad"}:\nERROR HTTP 503');
    expect(evidence).not.toContain('thinking');
  });

  it('stays bounded when tools return large payloads', () => {
    const big = { type: 'tool_call', input: { tool: 'github_list_issues' }, output: 'x'.repeat(30_000) };
    const evidence = runEvidence({ steps: [big, big, big, big, big, big, big] });
    expect(evidence.length).toBeLessThan(45_000);
    expect(evidence).toContain('… (cut)');
    expect(evidence).toContain('(left out: the evidence limit was reached)');
  });

  it('puts the evidence in front of each checker and tells it not to overrule it', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"passed_rules":[]}' }, cost: 0, usage: { totalTokens: 1 } });
    const helper = new AgentVerifierHelper({ chat } as any);
    const panel = await helper.runPanel(
      { target: '| lodash | ^4.17.21 | 4.18.1 | outdated-minor |', checkers: [{ name: 'c', providerId: 'p', model: 'm' }], evidence: runEvidence(run) },
      'org-1',
      'user-1',
    );
    expect(panel.passed).toBe(true);
    const [system, user] = chat.mock.calls[0][1].messages;
    expect(system.content).toMatch(/Never use your own knowledge/);
    expect(user.content).toMatch(/EVIDENCE \(ground truth for this run\):\n[\s\S]*"version":"4\.18\.1"[\s\S]*OUTPUT \(to check\):/);
  });

  it('keeps the old prompt when there is no evidence (a workflow verify step)', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }] }, 'org-1');
    const [system, user] = chat.mock.calls[0][1].messages;
    expect(system.content).not.toMatch(/EVIDENCE/);
    expect(user.content).not.toMatch(/EVIDENCE/);
    // Every checker knows today's date: one failed papers from last week as "future".
    expect(system.content).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`);
  });

  it('is what the autonomous final-output verification passes', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    const verify = src.slice(src.indexOf('private async runAutonomousVerify'), src.indexOf('private hasFinalOutputVerification'));
    expect(verify).toMatch(/evidence: runEvidence\(run/);
  });
});
