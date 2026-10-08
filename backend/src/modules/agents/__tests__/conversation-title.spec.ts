import { CONVERSATION_TITLE_MAX, conversationTitle } from '../conversation-title';

describe('conversationTitle', () => {
  it('is the first line with text, spaces collapsed', () => {
    expect(conversationTitle('\n\n   Hello   there \nsecond line')).toBe('Hello there');
  });

  it('reads the message out of an input object', () => {
    expect(conversationTitle({ message: '  Refund for order 12 ' })).toBe('Refund for order 12');
  });

  it('cuts a long first line at a word, with an ellipsis', () => {
    const long = 'Please could you tell me whether the blue jacket I ordered last week comes in a larger size than the one listed';
    const title = conversationTitle(long)!;
    expect(title.length).toBeLessThanOrEqual(CONVERSATION_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1)).not.toMatch(/\s$/);
  });

  it('gives none for a message with no text', () => {
    expect(conversationTitle('   \n ')).toBeNull();
    expect(conversationTitle({})).toBeNull();
    expect(conversationTitle(null)).toBeNull();
  });
});
