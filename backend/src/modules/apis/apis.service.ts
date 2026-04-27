import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, DataSource } from 'typeorm';
import axios from 'axios';

import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { ApiSchema, SchemaFormat } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Tool } from '../../entities/tool.entity';
import { Organization } from '../../entities/organization.entity';

import { SchemaParserService } from '../schema-parser/schema-parser.service';
import { ToolsService } from '../tools/tools.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { validateUrl } from '../../common/security/url-validator';

export interface CreateApiData {
  name: string;
  description?: string;
  baseUrl: string;
  version?: string;
  type: ApiType;
  organizationId: string;
  headers?: Record<string, string>;
  authentication?: {
    type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
    config: Record<string, any>;
  };
  rateLimits?: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
  timeoutMs?: number;
  retryAttempts?: number;
  metadata?: Record<string, any>;
}

export interface UpdateApiData {
  name?: string;
  description?: string;
  baseUrl?: string;
  version?: string;
  headers?: Record<string, string>;
  authentication?: {
    type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
    config: Record<string, any>;
  };
  rateLimits?: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
  timeoutMs?: number;
  retryAttempts?: number;
  metadata?: Record<string, any>;
}

export interface FindApisOptions {
  type?: ApiType;
  status?: ApiStatus;
  page?: number;
  limit?: number;
}

