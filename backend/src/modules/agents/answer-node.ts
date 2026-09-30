import type { AgentPipeline, AgentPipelineNode } from '../../entities/agent.entity';

/**
 * The llm_call whose text IS the run's answer, if there is exactly one.
 *
 * The pipeline engine has no token-level streaming of its own: nodes run to
 * completion and hand their output on. A caller that streams (the compat
 * APIs) could only send the answer once the run had finished. In the common
 * shape -- an llm_call feeding the output node, which returns its text
 * unchanged -- the answer is exactly what that one model call writes, so its
 * tokens can go to the caller as the model produces them.
 *
 * Every condition below is one under which those tokens would NOT be the
 * answer, or would not arrive once:
 *
 *   - one output node, fed by one edge, from an llm_call. A second input to
 *     the output node, or another node in between (a verify panel, a merge,
 *     a transform), means the model's text is not what comes back.
 *   - the output mapping is exactly `{{nodes.<id>.output}}`. A mapping that
 *     wraps it ("Answer: {{...}}") or picks fields returns something else.
 *   - the node offers no tools. A model that calls tools writes narration
 *     before its call and the answer after the results, in separate calls;
 *     the streaming path does not run that loop.
 *   - the node names no routing policy. A routed non-streaming call walks to
 *     the next candidate when one fails; a stream cannot, once tokens are out.
 *   - no loop node. A node in a loop body runs more than once.
 *
 * Anything else answers whole when the run ends, as before. The caller still
 * checks the finished output against what was streamed (compat-agent-invoker).
 */
export function streamableAnswerNode(pipeline: Pick<AgentPipeline, 'nodes' | 'edges'> | null | undefined): string | null {
  const nodes = pipeline?.nodes ?? [];
  const edges = pipeline?.edges ?? [];
  if (nodes.some((node) => node.type === 'loop')) return null;

  const outputs = nodes.filter((node) => node.type === 'output');
  if (outputs.length !== 1) return null;
  const output = outputs[0];

  const incoming = edges.filter((edge) => edge.target === output.id);
  if (incoming.length !== 1) return null;
  const source = nodes.find((node) => node.id === incoming[0].source);
  if (!source || source.type !== 'llm_call') return null;

  const config = configOf(source);
  if (Array.isArray(config.toolIds) && config.toolIds.length > 0) return null;
  if (Array.isArray(config.tools) && config.tools.length > 0) return null;
  if (config.routing && typeof config.routing === 'object') return null;

  const mapping = configOf(output).mapping;
  if (typeof mapping !== 'string' || mapping.trim() !== `{{nodes.${source.id}.output}}`) return null;

  return source.id;
}

/** The executor reads `data || config`; so does this. */
function configOf(node: AgentPipelineNode): Record<string, any> {
  return (node.data || node.config || {}) as Record<string, any>;
}
