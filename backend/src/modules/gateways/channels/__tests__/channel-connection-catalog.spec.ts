import { CredentialType } from '../../../../entities/credential.entity';
import { GatewayType } from '../../../../entities/gateway.entity';
import { makeCredentialRefFake } from '../../../../test/credential-ref.fake';
import { makeEnvelopeCryptoMock } from '../../../../test/envelope-crypto.mock';
import { CHANNEL_CONNECTORS } from '../../../connections/connector-catalog';
import { schemaViolations, splitSecrets } from '../../../connections/connector-schema';
import { ConnectorDefinition } from '../../../connections/connector.types';
import { getChannelConfig } from '../channel-config.helper';
import { ChannelCredentialService, channelConnectorKey } from '../channel-credential.service';

/**
 * The seam the whole change exists for: a connection made in the
 * Connections connect sheet, with the catalog's form schema, must resolve
 * into exactly the configuration the channel adapter reads. No key
 * translation, no camelCase, nothing missing.
 */
describe('a connect-sheet channel connection feeds the gateway', () => {
  const ORG = 'org-1';
  const connector = (type: string): ConnectorDefinition =>
    CHANNEL_CONNECTORS.find((c) => c.key === channelConnectorKey(type))!;

  /**
   * What the connect sheet does with a form: check the input against the
   * method schema, then store secrets and plain fields on one row tagged
   * with the connector. Mirrors ConnectionsService.finalize.
   */
  const connectThroughTheSheet = (store: ReturnType<typeof makeCredentialRefFake>, type: string, input: Record<string, unknown>, methodIndex = 0) => {
    const def = connector(type);
    const method = def.connect.filter((m) => m.schema)[methodIndex];
    expect(schemaViolations(input, method.schema)).toEqual([]);
    const { secrets, plain } = splitSecrets(input, method.schema);
    return store.seed({
      organizationId: ORG,
      name: `${def.displayName} bot`,
      type: (method.credentialType as CredentialType) ?? CredentialType.API_KEY,
      connectorKey: def.key,
      config: { ...plain, ...secrets },
      isActive: true,
    });
  };

  const gatewayOn = (type: GatewayType, credentialId: string) => ({
    id: 'gw-1',
    name: 'support',
    type,
    organizationId: ORG,
    configuration: { credentialId, aiDisclosure: true },
  });

  it('a channel-slack connection resolves into the exact config the Slack adapter reads', async () => {
    const store = makeCredentialRefFake();
    const service = new ChannelCredentialService(store.resolver, makeEnvelopeCryptoMock());
    const row = connectThroughTheSheet(store, GatewayType.SLACK, { bot_token: 'xoxb-northwind', signing_secret: 'sig-northwind' }, 0);
    expect(row.connectorKey).toBe('channel-slack');

    const resolved = await service.resolveConfig(gatewayOn(GatewayType.SLACK, row.id), 'channel_outbound');

    // The two keys slack.adapter.ts reads, spelled its way.
    expect(resolved.bot_token).toBe('xoxb-northwind');
    expect(resolved.signing_secret).toBe('sig-northwind');
    // The gateway's own non-secret configuration survives the merge.
    expect(resolved.aiDisclosure).toBe(true);
    // Nothing camelCase was invented on the way through.
    expect(resolved.botToken).toBeUndefined();
    expect(resolved.signingSecret).toBeUndefined();
  });

  it.each([
    [GatewayType.DISCORD, { bot_token: 'discord-token-value-1' }],
    [GatewayType.TELEGRAM, { bot_token: '12345:AAG-telegram-token-x', webhook_secret_token: 'wst' }],
    [GatewayType.WHATSAPP, { twilio_account_sid: 'AC' + 'a'.repeat(32), twilio_auth_token: 'twilio-token-1234', phone_number: 'whatsapp:+15550001111' }],
    [GatewayType.SMS, { twilio_account_sid: 'AC' + 'b'.repeat(32), twilio_auth_token: 'twilio-token-5678', phone_number: '+15550002222' }],
    [GatewayType.WHATSAPP_CLOUD, { phone_number_id: '109876543210', access_token: 'EAAG-cloud-access-token-1', app_secret: 'app-secret', verify_token: 'vt' }],
    [GatewayType.MICROSOFT_TEAMS, { bot_id: 'app-id', bot_password: 'app-password', tenant_id: 'botframework.com' }],
    [GatewayType.GOOGLE_CHAT, { webhook_url: 'https://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t', verification_token: 'vt' }],
    [GatewayType.SIGNAL, { api_url: 'https://signal.example.com', phone_number: '+15550001111', inbound_token: 'it' }],
    [GatewayType.MATRIX, { homeserver_url: 'https://matrix.example.org', access_token: 'syt_matrix_access_token', room_id: '!r:example.org' }],
    [GatewayType.IRC, { webhook_url: 'https://bridge.example.com/out', bridge_token: 'bt', inbound_token: 'it', channel: '#ops', nick: 'almyty' }],
    [GatewayType.EMAIL, { resend_api_key: 're_key', reply_from: 'agent@northwind.example', inbound_address: 'in@northwind.example' }],
    [GatewayType.WEBHOOK, { callback_url: 'https://hooks.example.com/almyty', secret: 'a'.repeat(24) }],
  ] as const)('%s resolves every field of its connection back out under the same name', async (type, input) => {
    const store = makeCredentialRefFake();
    const service = new ChannelCredentialService(store.resolver, makeEnvelopeCryptoMock());
    const row = connectThroughTheSheet(store, type, input as Record<string, unknown>);

    const resolved = await service.resolveConfig(gatewayOn(type, row.id), 'channel_inbound');

    for (const [key, value] of Object.entries(input)) expect(resolved[key]).toBe(value);
  });

  it('the connection is the only place the secret lives: the gateway row keeps a reference, not a value', async () => {
    const store = makeCredentialRefFake();
    const service = new ChannelCredentialService(store.resolver, makeEnvelopeCryptoMock());
    const row = connectThroughTheSheet(store, GatewayType.SLACK, { bot_token: 'xoxb-secret-value', signing_secret: 'sig-secret-value' });

    const configuration: Record<string, any> = { credentialId: row.id, aiDisclosure: true };
    await service.persistSecrets(gatewayOn(GatewayType.SLACK, row.id), configuration, null);

    expect(configuration).toEqual({ aiDisclosure: true, credentialId: row.id, credentialKeys: ['bot_token', 'signing_secret'] });
    expect(JSON.stringify(configuration)).not.toContain('xoxb-secret-value');
    // Nothing was copied onto the gateway, so the raw read sees no secret.
    expect(getChannelConfig(configuration, ORG).bot_token).toBeUndefined();
    // Adopting an existing connection must not create a second managed row.
    expect(store.rows).toHaveLength(1);
  });
});
