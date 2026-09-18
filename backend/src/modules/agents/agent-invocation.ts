import { Agent, AgentStatus } from '../../entities/agent.entity';

/**
 * The two decisions every surface that runs an agent has to make, in one
 * place: may this agent run, and which engine runs it.
 *
 * Seven copies of `agent.status !== AgentStatus.ACTIVE` existed across
 * the HTTP invoke and stream handlers, the unified gateway endpoint, the
 * MCP control plane and the scheduler. A gate duplicated seven times is
 * how it comes to be missing from the eighth — and the autonomous split
 * below is worse than duplicated, because getting it wrong is silent:
 * routing an autonomous agent through the pipeline engine returns a
 * "completed" run with zero node results and a null output, which reads
 * as an agent that ran and had nothing to say.
 *
 * These are plain functions rather than a service method on purpose. The
 * pipeline engine and the autonomous runtime both depend on
 * AgentsService, so a method there that called them would close a
 * dependency cycle; the decision does not need injection, only the
 * agent.
 */

export class AgentNotActive extends Error {
  readonly code = 'AGENT_NOT_ACTIVE';
  constructor(readonly status: string) {
    super(
      `This agent is ${status}, and only an active agent can be invoked. ` +
        'Activate it first.',
    );
    this.name = 'AgentNotActive';
  }
}

/** Throw unless the agent may be invoked. */
export function assertAgentInvokable(agent: Pick<Agent, 'status'>): void {
  if (agent.status !== AgentStatus.ACTIVE) throw new AgentNotActive(String(agent.status));
}

/** Whether the agent may be invoked, without throwing — for a path that skips rather than refuses. */
export function agentIsInvokable(agent: Pick<Agent, 'status'> | null | undefined): boolean {
  return Boolean(agent && agent.status === AgentStatus.ACTIVE);
}

/**
 * Which engine runs this agent.
 *
 * An autonomous agent has no pipeline graph, so the ReAct runtime owns
 * it; only that path reaches the built-in tools (wait, ask_user,
 * request_approval, memory).
 */
export function runsOnAutonomousRuntime(agent: Pick<Agent, 'mode'>): boolean {
  return agent.mode === 'autonomous';
}
