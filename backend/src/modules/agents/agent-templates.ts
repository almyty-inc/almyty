import { AgentPipeline } from '../../entities/agent.entity';

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  pipeline: AgentPipeline;
}

/**
 * Static catalog of starter agent templates exposed via
 * `GET /agents/templates`. Pure data — no DI, no DB.
 */
export function getAgentTemplates(): AgentTemplate[] {
    return [
      {
        id: 'simple-chat',
        name: 'Simple Chat Agent',
        description: 'Single LLM with tools — the basic conversational agent',
        category: 'basic',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, config: {}, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } as any,
            { id: 'llm_1', type: 'llm_call', position: { x: 350, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant.' } } as any,
            { id: 'output_1', type: 'output', position: { x: 650, y: 200 }, config: {}, data: { mapping: '{{nodes.llm_1.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_1' },
            { id: 'e2', source: 'llm_1', target: 'output_1' },
          ],
        },
      },
      {
        id: 'multi-llm-consensus',
        name: 'Multi-LLM Consensus',
        description: 'Send prompt to multiple LLMs in parallel, then use a judge to pick the best answer',
        category: 'advanced',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 250 }, config: {}, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } as any,
            { id: 'parallel_1', type: 'parallel', position: { x: 250, y: 250 }, config: {} } as any,
            { id: 'llm_a', type: 'llm_call', position: { x: 500, y: 100 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant.' } } as any,
            { id: 'llm_b', type: 'llm_call', position: { x: 500, y: 400 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant.' } } as any,
            { id: 'merge_1', type: 'merge', position: { x: 750, y: 250 }, config: {}, data: { strategy: 'best_of_n', judgeConfig: { providerId: '' } } } as any,
            { id: 'output_1', type: 'output', position: { x: 1000, y: 250 }, config: {}, data: { mapping: '{{nodes.merge_1.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'parallel_1' },
            { id: 'e2', source: 'parallel_1', target: 'llm_a' },
            { id: 'e3', source: 'parallel_1', target: 'llm_b' },
            { id: 'e4', source: 'llm_a', target: 'merge_1' },
            { id: 'e5', source: 'llm_b', target: 'merge_1' },
            { id: 'e6', source: 'merge_1', target: 'output_1' },
          ],
        },
      },
      {
        id: 'research-agent',
        name: 'Research Agent',
        description: 'Extract facts with one LLM, then summarize with another — sequential chain',
        category: 'advanced',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, config: {}, data: { schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } } } as any,
            { id: 'llm_extract', type: 'llm_call', position: { x: 300, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: 'Research and list key facts about: {{input.topic}}', systemPrompt: 'You are a research assistant. List facts as bullet points.', responseFormat: 'text' } } as any,
            { id: 'transform_1', type: 'transform', position: { x: 550, y: 200 }, config: {}, data: { expression: '{{nodes.llm_extract.output}}' } } as any,
            { id: 'llm_summarize', type: 'llm_call', position: { x: 800, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: 'Write a concise summary from these facts:\n\n{{nodes.transform_1.output}}', systemPrompt: 'You are a skilled writer. Produce clear, concise summaries.' } } as any,
            { id: 'output_1', type: 'output', position: { x: 1050, y: 200 }, config: {}, data: { mapping: '{{nodes.llm_summarize.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_extract' },
            { id: 'e2', source: 'llm_extract', target: 'transform_1' },
            { id: 'e3', source: 'transform_1', target: 'llm_summarize' },
            { id: 'e4', source: 'llm_summarize', target: 'output_1' },
          ],
        },
      },
      {
        id: 'tool-augmented',
        name: 'Tool-Augmented Agent',
        description: 'LLM with access to your API tools — the standard agentic pattern',
        category: 'basic',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, config: {}, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } as any,
            { id: 'llm_1', type: 'llm_call', position: { x: 350, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant with access to tools. Use them when needed.', toolIds: [], maxToolRounds: 5 } } as any,
            { id: 'output_1', type: 'output', position: { x: 650, y: 200 }, config: {}, data: { mapping: '{{nodes.llm_1.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_1' },
            { id: 'e2', source: 'llm_1', target: 'output_1' },
          ],
        },
      },
    ];
}
