import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';

import { Api } from '../../entities/api.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';
import { connectionSecretOf } from '../credentials/inline-api-auth.helper';
import { ApisService } from './apis.service';

export type ApiKeyType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
const KEY_TYPES: ApiKeyType[] = ['none', 'api_key', 'bearer', 'basic', 'oauth2'];

/** What the API page's Key card shows. Never a secret, not even masked. */
export interface ApiKeyView {
  type: ApiKeyType;
  /** api_key: where the key goes. */
  headerName: string | null;
  location: 'header' | 'query' | null;
  /** oauth2: what the spec declared, so signing in needs only a client id and secret. */
  oauth2: { flow: string | null; authorizationUrl: string | null; tokenUrl: string | null; scopes: string[] } | null;
  /** Where the secret in use comes from; null when calls go out without one. */
  source: 'key' | 'oauth' | 'connection' | null;
  credential: { id: string; name: string; type: string; lastUsedAt: Date | null; updatedAt: Date | null } | null;
  connection: { id: string; name: string; accountLabel: string | null; connectorKey: string | null } | null;
}

export interface SetApiKeyInput {
  /** How the key is sent. Defaults to what the API already says (detected from its description). */
  type?: ApiKeyType;
  /** The key or token. For basic auth, the password. */
  key?: string;
  username?: string;
  headerName?: string;
  location?: 'header' | 'query';
  /** Use an existing connection instead of pasting a key. */
  connectionId?: string;
}

/** Public config fields that describe how the key is sent; everything else on api.authentication.config is dropped on a key write. */
const PUBLIC_KEYS = ['headerName', 'location', 'authUrl', 'tokenUrl', 'scopes', 'flow'];

/**
 * An API's key: the one secret its tools send upstream.
 *
 * The API page used to show this twice -- an "Authentication" card that
 * wrote `api.authentication` (moved into a managed Credential on save) and
 * an "Upstream credentials" card that added more Credential rows for the
 * same API -- and the tool executor quietly used whichever row was newest.
 * Both cards were the same thing. This is the one: the Credential the
 * executor uses (ToolAuthService), or a connection the API points at.
 *
 * Secrets never live anywhere but `credentials` (docs/connections.md).
 */
