import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { Api } from '../../entities/api.entity';
import { ChannelInstallation } from '../../entities/channel-installation.entity';
import { CredentialType } from '../../entities/credential.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { McpSource } from '../../entities/mcp-source.entity';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { LlmProviderSecretsHelper } from '../llm-providers/llm-provider-secrets.helper';
import { CredentialRefResolver } from './credential-ref.resolver';
import { splitInlineApiAuth } from './inline-api-auth.helper';

export interface BackfillCount {
  moved: number;
  skipped: number;
  failed: number;
}

export interface BackfillReport {
  llmProviders: BackfillCount;
  mcpSources: BackfillCount;
  channelInstallations: BackfillCount;
  apis: BackfillCount;
}

const CHANNEL_SECRET_KEYS = ['bot_token', 'access_token', 'refresh_token'];

/**
 * One-shot startup routine: every third-party secret still sitting on a
 * consumer row (LLM provider inline keys, MCP source authConfig, channel
 * installation credentials, API inline authentication) moves into a
 * Credential row the consumer then references. Idempotent: a row that
 * already references a credential, or has nothing inline, is skipped.
 * Counts are logged; values never are.
 *
 * Runs on application bootstrap unless SECRET_BACKFILL=off (or in the
 * test environment). `run()` can also be called on demand.
 */
@Injectable()
export class ConsumerSecretBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConsumerSecretBackfillService.name);

  constructor(
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(McpSource) private readonly mcpSources: Repository<McpSource>,
    @InjectRepository(ChannelInstallation) private readonly installations: Repository<ChannelInstallation>,
    @InjectRepository(Api) private readonly apis: Repository<Api>,
    private readonly envelopeCrypto: EnvelopeCryptoService,
    private readonly credentialRefs: CredentialRefResolver,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SECRET_BACKFILL === 'off' || process.env.NODE_ENV === 'test') return;
    void this.run().catch((err) => this.logger.error(`secret backfill failed: ${err?.message ?? err}`));
  }

  async run(): Promise<BackfillReport> {
    const report: BackfillReport = {
      llmProviders: await this.backfillLlmProviders(),
      mcpSources: await this.backfillMcpSources(),
      channelInstallations: await this.backfillChannelInstallations(),
      apis: await this.backfillApis(),
    };
    for (const [store, count] of Object.entries(report)) {
      this.logger.log(`secret backfill ${store}: moved=${count.moved} skipped=${count.skipped} failed=${count.failed}`);
    }
    return report;
  }

  /** Inline apiKey / usageApiKey -> managed rows, via the same helper the service uses. */
  private async backfillLlmProviders(): Promise<BackfillCount> {
    const count: BackfillCount = { moved: 0, skipped: 0, failed: 0 };
    const helper = new LlmProviderSecretsHelper(this.credentialRefs);
    for (const provider of await this.providers.find()) {
      const inline = (!provider.credentialId && !!provider.configuration?.apiKey) || (!provider.usageCredentialId && !!provider.configuration?.usageApiKey);
      if (!inline) { count.skipped++; continue; }
      try {
        await this.envelopeCrypto.warmOrg(provider.organizationId);
        await helper.applyKey(provider, 'inference', {});
        await helper.applyKey(provider, 'usage', {});
        await this.providers.save(provider);
        count.moved++;
      } catch (err: any) {
        count.failed++;
        this.logger.warn(`llm provider ${provider.id}: ${err?.message ?? err}`);
      }
    }
    return count;
  }

  /** authConfig (bearer token / header map) -> managed row. */
  private async backfillMcpSources(): Promise<BackfillCount> {
    const count: BackfillCount = { moved: 0, skipped: 0, failed: 0 };
    for (const source of await this.mcpSources.find({ where: { credentialId: IsNull(), authConfig: Not(IsNull()) } })) {
      const auth = source.authConfig;
      if (!auth || (!auth.bearerToken && !auth.headers)) { count.skipped++; continue; }
      try {
        const managedBy = { kind: 'mcp_source' as const, id: source.id };
        let row;
        if (auth.bearerToken) {
          const token = await this.envelopeCrypto.decryptForOrg(source.organizationId, auth.bearerToken);
          row = await this.credentialRefs.createManaged(source.organizationId, {
            name: `${source.name} MCP token`,
            type: CredentialType.BEARER_TOKEN,
            config: { token },
            managedBy,
          });
        } else {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(auth.headers ?? {})) {
            headers[key] = await this.envelopeCrypto.decryptForOrg(source.organizationId, value);
          }
          row = await this.credentialRefs.createManaged(source.organizationId, {
            name: `${source.name} MCP headers`,
            type: CredentialType.CUSTOM,
            config: { headers },
            secretKeys: ['headers'],
            managedBy,
          });
        }
        source.credentialId = row.id;
        source.authConfig = null;
        await this.mcpSources.save(source);
        count.moved++;
      } catch (err: any) {
        count.failed++;
        this.logger.warn(`mcp source ${source.id}: ${err?.message ?? err}`);
      }
    }
    return count;
  }

  /** The per-workspace credentials blob -> managed row (active installations only; revoked rows are already empty). */
  private async backfillChannelInstallations(): Promise<BackfillCount> {
    const count: BackfillCount = { moved: 0, skipped: 0, failed: 0 };
    for (const installation of await this.installations.find({ where: { credentialId: IsNull(), credentials: Not(IsNull()) } })) {
      if (!installation.credentials || installation.status !== 'active') { count.skipped++; continue; }
      try {
        const config: Record<string, any> = {};
        for (const [key, value] of Object.entries(installation.credentials)) {
          config[key] = typeof value === 'string' ? await this.envelopeCrypto.decryptForOrg(installation.organizationId, value) : value;
        }
        const row = await this.credentialRefs.createManaged(installation.organizationId, {
          name: `Channel installation ${installation.externalTenantId}`,
          type: CredentialType.CUSTOM,
          config,
          secretKeys: CHANNEL_SECRET_KEYS,
          managedBy: { kind: 'channel_installation', id: installation.id },
        });
        installation.credentialId = row.id;
        installation.credentials = null;
        await this.installations.save(installation);
        count.moved++;
      } catch (err: any) {
        count.failed++;
        this.logger.warn(`channel installation ${installation.id}: ${err?.message ?? err}`);
      }
    }
    return count;
  }

  /** Inline authentication.config secrets -> a row bound to the API (credentials.apiId). */
  private async backfillApis(): Promise<BackfillCount> {
    const count: BackfillCount = { moved: 0, skipped: 0, failed: 0 };
    for (const api of await this.apis.find({ where: { authentication: Not(IsNull()) } })) {
      const split = splitInlineApiAuth(api.authentication);
      if (!split) { count.skipped++; continue; }
      try {
        const row = await this.credentialRefs.createManaged(api.organizationId, {
          name: `${api.name} ${api.authentication.type} auth`,
          type: split.credentialType,
          config: split.secretConfig,
          keyName: split.keyName,
          keyLocation: split.keyLocation,
          apiId: api.id,
          managedBy: { kind: 'api', id: api.id },
        });
        api.authentication = { type: api.authentication.type, config: { ...split.publicConfig, credentialId: row.id } };
        await this.apis.save(api);
        count.moved++;
      } catch (err: any) {
        count.failed++;
        this.logger.warn(`api ${api.id}: ${err?.message ?? err}`);
      }
    }
    return count;
  }
}
