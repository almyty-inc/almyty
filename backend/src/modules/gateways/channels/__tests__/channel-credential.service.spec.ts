import { ForbiddenException } from '@nestjs/common';

import { CredentialType } from '../../../../entities/credential.entity';
import { GatewayType } from '../../../../entities/gateway.entity';
import { encryptField, isEncrypted } from '../../../../common/security/field-crypto';
import { makeCredentialRefFake } from '../../../../test/credential-ref.fake';
import { makeEnvelopeCryptoMock } from '../../../../test/envelope-crypto.mock';
import { MASKED_CHANNEL_SECRET } from '../channel-config.helper';
import { ChannelCredentialService, channelConnectorKey, channelManagedBy } from '../channel-credential.service';

/**
 * The single-workspace channel credential seam: pasted secrets become
 * a managed connection, reads go through the store, inline values stay
 * a read-through shim until they are written or backfilled.
 */
describe('ChannelCredentialService', () => {
  type Config = Record<string, any>;
  const gateway = (configuration: Config, over: Record<string, any> = {}) => ({
    id: 'gw-1',
    name: 'support',
    type: GatewayType.SLACK,
    organizationId: 'org-1',
    configuration,
    ...over,
  });

  const build = () => {
    const store = makeCredentialRefFake();
    const service = new ChannelCredentialService(store.resolver, makeEnvelopeCryptoMock());
    return { store, service };
  };

  describe('persistSecrets', () => {
    it('moves pasted secrets into a managed row tagged with the adapter and leaves only the reference on the row', async () => {
      const { store, service } = build();
      const configuration: Config = { bot_token: 'xoxb-1', signing_secret: 'sig-1', client_id: 'A1', aiDisclosure: true };

      await service.persistSecrets(gateway(configuration), configuration, null);

      expect(store.rows).toHaveLength(1);
      const row = store.rows[0];
      expect(row.type).toBe(CredentialType.CUSTOM);
      expect(row.connectorKey).toBe(channelConnectorKey('slack'));
      expect(row.metadata.managedBy).toEqual(channelManagedBy('gw-1', 'slack'));
      expect(isEncrypted(row.config.bot_token)).toBe(true);
      expect(isEncrypted(row.config.signing_secret)).toBe(true);
      expect(configuration).toEqual({
        client_id: 'A1',
        aiDisclosure: true,
        credentialId: row.id,
        credentialKeys: ['bot_token', 'signing_secret'],
      });
      expect(JSON.stringify(configuration)).not.toContain('xoxb-1');
    });

    it('moves legacy camelCase and encrypted inline values (the shim) onto canonical keys', async () => {
      const { store, service } = build();
      const configuration: Config = { botToken: encryptField('xoxb-old'), signingSecret: 'sig-old' };

      await service.persistSecrets(gateway(configuration), configuration, configuration);

      const resolved = await store.resolver.resolve('org-1', configuration.credentialId);
      expect(resolved.config).toEqual({ bot_token: 'xoxb-old', signing_secret: 'sig-old' });
      expect(configuration.botToken).toBeUndefined();
      expect(configuration.signingSecret).toBeUndefined();
    });

    it('rotates the managed row in place on the next paste and keeps untouched keys', async () => {
      const { store, service } = build();
      const first: Config = { bot_token: 'xoxb-1', signing_secret: 'sig-1' };
      await service.persistSecrets(gateway(first), first, null);
      const previous = { ...first };

      const next: Config = { ...previous, bot_token: 'xoxb-2', signing_secret: MASKED_CHANNEL_SECRET };
      await service.persistSecrets(gateway(next), next, previous);

      expect(store.rows).toHaveLength(1);
      expect(next.credentialId).toBe(previous.credentialId);
      expect(next.credentialKeys).toEqual(['bot_token', 'signing_secret']);
      const resolved = await store.resolver.resolve('org-1', next.credentialId);
      expect(resolved.config).toEqual({ bot_token: 'xoxb-2', signing_secret: 'sig-1' });
    });

    it('carries the stored reference over when the update names none', async () => {
      const { service } = build();
      const first: Config = { bot_token: 'xoxb-1' };
      await service.persistSecrets(gateway(first), first, null);

      const next: Config = { aiDisclosure: false };
      await service.persistSecrets(gateway(next), next, first);

      expect(next).toEqual({ aiDisclosure: false, credentialId: first.credentialId, credentialKeys: ['bot_token'] });
    });

    it('adopts a shared connection of the org, lists the secret names it holds and releases the managed row', async () => {
      const { store, service } = build();
      const first: Config = { bot_token: 'xoxb-1' };
      await service.persistSecrets(gateway(first), first, null);
      const shared = store.seed({
        organizationId: 'org-1', name: 'Shared Slack', type: CredentialType.CUSTOM,
        connectorKey: 'channel-slack', config: { bot_token: encryptField('xoxb-shared'), signing_secret: encryptField('s') },
      });

      const next: Config = { credentialId: shared.id, connectionId: shared.id };
      await service.persistSecrets(gateway(next), next, first);

      expect(next).toEqual({ credentialId: shared.id, credentialKeys: ['bot_token', 'signing_secret'] });
      expect(store.rows.map((r) => r.id)).toEqual([shared.id]);
    });

    it('refuses a credential of another organization', async () => {
      const { store, service } = build();
      const foreign = store.seed({ organizationId: 'org-2', type: CredentialType.CUSTOM, config: { bot_token: encryptField('x') } });
      const next: Config = { credentialId: foreign.id };
      await expect(service.persistSecrets(gateway(next), next, null)).rejects.toMatchObject({ response: { code: 'CREDENTIAL_NOT_FOUND' } });
    });

    it('a paste while a shared connection is selected makes a managed row and leaves the shared one alone', async () => {
      const { store, service } = build();
      const shared = store.seed({
        organizationId: 'org-1', name: 'Shared', type: CredentialType.CUSTOM, connectorKey: 'channel-slack',
        config: { bot_token: encryptField('xoxb-shared') },
      });
      const previous = { credentialId: shared.id, credentialKeys: ['bot_token'] };

      const next: Config = { credentialId: shared.id, bot_token: 'xoxb-mine' };
      await service.persistSecrets(gateway(next), next, previous);

      expect(store.rows).toHaveLength(2);
      expect(next.credentialId).not.toBe(shared.id);
      expect((await store.resolver.resolve('org-1', shared.id)).config.bot_token).toBe('xoxb-shared');
      expect((await store.resolver.resolve('org-1', next.credentialId)).config.bot_token).toBe('xoxb-mine');
    });

    it('null clears the reference and deletes the managed row', async () => {
      const { store, service } = build();
      const first: Config = { bot_token: 'xoxb-1' };
      await service.persistSecrets(gateway(first), first, null);

      const next: Config = { credentialId: null };
      await service.persistSecrets(gateway(next), next, first);

      expect(next).toEqual({});
      expect(store.rows).toHaveLength(0);
    });
  });

  describe('resolveConfig', () => {
    it('merges the connection secrets over the normalized row and never caches', async () => {
      const { store, service } = build();
      const configuration: Config = { bot_token: 'xoxb-1', client_id: 'A1', channelName: 'x' };
      await service.persistSecrets(gateway(configuration), configuration, null);

      const first = await service.resolveConfig(gateway(configuration), 'channel_inbound');
      expect(first).toMatchObject({ bot_token: 'xoxb-1', client_id: 'A1', credentialId: configuration.credentialId });

      await store.resolver.rotateManaged('org-1', configuration.credentialId, {
        config: { bot_token: 'xoxb-rotated' }, secretKeys: ['bot_token'], managedBy: channelManagedBy('gw-1', 'slack'),
      });
      const second = await service.resolveConfig(gateway(configuration), 'channel_inbound');
      expect(second.bot_token).toBe('xoxb-rotated');
    });

    it('reads the inline shim when no connection is referenced', async () => {
      const { service } = build();
      const out = await service.resolveConfig(gateway({ botToken: encryptField('xoxb-legacy') }), 'channel_inbound');
      expect(out.bot_token).toBe('xoxb-legacy');
    });

    it('yields no secret (fails closed) when the connection is gone or inactive', async () => {
      const { store, service } = build();
      const configuration: Config = { bot_token: 'xoxb-1' };
      await service.persistSecrets(gateway(configuration), configuration, null);
      store.rows[0].isActive = false;

      const out = await service.resolveConfig(gateway(configuration), 'channel_inbound');
      expect(out.bot_token).toBeUndefined();

      const missing = await service.resolveConfig(gateway({ credentialId: 'nope', credentialKeys: ['bot_token'] }), 'channel_inbound');
      expect(missing.bot_token).toBeUndefined();
    });

    it('passes the purpose to the use policy and propagates a denial', async () => {
      const policy = { assertCanUse: jest.fn(async ({ context }: any) => {
        if (context.purpose === 'channel_outbound') throw new ForbiddenException({ code: 'CONNECTION_USE_DENIED' });
      }) };
      const store = makeCredentialRefFake(policy as any);
      const service = new ChannelCredentialService(store.resolver, makeEnvelopeCryptoMock());
      const configuration: Config = { bot_token: 'xoxb-1' };
      await service.persistSecrets(gateway(configuration), configuration, null);

      await expect(service.resolveConfig(gateway(configuration), 'channel_inbound')).resolves.toMatchObject({ bot_token: 'xoxb-1' });
      await expect(service.resolveConfig(gateway(configuration), 'channel_outbound')).rejects.toMatchObject({ response: { code: 'CONNECTION_USE_DENIED' } });
      expect(policy.assertCanUse.mock.calls[0][0].context).toEqual({ purpose: 'channel_inbound', resourceType: 'gateway', resourceId: 'gw-1' });
    });
  });

  describe('release', () => {
    it('deletes the managed row with the gateway and leaves a shared connection alone', async () => {
      const { store, service } = build();
      const configuration: Config = { bot_token: 'xoxb-1' };
      await service.persistSecrets(gateway(configuration), configuration, null);
      const shared = store.seed({ organizationId: 'org-1', type: CredentialType.CUSTOM, config: { bot_token: encryptField('s') } });

      await service.release(gateway(configuration));
      await service.release(gateway({ credentialId: shared.id }));

      expect(store.rows.map((r) => r.id)).toEqual([shared.id]);
    });
  });

  describe('resolveWith', () => {
    it('falls back to the inline read when no service is wired', async () => {
      const warmOrg = jest.fn(async () => undefined);
      const out = await ChannelCredentialService.resolveWith(undefined, { warmOrg }, gateway({ bot_token: encryptField('xoxb-1') }), 'channel_inbound');
      expect(out.bot_token).toBe('xoxb-1');
      expect(warmOrg).toHaveBeenCalledWith('org-1');
    });
  });
});
