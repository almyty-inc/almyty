/**
 * Tool-call loop helpers salvaged from the deleted A2A service.
 *
 * These utilities handle the LLM→tool→LLM loop for external LLM provider
 * proxying. They know how to extract tool calls from OpenAI and Anthropic
 * response formats, execute them via ToolExecutorService, and append the
 * results back into the conversation in the correct format.
 *
 * Not wired into any runtime path yet — preserved as reusable building
 * blocks for the A2A client (Phase 6) and any future provider-proxy flow.
 */

import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Tool } from '../../entities/tool.entity';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { batchAsyncSettled } from '../../common/utils/batch-async';

const logger = new Logger('LlmToolLoop');

export interface ToolCallEntry {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  result: any;
  error?: string;
}

/**
 * Extract tool calls from an LLM response in either OpenAI or Anthropic format.
 */
export function extractToolCalls(
  format: 'openai' | 'anthropic',
  responseData: any,
): ToolCallEntry[] {
  if (format === 'openai') {
    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls)) return [];
    return toolCalls.map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments:
        typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
    }));
  }

  if (format === 'anthropic') {
    const contentBlocks = responseData?.content;
    if (!contentBlocks || !Array.isArray(contentBlocks)) return [];
    return contentBlocks
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      }));
  }

  return [];
}

/**
 * Execute a batch of tool calls via ToolExecutorService.
 */
export async function executeToolCalls(
  toolCalls: ToolCallEntry[],
  organizationId: string,
  toolRepository: Repository<Tool>,
  toolExecutorService: ToolExecutorService,
): Promise<ToolCallResult[]> {
  const results = await batchAsyncSettled(toolCalls, 3, async (tc) => {
    const tool = await toolRepository.findOne({
      where: { name: tc.name, organizationId, status: 'active' as any },
    });

    if (!tool) {
      return { id: tc.id, name: tc.name, result: null, error: `Tool '${tc.name}' not found` };
    }

    try {
      const execResult = await toolExecutorService.executeTool(
        tool.id,
        tc.arguments,
        { userId: null, organizationId, skipRateLimit: false },
      );
      return {
        id: tc.id,
        name: tc.name,
        result: execResult.success ? execResult.data : null,
        error: execResult.error,
      };
    } catch (err) {
      logger.error(`Tool execution failed for ${tc.name}: ${err.message}`);
      return { id: tc.id, name: tc.name, result: null, error: err.message };
    }
  });

  return results.map((r) =>
    r != null
      ? r
      : { id: '', name: '', result: null, error: 'Tool call failed' },
  );
}

/**
 * Append a tool-call round (assistant + tool results) to an LLM conversation.
 */
export function appendToolCallRound(
  format: 'openai' | 'anthropic',
  messages: any[],
  responseData: any,
  toolCalls: ToolCallEntry[],
  toolResults: ToolCallResult[],
): any[] {
  if (format === 'openai') {
    messages.push(responseData.choices[0].message);
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.id,
        content: JSON.stringify(tr.error ? { error: tr.error } : tr.result),
      });
    }
    return messages;
  }

  if (format === 'anthropic') {
    messages.push({ role: 'assistant', content: responseData.content });
    messages.push({
      role: 'user',
      content: toolResults.map((tr) => ({
        type: 'tool_result',
        tool_use_id: tr.id,
        content: tr.error ? JSON.stringify({ error: tr.error }) : JSON.stringify(tr.result),
        is_error: !!tr.error,
      })),
    });
    return messages;
  }

  return messages;
}
