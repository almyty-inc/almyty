import { Agent } from '../../entities/agent.entity';

/**
 * What a `/v1` chat request actually has to become before an agent can read it.
 *
 * Both compat routes are stateless in the same way the upstream APIs are: the
 * `messages` array IS the conversation, resent in full on every turn. The agent
 * engine, by contrast, takes a flat `input` object and an `llm_call` node renders
 * exactly one system and one user message out of prompt templates. Every stock
 * template binds `{{input.message}}`.
 *
 * So `input.message` is the only channel that reliably reaches a model, and
 * putting just the last user line in it drops the rest of the conversation --
 * silently, with the right shape and a plausible-looking answer. That is why the
 * transcript is rendered into `message` rather than parked in a sibling field
 * that nothing reads: a fix that depended on every agent re-binding its prompt
 * would leave every agent that exists today amnesiac.
 *
 * A single-turn request renders byte-for-byte as it did before, so nothing that
 * worked changes.
 */

/** A message as either compat protocol hands it over. */
export interface CompatMessage {
  role: string;
  content: unknown;
  name?: string;
}

/**
 * Content down to text. Both protocols allow an array of typed parts where a
 * string is also legal; a raw array reaching a prompt template renders as
 * `[object Object]`, so flatten it here instead.
 */
export function flattenContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        // A non-text part (an image, an input_audio) has no text form. Name it
        // rather than dropping it, so a model that cannot see it is at least
        // told something was there.
        if (part && typeof part.type === 'string') return `[${part.type}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

export interface RenderedConversation {
  /** What `{{input.message}}` binds to: the whole conversation when there is one. */
  message: string;
  /** The final user turn alone, for a prompt template that deliberately wants only it. */
  latestMessage: string;
  /** The client's system instruction, kept separately as well as folded into `message`. */
  systemPrompt: string;
  /** True when `message` is a rendered transcript rather than a single turn verbatim. */
  isTranscript: boolean;
}

const TRANSCRIPT_ROLE_LABEL: Record<string, string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool result',
  function: 'tool result',
};

/**
 * Render a stateless `messages` array into the one string an agent prompt reads.
 *
 * `system` is the Anthropic top-level system field; OpenAI system-role messages
 * are collected into the same place, so one mechanism covers both.
 */
export function renderConversation(
  messages: CompatMessage[] | undefined,
  system?: string,
): RenderedConversation {
  const all = Array.isArray(messages) ? messages : [];

  const systemParts = [
    ...(system ? [system] : []),
    ...all.filter((m) => m?.role === 'system').map((m) => flattenContent(m.content)),
  ].filter((s) => s.trim().length > 0);
  const systemPrompt = systemParts.join('\n\n');

  const turns = all.filter((m) => m?.role !== 'system');
  const lastUser = [...turns].reverse().find((m) => m?.role === 'user');
  const latestMessage = flattenContent(lastUser?.content);

  // One turn and no system instruction is the single-shot case every existing
  // caller and every existing test exercises. Hand it over unchanged.
  if (!systemPrompt && turns.length <= 1) {
    return {
      message: flattenContent(turns[0]?.content),
      latestMessage,
      systemPrompt: '',
      isTranscript: false,
    };
  }

  const blocks: string[] = [];
  if (systemPrompt) blocks.push(`[system]\n${systemPrompt}`);
  for (const turn of turns) {
    const label = TRANSCRIPT_ROLE_LABEL[turn.role] ?? turn.role;
    blocks.push(`[${label}]\n${flattenContent(turn.content)}`);
  }

  return {
    message: blocks.join('\n\n'),
    latestMessage,
    systemPrompt,
    isTranscript: true,
  };
}

/** Per-request sampling a compat caller asked for. */
export interface SamplingOverrides {
  temperature?: number;
  maxTokens?: number;
}

/**
 * The caller's sampling, applied to a throwaway copy of the agent.
 *
 * `temperature` and `max_tokens` are read off an `llm_call` node's own config
 * and off `modelConfig`; there is no per-request override channel on the engine.
 * Rather than accept the fields and drop them -- the failure a caller cannot
 * see, because the answer still looks fine -- this hands the engine an agent
 * object that carries the requested values. Nothing here is persisted: the copy
 * lives for the length of one request and the stored agent is untouched.
 *
 * Only `llm_call` nodes are rewritten. A caller asking for temperature 0 means
 * the answer, not an internal context-extraction step.
 */
export function withSamplingOverrides<T extends Agent>(agent: T, overrides: SamplingOverrides): T {
  const { temperature, maxTokens } = overrides;
  if (temperature === undefined && maxTokens === undefined) return agent;

  const patch: Record<string, any> = {};
  if (temperature !== undefined) patch.temperature = temperature;
  if (maxTokens !== undefined) patch.maxTokens = maxTokens;

  const nodes = agent.pipeline?.nodes;
  // Keep the prototype: the copy stands in for an Agent entity for the length
  // of the run, and a plain-object spread would quietly drop its methods.
  const clone: any = Object.assign(Object.create(Object.getPrototypeOf(agent)), agent, {
    modelConfig: { ...(agent.modelConfig ?? {}), ...patch },
  });

  if (Array.isArray(nodes)) {
    clone.pipeline = {
      ...agent.pipeline,
      nodes: nodes.map((node) => {
        if (node?.type !== 'llm_call') return node;
        // The node executor reads `data || config`, so patch whichever one is
        // actually in effect or the override lands on the ignored half.
        return node.data
          ? { ...node, data: { ...node.data, ...patch } }
          : { ...node, config: { ...(node.config ?? {}), ...patch } };
      }),
    };
  }

  return clone as T;
}

/** A request field this endpoint will not silently ignore. */
export interface UnsupportedField {
  param: string;
  message: string;
}

const AGENT_RUNS_ITS_OWN_TOOLS =
  'An almyty agent runs its own tools and returns the finished answer, so there is no turn at which one ' +
  'could be handed back to you. Give the agent the tools instead.';

/**
 * The OpenAI request fields this endpoint cannot honour, refused by name.
 *
 * The sibling Anthropic route already settled the principle for client-declared
 * tools: accepting a field and returning a normal-looking answer leaves a caller
 * with a silent behaviour change and nothing to debug, which is worse than a
 * refusal that says which field and why. Everything listed here changes either
 * the answer or the response shape in a way the caller cannot detect, so it is
 * refused rather than dropped.
 *
 * `temperature` and `max_tokens` are deliberately absent: those are honoured,
 * via `withSamplingOverrides`. So are the OpenAI defaults a client library sends
 * on every request without being asked to (`n: 1`, `top_p: 1`, zero penalties) --
 * refusing those would reject requests whose behaviour is in fact exactly right.
 */
export function unsupportedOpenAIField(body: any): UnsupportedField | null {
  if (!body || typeof body !== 'object') return null;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { param: 'tools', message: `This endpoint does not take client-declared tools. ${AGENT_RUNS_ITS_OWN_TOOLS}` };
  }
  if (Array.isArray(body.functions) && body.functions.length > 0) {
    return { param: 'functions', message: `This endpoint does not take client-declared functions. ${AGENT_RUNS_ITS_OWN_TOOLS}` };
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'none') {
    return {
      param: 'tool_choice',
      message: `This endpoint does not take a client tool_choice. ${AGENT_RUNS_ITS_OWN_TOOLS}`,
    };
  }
  if (body.function_call !== undefined && body.function_call !== 'none') {
    return {
      param: 'function_call',
      message: `This endpoint does not take a client function_call. ${AGENT_RUNS_ITS_OWN_TOOLS}`,
    };
  }

  if (body.response_format !== undefined) {
    const type = body.response_format?.type;
    if (type !== undefined && type !== 'text') {
      return {
        param: 'response_format',
        message:
          `response_format "${type}" is not supported. An agent's output shape is decided by the agent, not per request, ` +
          'so accepting this would return prose to a caller expecting parseable structure. Build the shape into the agent.',
      };
    }
  }

  if (body.n !== undefined && body.n !== 1) {
    return {
      param: 'n',
      message: 'n must be 1. An agent run produces one answer, so a larger n would return fewer choices than you asked for.',
    };
  }

  if (body.top_p !== undefined && body.top_p !== 1) {
    return {
      param: 'top_p',
      message: 'top_p is not supported. The agent execution path takes temperature and max_tokens per request, but not top_p.',
    };
  }

  if (body.frequency_penalty) {
    return { param: 'frequency_penalty', message: 'frequency_penalty is not supported by this endpoint.' };
  }
  if (body.presence_penalty) {
    return { param: 'presence_penalty', message: 'presence_penalty is not supported by this endpoint.' };
  }

  if (body.stop !== undefined && (Array.isArray(body.stop) ? body.stop.length > 0 : body.stop !== null)) {
    return {
      param: 'stop',
      message: 'stop sequences are not supported by this endpoint. The agent returns its run output whole.',
    };
  }

  if (body.seed !== undefined && body.seed !== null) {
    return { param: 'seed', message: 'seed is not supported by this endpoint; runs are not reproducible from a seed.' };
  }

  if (body.logprobs) {
    return { param: 'logprobs', message: 'logprobs are not supported by this endpoint.' };
  }
  if (body.top_logprobs !== undefined && body.top_logprobs !== null) {
    return { param: 'top_logprobs', message: 'top_logprobs are not supported by this endpoint.' };
  }

  return null;
}
