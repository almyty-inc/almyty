import { Inject, forwardRef } from '@nestjs/common';
import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, DataSource } from 'typeorm';
import axios from 'axios';
import { createHash } from 'crypto';
import * as v8 from 'v8';

import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { ApiSchema, SchemaFormat } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Tool } from '../../entities/tool.entity';
import { Organization } from '../../entities/organization.entity';

import { SchemaParserService } from '../schema-parser/schema-parser.service';
import { ToolsService } from '../tools/tools.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ApisImportHelper } from './apis-import.helper';
import { ApisToolGeneratorHelper } from './apis-tool-generator.helper';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { validateUrl } from '../../common/security/url-validator';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

import { CreateApiData, UpdateApiData, FindApisOptions, ImportSchemaOptions } from './dto/apis.dto';
export type { CreateApiData, UpdateApiData, FindApisOptions, ImportSchemaOptions };

@Injectable()
export class ApisService {
  private readonly logger = new Logger(ApisService.name);

  constructor(
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    @InjectRepository(ApiSchema)
    private apiSchemaRepository: Repository<ApiSchema>,
    @InjectRepository(Operation)
    private operationRepository: Repository<Operation>,
    @InjectRepository(Resource)
    private resourceRepository: Repository<Resource>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    private schemaParserService: SchemaParserService,
    private toolsService: ToolsService,
    private readonly auditLogService: AuditLogService,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => ApisImportHelper))
    private readonly importHelper: ApisImportHelper,
    private readonly toolGen: ApisToolGeneratorHelper,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async create(createApiData: CreateApiData, userId?: string): Promise<Api> {
    // Check if organization exists
    const organization = await this.organizationRepository.findOne({
      where: { id: createApiData.organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    // Check API limit using COUNT instead of loading all relations
    const apiCount = await this.apiRepository.count({
      where: { organizationId: createApiData.organizationId },
    });

    const maxApis = organization.settings?.maxApis;
    if (maxApis && apiCount >= maxApis) {
      throw new BadRequestException('API limit exceeded for organization');
    }

    // Check for duplicate API name in organization
    const existingApi = await this.apiRepository.findOne({
      where: {
        name: createApiData.name,
        organizationId: createApiData.organizationId,
      },
    });

    if (existingApi) {
      throw new BadRequestException('API with this name already exists in the organization');
    }

    if (userId) {
      await this.accessPolicy.assertCanScopeToTeam(
        userId,
        createApiData.organizationId,
        (createApiData as any).visibility,
        (createApiData as any).teamId,
      );
    }

    const api = this.apiRepository.create({
      ...createApiData,
      status: ApiStatus.DRAFT,
    });

    const saved = await this.apiRepository.save(api);

    // Audit log (fire-and-forget)
    this.auditLogService.logCreate(createApiData.organizationId, undefined, AuditResource.API, saved.id, saved.name, { type: saved.type });

    return saved;
  }

  /**
   * Fetch an API by id, scoped to a single organization. The
   * `organizationId` argument is REQUIRED — this used to be a
   * by-id lookup with no tenancy filter at all, which meant every
   * downstream call site (update, remove, importSchema,
   * generateToolsFromApi, testApiConnection, getApiOperations,
   * getApiResources, getApiSchemas, updateStatus, and every
   * controller route that did a findOne-then-check) was one
   * forgotten guard away from leaking cross-tenant data. The
   * controller did the org check at the HTTP layer, but any
   * internal caller (worker, cron job, new code path) was
   * implicitly trusting the id. Defence in depth now lives at
   * this layer.
   */
  async findOne(id: string, organizationId: string): Promise<Api | null> {
    // Only eager-load `operations` — that's the one relation any
    // caller actually consumes (generateToolsFromApi falls back to
    // `api.operations` when preloadedOperations isn't supplied).
    //
    // Previously this also pulled `schemas`, `resources`, and
    // `organization`. None of those are read by any caller. The
    // `schemas` relation was the killer: each row holds the full
    // raw + processed schema JSON column, so on a Stripe-class
    // import a single `findOne` deserialized ~30 MB+ of JSON into
    // a JS object graph that V8 then needed several hundred MB to
    // hold. On re-imports the existing operations + resources
    // amplified this enough to OOM the worker before tool
    // generation even started.
    return this.apiRepository.findOne({
      where: { id, organizationId },
      relations: { operations: true },
    });
  }

  async findAllByOrganization(
    caller: { id: string },
    organizationId: string,
    options: FindApisOptions = {},
  ): Promise<{ apis: Api[]; total: number }> {
    const { type, status, page = 1, limit = 10 } = options;

    const qb = this.apiRepository.createQueryBuilder('api');
    await this.accessPolicy.applyListFilter(qb, caller, organizationId, 'api');
    if (type) qb.andWhere('api.type = :type', { type });
    if (status) qb.andWhere('api.status = :status', { status });
    // Count, don't load: a Stripe-class API has hundreds of operations
    // with large JSON columns — the list only needs the number. typeorm 1.x
    // dropped loadRelationCountAndMap, so we attach the count as a correlated
    // subquery and read it back via getRawAndEntities.
    qb.addSelect(
      (sub) =>
        sub
          .select('COUNT(op.id)', 'cnt')
          .from(Operation, 'op')
          .where('op."apiId" = api.id'),
      'api_operationCount',
    );
    qb.orderBy('api.createdAt', 'DESC').skip((page - 1) * limit).take(limit);

    const total = await qb.getCount();
    const { entities, raw } = await qb.getRawAndEntities();
    entities.forEach((api, i) => {
      api.operationCount = Number(raw[i]?.api_operationCount ?? 0);
    });
    return { apis: entities, total };
  }

  async createHttpApi(data: {
    name: string;
    baseUrl: string;
    description?: string;
    headers?: Record<string, string>;
    authentication?: any;
    rateLimits?: any;
    timeoutMs?: number;
    retryAttempts?: number;
  }, organizationId: string): Promise<Api> {
    // Check if organization exists
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    // Check API limit
    const apiCount = await this.apiRepository.count({
      where: { organizationId },
    });

    const maxApis = organization.settings?.maxApis;
    if (maxApis && apiCount >= maxApis) {
      throw new BadRequestException('API limit exceeded for organization');
    }

    // Check for duplicate name
    const existingApi = await this.apiRepository.findOne({
      where: { name: data.name, organizationId },
    });

    if (existingApi) {
      throw new BadRequestException('API with this name already exists in the organization');
    }

    const api = this.apiRepository.create({
      name: data.name,
      baseUrl: data.baseUrl,
      description: data.description || null,
      type: ApiType.HTTP,
      status: ApiStatus.ACTIVE,
      organizationId,
      headers: data.headers || {},
      authentication: data.authentication || null,
      rateLimits: data.rateLimits || null,
      timeoutMs: data.timeoutMs || 30000,
      retryAttempts: data.retryAttempts || 3,
      version: '1.0.0',
    });

    const saved = await this.apiRepository.save(api);

    // Audit log (fire-and-forget)
    this.auditLogService.logCreate(organizationId, undefined, AuditResource.API, saved.id, saved.name, { type: 'http' });

    return saved;
  }

  async createSdkApi(data: {
    name: string;
    description?: string;
    dependencies: Record<string, string>;
    npmRegistry?: any;
  }, organizationId: string): Promise<Api> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } });
    if (!organization) throw new NotFoundException('Organization not found');

    const existingApi = await this.apiRepository.findOne({ where: { name: data.name, organizationId } });
    if (existingApi) throw new BadRequestException('API with this name already exists');

    if (!data.dependencies || Object.keys(data.dependencies).length === 0) {
      throw new BadRequestException('At least one npm package is required');
    }

    const api = this.apiRepository.create({
      name: data.name,
      description: data.description || null,
      type: 'sdk' as any,
      status: 'active' as any,
      baseUrl: '',
      organizationId,
      dependencies: data.dependencies,
      npmRegistry: data.npmRegistry || null,
      sdkMaps: {},
    });

    const saved = await this.apiRepository.save(api);
    this.auditLogService.logCreate(organizationId, undefined, AuditResource.API, saved.id, saved.name, { type: 'sdk', packages: Object.keys(data.dependencies) });

    return saved;
  }

  async update(
    id: string,
    updateApiData: UpdateApiData,
    organizationId: string,
    userId?: string,
  ): Promise<Api> {
    const api = await this.findOne(id, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    // Authorization: org owner/admin always, team-scoped requires team lead.
    if (userId) {
      const decision = await this.accessPolicy.canAccess({ id: userId }, api, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }
    }

    // Re-validate team scoping if it's being changed.
    if (userId && ((updateApiData as any).visibility !== undefined || (updateApiData as any).teamId !== undefined)) {
      const updateAnyEarly = updateApiData as any;
      const nextVis = updateAnyEarly.visibility ?? (api as any).visibility;
      const nextTeamId = updateAnyEarly.teamId !== undefined ? updateAnyEarly.teamId : (api as any).teamId;
      await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, nextVis, nextTeamId);
    }

    Object.assign(api, updateApiData);
    // Sanitize team-scoping after the spread so a flip back to 'org'
    // clears the dangling teamId (the DB constraint allows it but it
    // leaves a stale UUID hanging on the row otherwise).
    const updateAny = updateApiData as any;
    if (updateAny.visibility === 'org') {
      api.teamId = null;
    } else if (updateAny.visibility === 'team' && updateAny.teamId !== undefined) {
      api.teamId = updateAny.teamId;
    }
    const saved = await this.apiRepository.save(api);

    // Audit log (fire-and-forget)
    this.auditLogService.logUpdate(organizationId, userId, AuditResource.API, saved.id, saved.name);

    return saved;
  }

  async remove(id: string, organizationId: string, userId?: string): Promise<void> {
    // DELETE with a org-scoped WHERE in a single statement so a
    // race between the findOne and the delete can't cause us to
    // drop a row that was just re-homed (paranoid, but cheap).
    const existing = await this.apiRepository.findOne({
      where: { id, organizationId },
    });
    if (!existing) {
      throw new NotFoundException('API not found');
    }

    // Authorization: org owner/admin always, team-scoped requires team lead.
    if (userId) {
      const decision = await this.accessPolicy.canAccess({ id: userId }, existing, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }
    }

    const result = await this.apiRepository.delete({ id, organizationId });

    if (result.affected === 0) {
      throw new NotFoundException('API not found');
    }

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, userId, AuditResource.API, id, existing.name);
  }

  async updateStatus(
    id: string,
    status: ApiStatus,
    organizationId: string,
  ): Promise<Api> {
    const api = await this.findOne(id, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    api.status = status;
    return this.apiRepository.save(api);
  }


  /**
   * Generate tools for an API. When called inside an open transaction
   * (e.g. during importSchema), pass `preloadedOperations` so we don't
   * re-query for operations on a different connection that can't see
   * the in-flight rows.
   */
  private async assertApiInOrganization(
    apiId: string,
    organizationId: string,
  ): Promise<void> {
    const found = await this.apiRepository.findOne({
      where: { id: apiId, organizationId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('API not found');
    }
  }

  async getApiOperations(
    apiId: string,
    organizationId: string,
  ): Promise<Operation[]> {
    await this.assertApiInOrganization(apiId, organizationId);
    return this.operationRepository.find({
      where: { apiId },
      order: { createdAt: 'DESC' },
    });
  }

  async getApiResources(
    apiId: string,
    organizationId: string,
  ): Promise<Resource[]> {
    await this.assertApiInOrganization(apiId, organizationId);
    return this.resourceRepository.find({
      where: { apiId },
      order: { createdAt: 'DESC' },
    });
  }

  async getApiSchemas(
    apiId: string,
    organizationId: string,
  ): Promise<ApiSchema[]> {
    await this.assertApiInOrganization(apiId, organizationId);
    return this.apiSchemaRepository.find({
      where: { apiId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Run the parser against a stored rawSchema on demand and return
   * the parsed-form (operations, resources, metadata) without
   * persisting anything. Used by the UI's "view parsed" path so we
   * don't have to keep an 8-15 MB processedSchema column on every
   * row for a feature that's clicked maybe once per API.
   *
   * The parser used is dictated by the parent api.type, so the
   * caller can't inject a different parser by querying with a
   * mismatched expectation.
   */
  async parseSchemaOnDemand(
    apiId: string,
    schemaId: string,
    organizationId: string,
  ): Promise<any> {
    await this.assertApiInOrganization(apiId, organizationId);
    const api = await this.apiRepository.findOne({
      where: { id: apiId, organizationId },
    });
    if (!api) {
      throw new NotFoundException('API not found');
    }
    const schema = await this.apiSchemaRepository.findOne({
      where: { id: schemaId, apiId },
    });
    if (!schema) {
      throw new NotFoundException('Schema not found');
    }
    if (!schema.rawSchema) {
      throw new BadRequestException(
        'Schema row has no rawSchema content — cannot parse on demand',
      );
    }
    return this.schemaParserService.parseApiSchema(
      schema.rawSchema,
      api.type,
      schema.fileName,
    );
  }

  async testApiConnection(
    apiId: string,
    organizationId: string,
  ): Promise<{ success: boolean; statusCode?: number; responseTime?: number; error?: string }> {
    const api = await this.findOne(apiId, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    // SSRF guard. `api.baseUrl` is user-supplied at API creation /
    // update time, and testApiConnection is a privileged operation
    // — admins click "test connection" and the server makes an
    // outbound HTTP request to whatever URL was stored. Without
    // this, a user could create an API with baseUrl set to
    // http://169.254.169.254/ / http://localhost:6379/ / etc., and
    // the connectivity-check button would fetch it on their behalf.
    const validation = validateUrl(api.baseUrl);
    if (!validation.valid) {
      return {
        success: false,
        error: `Refused to connect to API base URL: ${validation.error}`,
      };
    }

    try {
      const startTime = Date.now();

      const config: any = {
        timeout: api.timeoutMs || 30000,
        validateStatus: () => true, // Accept any status code
        maxContentLength: 256 * 1024,
        maxBodyLength: 256 * 1024,
        maxRedirects: 0,
      };

      // Add authentication if configured
      if (api.authentication && api.authentication.type !== 'none') {
        this.toolGen.applyAuthentication(config, api.authentication);
      }

      // Add default headers
      if (api.headers) {
        config.headers = { ...config.headers, ...api.headers };
      }

      const response = await axios.get(api.baseUrl, config);
      const responseTime = Date.now() - startTime;

      return {
        success: response.status < 400,
        statusCode: response.status,
        responseTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Memory-aware backpressure between batches. If V8's used heap is
   * over `threshold` of the configured heap ceiling, wait briefly to
   * let GC run before producing more allocations. Cheap (one v8 stat
   * read), idempotent, safe to call from anywhere.
   *
   * Without this, a real-world OpenAPI import (Stripe-class) could
   * push past 70% heap and fail the liveness probe before the next
   * batch had a chance to free its predecessor's working set. With
   * this, the import naturally throttles when the host is under
   * pressure.
   */
  /**
   * One-line memory snapshot for import-phase diagnostics. Logs heap
   * + RSS + external in MB so we can see which phase actually moves
   * peak memory. Cheap (one v8 stat read), only logged at phase
   * boundaries (4-6 calls per import) so it doesn't pollute logs.
   *
   * Format:
   *   [MEM phase] heapUsed=NN heapTotal=NN rss=NN external=NN
   */

  // ── Delegations to ApisImportHelper ──
  importSchema(...args: Parameters<ApisImportHelper['importSchema']>) { return this.importHelper.importSchema(...args); }
  fetchSchemaFromUrl(...args: Parameters<ApisImportHelper['fetchSchemaFromUrl']>) { return this.importHelper.fetchSchemaFromUrl(...args); }
  async generateToolsFromApi(
    ...args: Parameters<ApisToolGeneratorHelper['generateToolsFromApi']>
  ): ReturnType<ApisToolGeneratorHelper['generateToolsFromApi']> {
    // Defense-in-depth: enforce the org boundary at the service layer
    // so the tenant check is preserved even when callers wire a
    // non-checking toolGen (e.g. a future helper refactor or a test
    // double). The helper also performs this lookup, but doing it
    // here means a missing org scope can never silently leak across
    // tenants if the helper changes.
    const [apiId, organizationId] = args;
    const api = await this.apiRepository.findOne({ where: { id: apiId, organizationId } });
    if (!api) {
      throw new NotFoundException('API not found');
    }
    return this.toolGen.generateToolsFromApi(...args);
  }
}