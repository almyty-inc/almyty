import { Injectable, Logger, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

import { Api, ApiType } from '../../entities/api.entity';
import { DependencyManagerService } from '../tools/node-sandbox/dependency-manager.service';
import { SdkIntrospectorService } from '../tools/node-sandbox/sdk-introspector.service';
import type { NpmRegistryConfig } from '../tools/node-sandbox/types';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';
import { connectionSecretOf } from '../credentials/inline-api-auth.helper';
import { userPrincipal } from '../../common/authorization/execution-access.service';
import { countCallables, SdkPackageMap, toSdkPackageMap } from './sdk-package-map';

/** BullMQ job name on the `schema-import` queue. */
export const SDK_ANALYSIS_JOB = 'analyse-sdk';

export interface SdkAnalysisJob {
  apiId: string;
  organizationId: string;
}

/**
 * Where an SDK API's analysis stands, kept on `api.metadata.sdkAnalysis`
 * so the API page can show it without a job id and it survives a Redis
 * restart. Why the last run failed is `api.lastImportError`, the column a
 * failed schema import writes too.
 */
export interface SdkAnalysisState {
  state: 'analysing' | 'ready' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  packages?: Array<{ name: string; version: string; exports: number; callables: number }>;
}

/**
 * Analyses an SDK API: installs its npm packages into the sandbox's
 * dependency cache and reads each package's type declarations into
 * `api.sdkMaps`, the map the Create tool form builds SDK tools from.
 *
 * Declarations only (see SdkIntrospectorService): the package's code is
 * installed, never loaded, in the backend process.
 */
@Injectable()
export class ApisSdkAnalysisHelper {
  private readonly logger = new Logger(ApisSdkAnalysisHelper.name);

  constructor(
    @InjectRepository(Api)
    private readonly apiRepository: Repository<Api>,
    private readonly dependencyManager: DependencyManagerService,
    private readonly introspector: SdkIntrospectorService,
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
  ) {}

  /** Mark the API as being analysed (called when the job is queued). */
  async markQueued(apiId: string, organizationId: string): Promise<void> {
    const api = await this.apiRepository.findOne({ where: { id: apiId, organizationId } });
    if (!api) return;
    api.metadata = { ...(api.metadata ?? {}), sdkAnalysis: { state: 'analysing', startedAt: new Date().toISOString() } };
    api.lastImportError = null;
    api.lastImportFailedAt = null;
    await this.apiRepository.save(api);
  }

  async analyse(
    apiId: string,
    organizationId: string,
    onProgress?: (pct: number) => void | Promise<void>,
  ): Promise<SdkAnalysisState> {
    const api = await this.apiRepository.findOne({ where: { id: apiId, organizationId } });
    if (!api) throw new NotFoundException(`API ${apiId} not found in organization ${organizationId}`);
    if (api.type !== ApiType.SDK) throw new BadRequestException(`${api.name} is not an SDK API`);
    const dependencies = api.dependencies ?? {};
    const names = Object.keys(dependencies);
    if (names.length === 0) throw new BadRequestException(`${api.name} lists no npm packages`);

    const startedAt = new Date().toISOString();
    try {
      await onProgress?.(10);
      const registry = await this.registryFor(api);
      const { installDir } = await this.dependencyManager.ensureInstalled(dependencies, registry);
      await onProgress?.(60);

      const sdkMaps: Record<string, SdkPackageMap> = {};
      const packages: NonNullable<SdkAnalysisState['packages']> = [];
      for (const name of names) {
        const version = this.installedVersion(installDir, name) ?? dependencies[name];
        const map = toSdkPackageMap(name, version, this.introspector.introspect(name, installDir));
        sdkMaps[name] = map;
        packages.push({ name, version, exports: map.exports.length, callables: countCallables(map) });
      }

      // A package with no type declarations reads as empty: say so rather
      // than leave the Create tool form showing nothing and no reason.
      const empty = packages.filter((p) => p.exports === 0).map((p) => p.name);
      const state: SdkAnalysisState = { state: 'ready', startedAt, finishedAt: new Date().toISOString(), packages };
      api.sdkMaps = sdkMaps;
      api.metadata = { ...(api.metadata ?? {}), sdkAnalysis: state };
      api.lastImportError = empty.length
        ? `No type declarations found for ${empty.join(', ')}: add its @types package to the API, or pick a package that ships .d.ts files.`
        : null;
      api.lastImportFailedAt = empty.length ? new Date() : null;
      await this.apiRepository.save(api);
      await onProgress?.(100);
      return state;
    } catch (error: any) {
      const message = (error?.message || 'The packages could not be analysed').slice(0, 4000);
      this.logger.warn(`SDK analysis failed for API ${apiId}: ${message}`);
      const state: SdkAnalysisState = { state: 'failed', startedAt, finishedAt: new Date().toISOString() };
      await this.apiRepository
        .update(
          { id: apiId, organizationId },
          { metadata: { ...(api.metadata ?? {}), sdkAnalysis: { ...state } } as Record<string, any>, lastImportError: message, lastImportFailedAt: new Date() },
        )
        .catch(() => undefined);
      throw error;
    }
  }

  private installedVersion(installDir: string, name: string): string | null {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'node_modules', name, 'package.json'), 'utf-8'));
      return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      return null;
    }
  }

  /** The API's private registry, its token resolved from the credential it points at. */
  private async registryFor(api: Api): Promise<NpmRegistryConfig | undefined> {
    const registry = api.npmRegistry as Record<string, any> | null;
    if (!registry?.url) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { credentialId, token: _token, authToken: _authToken, ...rest } = registry;
    if (!credentialId || !this.credentialRefs) return rest as NpmRegistryConfig;
    const resolved = await this.credentialRefs.resolve(api.organizationId, credentialId, {
      principal: userPrincipal(api.ownerUserId),
      context: { purpose: 'npm_registry', resourceType: 'api', resourceId: api.id },
    });
    const secret = connectionSecretOf(resolved.config);
    return { ...(rest as NpmRegistryConfig), ...(secret ? { authToken: secret } : {}) };
  }
}
