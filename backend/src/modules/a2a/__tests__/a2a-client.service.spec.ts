import axios from 'axios';

import { A2AClientService } from '../a2a-client.service';

jest.mock('axios');

/**
 * Outbound half of the same defect the server had inbound: a Part whose
 * discriminator matches no released A2A version leaves the REMOTE agent with
 * an empty message, and we get back a well-formed answer to nothing.
 *
 * This client uses slash-cased method names (`message/send`), so it speaks the
 * v0.2.x / v0.3.x dialect and its Parts must be `kind`-discriminated.
 */
describe('A2AClientService outbound wire shape', () => {
  const post = axios.post as unknown as jest.Mock;

  const externalAgent: any = {
    id: 'ext-1',
    organizationId: 'org-1',
    baseRpcUrl: 'https://remote.example.com/a2a',
    credentialId: null,
  };

  const makeService = () =>
    new A2AClientService(
      { increment: jest.fn() } as any,
      { findById: jest.fn() } as any,
      { warmOrg: jest.fn() } as any,
    );

  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { jsonrpc: '2.0', id: '1', result: {} } });
  });

  it('sends a kind-discriminated text Part the remote agent can actually read', async () => {
    await makeService().sendMessage(externalAgent, 'what is 2+2');

    const [, payload] = post.mock.calls[0];
    expect(payload.method).toBe('message/send');
    expect(payload.params.message.parts).toEqual([
      { kind: 'text', text: 'what is 2+2' },
    ]);
    // `type` was the v0.1.x draft discriminator and matches nothing in the
    // wild; emitting it drops the text on the remote side.
    expect(payload.params.message.parts[0].type).toBeUndefined();
  });

  it('sends a messageId, which Message requires in every version from 0.2 on', async () => {
    await makeService().sendMessage(externalAgent, 'hello');

    const [, payload] = post.mock.calls[0];
    expect(typeof payload.params.message.messageId).toBe('string');
    expect(payload.params.message.messageId.length).toBeGreaterThan(0);
  });

  it('keeps the v0.x lowercase role alongside the slash-cased method name', async () => {
    await makeService().sendMessage(externalAgent, 'hello');

    const [, payload] = post.mock.calls[0];
    expect(payload.params.message.role).toBe('user');
  });
});
