import * as fs from 'fs';
import * as path from 'path';

/**
 * The funnel events are only worth anything if every path that completes
 * a run, or verifies an account, reports it. A unit test of the service
 * stays green while nothing calls it, so this reads the call sites.
 */
const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8');

/** The text between the first match of `from` and the next match of `to` after it. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('funnel events are wired', () => {
  it('the autonomous engine reports a completed run right after counting it', () => {
    const step = src('modules/agents/agent-step-processor.ts');
    const success = between(step, 'bumpAgentStats(agent.id, true', "emitEvent(runId, 'run.completed'");
    expect(success).toContain('reportRunSucceeded?.(agent.id, run.userId)');
    expect(src('modules/agents/agent-runtime-misc.helper.ts')).toContain('this.productAnalytics?.runSucceeded(');
  });

  it('a collaboration run reports its completion', () => {
    const collab = src('modules/agents/agent-collaboration.helper.ts');
    const complete = between(collab, 'private async complete(', 'private async persist(');
    expect(complete).toContain('this.productAnalytics?.runSucceeded({ agentId: run.agentId, userId: run.userId })');
  });

  it('the workflow engine reports a completed execution right after counting it', () => {
    const engine = src('modules/agents/agent-execution.engine.ts');
    const success = between(engine, 'bumpAgentStats(agent.id, true', "type: 'execution.completed'");
    expect(success).toContain('reportRunSucceeded?.(agent.id, execution.userId)');
    expect(src('modules/agents/agent-execution-state.helper.ts')).toContain('this.productAnalytics?.runSucceeded(');
  });

  it('sign-up reports verification, and nothing awaits the analytics call', () => {
    const auth = src('modules/auth/auth.service.ts');
    const verify = between(auth, 'async verifyEmail(', 'async requestEmailVerification(');
    expect(verify).toContain('void this.productAnalytics?.signupCompleted(user.id)');
    const register = between(auth, 'async register(', 'async login(');
    expect(register).toContain('void this.productAnalytics?.signupCompleted(savedUser.id)');
    expect(auth).not.toMatch(/await this\.productAnalytics/);
  });

  it('the module is registered', () => {
    expect(src('app.module.ts')).toMatch(/imports:[\s\S]*ProductAnalyticsModule,/);
  });
});
