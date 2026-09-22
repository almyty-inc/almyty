import { Injectable, Logger, Optional } from '@nestjs/common';

import { CredentialType } from '../../../entities/credential.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { decryptField } from '../../../common/security/field-crypto';
import { CredentialRefResolver, ManagedBy } from '../../credentials/credential-ref.resolver';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import {
  channelSecretKeysIn,
  getChannelConfig,
  splitChannelConfigSecrets,
} from './channel-config.helper';

/** What a channel secret is being read for; forwarded to the connection use policy. */
export type ChannelUsePurpose = 'channel_inbound' | 'channel_outbound';

/** The slice of a gateway the channel credential paths need. */
export type ChannelGatewayRef = Pick<Gateway, 'id' | 'type' | 'organizationId' | 'configuration'> & { name?: string };

/**
 * Managed rows are tagged with the vendor as their connector:
 * `channel-slack`, `channel-telegram`, `channel-whatsapp-cloud`, ... The
 * gateway type's underscores are dasherized because connector keys are
 * `[a-z0-9-]` (see validateConnectorDefinition); the catalog builds its
 * channel keys the same way, so a gateway's managed row and a connection
 * made in the connect sheet land on the same connector.
 */
export function channelConnectorKey(type: string): string {
  return `channel-${type.replace(/_/g, '-')}`;
}

/** The consumer identity a channel credential row is managed by: one per gateway and adapter. */
export function channelManagedBy(gatewayId: string, type: string): ManagedBy {
  return { kind: 'gateway_channel', id: `${gatewayId}:${type}` };
}

/**
 * The single-workspace channel credentials of a gateway: the bot token,
 * signing secret, app secret, Twilio auth token, ... an adapter reads
 * from `gateway.configuration`.
 *
 * Read path (`resolveConfig`): the normalized, decrypted configuration
 * with the connection's config merged on top, resolved through
 * CredentialRefResolver on every call (nothing cached, a rotation is
 * visible on the next message). A gateway with no `credentialId` keeps
 * reading its inline values, the shim for rows the startup backfill has
 * not moved yet. A connection that is gone, inactive or refused by the
 * use policy yields no secret, so every adapter fails closed.
 *
 * Write path (`persistSecrets`): pasted values are moved into the row
 * this gateway manages (rotated in place when it exists, created when
 * not), a chosen connection is checked and referenced, an explicit null
 * clears it, and the configuration is left with `credentialId` plus
 * `credentialKeys` (names only). Plaintext never reaches the gateway row.
 */
@Injectable()
export class ChannelCredentialService {
  private readonly logger = new Logger(ChannelCredentialService.name);

  constructor(
    private readonly credentialRefs: CredentialRefResolver,
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
  ) {}

  /**
   * Resolve with the service when it is wired, else fall back to the
   * inline read (positional unit tests construct consumers without it).
   */
  static async resolveWith(
    service: ChannelCredentialService | undefined,
    envelopeCrypto: Pick<EnvelopeCryptoService, 'warmOrg'> | undefined,
    gateway: ChannelGatewayRef,
    purpose: ChannelUsePurpose,
  ): Promise<Record<string, any>> {
    if (service) return service.resolveConfig(gateway, purpose);
    await envelopeCrypto?.warmOrg(gateway.organizationId);
    return getChannelConfig(gateway.configuration, gateway.organizationId);
  }

  /** The decrypted, key-normalized configuration the adapters read. */
  async resolveConfig(gateway: ChannelGatewayRef, purpose: ChannelUsePurpose): Promise<Record<string, any>> {
    await this.envelopeCrypto?.warmOrg(gateway.organizationId);
    const base = getChannelConfig(gateway.configuration, gateway.organizationId);
    const credentialId = gateway.configuration?.credentialId;
    if (typeof credentialId !== 'string' || credentialId.length === 0) return base;
    const resolved = await this.credentialRefs.tryResolve(gateway.organizationId, credentialId, {
      context: { purpose, resourceType: 'gateway', resourceId: gateway.id },
    });
    if (!resolved) {
      this.logger.warn(`channel gateway ${gateway.id} references credential ${credentialId} which cannot be used`);
      return base;
    }
    const out: Record<string, any> = { ...base };
    for (const [key, value] of Object.entries(resolved.config)) {
      if (value === undefined || value === null || value === '') continue;
      out[key] = value;
    }
    return out;
  }

