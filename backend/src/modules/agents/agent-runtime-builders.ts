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
import { messageContentForModel } from './attached-files';
import { memorySettings, type AgentMemoryConfig } from './agent-memory-settings';

/**
 * What the store_memory tool tells the model: when to save (every time it
 * learns something lasting, or only when the person asks it to remember
 * something) and what never to save. The rules are enforced too: every
 * save is screened against them (AgentMemoryKeeper), so this is guidance,
 * not the guard.
 */
export function storeMemoryDescription(agent: Pick<Agent, 'memoryConfig'>): string {
  const s = memorySettings(agent.memoryConfig as AgentMemoryConfig);
  const when =
    s.save === 'asked'
      ? 'Save something to your memory, only when the person asks you to remember it.'
      : 'Save an important fact, preference, or piece of context to your memory for later conversations.';
  return s.neverSave.length ? `${when} Never save: ${s.neverSave.join('; ')}.` : when;
}

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

  async buildMessages(agent: Agent, run: AgentRun, tools: Tool[], memoryContext: string, org?: Organization, options: { discover?: boolean } = {}): Promise<any[]> {
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

    // [TOOLS] — available tools. In discover mode (agent-tool-mode.ts) only the
    // tools offered in full are listed; the rest are found with search_tools.
    const toolLines: string[] = [];
    if (options.discover) {
      toolLines.push('- search_tools: Find the tools that fit what you need to do');
      toolLines.push("- get_tool: Get one tool's arguments and an example call");
      toolLines.push('- call_tool: Run a tool by name with its arguments');
    }
    if (tools.length > 0) {
      for (const tool of tools) {
        toolLines.push(`- ${tool.name}: ${tool.description || 'No description'}`);
      }
    }
    toolLines.push('- wait: Pause execution');
    toolLines.push('- ask_user: Ask user a question');
    toolLines.push('- request_approval: Pause for human approval before continuing');
    if (agent.memoryConfig?.enabled) {
      toolLines.push(`- store_memory: ${storeMemoryDescription(agent)}`);
      toolLines.push('- recall_memory: Search your memory');
    }
    parts.push(`[AVAILABLE TOOLS]\nYou have access to these tools:\n${toolLines.join('\n')}`);
    if (options.discover) {
      parts.push(
        '[FINDING TOOLS]\nMore tools are available than are listed here. Use search_tools to find the ones that fit, ' +
          'get_tool to see how to call one, and call_tool to run it.',
      );
    }

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
        // A message that came with files carries them as references after
        // its text; the model call resolves them (attached-files.ts).
        const msgObj: any = { role: msg.role, content: messageContentForModel(msg) };
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
      defs.push({ ...BUILT_IN_TOOLS.store_memory, description: storeMemoryDescription(agent) });
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
