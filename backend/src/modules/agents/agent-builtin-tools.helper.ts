import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AgentRunStatus } from '../../entities/agent-run.entity';
import { MemoryError } from '../memory/canonical/canonical.types';
import { legacyTypeToTier } from './agent-runtime.service';
import { CanonicalMemoryService } from '../memory/canonical/canonical-memory.service';
import { Provenance, Tier } from '../memory/canonical/canonical.types';
import { AgentRuntimeService } from './agent-runtime.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { runMayWriteSharedMemory } from './memory-autosave.policy';
import { canReference } from '../../common/authorization/private-visibility';

@Injectable()
export class AgentBuiltInToolsHelper {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
    @Inject(forwardRef(() => CanonicalMemoryService))
    private readonly memoryService: CanonicalMemoryService,
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

      case 'store_memory': {
        // A visitor's run does not write shared memory unless the product
        // opted its visitors in -- the rule auto-save follows too.
        if (!runMayWriteSharedMemory(run)) {
          return { result: null, error: 'memory is not kept for visitor conversations' };
        }
        try {
          // Map the legacy `type` hint into the canonical tier:
          //   'fact'/'preference'/'instruction' → 'long' (durable)
          //   'context' → 'short' (within-session)
          //   'episode' → 'project' (work-product)
          //   anything else → 'project' (sane default)
          const tier: Tier = legacyTypeToTier(parameters.type as string | undefined);
          const provenance: Provenance = {
            agent_id: agent.id,
            session_id: run.id,
            collab_id: null,
            model: null,
            provider: null,
            tool_chain: ['store_memory'],
            created_by: 'agent',
            source_backend: 'almyty-native',
          };
          const item = await this.memoryService.put(
            {
              mode: 'memory',
              scope: { scope_type: 'workspace', scope_id: run.organizationId },
              content: parameters.content,
              tier,
              tags: parameters.tags || [],
              metadata: { source: { type: 'agent_runtime', id: run.id, name: agent.name } },
              provenance,
            },
            { user_id: run.userId },
          );
          return { result: `Memory stored (id: ${item.id})` };
        } catch (err) {
          if (err instanceof MemoryError) {
            return { result: null, error: `memory rejected: ${err.tag.kind}` };
          }
          return { result: null, error: `Failed to store memory: ${(err as Error).message}` };
        }
      }

      case 'recall_memory': {
        try {
          const ranked = await this.memoryService.search({
            scope: { scope_type: 'workspace', scope_id: run.organizationId },
            query: parameters.query,
            mode: 'memory',
            top_k: parameters.limit || 5,
          });
          if (ranked.length === 0) {
            return { result: 'No relevant memories found.' };
          }
          const formatted = ranked.map((r, i) =>
            `${i + 1}. [${r.item.tier ?? 'memory'}] (score: ${r.score.toFixed(2)}) ${r.item.content}`,
          ).join('\n');
          return { result: formatted };
        } catch (err) {
          return { result: null, error: `Failed to recall memory: ${err.message}` };
        }
      }

      case 'create_agent': {
        // Offered only when the agent may create agents (buildToolDefinitions),
        // but a tool call is whatever name the model emits, so the gate has
        // to hold here too.
        if (!agent.agentConfig?.canCreateAgents) {
          return { result: null, error: 'This agent is not allowed to create agents' };
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
            createdBy: 'system',
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
          !!agent.agentConfig?.canCallAgents &&
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
            { parentRunId: run.id, maxSteps: 20, endUserId: run.endUserId ?? null },
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
