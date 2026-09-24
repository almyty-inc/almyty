import { answerCallMessages, composesFinalAnswer, verifiesFinalOutput } from '../final-answer';

describe('final-answer', () => {
  describe('answerCallMessages', () => {
    it('writes tool turns out as text, naming each result by the call it answers', () => {
      const out = answerCallMessages([
        { role: 'system', content: 'You are Acme support.' },
        { role: 'user', content: 'Where is my order?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'a', name: 'crm_lookup', parameters: { account: '4411' } },
            { id: 'b', name: 'shipping_eta' },
          ],
        },
        { role: 'tool', toolCallId: 'b', content: 'Monday' },
        { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'jane' }] },
      ]);

      expect(out).toEqual([
        { role: 'system', content: 'You are Acme support.' },
        { role: 'user', content: 'Where is my order?' },
        { role: 'assistant', content: '[called crm_lookup with {"account":"4411"}]\n[called shipping_eta with {}]' },
        { role: 'user', content: '[result of shipping_eta]\nMonday' },
        { role: 'user', content: '[result of crm_lookup]\n[{"type":"text","text":"jane"}]' },
      ]);
      expect(out.some((m) => m.toolCalls || m.toolCallId)).toBe(false);
    });

    it('keeps the narration that came with a tool call', () => {
      const [msg] = answerCallMessages([
        { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'a', name: 'crm_lookup', parameters: {} }] },
      ]);
      expect(msg.content).toBe('Checking.\n[called crm_lookup with {}]');
    });

    it('names a result whose call it never saw as a tool result', () => {
      const [msg] = answerCallMessages([{ role: 'tool', toolCallId: 'gone', content: 'x' }]);
      expect(msg).toEqual({ role: 'user', content: '[result of tool]\nx' });
    });
  });

  describe('composesFinalAnswer', () => {
    const verify = { enabled: true, checkers: [{ providerId: 'p' }] } as any;

    it('only for a run that asked for it', () => {
      expect(composesFinalAnswer({ metadata: { composeFinalAnswer: true } } as any, { agentConfig: {} } as any)).toBe(true);
      expect(composesFinalAnswer({ metadata: {} } as any, { agentConfig: {} } as any)).toBe(false);
      expect(composesFinalAnswer({ metadata: null } as any, { agentConfig: {} } as any)).toBe(false);
    });

    it('not when a verify panel gates the final output, which holds the stream back anyway', () => {
      expect(composesFinalAnswer({ metadata: { composeFinalAnswer: true } } as any, { agentConfig: { verify } } as any)).toBe(false);
      // A panel that only reviews mid-run does not hold the answer back.
      expect(
        composesFinalAnswer(
          { metadata: { composeFinalAnswer: true } } as any,
          { agentConfig: { verify: { ...verify, triggers: ['every_n_steps'] } } } as any,
        ),
      ).toBe(true);
      expect(verifiesFinalOutput({ verify: { ...verify, checkers: [] } } as any)).toBe(false);
      expect(verifiesFinalOutput({ verify: { ...verify, enabled: false } } as any)).toBe(false);
    });
  });
});
