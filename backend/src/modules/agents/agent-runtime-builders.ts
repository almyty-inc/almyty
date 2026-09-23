import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Tool } from '../../entities/tool.entity';
import { Organization } from '../../entities/organization.entity';
import { Message } from '../../entities/message.entity';
import { BUILT_IN_TOOLS } from './agent-runtime.service';
import { AgentConstraintsService } from '../agent-constraints/agent-constraints.service';
import { buildCollaborationContext } from './collaboration-participants';

/**
 * How many recent messages a run rebuilds its thread from by default.
 * Overridable per agent via modelConfig.historyMessageLimit.
 */
const DEFAULT_HISTORY_MESSAGES = 100;

@Injectable()
export class AgentRuntimeBuilders {
  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    private readonly constraintsService: AgentConstraintsService,
  ) {}

  async buildMessages(agent: Agent, run: AgentRun, tools: Tool[], memoryContext: string, org?: Organization): Promise<any[]> {
    const messages: any[] = [];

    // Build structured system prompt
    const parts: string[] = [];

    // [ORGANIZATION DEFAULTS] — org-level personality and rules
    const orgDefaults = org?.agentDefaults;
    if (orgDefaults?.personality || orgDefaults?.rules) {
      const orgParts: string[] = [];
      if (orgDefaults.personality) orgParts.push(orgDefaults.personality);
      if (orgDefaults.rules) orgParts.push(orgDefaults.rules);
      parts.push(`[ORGANIZATION DEFAULTS]\n${orgParts.join('\n')}`);
    }

    // [PERSONALITY] — agent-level personality, tone, boundaries
    if (agent.personality) {
      parts.push(`[PERSONALITY]\n${agent.personality}`);
    }

    // [COLLABORATION CONTEXT] — only if this run is part of a collaboration
    const collab = agent.collaboration;
    if (run.parentRunId || (collab?.strategy && collab?.participants?.length > 0)) {
      // This agent's own role, when it is one of the listed participants.
      const currentAgentRole = collab?.participants?.find(
        (p) => p.kind === 'agent' && p.agentId === agent.id,
      )?.role;
      // Same text a model participant is given (collaboration-participants.ts).
      const collabParts = buildCollaborationContext(collab, currentAgentRole);
      if (collabParts.length > 0) {
        parts.push(`[COLLABORATION CONTEXT]\n${collabParts.join('\n')}`);
      }
    }

    // [INSTRUCTIONS] — what to do
    parts.push(`[INSTRUCTIONS]\n${agent.instructions || 'You are a helpful autonomous agent.'}`);

    // [CONSTRAINTS] — hard rules learned from past failures (opt-in)
    if (agent.agentConfig?.constraints?.enabled && run.organizationId) {
      try {
        const rules = await this.constraintsService.listActiveRules(run.organizationId, agent.id);
        if (rules.length > 0) {
          parts.push(
            `[CONSTRAINTS]\nHard rules learned from past failures — never violate:\n${rules
              .map((r) => `- ${r}`)
              .join('\n')}`,
          );
        }
      } catch {
        /* constraints are best-effort; never block message building */
      }
    }

    // [MEMORY] — relevant memories
    if (memoryContext) {
      parts.push(`[RELEVANT MEMORIES]\nRelevant memories:${memoryContext}`);
    }

    // [TOOLS] — available tools
    const toolLines: string[] = [];
    if (tools.length > 0) {
      for (const tool of tools) {
        toolLines.push(`- ${tool.name}: ${tool.description || 'No description'}`);
      }
    }
    toolLines.push('- wait: Pause execution');
    toolLines.push('- ask_user: Ask user a question');
    toolLines.push('- request_approval: Pause for human approval before continuing');
    toolLines.push('- store_memory: Save to long-term memory');
    toolLines.push('- recall_memory: Search long-term memory');
    parts.push(`[AVAILABLE TOOLS]\nYou have access to these tools:\n${toolLines.join('\n')}`);

    const systemPrompt = parts.join('\n\n');

    messages.push({ role: 'system', content: systemPrompt });

    // Thread history: load from messages table.
    //
    // Bounded to the tail. This loaded the entire conversation on EVERY
    // step of EVERY run, and compaction -- the thing that folds an old
    // prefix into a summary -- is off unless the agent opts in. So the
    // default path re-materialized the whole message table for a
    // conversation that, in a hosted chat or a Slack channel, lives for
    // weeks. The provider eventually refuses on context length, but the
    // heap on the API pod gives out first, and the cost is paid per
    // step. Compaction still folds the prefix when it is on; this is
    // the floor under it when it is not.
    if (run.conversationId) {
      const historyLimit = (agent.modelConfig as any)?.historyMessageLimit ?? DEFAULT_HISTORY_MESSAGES;
      const recent = await this.messageRepository.find({
        where: { conversationId: run.conversationId },
        order: { createdAt: 'DESC' },
        take: historyLimit,
      });
      const conversationMessages = recent.reverse();
      for (const msg of conversationMessages) {
        const msgObj: any = { role: msg.role, content: msg.content };
        if (msg.toolCalls) {
          msgObj.toolCalls = msg.toolCalls;
        }
        if (msg.toolCallId) {
          msgObj.toolCallId = msg.toolCallId;
        }
        messages.push(msgObj);
      }
    }

    return messages;
  }

  /**
   * Build tool definitions for the LLM (user tools + built-in tools)
   */
  buildToolDefinitions(tools: Tool[], agent: Agent): Array<{ name: string; description: string; parameters: Record<string, any> }> {
    const defs: Array<{ name: string; description: string; parameters: Record<string, any> }> = [];

    // User-defined tools
    for (const tool of tools) {
      defs.push({
        name: tool.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      });
    }

    // Built-in tools
    defs.push(BUILT_IN_TOOLS.wait);
    defs.push(BUILT_IN_TOOLS.ask_user);
    defs.push(BUILT_IN_TOOLS.request_approval);
    if (agent.memoryConfig?.enabled) {
      defs.push(BUILT_IN_TOOLS.store_memory);
      defs.push(BUILT_IN_TOOLS.recall_memory);
    }

    // Agent creation and invocation tools (only when canCreateAgents is enabled)
    if (agent.agentConfig?.canCreateAgents) {
      defs.push({
        name: 'create_agent',
        description: 'Create a temporary specialist agent for a specific task. The agent will be automatically cleaned up after your run completes.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for the temporary agent' },
            instructions: { type: 'string', description: 'What this agent should do' },
            personality: { type: 'string', description: 'Personality and style of this agent' },
            toolIds: { type: 'array', items: { type: 'string' }, description: 'Tool IDs this agent can use (from your available tools)' },
          },
          required: ['name', 'instructions'],
        },
      });
      defs.push({
        name: 'invoke_agent',
        description: 'Run an agent (existing or temporary) with the given input and wait for its response.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'ID of the agent to invoke' },
            input: { type: 'string', description: 'Input message for the agent' },
          },
          required: ['agentId', 'input'],
        },
      });
    }

    return defs;
  }

  /**
   * Wait for a run to complete (polling).
   */
}
