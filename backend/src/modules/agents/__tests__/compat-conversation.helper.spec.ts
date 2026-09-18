import {
  flattenContent,
  renderConversation,
  unsupportedOpenAIField,
  withSamplingOverrides,
} from '../compat-conversation.helper';

/**
 * The compat endpoints are stateless the way the upstream APIs are: the
 * `messages` array IS the conversation. These pin the three things that were
 * being accepted and then dropped -- the conversation itself, the caller's
 * sampling, and the request fields that cannot be honoured at all.
 */
describe('compat conversation helper', () => {
  describe('renderConversation — the conversation has to reach the model', () => {
    it('renders a multi-turn conversation into `message`, in order', () => {
      const rendered = renderConversation([
        { role: 'user', content: 'My name is Frane.' },
        { role: 'assistant', content: 'Nice to meet you, Frane.' },
        { role: 'user', content: 'What is my name?' },
      ]);

      // The regression: only the last user line used to survive, so the agent
      // could not answer this question and had no way to say why.
      expect(rendered.message).toContain('My name is Frane.');
      expect(rendered.message).toContain('Nice to meet you, Frane.');
      expect(rendered.message).toContain('What is my name?');
      expect(rendered.isTranscript).toBe(true);

      const first = rendered.message.indexOf('My name is Frane.');
      const second = rendered.message.indexOf('Nice to meet you, Frane.');
      const third = rendered.message.indexOf('What is my name?');
      expect(first).toBeLessThan(second);
      expect(second).toBeLessThan(third);
    });

    it('labels each turn with its role so the model can tell them apart', () => {
      const rendered = renderConversation([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ]);
      expect(rendered.message).toBe('[user]\na\n\n[assistant]\nb');
    });

    it('folds a system message into the transcript rather than dropping it', () => {
      const rendered = renderConversation([
        { role: 'system', content: 'Answer only in French.' },
        { role: 'user', content: 'Hello' },
      ]);
      expect(rendered.message).toContain('Answer only in French.');
      expect(rendered.systemPrompt).toBe('Answer only in French.');
    });

    it('folds the Anthropic top-level system prompt in the same place', () => {
      const rendered = renderConversation([{ role: 'user', content: 'Hello' }], 'You are terse.');
      expect(rendered.message).toContain('You are terse.');
      expect(rendered.systemPrompt).toBe('You are terse.');
    });

    it('leaves a single-turn request byte-for-byte unchanged', () => {
      const rendered = renderConversation([{ role: 'user', content: 'Hello' }]);
      expect(rendered.message).toBe('Hello');
      expect(rendered.isTranscript).toBe(false);
    });

    it('still exposes the final user turn on its own', () => {
      const rendered = renderConversation([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ]);
      expect(rendered.latestMessage).toBe('second');
    });

    it('keeps tool-result turns in the transcript', () => {
      const rendered = renderConversation([
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: 'checking' },
        { role: 'tool', content: '{"tempC":9}' },
        { role: 'user', content: 'so?' },
      ]);
      expect(rendered.message).toContain('{"tempC":9}');
    });

    it('survives an empty message list', () => {
      const rendered = renderConversation([]);
      expect(rendered.message).toBe('');
      expect(rendered.latestMessage).toBe('');
    });
  });

  describe('flattenContent — content parts must not reach a prompt as an object', () => {
    it('joins the text parts of an array content', () => {
      expect(flattenContent([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])).toBe('one\ntwo');
    });

    it('names a non-text part instead of dropping it silently', () => {
      expect(flattenContent([{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'what is this' }]))
        .toBe('[image_url]\nwhat is this');
    });

    it('passes a plain string through', () => {
      expect(flattenContent('hello')).toBe('hello');
    });

    it('does not render an object as [object Object]', () => {
      expect(flattenContent([{ type: 'text', text: 'hi' }])).not.toContain('[object Object]');
    });
  });

  describe('withSamplingOverrides — temperature and max_tokens have to be honoured', () => {
    const agent: any = {
      id: 'a1',
      modelConfig: { providerId: 'p1', temperature: 0.9 },
      pipeline: {
        nodes: [
          { id: 'in', type: 'input' },
          { id: 'llm', type: 'llm_call', data: { providerId: 'p1', temperature: 0.9, maxTokens: 4096 } },
          { id: 'out', type: 'output' },
        ],
        edges: [],
      },
    };

    it('puts the requested temperature on the llm_call node the engine reads', () => {
      const patched: any = withSamplingOverrides(agent, { temperature: 0 });
      expect(patched.pipeline.nodes[1].data.temperature).toBe(0);
    });

    it('puts the requested max_tokens on the llm_call node too', () => {
      const patched: any = withSamplingOverrides(agent, { maxTokens: 16 });
      expect(patched.pipeline.nodes[1].data.maxTokens).toBe(16);
    });

    it('also patches modelConfig, which is where an autonomous agent reads it', () => {
      const patched: any = withSamplingOverrides(agent, { temperature: 0.1, maxTokens: 32 });
      expect(patched.modelConfig).toMatchObject({ providerId: 'p1', temperature: 0.1, maxTokens: 32 });
    });

    it('patches a node that carries `config` rather than `data`', () => {
      const configAgent: any = {
        id: 'a2',
        pipeline: { nodes: [{ id: 'llm', type: 'llm_call', config: { providerId: 'p1' } }], edges: [] },
      };
      const patched: any = withSamplingOverrides(configAgent, { temperature: 0.2 });
      expect(patched.pipeline.nodes[0].config.temperature).toBe(0.2);
    });

    it('leaves every other node type alone', () => {
      const patched: any = withSamplingOverrides(agent, { temperature: 0 });
      expect(patched.pipeline.nodes[0]).toBe(agent.pipeline.nodes[0]);
      expect(patched.pipeline.nodes[2]).toBe(agent.pipeline.nodes[2]);
    });

    it('never mutates the stored agent', () => {
      withSamplingOverrides(agent, { temperature: 0, maxTokens: 1 });
      expect(agent.pipeline.nodes[1].data.temperature).toBe(0.9);
      expect(agent.pipeline.nodes[1].data.maxTokens).toBe(4096);
      expect(agent.modelConfig.temperature).toBe(0.9);
    });

    it('returns the agent untouched when nothing was asked for', () => {
      expect(withSamplingOverrides(agent, {})).toBe(agent);
    });

    it('honours temperature 0 rather than treating it as absent', () => {
      const patched: any = withSamplingOverrides(agent, { temperature: 0 });
      expect(patched).not.toBe(agent);
      expect(patched.pipeline.nodes[1].data.temperature).toBe(0);
    });
  });

  describe('unsupportedOpenAIField — refuse by name rather than drop silently', () => {
    const base = { model: 'agent:1', messages: [{ role: 'user', content: 'hi' }] };

    it.each([
      ['tools', { tools: [{ type: 'function', function: { name: 'f' } }] }],
      ['functions', { functions: [{ name: 'f' }] }],
      ['tool_choice', { tool_choice: 'auto' }],
      ['function_call', { function_call: 'auto' }],
      ['response_format', { response_format: { type: 'json_object' } }],
      ['n', { n: 3 }],
      ['top_p', { top_p: 0.1 }],
      ['stop', { stop: ['\n\n'] }],
      ['seed', { seed: 42 }],
      ['logprobs', { logprobs: true }],
      ['top_logprobs', { top_logprobs: 5 }],
      ['frequency_penalty', { frequency_penalty: 0.5 }],
      ['presence_penalty', { presence_penalty: 0.5 }],
    ])('refuses %s and names it', (param, extra) => {
      const found = unsupportedOpenAIField({ ...base, ...(extra as any) });
      expect(found).not.toBeNull();
      expect(found!.param).toBe(param);
      expect(found!.message).toBeTruthy();
    });

    it('accepts the defaults a client library sends unasked', () => {
      // LangChain's ChatOpenAI sends these on every request. Refusing them
      // would reject requests whose behaviour is in fact exactly right.
      expect(
        unsupportedOpenAIField({
          ...base,
          temperature: 0.7,
          n: 1,
          top_p: 1,
          frequency_penalty: 0,
          presence_penalty: 0,
          stream: false,
        }),
      ).toBeNull();
    });

    it('accepts temperature and max_tokens, which are honoured', () => {
      expect(unsupportedOpenAIField({ ...base, temperature: 0, max_tokens: 64 })).toBeNull();
    });

    it('accepts response_format text and an empty tools array', () => {
      expect(unsupportedOpenAIField({ ...base, response_format: { type: 'text' }, tools: [] })).toBeNull();
    });

    it('accepts stream_options, which is honoured', () => {
      expect(unsupportedOpenAIField({ ...base, stream: true, stream_options: { include_usage: true } })).toBeNull();
    });
  });
});
