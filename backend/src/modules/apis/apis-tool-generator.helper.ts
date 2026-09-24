import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { createHash } from 'crypto';
import * as v8 from 'v8';

import { Api, ApiType } from '../../entities/api.entity';
import { SchemaFormat } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';

import { ToolsService } from '../tools/tools.service';
import {
  assertWithinPerSchemaCap,
  capGeneratedDescription,
  precheckToolQuota,
  writeToolBatch,
} from '../tools/tool-quota';
import { ApisService } from './apis.service';

/** What a generation run produced, including what it could not. */
export interface ToolGenerationResult {
  tools: Tool[];
  generated: number;
  failed: number;
  skippedInactive: number;
  skippedExisting: number;
  total: number;
}

@Injectable()
export class ApisToolGeneratorHelper {
  private readonly logger = new Logger(ApisToolGeneratorHelper.name);

  constructor(
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    private toolsService: ToolsService,
    @Inject(forwardRef(() => ApisService))
    private readonly apis: ApisService,
  ) {}

  async generateToolsFromApi(
    apiId: string,
    organizationId: string,
    preloadedOperations?: Operation[],
    onBatchProgress?: (done: number, total: number) => void | Promise<void>,
  ): Promise<ToolGenerationResult> {
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

    const activeOperations = operations.filter(op => {
      if (!op.isActive) {
        skippedInactive++;
        this.logger.log(`[TOOL-GEN] Skipping inactive operation: ${op.name}`);
        return false;
      }
      return true;
    });

    // Quota (see tools/tool-quota.ts for the reject-not-truncate policy).
    // Only operations whose tool name no live tool holds add a row; the
    // rest update in place. A deleted tool frees its name, so it neither
    // counts here nor gets "updated" below: its name gets a fresh row.
    // This check is unlocked and only refuses early, before any row is
    // built; writeToolBatch below re-checks the whole batch under the
    // organization's lock as it writes it.
    assertWithinPerSchemaCap(activeOperations.length, `API '${api.name}'`);
    const plannedNames = [
      ...new Set(activeOperations.map((op) => this.generateSemanticToolName(api.name, op))),
    ];
    const alreadyThere = plannedNames.length
      ? await this.apiRepository.manager
          .getRepository(Tool)
          .count({ where: { organizationId: api.organizationId, name: In(plannedNames), status: Not(ToolStatus.DELETED) } })
      : 0;
    await precheckToolQuota(
      this.apiRepository.manager,
      api.organizationId,
      plannedNames.length - alreadyThere,
    );

    // Build every row first. Parameter generation and $ref resolution are
    // the slow part and need no lock, so they run here, 20 operations at a
    // time; nothing is written in this loop. The writes happen once, below.
    const BATCH_SIZE = 20;
    const creates: Tool[] = [];
    const updates: Tool[] = [];

    for (let i = 0; i < activeOperations.length; i += BATCH_SIZE) {
      await this.awaitHeapHeadroom();
      const batch = activeOperations.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (operation) => {
          const options = {
            name: this.generateSemanticToolName(api.name, operation),
            description: capGeneratedDescription(
              operation.description || `${(operation.method || 'GET').toUpperCase()} ${operation.endpoint || ''} operation`,
            ),
            organizationId: api.organizationId,
          };
          try {
            const existingTool = await this.toolsService.findByName(options.name, api.organizationId);
            if (existingTool) {
              updates.push(await this.toolsService.prepareUpdateFromOperation(existingTool, operation, options));
            } else {
              creates.push(await this.toolsService.buildFromOperation(operation, options));
            }
          } catch (error) {
            errorCount++;
            this.logger.error(`[TOOL-GEN] Failed: ${operation.name}: ${error.message}`);
          }
        }),
      );
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

    // Write the batch whole, in one transaction under the organization's
    // tool-quota lock: it fits, or it is refused (ToolQuotaExceededException)
    // before any row -- new or updated -- lands. Written row by row, two
    // imports racing for the last slots both passed the precheck above and
    // the loser stopped partway with an arbitrary subset of its operations.
    const written = await writeToolBatch(
      this.apiRepository.manager,
      api.organizationId,
      { creates, updates },
      // Another writer created this name since findByName: regenerate
      // that row in place, as an existing tool would have been.
      (existing, built) => {
        existing.description = built.description;
        existing.parameters = built.parameters;
        existing.metadata = { ...existing.metadata, ...built.metadata };
        return existing;
      },
    );
    skippedExisting += written.skipped.length;

    for (let i = 0; i < written.created.length; i += BATCH_SIZE) {
      await Promise.all(
        written.created
          .slice(i, i + BATCH_SIZE)
          .map((tool) => this.toolsService.createToolVersion(tool, 'Auto-generated from API operation', 'system')),
      );
    }

    // Trim each tool's heavy JSON columns before returning them.
    // The DB row is canonical; the in-memory copy is only kept so
    // callers can count + reference Tool.id / .name / .operationId.
    // Holding 587 fully-hydrated Tool entities (each with translated
    // input + output schemas, parameters, configuration) adds tens
    // of MB of retained heap for nothing once tool gen is done.
    const generatedTools: Tool[] = [...written.updated, ...written.created];
    for (const tool of generatedTools) {
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
    }

    this.logger.log(`[TOOL-GEN] Parallel tool generation complete for API ${api.name}:`);
    this.logger.log(`[TOOL-GEN]   - Total operations: ${operations.length}`);
    this.logger.log(`[TOOL-GEN]   - Tools generated: ${generatedTools.length}`);
    this.logger.log(`[TOOL-GEN]   - Skipped (inactive): ${skippedInactive}`);
    this.logger.log(`[TOOL-GEN]   - Skipped (existing): ${skippedExisting}`);
    this.logger.log(`[TOOL-GEN]   - Errors: ${errorCount}`);

    // The counts travel with the tools. They were logged and discarded,
    // so a 600-operation import that failed on 60 of them answered with
    // 540 tools and a green "540 tools created successfully" -- the
    // failures were visible only in the server log.
    return {
      tools: generatedTools,
      generated: generatedTools.length,
      failed: errorCount,
      skippedInactive,
      skippedExisting,
      total: operations.length,
    };
  }

  logMemoryPhase(phase: string): void {
    const m = process.memoryUsage();
    const mb = (b: number) => Math.round(b / 1024 / 1024);
    this.logger.log(
      `[MEM ${phase}] heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} ` +
      `rss=${mb(m.rss)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers || 0)}`,
    );
  }

  async awaitHeapHeadroom(threshold = 0.75): Promise<void> {
    const stats = v8.getHeapStatistics();
    const ratio = stats.used_heap_size / Math.max(stats.heap_size_limit, 1);
    if (ratio < threshold) return;
    this.logger.warn(
      `[BACKPRESSURE] heap at ${(ratio * 100).toFixed(1)}% of limit — pausing 250ms`,
    );
    if (typeof (global as any).gc === 'function') (global as any).gc();
    await new Promise((r) => setTimeout(r, 250));
  }

  generateSemanticToolName(apiName: string, operation: any): string {
    let name = operation.operationId || '';

    if (!name && operation.endpoint) {
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
      name = (operation.name || 'unnamed').substring(0, 30);
    }

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
    // operation.
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

  detectSchemaFormat(apiType: ApiType): SchemaFormat {
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