@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(Credential)
    private readonly credentials: Repository<Credential>,
    private readonly apis: ApisService,
    private readonly credentialRefs: CredentialRefResolver,
  ) {}

  async get(apiId: string, organizationId: string, caller: { id: string }): Promise<ApiKeyView> {
    const api = await this.load(apiId, organizationId, caller);
    return this.view(api);
  }

  async set(apiId: string, organizationId: string, userId: string, input: SetApiKeyInput): Promise<ApiKeyView> {
    const api = await this.load(apiId, organizationId, { id: userId });
    const current = api.authentication ?? { type: 'none' as const, config: {} };
    const type = (input.type ?? current.type ?? 'none') as ApiKeyType;
    if (!KEY_TYPES.includes(type)) throw new BadRequestException('Unknown sign-in type.');

    const publicConfig: Record<string, any> = {};
    for (const k of PUBLIC_KEYS) if (current.config?.[k] !== undefined) publicConfig[k] = current.config[k];
    if (type === 'api_key') {
      const headerName = (input.headerName ?? publicConfig.headerName ?? current.config?.name ?? current.config?.parameter ?? 'X-API-Key').trim();
      if (!headerName) throw new BadRequestException('Say which header the key goes in.');
      publicConfig.headerName = headerName;
      publicConfig.location = input.location ?? publicConfig.location ?? 'header';
    } else {
      delete publicConfig.headerName;
      delete publicConfig.location;
    }

    const key = typeof input.key === 'string' ? input.key.trim() : '';

    if (input.connectionId) {
      if (type === 'none') throw new BadRequestException('Choose how the key is sent first.');
      // Resolved as the person choosing it: a connection they may not use
      // is not one they can attach, and one without a key is refused here
      // rather than at the first tool call.
      const resolved = await this.credentialRefs.resolve(organizationId, input.connectionId, {
        principal: { id: userId },
        context: { purpose: 'api_call', resourceType: 'api', resourceId: api.id },
      });
      if (!connectionSecretOf(resolved.config)) {
        throw new BadRequestException("This account has no key almyty can send. Paste a key instead.");
      }
      const previous = current.config?.credentialId as string | undefined;
      await this.apis.update(apiId, { authentication: { type, config: { ...publicConfig, connectionId: input.connectionId } } }, organizationId, userId);
      await this.credentialRefs.releaseManaged(organizationId, previous, { kind: 'api', id: api.id });
      return this.get(apiId, organizationId, { id: userId });
    }

    if (key) {
      if (type === 'none') throw new BadRequestException('Choose how the key is sent first.');
      if (type === 'basic' && !input.username?.trim()) throw new BadRequestException('Enter the username too.');
      const secret: Record<string, string> =
        type === 'api_key' ? { apiKey: key }
        : type === 'bearer' ? { token: key }
        : type === 'basic' ? { username: input.username!.trim(), password: key }
        : { accessToken: key };
      // Keep the managed row's reference so ApisService rotates it in place.
      const credentialId = current.config?.connectionId ? undefined : current.config?.credentialId;
      const saved = await this.apis.update(
        apiId,
        { authentication: { type, config: { ...publicConfig, ...(credentialId ? { credentialId } : {}), ...secret } } },
        organizationId,
        userId,
      );
      // One key per API: any other row the executor could pick instead
      // (an older "upstream credential", a previous sign-in) stops being used.
      const inUse = saved.authentication?.config?.credentialId as string | undefined;
      if (inUse) {
        await this.credentials.update({ apiId: api.id, organizationId, isActive: true, id: Not(inUse) }, { isActive: false });
      }
      return this.get(apiId, organizationId, { id: userId });
    }

    // No new secret: only how it is sent changed (header name, location, type).
    const keep: Record<string, any> = {};
    if (current.config?.credentialId && current.type === type) keep.credentialId = current.config.credentialId;
    if (current.config?.connectionId) keep.connectionId = current.config.connectionId;
    await this.apis.update(apiId, { authentication: { type, config: { ...publicConfig, ...keep } } }, organizationId, userId);
    if (type === 'api_key') {
      await this.credentials.update(
        { apiId: api.id, organizationId, isActive: true, type: CredentialType.API_KEY },
        { keyName: publicConfig.headerName, keyLocation: publicConfig.location },
      );
    }
    return this.get(apiId, organizationId, { id: userId });
  }

  /** Stop sending a key. How it would be sent stays, so adding one back is one paste. */
  async remove(apiId: string, organizationId: string, userId: string): Promise<ApiKeyView> {
    const api = await this.load(apiId, organizationId, { id: userId });
    const current = api.authentication ?? { type: 'none' as const, config: {} };
    const publicConfig: Record<string, any> = {};
    for (const k of PUBLIC_KEYS) if (current.config?.[k] !== undefined) publicConfig[k] = current.config[k];
    await this.apis.update(apiId, { authentication: { type: current.type, config: publicConfig } }, organizationId, userId);
    await this.credentialRefs.releaseManaged(organizationId, current.config?.credentialId, { kind: 'api', id: api.id });
    await this.credentials.update({ apiId: api.id, organizationId, isActive: true }, { isActive: false });
    return this.get(apiId, organizationId, { id: userId });
  }

  private async load(apiId: string, organizationId: string, caller: { id: string }): Promise<Api> {
    const api = await this.apis.findOne(apiId, organizationId, caller);
    if (!api) throw new NotFoundException('API not found');
    return api;
  }

  private async view(api: Api): Promise<ApiKeyView> {
    const auth = api.authentication ?? { type: 'none' as const, config: {} };
    const config = auth.config ?? {};
    const type = (auth.type ?? 'none') as ApiKeyType;
    const base = {
      type,
      headerName: type === 'api_key' ? (config.headerName ?? config.name ?? config.parameter ?? null) : null,
      location: type === 'api_key' ? (config.location ?? 'header') : null,
      oauth2:
        type === 'oauth2'
          ? { flow: config.flow ?? null, authorizationUrl: config.authUrl ?? null, tokenUrl: config.tokenUrl ?? null, scopes: Array.isArray(config.scopes) ? config.scopes : [] }
          : null,
    };

    if (config.connectionId) {
      const row = await this.credentials.findOne({ where: { id: config.connectionId, organizationId: api.organizationId } });
      return {
        ...base,
        source: row ? 'connection' : null,
        credential: null,
        connection: row ? { id: row.id, name: row.name, accountLabel: row.accountLabel ?? null, connectorKey: row.connectorKey ?? null } : null,
      };
    }

    // The row the executor sends: ToolAuthService picks the newest active one.
    const inUse = await this.credentials.findOne({
      where: { apiId: api.id, organizationId: api.organizationId, isActive: true },
      order: { createdAt: 'DESC' },
    });
    if (!inUse) return { ...base, source: null, credential: null, connection: null };
    const managed = CredentialRefResolver.isManagedBy(inUse, { kind: 'api', id: api.id });
    return {
      ...base,
      source: !managed && inUse.type === CredentialType.OAUTH2 ? 'oauth' : 'key',
      credential: { id: inUse.id, name: inUse.name, type: inUse.type, lastUsedAt: inUse.lastUsedAt ?? null, updatedAt: (inUse as any).updatedAt ?? null },
      connection: null,
    };
  }
}
