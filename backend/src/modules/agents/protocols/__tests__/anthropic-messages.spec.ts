import {
  AnthropicRequestInvalid,
  fromAnthropicRequest,
  toAnthropicError,
  toAnthropicResponse,
} from '../anthropic-messages';

/**
 * Gate 2b: an Anthropic-SDK client works against almyty with a base-URL
 * change.
 *
 * The tests below are mostly about the differences that are easy to
 * flatten and expensive to get wrong. A translator that turns every
 * request into plausible-looking text passes a smoke test and breaks the
 * tool loop, which is the only thing a coding client really needs.
 */
describe('an Anthropic request becomes the internal shape', () => {
  it('takes the simplest thing a client sends', () => {
    const internal = fromAnthropicRequest({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(internal).toMatchObject({
      model: 'claude-opus-4-6',
      maxTokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('lifts system out of the top level, where OpenAI keeps it as a message', () => {
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(internal.systemPrompt).toBe('be terse');
    expect(internal.messages.every((m) => m.role !== 'user' || m.content === 'hi')).toBe(true);
  });

  it('accepts system as blocks, which the SDK sends for cache control', () => {
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      system: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(internal.systemPrompt).toBe('line one\nline two');
  });

  it('flattens text blocks into the message text', () => {
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    });
    expect(internal.messages[0].content).toBe('a\nb');
  });

  it('keeps an assistant turn that used tools, with its call ids', () => {
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will read it' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
          ],
        },
      ],
    });
    const assistant = internal.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('I will read it');
    expect(assistant.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }]);
  });

  it('turns a tool result into a tool message, not user text', () => {
    // This is the one that matters. Anthropic sends tool results as a USER
    // message containing tool_result blocks. Collapsing them into user
    // text is how a client's tool loop silently stops working: the model
    // never sees an answer tied to the call it made.
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
      ],
    });
    const toolMessage = internal.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ role: 'tool', toolCallId: 'call_1', content: 'file contents' });
    // And it did not also emit an empty user turn alongside it.
    expect(internal.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('handles several tool results in one turn, which parallel tool use produces', () => {
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'one' },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'two' },
          ],
        },
      ],
    });
    expect(internal.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(internal.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_1', 'call_2']);
  });

  it('translates tools and tool_choice into the internal names', () => {
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', description: 'reads', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    });
    expect(internal.tools).toEqual([{ name: 'read_file', description: 'reads', parameters: { type: 'object' } }]);
    expect(internal.toolChoice).toBe('required');
  });

  it('carries a named tool choice through', () => {
    const internal = fromAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'tool', name: 'read_file' },
    });
    expect(internal.toolChoice).toEqual({ name: 'read_file' });
  });

  it('refuses a missing max_tokens rather than inventing one', () => {
    // Required in this protocol. Defaulting it silently changes what the
    // caller asked for.
    expect(() => fromAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as never)).toThrow(
      AnthropicRequestInvalid,
    );
  });

  it('names the field it refused, so a client can fix it', () => {
    try {
      fromAnthropicRequest({ model: '', max_tokens: 1, messages: [] } as never);
    } catch (err) {
      expect((err as AnthropicRequestInvalid).field).toBe('model');
    }
    try {
      fromAnthropicRequest({ model: 'm', max_tokens: 1, messages: [{ role: 'system', content: 'x' }] } as never);
    } catch (err) {
      expect((err as AnthropicRequestInvalid).field).toBe('messages[0].role');
    }
  });
});

describe('the internal answer becomes an Anthropic response', () => {
  it('returns text as a content block with end_turn', () => {
    const out = toAnthropicResponse({ id: 'msg_1', model: 'm', content: 'hello', usage: { inputTokens: 5, outputTokens: 2 } });
    expect(out).toMatchObject({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it('reports tool_use when the turn called tools, or the client never runs them', () => {
    const out = toAnthropicResponse({
      id: 'msg_1',
      model: 'm',
      content: 'let me look',
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
    });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  it('maps a length stop to max_tokens, which is the name this protocol uses', () => {
    expect(toAnthropicResponse({ id: 'x', model: 'm', content: 'a', finishReason: 'length' }).stop_reason).toBe('max_tokens');
  });

  it('never returns empty content, which some clients reject outright', () => {
    const out = toAnthropicResponse({ id: 'x', model: 'm', content: '' });
    expect(out.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('survives tool arguments that are not valid JSON', () => {
    const out = toAnthropicResponse({ id: 'x', model: 'm', content: '', toolCalls: [{ id: 'c', name: 'n', arguments: '{oops' }] });
    const toolUse = out.content.find((b) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', input: {} });
    // An unparseable argument must not take the whole turn down: the
    // client still gets a well-formed tool_use it can reject itself.
    expect(out.stop_reason).toBe('tool_use');
  });

  it('defaults usage to zero rather than omitting it', () => {
    expect(toAnthropicResponse({ id: 'x', model: 'm', content: 'a' }).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('errors come back in the shape the client reads', () => {
  it.each([
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [400, 'invalid_request_error'],
  ])('%s maps to %s', (status, type) => {
    expect(toAnthropicError(status, 'nope')).toEqual({ type: 'error', error: { type, message: 'nope' } });
  });

  it('keeps the message, so the reason reaches the user', () => {
    expect(toAnthropicError(400, 'max_tokens is required').error.message).toBe('max_tokens is required');
  });
});
