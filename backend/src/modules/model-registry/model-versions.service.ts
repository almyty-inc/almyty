import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { ModelVersion, ModelLineage } from '../../entities/model-version.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { InvalidRegistryUriError, parseRegistryUri } from './registry-uri';
import { ModelRegistryService } from './model-registry.service';
import type { ModelManifest } from './manifest';

export interface RegisterVersionInput {
  name: string;
  registryUri: string;
  /** Required when the URI carries no almyty manifest (most hf:// repos). */
  base?: string;
  quantizations?: string[];
  lineage?: ModelLineage | null;
  metadata?: Record<string, any> | null;
}

/** What the API shows about a manifest without shipping the whole file list every time. */
export interface ManifestSummary {
  license: string;
  tokenizer: string;
  created: string;
  fileCount: number;
  chatTemplate?: string;
}

const TERMINAL = ['torn_down'];

/**
 * A version is a pinned pointer to weights. Registering it reads the
 * manifest where one must exist (our own s3:// registry) and records
 * what it can where one is optional (hf:// repos, file:// paths on a host
 * we cannot see); the adapters do the rest at deploy time.
 */
@Injectable()
export class ModelVersionsService {
  private readonly logger = new Logger(ModelVersionsService.name);

  constructor(
    @InjectRepository(ModelVersion) private readonly versions: Repository<ModelVersion>,
    @InjectRepository(ModelDeployment) private readonly deployments: Repository<ModelDeployment>,
    private readonly registry: ModelRegistryService,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  list(organizationId: string): Promise<ModelVersion[]> {
    return this.versions.find({ where: { organizationId }, order: { createdAt: 'DESC' } });
  }

  async get(organizationId: string, id: string): Promise<ModelVersion> {
    const row = await this.versions.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Model version not found');
    return row;
  }

  async register(organizationId: string, input: RegisterVersionInput, userId?: string): Promise<ModelVersion> {
    let parsed;
    try {
      parsed = parseRegistryUri(input.registryUri);
    } catch (err) {
      if (err instanceof InvalidRegistryUriError) throw new BadRequestException({ code: 'REGISTRY_URI_INVALID', message: err.message });
      throw err;
    }
    const duplicate = await this.versions.findOne({ where: { organizationId, registryUri: input.registryUri } });
    if (duplicate) throw new ConflictException({ code: 'VERSION_EXISTS', message: `This registry URI is already registered as ${duplicate.name} (${duplicate.id})` });

    let manifest: ModelManifest | null = null;
    let manifestSha: string | null = null;
    let sizeBytes: number | null = null;
    try {
      const described = await this.registry.describeVersion(input.registryUri);
      manifest = described.manifest;
      manifestSha = described.manifestSha;
      sizeBytes = described.sizeBytes;
    } catch (err: any) {
      // Our own registry must carry a manifest; elsewhere it is a bonus.
      if (parsed.scheme === 's3') {
        throw new BadRequestException({ code: err?.code ?? 'REGISTRY_MANIFEST_UNREADABLE', message: `Cannot read the manifest at ${input.registryUri}: ${err?.message ?? err}` });
      }
      this.logger.debug(`no manifest at ${input.registryUri}: ${err?.message ?? err}`);
    }
    const base = manifest?.base ?? input.base;
    if (!base) throw new BadRequestException({ code: 'VERSION_BASE_REQUIRED', message: 'base is required when the registry URI carries no almyty manifest' });

    const row = this.versions.create({
      organizationId,
      name: input.name,
      registryUri: input.registryUri,
      base,
      sizeBytes: sizeBytes != null ? String(sizeBytes) : null,
      quantizations: input.quantizations ?? manifest?.quantizations ?? [],
      lineage: input.lineage ?? manifest?.lineage ?? null,
      evalScores: null,
      manifestSha,
      metadata: {
        ...(input.metadata ?? {}),
        scheme: parsed.scheme,
        manifest: manifest ? summarize(manifest) : null,
      },
    });
    const saved = await this.versions.save(row);
    this.audit(saved, AuditAction.CREATE, userId, { registryUri: saved.registryUri, hasManifest: Boolean(manifest) });
    return saved;
  }

  /** Deployments that still exist on a provider keep the version alive. */
  async remove(organizationId: string, id: string, userId?: string): Promise<void> {
    const row = await this.get(organizationId, id);
    const live = await this.deployments.count({ where: { modelVersionId: id, organizationId, state: Not(In(TERMINAL)) } });
    if (live > 0) throw new ConflictException({ code: 'VERSION_IN_USE', message: `${live} deployment(s) still reference this version; tear them down first` });
    await this.versions.remove(row);
    this.audit(Object.assign(row, { id }), AuditAction.DELETE, userId, {});
  }

  private audit(row: ModelVersion, action: AuditAction, userId: string | undefined, details: Record<string, any>): void {
    if (!this.auditLog) return;
    void this.auditLog
      .log({ organizationId: row.organizationId, userId, action, resourceType: AuditResource.MODEL_VERSION, resourceId: row.id, resourceName: row.name, details })
      .catch((err) => this.logger.warn(`version audit failed: ${err?.message ?? err}`));
  }
}

export function summarize(manifest: ModelManifest): ManifestSummary {
  return {
    license: manifest.license,
    tokenizer: manifest.tokenizer,
    created: manifest.created,
    fileCount: manifest.files.length,
    ...(manifest.chatTemplate ? { chatTemplate: manifest.chatTemplate } : {}),
  };
}
