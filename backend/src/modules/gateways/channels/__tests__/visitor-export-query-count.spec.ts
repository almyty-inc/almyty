import { HostedChatService } from '../hosted-chat.service';
import { MessageRole } from '../../../../entities/message.entity';

/**
 * The visitor data export was 1 + 500 queries — one `listMessages` per
 * conversation — to build a single GDPR export, on a public endpoint.
 */
describe('HostedChatService.exportVisitor query count', () => {
  const gateway: any = { id: 'gw-1', configuration: {} };
  const endUser: any = {
    id: 'eu-1',
    email: 'v@example.com',
    displayName: 'V',
    authProvider: null,
    createdAt: new Date('2026-01-01'),
    lastSeenAt: new Date('2026-02-01'),
  };

  const makeService = (conversations: any[], messages: any[]) => {
    const conversationRepository = { find: jest.fn().mockResolvedValue(conversations) };
    const messageRepository = { find: jest.fn().mockResolvedValue(messages) };
    const service = Object.create(HostedChatService.prototype) as HostedChatService;
    (service as any).conversationRepository = conversationRepository;
    (service as any).messageRepository = messageRepository;
    (service as any).logger = { log: jest.fn() };
    return { service, conversationRepository, messageRepository };
  };

  const turn = (conversationId: string, i: number, role = MessageRole.USER) => ({
    id: `${conversationId}-m${i}`,
    conversationId,
    role,
    content: `hello ${i}`,
    metadata: {},
    createdAt: new Date(2026, 0, 1, 0, i),
  });

  it('builds an export of 200 conversations in two queries, not 201', async () => {
    const conversations = Array.from({ length: 200 }, (_, i) => ({
      id: `c-${i}`, title: `T${i}`, status: 'active', createdAt: new Date(),
    }));
    const messages = conversations.flatMap((c) => [turn(c.id, 1), turn(c.id, 2)]);
    const { service, conversationRepository, messageRepository } = makeService(conversations, messages);

    const result: any = await service.exportVisitor(gateway, endUser);

    expect(conversationRepository.find).toHaveBeenCalledTimes(1);
    expect(messageRepository.find).toHaveBeenCalledTimes(1);
    expect(result.conversations).toHaveLength(200);
    expect(result.conversations[0].messages).toHaveLength(2);
    expect(result.conversations[199].messages).toHaveLength(2);
  });

  it('groups each conversation\'s turns back to it, in order', async () => {
    const conversations = [
      { id: 'c-1', title: 'One', status: 'active', createdAt: new Date() },
      { id: 'c-2', title: 'Two', status: 'active', createdAt: new Date() },
    ];
    const messages = [
      turn('c-1', 1),
      turn('c-1', 2, MessageRole.ASSISTANT),
      turn('c-2', 1),
    ];
    const { service } = makeService(conversations, messages);

    const result: any = await service.exportVisitor(gateway, endUser);

    expect(result.conversations[0].messages.map((m: any) => m.content)).toEqual(['hello 1', 'hello 2']);
    expect(result.conversations[1].messages.map((m: any) => m.content)).toEqual(['hello 1']);
  });

  it('keeps tool and internal turns out of the transcript, as listMessages did', async () => {
    const conversations = [{ id: 'c-1', title: 'One', status: 'active', createdAt: new Date() }];
    const messages = [
      turn('c-1', 1),
      { ...turn('c-1', 2), role: MessageRole.TOOL },
      { ...turn('c-1', 3), metadata: { internal: true } },
    ];
    const { service } = makeService(conversations, messages);

    const result: any = await service.exportVisitor(gateway, endUser);

    expect(result.conversations[0].messages).toHaveLength(1);
    expect(result.conversations[0].messages[0].content).toBe('hello 1');
  });

  it('asks for no messages when the visitor has no conversations', async () => {
    const { service, messageRepository } = makeService([], []);

    const result: any = await service.exportVisitor(gateway, endUser);

    expect(messageRepository.find).not.toHaveBeenCalled();
    expect(result.conversations).toEqual([]);
  });

  it('bounds both the conversation and the message row count', async () => {
    const conversations = [{ id: 'c-1', title: 'One', status: 'active', createdAt: new Date() }];
    const { service, conversationRepository, messageRepository } = makeService(conversations, []);

    await service.exportVisitor(gateway, endUser);

    expect(conversationRepository.find.mock.calls[0][0].take).toBe(500);
    expect(messageRepository.find.mock.calls[0][0].take).toBe(25_000);
  });
});
