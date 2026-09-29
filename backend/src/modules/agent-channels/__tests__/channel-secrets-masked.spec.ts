import { AgentChannel, ChannelType } from '../../../entities/agent-channel.entity';
import { AgentChannelsController } from '../agent-channels.controller';
import { AgentChannelsService } from '../agent-channels.service';
import { MASKED_CHANNEL_SECRET } from '../../gateways/channels/channel-config.helper';
import { fakeRepository } from '../../../test/fake-repository';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { Credential } from '../../../entities/credential.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { decryptField } from '../../../common/security/field-crypto';

/**
 * A channel's platform keys (a Slack bot token and signing secret, a
 * Twilio auth token, a Resend key) belong in its credential, but a row
 * written before that still carries them inline, as the seed here does.
 * The channel list is readable by any member who can read the agent, so
 * whatever the row holds is masked on the way out, and the next write
 * moves it into the store.
 */

const ORG = 'org-1';
const SECRET = 'xoxb-real-bot-token';
const SIGNING = 'real-signing-secret';

function makeService() {
  const agents = fakeRepository<any>([{ id: 'agent-1', organizationId: ORG, name: 'Acme', visibility: 'org', mode: 'autonomous', createdBy: 'user-1' }]);
  const channels = fakeRepository<any>({
    make: () => new AgentChannel(),
    seed: [
      {
        id: 'channel-1',
        organizationId: ORG,
        agentId: 'agent-1',
        type: ChannelType.SLACK,
        status: 'draft',
        configuration: { bot_token: SECRET, signing_secret: SIGNING, phone_number: '+1555' },
      },
    ],
  });
  const credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
  const service = new AgentChannelsService(
    channels as any,
    agents as any,
    fakeRepository<any>() as any,
    {} as any,
    { canAccess: async () => ({ allowed: true }) } as any,
    undefined,
    new CredentialRefResolver(credentials as any, makeEnvelopeCryptoMock()),
  );
  return { service, channels, credentials };
}

const req = { user: { id: 'user-1', currentOrganizationId: ORG } };

describe('channel keys never leave the API in the clear', () => {
  it('masks platform keys in the channel list and on the channel page', async () => {
    const { service } = makeService();
    const controller = new AgentChannelsController(service, {} as any);

    const listed = JSON.stringify((await controller.list('agent-1', req)).data);
    const { data } = await controller.get('agent-1', 'channel-1', req);

    for (const body of [listed, JSON.stringify(data)]) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(SIGNING);
    }
    expect((data as any).configuration.bot_token).toBe(MASKED_CHANNEL_SECRET);
    // Non-secret settings are still readable.
    expect((data as any).configuration.phone_number).toBe('+1555');
  });

  it('masks them in the response to a settings write', async () => {
    const { service } = makeService();
    const controller = new AgentChannelsController(service, {} as any);
    const { data } = await controller.update('agent-1', 'channel-1', { configuration: { phone_number: '+1666' } }, req);
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it('keeps the stored key when a masked placeholder is sent back, and moves both into the store', async () => {
    const { service, channels, credentials } = makeService();

    await service.update(ORG, 'agent-1', 'channel-1', { id: 'user-1' }, {
      configuration: { bot_token: MASKED_CHANNEL_SECRET, signing_secret: 'rotated-secret' },
    });

    const row = channels.row('channel-1')!;
    expect(JSON.stringify(row.configuration)).not.toContain(SECRET);
    const credential = credentials.row(row.configuration.credentialId)!;
    expect(decryptField(credential.config.bot_token, ORG)).toBe(SECRET);
    expect(decryptField(credential.config.signing_secret, ORG)).toBe('rotated-secret');
  });
});
