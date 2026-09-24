import type { Agent } from '../../entities/agent.entity';
import type { AgentRun } from '../../entities/agent-run.entity';

/**
 * The visitor-facing answer of a hosted chat run, written by a call that
 * offers no tools.
 *
 * An autonomous step always offers the model its tools, and a provider
 * cannot tell whether such a reply is the answer or narration ahead of a
 * tool call until the reply has ended (StreamChunk.stepKind). A surface
 * that must never show that narration therefore held every step until it
 * finished, and the answer reached the visitor in one piece.
 *
 * A run started with `metadata.composeFinalAnswer` works the other way
 * round. Its tool steps are marked as working (`llm.started` with
 * `answer: false`) and never shown. When a step comes back with no tool
 * calls, the tool work is over, and that reply is set aside as a draft:
 * the runtime asks the same model once more, with the same system
 * prompt, memory context and conversation but no tools, and that reply
 * is the answer. With no tools on the request the provider knows from its
 * first byte that the reply is text, so the answer streams word by word.
 *
 * It costs one call per reply: the draft's output plus one more pass over
 * the context. The other shape considered, a `finish` tool the model calls
 * when it is ready followed by the no-tools call, would save the draft's
 * output tokens, but only if the model reliably calls it; nothing on
 * ChatRequest forces a tool choice, and a model that answers a greeting
 * directly without calling `finish` lands back on this path anyway.
 */

/** Whether a verify panel gates this agent's final output. */
export function verifiesFinalOutput(agentConfig: Agent['agentConfig'] | undefined | null): boolean {
  const verify = agentConfig?.verify;
  return !!(
    verify?.enabled &&
    Array.isArray(verify.checkers) &&
    verify.checkers.length > 0 &&
    (verify.triggers ?? ['on_final_output']).includes('on_final_output')
  );
}

/**
 * Whether this run writes its answer with a separate no-tools call.
 *
 * Only a run whose surface asked for it: a streaming visitor surface. A
 * verify panel on the final output holds everything back until its
 * verdict anyway, so there the extra call would buy nothing and is not
 * made.
 */
export function composesFinalAnswer(
  run: Pick<AgentRun, 'metadata'>,
  agent: Pick<Agent, 'agentConfig'>,
): boolean {
  return run.metadata?.composeFinalAnswer === true && !verifiesFinalOutput(agent.agentConfig);
}

type ChatMessage = {
  role: string;
  content: any;
  toolCalls?: Array<{ id?: string; name: string; parameters?: Record<string, any> }>;
  toolCallId?: string;
};

const asText = (content: unknown): string =>
  typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content);

/**
 * The conversation for the answer call, with tool turns written out as
 * plain text.
 *
 * A request that carries tool-call and tool-result turns but defines no
 * tools is refused by some APIs, and nothing guarantees how each
 * chat-completions vendor treats one. The same information as text is
 * accepted everywhere: an assistant turn that called tools says which,
 * with what arguments, and each result is a user turn naming its tool.
 */
export function answerCallMessages(messages: ChatMessage[]): ChatMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((msg) => {
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
      for (const call of msg.toolCalls) if (call.id) toolNames.set(call.id, call.name);
      const calls = msg.toolCalls.map(
        (call) => `[called ${call.name} with ${JSON.stringify(call.parameters ?? {})}]`,
      );
      const narration = asText(msg.content).trim();
      return { role: msg.role, content: [narration, ...calls].filter(Boolean).join('\n') };
    }
    if (msg.role === 'tool' || msg.toolCallId) {
      const name = (msg.toolCallId && toolNames.get(msg.toolCallId)) || 'tool';
      return { role: 'user', content: `[result of ${name}]\n${asText(msg.content)}` };
    }
    return { role: msg.role, content: msg.content };
  });
}
