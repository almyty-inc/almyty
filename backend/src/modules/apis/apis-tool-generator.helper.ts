import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import * as v8 from 'v8';

import { Api, ApiType } from '../../entities/api.entity';
import { SchemaFormat } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Tool } from '../../entities/tool.entity';

import { ToolsService } from '../tools/tools.service';
import { ApisService } from './apis.service';

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

    const activeOperations = operations.filter(op => {
      if (!op.isActive) {
        skippedInactive++;
        this.logger.log(`[TOOL-GEN] Skipping inactive operation: ${op.name}`);
        return false;
      }
      return true;
    });

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
