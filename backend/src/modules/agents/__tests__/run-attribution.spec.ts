import { Conversation } from '../../../entities/conversation.entity';

/**
 * Who a run belongs to.
 *
 * `conversations.userId` carries a foreign key to `users`. A visitor on
 * a published surface has no account here, so attributing them through
 * that column wrote a value no `users` row matched, and every write
 * after it failed. The symptom was that a hosted chat or a channel
 * accepted a message, started a run, and failed at the first model call
 * with a constraint error nobody would connect to attribution.
 *
 * These pin the shape that keeps the two apart.
 */
describe('Conversation.createConversation attribution', () => {
  it('records a dashboard user in userId', () => {
    const conversation = Conversation.createConversation({
      organizationId: 'org-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });

    expect(conversation.userId).toBe('user-1');
    expect(conversation.endUserId).toBeNull();
  });

  it('records a visitor in endUserId, leaving userId unset', () => {
    // Not 'user-1' in both: userId references users(id), and an end
    // user has no row there.
    const conversation = Conversation.createConversation({
      organizationId: 'org-1',
      agentId: 'agent-1',
      endUserId: 'end-user-1',
    });

    expect(conversation.userId).toBeUndefined();
    expect(conversation.endUserId).toBe('end-user-1');
  });

  it('defaults endUserId to null rather than leaving it undefined', () => {
    // A column that is sometimes undefined and sometimes null is two
    // shapes for the same absence.
    const conversation = Conversation.createConversation({
      organizationId: 'org-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });

    expect(conversation.endUserId).toBeNull();
  });

  it('keeps both when a signed-in user talks to a surface', () => {
    // email_otp and oauth surfaces have an end user who is also known.
    const conversation = Conversation.createConversation({
      organizationId: 'org-1',
      agentId: 'agent-1',
      userId: 'user-1',
      endUserId: 'end-user-1',
    });

    expect(conversation.userId).toBe('user-1');
    expect(conversation.endUserId).toBe('end-user-1');
  });
});
