import { NotFoundException } from '@nestjs/common';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { ImportSchemaOptions } from './dto/apis.dto';
import { validateUrl } from '../../common/security/url-validator';
import { Injectable, Logger, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import axios from 'axios';
import { createHash } from 'crypto';
import * as v8 from 'v8';

import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { ApiSchema, SchemaFormat } from '../../entities/api-schema.entity';
import { Tool } from '../../entities/tool.entity';

import { SchemaParserService } from '../schema-parser/schema-parser.service';
import { ToolsService } from '../tools/tools.service';
import { ApisService } from './apis.service';

@Injectable()
export class ApisImportHelper {
  private readonly logger = new Logger(ApisImportHelper.name);

  constructor(
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    @InjectRepository(ApiSchema)
    private apiSchemaRepository: Repository<ApiSchema>,
    private schemaParserService: SchemaParserService,
    private toolsService: ToolsService,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => ApisService))
    private readonly apis: ApisService,
  ) {}

  async importSchema(
    apiId: string,
    schemaContent: string,
    organizationId: string,
    options: ImportSchemaOptions = {},
    onProgress?: (pct: number) => void | Promise<void>,
  ): Promise<{ api: Api; schema: ApiSchema; operations: Operation[]; resources: Resource[]; tools?: Tool[] }> {
    const api = await this.apis.findOne(apiId, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    // Schema size cap matches the controller's: 100 MB. Real-world
    // OpenAPIs land in the 1-30 MB range; the cap exists to refuse
    // pathological inputs, not to block legitimate big specs.
    const schemaSizeBytes = Buffer.byteLength(schemaContent, 'utf8');
    const maxSizeBytes = 100 * 1024 * 1024;
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
      this.logMemoryPhase('start');

      // Parse the schema. `let` (not const) so we can null it out
      // once extraction is done — keeping the parsed graph in scope
      // through tool generation wastes tens of MB of retained heap.
      let parsedSchema: any = await this.schemaParserService.parseApiSchema(
        schemaContent,
        api.type,
        options.fileName,
      );

      this.logMemoryPhase('after-parse');

      // Create API schema record. processedSchema is no longer
      // persisted — the parsed form is rebuilt on demand from
      // rawSchema via the on-demand parse endpoint when the UI
      // asks for it.
      const apiSchema = this.apiSchemaRepository.create({
        apiId,
        version: parsedSchema.version,
        rawSchema: schemaContent,
        fileName: options.fileName,
        fileSize: schemaSizeBytes,
        format: this.detectSchemaFormat(api.type),
        metadata: {
          description: options.description,
          importedAt: new Date().toISOString(),
        },
      });

      const savedSchema = await queryRunner.manager.save(apiSchema);

      // Once the schema row is persisted we no longer need the raw
      // text hanging off the JS entity. The DB has it; the JS heap
      // carrying it through the rest of the import is wasted. On a
      // 7 MB Stripe spec this is ~10 MB of retained heap until tool
      // gen finishes. Null it on the returned entity so it's
      // GC-eligible immediately.
      (savedSchema as any).rawSchema = '';

      // Extract operations and resources in parallel for better performance
      const parser = this.schemaParserService.getParserForApiType(api.type);
      const [operations, resources] = await Promise.all([
        parser.extractOperations(parsedSchema),
        parser.extractResources(parsedSchema),
      ]);

      // Propagate parser-detected protocol-level metadata onto the
      // api row so the executor can pick it up at run time without
      // having to re-parse. Concretely: SOAP parsers extract
      // `targetNamespace` from the WSDL and Protobuf parsers
      // extract `packageName` — both are needed when building the
      // outbound request (SOAP envelope xmlns, gRPC service
      // resolution). Without this propagation the api row stays
      // `metadata: null` and the executor falls back to ambiguous
      // defaults that the upstream server rejects.
      const parserMeta = (parsedSchema as any).metadata || {};
      const protocolFields = ['targetNamespace', 'packageName'];
      const lifted: Record<string, any> = {};
      for (const k of protocolFields) {
        if (parserMeta[k] !== undefined) lifted[k] = parserMeta[k];
      }
      // Defer this UPDATE until the same call that flips status (below).
      // Doing two separate UPDATEs of the api row — one through the
      // queryRunner and one through `updateStatus` (default pool) — caused
      // a self-deadlock: queryRunner's row lock blocked the pool's UPDATE,
      // but the queryRunner couldn't commit until the pool call returned.
      // Symptom: SOAP/gRPC imports hung past the 60s test timeout while
      // OpenAPI/GraphQL (no `lifted` keys) passed.
      const liftedMetadata = Object.keys(lifted).length > 0 ? lifted : null;

      // Drop the parser's intermediate object graph — `operations`
      // and `resources` are the only data we need from this point
      // on. Keeping `parsedSchema` in scope through tool gen wastes
      // tens of MB of retained heap on big specs.
      parsedSchema = null;

      this.logMemoryPhase(`after-extract ops=${operations.length} resources=${resources.length}`);

      // Set apiId for all operations and resources
      operations.forEach(op => op.apiId = apiId);
      resources.forEach(res => res.apiId = apiId);

      // Chunked save. A whole-array `manager.save(operations)` on a
      // 600-operation schema (Stripe / GitHub REST) holds every
      // entity + every TypeORM working object in memory at once
      // and pushed the V8 heap past 1.5GB on staging — the pod
      // OOM-killed mid-import. Save in chunks so each batch can
      // be GC'd before the next is loaded. ~50 keeps each pg
      // INSERT under the libpq parameter cap (16k params) for any
      // realistic operation row width.
      // Skip per-row version diffs during bulk import — see comment
      // on importSchema. typeorm-versions >=0.6.0's subscriber reads
      // SaveOptions.data.skipVersioning, set by the helper here.
      const SAVE_CHUNK = 50;
      const skipVer = { data: { skipVersioning: true } };

      // Re-import upsert: match incoming operations against existing
      // rows by (apiId, operationId-string) and reuse the existing
      // entity id. Without this, every re-import inserts brand-new
      // rows — orphaning every Tool/Resource/skill that pointed at
      // the old operation_id UUID. Symptom on staging: re-importing
      // the Countries GraphQL schema after the parser was upgraded
      // to capture return-type fields produced fresh operations
      // with the new field info, but the existing tools still
      // pointed at the stale rows, so SKILL.md kept emitting the
      // __typename stub.
      // Prefer the OLDEST row when duplicates already exist for the
      // same operationId (a leftover from imports that ran before
      // this upsert was added). Tools/Resources/skills created by
      // the very first import all point at the oldest UUID, so
      // updating it is what makes the new parser output reach
      // downstream consumers. The newer dupes become orphans we
      // leave in place — `onDelete: 'CASCADE'` on Tool→Operation
      // means an unconditional cleanup would risk wiping live tools
      // if any of them were ever relinked to a newer dupe.
      const existingByOpId = new Map<string, string>();
      const ops = await queryRunner.manager.find(Operation, {
        where: { apiId },
        select: { id: true, operationId: true },
        order: { createdAt: 'ASC' },
      });
      for (const op of ops) {
        if (op.operationId && !existingByOpId.has(op.operationId)) {
          existingByOpId.set(op.operationId, op.id);
        }
      }
      for (const op of operations) {
        const existing = existingByOpId.get(op.operationId);
        if (existing) (op as any).id = existing;
      }

      const savedOperations: Operation[] = [];
      for (let i = 0; i < operations.length; i += SAVE_CHUNK) {
        await this.awaitHeapHeadroom();
        const slice = operations.slice(i, i + SAVE_CHUNK);
        const saved = await queryRunner.manager.save(slice, skipVer);
        savedOperations.push(...(saved as Operation[]));
        if (onProgress) {
          try {
            await onProgress(10 + Math.floor((i / Math.max(operations.length, 1)) * 30));
          } catch { /* progress is best-effort */ }
        }
      }
      const savedResources: Resource[] = [];
      for (let i = 0; i < resources.length; i += SAVE_CHUNK) {
        await this.awaitHeapHeadroom();
        const slice = resources.slice(i, i + SAVE_CHUNK);
        const saved = await queryRunner.manager.save(slice, skipVer);
        savedResources.push(...(saved as Resource[]));
      }
      // The unparsed source arrays are no longer needed; let GC
      // reclaim the entity instances we just persisted before tool
      // generation also allocates heavily.
      operations.length = 0;
      resources.length = 0;
      this.logMemoryPhase('after-save-ops');

      // Single transactional UPDATE for status flip + parser-detected
      // metadata. Combining into one queryRunner call avoids the
      // dual-connection deadlock described above.
      const apiPatch: Partial<Api> = {};
      if (api.status === ApiStatus.DRAFT) {
        apiPatch.status = ApiStatus.ACTIVE;
      }
      if (liftedMetadata) {
        apiPatch.metadata = { ...((api.metadata as any) || {}), ...liftedMetadata };
      }
      if (Object.keys(apiPatch).length > 0) {
        await queryRunner.manager.update(Api, apiId, apiPatch);
      }

      // Commit schema + operations BEFORE generating tools.
      //
      // Tool generation calls into ToolsService, which queries
      // operations and tools through the default repository pool —
      // a different connection than this queryRunner. Inside the
      // open transaction those queries can't see the uncommitted
      // operations, so every createFromOperation throws "Operation
      // not found" and zero tools come back. Decouple: commit the
      // structural import first, then run tool generation against
      // the now-visible rows. If tool gen fails, the operations
      // are still persisted and `generateToolsFromApi(apiId)` can
      // be retried — that's the same shape the standalone endpoint
      // already provides.
      await queryRunner.commitTransaction();
      this.logMemoryPhase('after-commit');

      let generatedTools: Tool[] = [];
      if (options.generateTools) {
        try {
          generatedTools = await this.generateToolsFromApi(
            apiId,
            organizationId,
            savedOperations,
            onProgress
              ? async (done, total) => onProgress(50 + Math.floor((done / Math.max(total, 1)) * 50))
              : undefined,
          );
        } catch (toolErr: any) {
          this.logger.error(
            `Tool generation failed after schema import for API ${apiId} (operations are committed; retry via /apis/${apiId}/generate-tools): ${toolErr.message}`,
          );
          // Re-throw so the caller knows tool gen didn't run.
          throw toolErr;
        }
      }

      this.logMemoryPhase(`after-tool-gen tools=${generatedTools.length}`);

      // Tool gen has consumed the per-operation JSON metadata
      // (parameters / responses / schema) — they're no longer
      // needed by any caller of importSchema (the processor uses
      // counts; the controller returns a 202 with just a job id).
      // Null them on the in-memory entities so the GC can reclaim
      // the per-row JSON object graphs while we still hold the
      // arrays for the return contract.
      for (const op of savedOperations) {
        (op as any).parameters = null;
        (op as any).responses = null;
        (op as any).metadata = null;
      }
      for (const res of savedResources) {
        (res as any).schema = null;
        (res as any).properties = null;
        (res as any).examples = null;
        (res as any).validationRules = null;
      }
      this.logMemoryPhase('after-trim-rows');

      // Lightweight reload — operations/resources/tools are returned
      // alongside this api object, so callers don't need them eager-
      // loaded onto `api`. Loading the `schemas` relation here would
      // re-deserialize the entire raw + processed schema JSON column
      // (the whole imported document), and on Stripe-class specs
      // this duplicated graph blew the worker heap.
      const updatedApi = await this.apiRepository.findOne({
        where: { id: apiId, organizationId },
      });
      this.logMemoryPhase('after-reload-api');

      return {
        api: updatedApi!,
        schema: savedSchema,
        operations: savedOperations,
        resources: savedResources,
        tools: generatedTools.length > 0 ? generatedTools : undefined,
      };
    } catch (error) {
      // Only roll back if we haven't already committed. Once the
      // transaction is committed, the queryRunner is in a state
      // where rollback is a no-op error; checking isTransactionActive
      // keeps the catch idempotent.
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
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
    onBatchProgress?: (done: number, total: number) => void | Promise<void>,
  ): Promise<Tool[]> {
    // When operations are supplied by the caller (e.g. inline from
    // importSchema), skip the heavy relation-loading findOne. That
    // call eager-loads `schemas` — which deserializes the entire
    // raw + processed schema JSON columns — plus operations and
    // resources we already have in memory. On a Stripe-class spec
    // the duplicated graph alone blows past a 4 GB heap before the
    // first tool is generated. Only fetch the lightweight api row
    // for name + organizationId.
    const api = preloadedOperations
      ? await this.apiRepository.findOne({ where: { id: apiId, organizationId } })
      : await this.apis.findOne(apiId, organizationId);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    const operations = preloadedOperations ?? api.operations ?? [];
    if (operations.length === 0) {
      throw new BadRequestException('No operations found for this API. Import a schema first.');
    }

    this.logger.log(`[TOOL-GEN] Starting PARALLEL tool generation for API ${api.name} (${apiId})`);
    this.logger.log(`[TOOL-GEN] Found ${operations.length} operations to process`);
    this.logMemoryPhase(`tool-gen-start ops=${operations.length}`);

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
    // Tool generation batch size — 20 in-flight saves per batch. The
    // old default of 5 was conservative for a 10-connection pool, but
    // the pool was bumped (see config/database.config.ts) and the real
    // cost is the per-tool roundtrip latency rather than connection
    // contention. 20 keeps each batch under half the pool while
    // cutting wall-time on 600-op imports from ~5 min sequential
    // batches to ~1.5 min.
    const BATCH_SIZE = 20;
    const generatedTools: Tool[] = [];

    for (let i = 0; i < activeOperations.length; i += BATCH_SIZE) {
      await this.awaitHeapHeadroom();
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
      // Trim each tool's heavy JSON columns before accumulating.
      // The DB row is canonical; the in-memory copy is only kept so
      // callers can count + reference Tool.id / .name / .operationId.
      // Holding 587 fully-hydrated Tool entities (each with translated
      // input + output schemas, parameters, configuration) adds tens
      // of MB of retained heap for nothing once tool gen is done.
      for (const tool of batchResults) {
        if (!tool) continue;
        (tool as any).parameters = null;
        (tool as any).configuration = null;
        (tool as any).httpConfig = null;
        (tool as any).graphqlConfig = null;
        (tool as any).soapConfig = null;
        (tool as any).grpcConfig = null;
        (tool as any).llmConfig = null;
        (tool as any).sdkConfig = null;
        (tool as any).metadata = null;
        (tool as any).examples = null;
        generatedTools.push(tool);
      }
      // The operations consumed by this batch won't be touched again
      // by tool gen — drop their JSON metadata now so the per-row
      // schemas can be GC'd while the next batch runs, instead of
      // waiting for the importSchema-level trim at the very end.
      for (const op of batch) {
        (op as any).parameters = null;
        (op as any).responses = null;
        (op as any).metadata = null;
      }

      // Heartbeat the host job (if any) every batch. The schema-import
      // BullMQ processor passes onBatchProgress => job.progress(); a
      // 7.7 MB Stripe spec generates 600+ tools and used to silently
      // stall its job lock during this loop, killing the import.
      if (onBatchProgress) {
        try {
          await onBatchProgress(Math.min(i + BATCH_SIZE, activeOperations.length), activeOperations.length);
        } catch {
          // progress reporting is best-effort
        }
      }
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

  private logMemoryPhase(phase: string): void {
    const m = process.memoryUsage();
    const mb = (b: number) => Math.round(b / 1024 / 1024);
    this.logger.log(
      `[MEM ${phase}] heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} ` +
      `rss=${mb(m.rss)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers || 0)}`,
    );
  }

  private async awaitHeapHeadroom(threshold = 0.75): Promise<void> {
    const stats = v8.getHeapStatistics();
    const ratio = stats.used_heap_size / Math.max(stats.heap_size_limit, 1);
    if (ratio < threshold) return;
    this.logger.warn(
      `[BACKPRESSURE] heap at ${(ratio * 100).toFixed(1)}% of limit — pausing 250ms`,
    );
    if (typeof (global as any).gc === 'function') (global as any).gc();
    await new Promise((r) => setTimeout(r, 250));
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

    // The old behavior was truncate(60) then strip the last `_word`,
    // which dropped the discriminator and silently collided distinct
    // operations onto the same tool name. A real-world Google
    // Translate proto import lost 22/38 operations to this. Replace
    // the dropped suffix with a 6-char identity hash so the result
    // stays under the 64-char ceiling and is deterministic per
    // operation. Hash key is op identity (endpoint+method+name) so
    // re-imports produce stable names.
    const MAX = 64;
    if (fullName.length <= MAX) return fullName;
    const identity = `${operation.endpoint || ''}|${(operation.method || '').toUpperCase()}|${operation.operationId || operation.name || ''}`;
    const hash = createHash('sha1').update(identity).digest('hex').slice(0, 6);
    return `${fullName.substring(0, MAX - 7)}_${hash}`;
  }

  applyAuthentication(config: any, authConfig: any): void {
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