export interface ImportSchemaOptions {
  fileName?: string;
  description?: string;
  generateTools?: boolean;
}

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
  ) {}

  async create(createApiData: CreateApiData): Promise<Api> {
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
    return this.apiRepository.findOne({
      where: { id, organizationId },
      relations: ['organization', 'schemas', 'operations', 'resources'],
    });
  }

  async findAllByOrganization(
    organizationId: string,
    options: FindApisOptions = {},
  ): Promise<{ apis: Api[]; total: number }> {
    const { type, status, page = 1, limit = 10 } = options;
    
    const where: FindOptionsWhere<Api> = { organizationId };
    
    if (type) where.type = type;
    if (status) where.status = status;

    const [apis, total] = await this.apiRepository.findAndCount({
      where,
      relations: ['schemas', 'operations', 'operations.tools'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { apis, total };
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
  ): Promise<Api> {
    const api = await this.findOne(id, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    Object.assign(api, updateApiData);
    const saved = await this.apiRepository.save(api);

    // Audit log (fire-and-forget)
    this.auditLogService.logUpdate(organizationId, undefined, AuditResource.API, saved.id, saved.name);

    return saved;
  }

  async remove(id: string, organizationId: string): Promise<void> {
    // DELETE with a org-scoped WHERE in a single statement so a
    // race between the findOne and the delete can't cause us to
    // drop a row that was just re-homed (paranoid, but cheap).
    const existing = await this.apiRepository.findOne({
      where: { id, organizationId },
    });
    if (!existing) {
      throw new NotFoundException('API not found');
    }

    const result = await this.apiRepository.delete({ id, organizationId });

    if (result.affected === 0) {
      throw new NotFoundException('API not found');
    }

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, undefined, AuditResource.API, id, existing.name);
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

  async importSchema(
    apiId: string,
    schemaContent: string,
    organizationId: string,
    options: ImportSchemaOptions = {},
  ): Promise<{ api: Api; schema: ApiSchema; operations: Operation[]; resources: Resource[]; tools?: Tool[] }> {
    const api = await this.findOne(apiId, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    // Validate schema size (max 10MB)
    const schemaSizeBytes = Buffer.byteLength(schemaContent, 'utf8');
    const maxSizeBytes = 10 * 1024 * 1024; // 10MB
    if (schemaSizeBytes > maxSizeBytes) {
      throw new BadRequestException(`Schema too large: ${(schemaSizeBytes / 1024 / 1024).toFixed(2)}MB (max ${maxSizeBytes / 1024 / 1024}MB)`);
    }

    // Use a QueryRunner transaction so all DB writes commit or roll back
    // as a unit. Without this, a failure partway through (e.g. during tool
    // generation) leaks "idle in transaction" connections and eventually
    // exhausts the pool.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Parse the schema
      const parsedSchema = await this.schemaParserService.parseApiSchema(
        schemaContent,
        api.type,
        options.fileName,
      );

      // Create API schema record
      const apiSchema = this.apiSchemaRepository.create({
        apiId,
        version: parsedSchema.version,
        rawSchema: schemaContent,
        processedSchema: parsedSchema,
        fileName: options.fileName,
        fileSize: schemaSizeBytes,
        format: this.detectSchemaFormat(api.type),
        metadata: {
          description: options.description,
          importedAt: new Date().toISOString(),
        },
      });

      const savedSchema = await queryRunner.manager.save(apiSchema);

      // Extract operations and resources in parallel for better performance
      const parser = this.schemaParserService.getParserForApiType(api.type);
      const [operations, resources] = await Promise.all([
        parser.extractOperations(parsedSchema),
        parser.extractResources(parsedSchema),
      ]);

      // Set apiId for all operations and resources
      operations.forEach(op => op.apiId = apiId);
      resources.forEach(res => res.apiId = apiId);

      // Save operations and resources in parallel
      const [savedOperations, savedResources] = await Promise.all([
        queryRunner.manager.save(operations),
        queryRunner.manager.save(resources),
      ]);

      // Update API status if it was draft
      if (api.status === ApiStatus.DRAFT) {
        await this.updateStatus(apiId, ApiStatus.ACTIVE, organizationId);
      }

      let generatedTools: Tool[] = [];

      // Generate tools if requested. Pass the just-saved operations
      // explicitly: generateToolsFromApi otherwise re-queries via
      // findOne on a connection from the default pool, which can't
      // see this transaction's uncommitted operation rows and would
      // throw 'No operations found'. Wrapping the import in a
      // transaction (commit 3a7988b) introduced this regression.
      if (options.generateTools) {
        generatedTools = await this.generateToolsFromApi(
          apiId,
          organizationId,
          savedOperations as Operation[],
        );
      }

      await queryRunner.commitTransaction();

      // Reload the API with updated relations
      const updatedApi = await this.findOne(apiId, organizationId);

      return {
        api: updatedApi!,
        schema: savedSchema,
        operations: savedOperations,
        resources: savedResources,
        tools: generatedTools.length > 0 ? generatedTools : undefined,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to import schema for API ${apiId}: ${error.message}`);
      throw new BadRequestException(`Schema import failed: ${error.message}`);
    } finally {
      await queryRunner.release();
    }
  }

  async fetchSchemaFromUrl(url: string): Promise<string> {
    // SSRF guard. Without this the user could ask the server to fetch
    // http://169.254.169.254/, http://localhost:6379/, file:///etc/passwd,
    // etc., and we'd dutifully run the request and hand back the body.
    const validation = validateUrl(url);
    if (!validation.valid) {
      throw new BadRequestException(`Refused to fetch schema URL: ${validation.error}`);
    }

    try {
      const response = await axios.get(url, {
        timeout: 30000,
        // 15 MB inbound cap. The downstream importSchema enforces a 10 MB
        // schema limit anyway; the slack here covers headers/transfer
        // overhead and lets that error surface a clearer message.
        maxContentLength: 15 * 1024 * 1024,
        maxBodyLength: 15 * 1024 * 1024,
        // Don't follow redirects — a public URL that 302s to an internal
        // host would otherwise re-introduce SSRF after the validateUrl
        // gate. Callers can still chase one-hop redirects themselves if
        // they need to.
        maxRedirects: 0,
        headers: {
          'Accept': 'application/json, application/yaml, text/yaml, text/plain, application/xml, text/xml',
        },
      });

      if (typeof response.data === 'string') {
        return response.data;
      } else if (typeof response.data === 'object') {
        return JSON.stringify(response.data);
      } else {
        return String(response.data);
      }
    } catch (error) {
      this.logger.error(`Failed to fetch schema from URL ${url}: ${error.message}`);
      throw new BadRequestException(`Failed to fetch schema from URL: ${error.message}`);
    }
  }

  /**
   * Generate tools for an API. When called inside an open transaction
   * (e.g. during importSchema), pass `preloadedOperations` so we don't
   * re-query for operations on a different connection that can't see
   * the in-flight rows.
   */
  async generateToolsFromApi(
    apiId: string,
    organizationId: string,
    preloadedOperations?: Operation[],
  ): Promise<Tool[]> {
    const api = await this.findOne(apiId, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    const operations = preloadedOperations ?? api.operations ?? [];
    if (operations.length === 0) {
      throw new BadRequestException('No operations found for this API. Import a schema first.');
    }

    this.logger.log(`[TOOL-GEN] Starting PARALLEL tool generation for API ${api.name} (${apiId})`);
    this.logger.log(`[TOOL-GEN] Found ${operations.length} operations to process`);

    let skippedInactive = 0;
    let skippedExisting = 0;
    let errorCount = 0;

    // Filter active operations first
    const activeOperations = operations.filter(op => {
      if (!op.isActive) {
        skippedInactive++;
        this.logger.log(`[TOOL-GEN] Skipping inactive operation: ${op.name}`);
        return false;
      }
      return true;
    });

    // Process operations in batches to avoid exhausting the DB connection pool.
    // The old code fired all operations in parallel (Promise.all on the full
    // array), which on a 438-operation API grabbed 438 connections simultaneously
    // and killed the DB.
    const BATCH_SIZE = 5;
    const generatedTools: Tool[] = [];

    for (let i = 0; i < activeOperations.length; i += BATCH_SIZE) {
      const batch = activeOperations.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (operation) => {
          const toolName = this.generateSemanticToolName(api.name, operation);
          const toolDescription = operation.description || `${(operation.method || 'GET').toUpperCase()} ${operation.endpoint || ''} operation`;

          const existingTool = await this.toolsService.findByName(toolName, api.organizationId);

          try {
            if (existingTool) {
              return await this.toolsService.updateFromOperation(existingTool.id, operation, {
                name: toolName,
                description: toolDescription,
                organizationId: api.organizationId,
              });
            } else {
              return await this.toolsService.createFromOperation(operation, {
                name: toolName,
                description: toolDescription,
                organizationId: api.organizationId,
              });
            }
          } catch (error) {
            errorCount++;
            this.logger.error(`[TOOL-GEN] Failed: ${operation.name}: ${error.message}`);
            return null;
          }
        }),
      );
      generatedTools.push(...batchResults.filter(Boolean) as Tool[]);
    }

    this.logger.log(`[TOOL-GEN] Parallel tool generation complete for API ${api.name}:`);
    this.logger.log(`[TOOL-GEN]   - Total operations: ${operations.length}`);
    this.logger.log(`[TOOL-GEN]   - Tools generated: ${generatedTools.length}`);
    this.logger.log(`[TOOL-GEN]   - Skipped (inactive): ${skippedInactive}`);
    this.logger.log(`[TOOL-GEN]   - Skipped (existing): ${skippedExisting}`);
    this.logger.log(`[TOOL-GEN]   - Errors: ${errorCount}`);

    return generatedTools;
  }

  /**
   * Verify the api belongs to the requesting organization before
   * returning any child rows. The operation/resource/schema tables
   * don't carry an organizationId column of their own — they're
   * tenant-scoped transitively through `apiId` → `api.organizationId`
   * — so we have to look the api up first and refuse if it doesn't
   * belong to the caller.
   */
  private async assertApiInOrganization(
    apiId: string,
    organizationId: string,
  ): Promise<void> {
    const found = await this.apiRepository.findOne({
      where: { id: apiId, organizationId },
      select: ['id'],
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
        this.applyAuthentication(config, api.authentication);
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

  private generateSemanticToolName(apiName: string, operation: any): string {
    // Prefer operationId if available (e.g., "getStatusCodes" from OpenAPI spec)
    let name = operation.operationId || '';

    if (!name && operation.endpoint) {
      // Build from method + endpoint: "get_status_codes"
      const method = (operation.method || 'get').toLowerCase();
      const pathParts = operation.endpoint
        .split('/')
        .filter((p: string) => p && !p.startsWith('{'))
        .map((p: string) => p.replace(/[^a-zA-Z0-9]/g, ''));

      if (pathParts.length > 0) {
        name = `${method}_${pathParts.join('_')}`;
      }
    }

    if (!name) {
      // Fallback: use operation name but truncate aggressively
      name = (operation.name || 'unnamed').substring(0, 30);
    }

    // Clean: camelCase to snake_case, remove special chars
    const prefix = apiName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
    name = name
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase();

    const fullName = `${prefix}_${name}`;

    // Truncate to 60 chars max
    if (fullName.length > 60) {
      return fullName.substring(0, 60).replace(/_[^_]*$/, '');
    }
    return fullName;
  }

  private applyAuthentication(config: any, authConfig: any): void {
    config.headers = config.headers || {};

    switch (authConfig.type) {
      case 'bearer':
        config.headers.Authorization = `Bearer ${authConfig.config.token}`;
        break;
      
      case 'basic':
        const credentials = Buffer.from(`${authConfig.config.username}:${authConfig.config.password}`).toString('base64');
        config.headers.Authorization = `Basic ${credentials}`;
        break;
      
      case 'api_key':
        if (authConfig.config.location === 'header') {
          config.headers[authConfig.config.name] = authConfig.config.value;
        } else if (authConfig.config.location === 'query') {
          config.params = config.params || {};
          config.params[authConfig.config.name] = authConfig.config.value;
        }
        break;
      
      case 'oauth2':
        if (authConfig.config.accessToken) {
          config.headers.Authorization = `Bearer ${authConfig.config.accessToken}`;
        }
        break;
    }
  }

  private detectSchemaFormat(apiType: ApiType): SchemaFormat {
    switch (apiType) {
      case ApiType.OPENAPI:
        return SchemaFormat.JSON;
      case ApiType.GRAPHQL:
        return SchemaFormat.SDL;
      case ApiType.SOAP:
        return SchemaFormat.XML;
      case ApiType.GRPC:
        return SchemaFormat.PROTOBUF;
      default:
        return SchemaFormat.JSON;
    }
  }
}