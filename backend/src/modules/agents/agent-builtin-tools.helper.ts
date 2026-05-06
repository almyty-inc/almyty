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

        // Enqueue the next step with a delay
        await this.runtimeQueue.add('next-step', { runId: run.id }, {
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
        try {
          const tempAgent = this.agentRepository.create({
            name: parameters.name,
            description: `Temporary agent created by ${agent.name}`,
            organizationId: run.organizationId,
            mode: 'autonomous' as any,
            status: 'active' as any,
            personality: parameters.personality || null,
            instructions: parameters.instructions,
            toolIds: parameters.toolIds || [],
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
        try {
          const childRun = await this.runtime.startRun(
            parameters.agentId,
            run.organizationId,
            run.userId || 'system',
            parameters.input,
            { parentRunId: run.id, maxSteps: 20 },
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
