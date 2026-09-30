import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { Agent } from '../../entities/agent.entity';
import { Tool } from '../../entities/tool.entity';
import { principalOfRun } from '../../common/authorization/execution-access.service';
import { AgentRun } from '../../entities/agent-run.entity';
import { AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentRuntimeService } from './agent-runtime.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { mayCallAgent, temporaryAgentLimits } from './agent-capabilities';
import { canReference } from '../../common/authorization/private-visibility';

@Injectable()
export class AgentBuiltInToolsHelper {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
    @Inject(forwardRef(() => AgentRuntimeService))
    private readonly runtime: AgentRuntimeService,
    private readonly approvals: ApprovalsService,
  ) {}

  async executeBuiltInTool(
    toolName: string,
    parameters: Record<string, any>,
    run: AgentRun,
    agent: Agent,
  ): Promise<{ result?: any; error?: string; status?: 'sleeping' | 'waiting_input' } | null> {
    switch (toolName) {
      case 'wait': {
        const seconds = Math.min(Math.max(Number(parameters.seconds) || 10, 1), 3600);
        run.status = AgentRunStatus.SLEEPING;

        // Enqueue the delayed wake. Seed seq from a timestamp so it sits
        // outside the sequential range and duplicate wakes collapse to one.
        const wakeSeq = Date.now();
        await this.runtimeQueue.add('next-step', { runId: run.id, seq: wakeSeq }, {
          jobId: `step:${run.id}:${wakeSeq}`,
          delay: seconds * 1000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        });

        return {
          result: `Sleeping for ${seconds} seconds. Will resume automatically.`,
          status: 'sleeping',
        };
      }

      case 'ask_user': {
        const question = parameters.question || 'Please provide input';
        run.status = AgentRunStatus.WAITING_INPUT;

        return {
          result: `Waiting for user input. Question: ${question}`,
          status: 'waiting_input',
        };
      }

      case 'create_agent': {
        // Offered only when the agent may create agents (buildToolDefinitions),
        // but a tool call is whatever name the model emits, so the gate has
        // to hold here too.
        if (!agent.agentConfig?.canCreateAgents) {
          return { result: null, error: 'This agent is not allowed to create agents' };
        }
        // Its limits: so many per run, and so many existing at once across
        // its runs (temporary agents are removed when their run ends).
        const limits = temporaryAgentLimits(agent);
        if (limits.perRun !== null || limits.alive !== null) {
          const temporary = await this.agentRepository.find({
            where: { organizationId: run.organizationId, isTemporary: true },
            select: { id: true, parentRunId: true },
          });
          const thisRun = temporary.filter((t) => t.parentRunId === run.id).length;
          if (limits.perRun !== null && thisRun >= limits.perRun) {
            return { result: null, error: `This agent may create at most ${limits.perRun} temporary ${limits.perRun === 1 ? 'agent' : 'agents'} per run` };
          }
          if (limits.alive !== null) {
            const parentRunIds = [...new Set(temporary.map((t) => t.parentRunId).filter((id): id is string => !!id))];
            const ownRuns = parentRunIds.length
              ? await this.agentRepository.manager.getRepository(AgentRun).find({
                  where: { id: In(parentRunIds), agentId: agent.id },
                  select: { id: true },
                })
              : [];
            const own = new Set(ownRuns.map((r) => r.id));
            const alive = temporary.filter((t) => t.parentRunId && own.has(t.parentRunId)).length;
            if (alive >= limits.alive) {
              return { result: null, error: `This agent may have at most ${limits.alive} temporary ${limits.alive === 1 ? 'agent' : 'agents'} at once` };
            }
          }
        }
        // A child gets a subset of the parent's own tools, never more. The
        // ids came straight from the model's arguments, so a parent limited
        // to two tools could mint a child holding any tool in the
        // organization -- a prompt-injected run widening its own reach.
        const requestedToolIds: string[] = Array.isArray(parameters.toolIds) ? parameters.toolIds : [];
        const parentToolIds = new Set(agent.toolIds ?? []);
        const outside = requestedToolIds.filter((id) => !parentToolIds.has(id));
        if (outside.length > 0) {
          return {
            result: null,
            error: `A temporary agent can only use tools this agent has; not available: ${outside.join(', ')}`,
          };
        }
        try {
          // The temporary agent's tools are checked against the run's
          // scope now, not only when the child calls them: a model must not
          // be able to hand a team or private tool id it was never offered
          // to an agent it builds. Any id outside the scope (or the org) is
          // refused as not found, and nothing is created.
          const requestedToolIds: string[] = Array.isArray(parameters.toolIds)
            ? [...new Set(parameters.toolIds.filter((id: unknown): id is string => typeof id === 'string'))]
            : [];
          if (requestedToolIds.length > 0) {
            const found = await this.agentRepository.manager.getRepository(Tool).find({
              where: { id: In(requestedToolIds), organizationId: run.organizationId },
              select: { id: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
            });
            const usable = new Set(
              (await this.runtime.executionAccess.filterExecutable(principalOfRun(run), found)).map((t) => t.id),
            );
            const missing = requestedToolIds.filter((id) => !usable.has(id));
            if (missing.length > 0) {
              return { result: null, error: `Failed to create temporary agent: tool not found: ${missing.join(', ')}` };
            }
          }
          const tempAgent = this.agentRepository.create({
            name: parameters.name,
            description: `Temporary agent created by ${agent.name}`,
            organizationId: run.organizationId,
            mode: 'autonomous' as any,
            status: 'active' as any,
            personality: parameters.personality || null,
            instructions: parameters.instructions,
            toolIds: requestedToolIds,
            modelConfig: agent.modelConfig,
            isTemporary: true,
            parentRunId: run.id,
            pipeline: { nodes: [], edges: [] },
            // Never wider than its parent. It runs on the parent's model
            // config and on tools the parent holds, so it takes the parent's
            // scope: a team parent's child is that team's, and a private
            // parent's child is private to the same owner. Left at the
            // column default ('org'), a private or team agent's child was
            // listed and runnable across the whole organization.
            visibility: agent.visibility ?? 'org',
            teamId: agent.visibility === 'team' ? agent.teamId ?? null : null,
            // Owned by whoever the parent run works for -- the user
            // invoke_agent runs the child as -- and by nobody for a run
            // without one (a visitor's). A private parent's child is its
            // owner's, whoever the run is for. Never a sentinel string in an
            // owner column.
            createdBy: agent.visibility === 'private' ? agent.createdBy ?? null : run.userId ?? null,
          });
          const savedAgent = await this.agentRepository.save(tempAgent);
          return { result: { agentId: savedAgent.id, name: savedAgent.name, status: 'created' } };
        } catch (err) {
          return { result: null, error: `Failed to create temporary agent: ${err.message}` };
        }
      }

      case 'invoke_agent': {
        // Same gate as create_agent: invoke_agent is offered only with it.
        if (!agent.agentConfig?.canCreateAgents) {
          return { result: null, error: 'This agent is not allowed to invoke agents' };
        }
        // Which agents this run may start: the temporary agents it created
        // itself, and -- when the agent may call agents at all -- exactly
        // the ones it is offered as call_agent_* tools (active, not
        // temporary, not itself, and referenceable from this agent). The
        // id used to go to startRun unchecked, so a run could start any
        // agent in the organization its user could see, including ones the
        // agent's own allow-list leaves out.
        const target = await this.agentRepository.findOne({
          where: { id: String(parameters.agentId ?? ''), organizationId: run.organizationId },
        }).catch(() => null);
        const ownTemporary = !!target && target.isTemporary && target.parentRunId === run.id;
        const callable =
          !!target &&
          mayCallAgent(agent, target.id) &&
          !target.isTemporary &&
          target.id !== agent.id &&
          target.status === ('active' as any) &&
          canReference({ visibility: agent.visibility, ownerId: agent.createdBy }, target);
        if (!ownTemporary && !callable) {
          return { result: null, error: 'Agent not found or not callable from this agent' };
        }
        try {
          // The child works for whoever the parent works for. A visitor
          // run has no user (userId is null and the visitor is its
          // endUserId); substituting the string 'system' put a non-uuid
          // into the conversation's userId column and the child never
          // started.
          const childRun = await this.runtime.startRun(
            target!.id,
            run.organizationId,
            run.userId ?? null,
            parameters.input,
            {
              parentRunId: run.id,
              maxSteps: 20,
              endUserId: run.endUserId ?? null,
              // The child runs in the parent's scope, unchanged: the model
              // cannot start a team or private agent the run's starter
              // could not have started directly.
              principal: principalOfRun(run),
            },
          );
          const result = await this.runtime.waitForRun(childRun.id, 60000);
          if (result?.status === AgentRunStatus.COMPLETED) {
            return { result: { status: 'completed', output: result.output } };
          } else {
            return { result: null, error: result?.error || 'Agent did not complete in time' };
          }
        } catch (err) {
          return { result: null, error: `Failed to invoke agent: ${err.message}` };
        }
      }

      case 'request_approval': {
        // Create an ApprovalRequest row + flip the run state. The run
        // is paused at WAITING_APPROVAL until the ApprovalsService
        // emits 'approval.decided' for this gate, at which point the
        // listener wired in agent-runtime will resume / terminate.
        try {
          const approval = await this.approvals.create({
            organizationId: run.organizationId,
            teamId: agent.teamId ?? null,
            runId: run.id,
            agentId: agent.id,
            toolCallId: parameters._toolCallId ?? null,
            reason: parameters.reason || 'agent requested approval',
            payload: parameters.payload ?? null,
            // A run through a gateway asks in its gateway's scope.
            principal: principalOfRun(run),
          });
          run.status = AgentRunStatus.WAITING_APPROVAL;
          return {
            result: `Awaiting human approval (id=${approval.id}). Run paused; will resume after approve/reject.`,
            status: 'waiting_input' as const,
          };
        } catch (err) {
          return { result: null, error: `Failed to request approval: ${(err as Error).message}` };
        }
      }

      default:
        return null; // Not a built-in tool
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup temporary agents
  // ---------------------------------------------------------------------------

  /**
   * Delete all temporary agents created during a specific run.
   */
}