  /**
   * Move every inline secret of `configuration` into the store and
   * settle the connection reference. Mutates `configuration` in place;
   * `previous` is the stored configuration before this write (null on
   * create) and decides which managed row may be released.
   */
  async persistSecrets(
    gateway: ChannelGatewayRef,
    configuration: Record<string, any>,
    previous?: Record<string, any> | null,
  ): Promise<void> {
    const managedBy = channelManagedBy(gateway.id, gateway.type);
    const previousId = typeof previous?.credentialId === 'string' ? previous.credentialId : null;
    const { secrets, publicConfig } = splitChannelConfigSecrets(configuration);

    // The connection reference: undefined keeps the stored one, null
    // clears it, a string is checked against the org and adopted.
    let credentialId: string | null;
    let credentialKeys: string[] = [];
    if (configuration.credentialId === null) {
      credentialId = null;
    } else if (typeof configuration.credentialId === 'string' && configuration.credentialId.length > 0) {
      credentialId = configuration.credentialId;
      const row = await this.credentialRefs.load(gateway.organizationId, credentialId);
      credentialKeys = channelSecretKeysIn(row.config);
    } else {
      credentialId = previousId;
      credentialKeys = Array.isArray(previous?.credentialKeys) ? [...previous!.credentialKeys] : [];
    }

    if (Object.keys(secrets).length > 0) {
      const plaintext: Record<string, string> = {};
      for (const [key, value] of Object.entries(secrets)) {
        plaintext[key] = await this.decrypt(gateway.organizationId, value);
      }
      const secretKeys = Object.keys(plaintext);
      const current = credentialId
        ? await this.credentialRefs.load(gateway.organizationId, credentialId).catch(() => null)
        : null;
      if (current && CredentialRefResolver.isManagedBy(current, managedBy)) {
        const rotated = await this.credentialRefs.rotateManaged(gateway.organizationId, current.id, {
          config: plaintext,
          secretKeys,
          managedBy,
        });
        credentialKeys = channelSecretKeysIn(rotated.config);
      } else {
        const created = await this.credentialRefs.createManaged(gateway.organizationId, {
          name: `${gateway.name ?? gateway.id} ${gateway.type} channel`,
          description: `Channel credentials of gateway ${gateway.id}`,
          type: CredentialType.CUSTOM,
          config: plaintext,
          secretKeys,
          connectorKey: channelConnectorKey(gateway.type),
          managedBy,
        });
        credentialId = created.id;
        credentialKeys = secretKeys;
      }
    }

    // A managed row this gateway no longer points at goes away with it.
    if (previousId && previousId !== credentialId) {
      await this.credentialRefs.releaseManaged(gateway.organizationId, previousId, managedBy);
    }

    for (const key of Object.keys(configuration)) delete configuration[key];
    Object.assign(configuration, publicConfig);
    delete configuration.connectionId;
    if (credentialId) {
      configuration.credentialId = credentialId;
      configuration.credentialKeys = credentialKeys;
    } else {
      delete configuration.credentialId;
      delete configuration.credentialKeys;
    }
  }

  /** Delete the managed row when the gateway goes; a shared connection is left alone. */
  async release(gateway: ChannelGatewayRef): Promise<void> {
    const credentialId = gateway.configuration?.credentialId;
    if (typeof credentialId !== 'string' || !credentialId) return;
    await this.credentialRefs.releaseManaged(gateway.organizationId, credentialId, channelManagedBy(gateway.id, gateway.type));
  }

  /** Inline values arrive plaintext from a form or encrypted from a stored row (the shim). */
  private async decrypt(organizationId: string, value: string): Promise<string> {
    if (this.envelopeCrypto) return this.envelopeCrypto.decryptForOrg(organizationId, value);
    return decryptField(value, organizationId);
  }
}
