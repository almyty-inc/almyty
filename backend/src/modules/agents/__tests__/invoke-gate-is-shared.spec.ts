import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentStatus } from '../../../entities/agent.entity';
import {
  AgentNotActive,
  agentIsInvokable,
  assertAgentInvokable,
  runsOnAutonomousRuntime,
} from '../agent-invocation';

/**
 * One gate, one dispatch rule, every surface.
 *
 * `agent.status !== AgentStatus.ACTIVE` was written out seven times —
 * the HTTP invoke and stream handlers, the unified gateway's invoke and
 * stream, the MCP control plane, and twice in the scheduler. The
 * autonomous split was worse: the dashboard's invoke dispatched on mode
 * and the gateway's did not, so every autonomous agent published behind
 * a gateway ran through the pipeline engine and answered with a
 * "completed" execution carrying zero node results and a null output.
 * Silent, and indistinguishable from an agent that had nothing to say.
 */
describe('the invoke gate lives in one place', () => {
  const agent = (over: any = {}) => ({ status: AgentStatus.ACTIVE, mode: 'workflow', ...over }) as any;

  describe('the gate itself', () => {
    it('lets an active agent through', () => {
      expect(() => assertAgentInvokable(agent())).not.toThrow();
      expect(agentIsInvokable(agent())).toBe(true);
    });

    it('refuses every non-active status, naming the one it found', () => {
      for (const status of [AgentStatus.DRAFT, AgentStatus.INACTIVE]) {
        const err = (() => {
          try {
            assertAgentInvokable(agent({ status }));
          } catch (e) {
            return e as AgentNotActive;
          }
        })();
        expect(err).toBeInstanceOf(AgentNotActive);
        expect(err!.code).toBe('AGENT_NOT_ACTIVE');
        expect(err!.message).toContain(String(status));
        expect(err!.message).toMatch(/Activate it first/);
        expect(agentIsInvokable(agent({ status }))).toBe(false);
      }
    });

    it('treats a missing agent as not invokable rather than throwing', () => {
      expect(agentIsInvokable(null)).toBe(false);
      expect(agentIsInvokable(undefined)).toBe(false);
    });

    it('sends only autonomous agents to the autonomous runtime', () => {
      expect(runsOnAutonomousRuntime(agent({ mode: 'autonomous' }))).toBe(true);
      expect(runsOnAutonomousRuntime(agent({ mode: 'workflow' }))).toBe(false);
      expect(runsOnAutonomousRuntime(agent({ mode: undefined }))).toBe(false);
    });
  });

  describe('nobody writes their own copy', () => {
    const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');

    const invokeSurfaces = [
      'modules/agents/agent-execution.controller.ts',
      'modules/gateways/unified-agent.helper.ts',
      'modules/mcp/almyty-mcp.service.ts',
    ];

    for (const file of invokeSurfaces) {
      it(`${file} uses the shared gate`, () => {
        const source = read(file);
                expect(source).toMatch(/from '\.[./]*(agents\/)?agent-invocation'/);
        expect(source).toMatch(/agentIsInvokable|assertAgentInvokable/);
        // The open-coded comparison is what drifts. Its absence is the
        // property worth pinning.
        expect(source).not.toMatch(/status\s*!==\s*AgentStatus\.ACTIVE/);
      });
    }

    it('every surface that invokes also dispatches on mode', () => {
      // A surface that gates but does not dispatch is the silent
      // failure: it accepts an autonomous agent and runs nothing.
      for (const file of invokeSurfaces) {
        expect(read(file)).toContain('runsOnAutonomousRuntime');
      }
    });
  });
});
