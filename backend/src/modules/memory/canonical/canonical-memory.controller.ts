import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CanonicalMemoryService } from './canonical-memory.service';
import {
  ListMemoryDto,
  PutMemoryDto,
  SearchMemoryDto,
  SupersedeMemoryDto,
} from './canonical-memory.dto';
import { MemoryError, Mode, ScopeType } from './canonical.types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { MemoryRouter } from './memory-router.service';
import { DocumentChunkerService } from './document-chunker.service';

/**
 * Canonical memory HTTP API. Mounts under `/memory/canonical` so it
 * lives alongside the legacy `/memories` endpoints during the cutover
 * window — once consumers move over the legacy controller comes out
 * (planned in the same release branch).
 */
@Controller('memory/canonical')
@ApiTags('Memory (Canonical v1)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CanonicalMemoryController {
  constructor(
    private readonly service: CanonicalMemoryService,
    private readonly router: MemoryRouter,
    private readonly chunker: DocumentChunkerService,
  ) {}

  // ── backends list / health ────────────────────────────────────────

  @Get('backends')
  @ApiOperation({ summary: 'List configured memory backends + capabilities' })
  async listBackends() {
    return { success: true, data: this.router.list_backends() };
  }

  @Get('backends/health')
  @ApiOperation({ summary: 'Run a health check against every backend' })
  async healthAll() {
    return { success: true, data: await this.router.healthAll() };
  }

  // ── workspace config (per-scope routing + softcap) ────────────────

  @Get('config')
  @ApiOperation({ summary: 'Get the canonical-memory config for a scope' })
  async getConfig(
    @Query('scope_type') scopeType: ScopeType,
    @Query('scope_id') scopeId: string,
  ) {
    if (!scopeType || !scopeId) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'scope_type and scope_id are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const cfg = await this.service.getOrCreateConfig(scopeType, scopeId);
    return { success: true, data: cfg };
  }

  @Post('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update the canonical-memory config for a scope (routing, mirror, credentials, softcap behavior)',
  })
  async updateConfig(
    @Body() body: {
      scope_type: ScopeType;
      scope_id: string;
      embedding_model?: string;
      embedding_dim?: number;
      embedding_provider?: string;
      softcap_behavior?: 'reject' | 'warn_log' | 'silent';
      overrides?: Record<string, unknown>;
    },
    @Request() req: any,
  ) {
    if (!body?.scope_type || !body?.scope_id) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'scope_type and scope_id are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const updated = await this.service.updateConfig(
      body.scope_type,
      body.scope_id,
      {
        embedding_model: body.embedding_model,
        embedding_dim: body.embedding_dim,
        embedding_provider: body.embedding_provider,
        softcap_behavior: body.softcap_behavior,
        overrides: body.overrides,
      },
      { user_id: req.user?.sub ?? req.user?.id },
    );
    return { success: true, data: updated };
  }

  // ── audit: soft-cap warnings ──────────────────────────────────────

  @Get('warnings/softcap')
  @ApiOperation({ summary: 'Recent soft-cap warnings for a scope (audit dashboard)' })
  async listSoftcapWarnings(
    @Query('scope_type') scopeType: ScopeType,
    @Query('scope_id') scopeId: string,
    @Query('limit') limitRaw?: string,
  ) {
    if (!scopeType || !scopeId) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'scope_type and scope_id are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 500);
    const rows = await this.service.listSoftcapWarnings(scopeType, scopeId, limit);
    return { success: true, data: rows };
  }

  // ── transfer between backends ─────────────────────────────────────

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer memory items from one backend to another' })
  async transfer(
    @Body() body: {
      scope_type: ScopeType;
      scope_id: string;
      source: string;
      target: string;
      mode?: Mode;
      dry_run?: boolean;
    },
  ) {
    try {
      const report = await this.router.transfer(
        { scope_type: body.scope_type, scope_id: body.scope_id },
        body.source,
        body.target,
        { mode: body.mode, dry_run: body.dry_run },
      );
      return { success: true, data: report };
    } catch (err) {
      throw memoryErrorToHttp(err);
    }
  }

  // ── document import (chunker + atomic re-import) ──────────────────

  @Post('document/import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import a document source — chunks the content, dedups by checksum, atomic re-import',
  })
  async importDocument(
    @Body() body: {
      scope_type: ScopeType;
      scope_id: string;
      source_uri: string;
      content: string;
      content_format?: 'text' | 'markdown' | 'json';
      force?: boolean;
      chunk_tokens?: number;
    },
    @Request() req: any,
  ) {
    if (!body?.source_uri || !body?.content) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'source_uri and content are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const result = await this.chunker.importSource({
        scope: { scope_type: body.scope_type, scope_id: body.scope_id },
        source_uri: body.source_uri,
        content: body.content,
        content_format: body.content_format,
        force: body.force,
        chunk_tokens: body.chunk_tokens,
        provenance: {
          agent_id: null, session_id: null, collab_id: null,
          model: null, provider: null, tool_chain: ['document_import'],
          created_by: 'import', source_backend: 'almyty-native',
        },
      });
      return { success: true, data: result };
    } catch (err) {
      throw memoryErrorToHttp(err);
    }
  }

  // ── put ───────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Write a memory or document item' })
  @ApiResponse({ status: 201, description: 'Item written; embedding pending' })
  async put(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: PutMemoryDto,
    @Request() req: any,
  ) {
    try {
      const item = await this.service.put(
        {
          mode: body.mode,
          scope: body.scope,
          content: body.content,
          content_format: body.content_format,
          tags: body.tags,
          metadata: body.metadata,
          file_refs: body.file_refs,
          tier: body.tier,
          ttl_seconds: body.ttl_seconds,
          source_uri: body.source_uri,
          source_version: body.source_version,
          source_checksum: body.source_checksum,
          chunk_index: body.chunk_index,
          chunk_total: body.chunk_total,
          chunk_of: body.chunk_of,
          confidence: body.confidence,
          provenance: body.provenance,
        },
        { user_id: req.user?.sub ?? req.user?.id },
      );
      return { success: true, data: item };
    } catch (err) {
      throw memoryErrorToHttp(err);
    }
  }

  // ── get ───────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get a memory item by id' })
  async get(@Param('id') id: string) {
    const item = await this.service.get(id);
    if (!item) {
      throw new HttpException(
        { success: false, error: 'NOT_FOUND', message: `memory ${id} not found` },
        HttpStatus.NOT_FOUND,
      );
    }
    return { success: true, data: item };
  }

  // ── delete ────────────────────────────────────────────────────────

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a memory item (default) or hard-delete' })
  async remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' | undefined,
    @Request() req: any,
  ) {
    const ok = await this.service.delete(id, mode ?? 'soft', { user_id: req.user?.sub ?? req.user?.id });
    if (!ok) {
      throw new HttpException(
        { success: false, error: 'NOT_FOUND', message: `memory ${id} not found` },
        HttpStatus.NOT_FOUND,
      );
    }
    return { success: true };
  }

  // ── list ──────────────────────────────────────────────────────────

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List memory items in a scope' })
  async list(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: ListMemoryDto,
  ) {
    const page = await this.service.list({
      scope: body.scope,
      mode: body.mode,
      tier: body.tier,
      tags: body.tags,
      include_superseded: body.include_superseded,
      include_deleted: body.include_deleted,
      limit: body.limit,
      cursor: body.cursor ?? null,
    });
    return { success: true, data: page };
  }

  // ── search ────────────────────────────────────────────────────────

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hybrid search (vector + FTS)' })
  async search(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: SearchMemoryDto,
  ) {
    const results = await this.service.search({
      scope: body.scope,
      query: body.query,
      mode: body.mode,
      tier: body.tier,
      tags: body.tags,
      top_k: body.top_k,
      fts_only: body.fts_only,
    });
    return { success: true, data: results };
  }

  // ── supersede ─────────────────────────────────────────────────────

  @Post(':id/supersede')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bi-temporal supersession: replace an item with a new one' })
  async supersede(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: SupersedeMemoryDto,
    @Request() req: any,
  ) {
    try {
      const result = await this.service.supersede(
        id,
        {
          mode: body.new_item.mode,
          scope: body.new_item.scope,
          content: body.new_item.content,
          content_format: body.new_item.content_format,
          tags: body.new_item.tags,
          metadata: body.new_item.metadata,
          file_refs: body.new_item.file_refs,
          tier: body.new_item.tier,
          ttl_seconds: body.new_item.ttl_seconds,
          confidence: body.new_item.confidence,
          provenance: body.new_item.provenance,
        },
        { user_id: req.user?.sub ?? req.user?.id },
      );
      return { success: true, data: result };
    } catch (err) {
      throw memoryErrorToHttp(err);
    }
  }
}

function memoryErrorToHttp(err: unknown): HttpException {
  if (err instanceof MemoryError) {
    const tag = err.tag;
    const map: Record<string, number> = {
      not_found: HttpStatus.NOT_FOUND,
      permission_denied: HttpStatus.FORBIDDEN,
      backend_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
      validation: HttpStatus.BAD_REQUEST,
      conflict: HttpStatus.CONFLICT,
      rate_limited: HttpStatus.TOO_MANY_REQUESTS,
      unsupported_capability: HttpStatus.UNPROCESSABLE_ENTITY,
      too_large: HttpStatus.PAYLOAD_TOO_LARGE,
      looks_like_blob: HttpStatus.UNPROCESSABLE_ENTITY,
      soft_cap_exceeded: HttpStatus.OK,
      embedding_failed: HttpStatus.SERVICE_UNAVAILABLE,
      transfer_aborted: HttpStatus.SERVICE_UNAVAILABLE,
    };
    return new HttpException(
      { success: false, error: tag.kind.toUpperCase(), tag },
      map[tag.kind] ?? HttpStatus.BAD_REQUEST,
    );
  }
  if (err instanceof HttpException) return err;
  return new HttpException(
    { success: false, error: 'INTERNAL', message: (err as Error).message ?? String(err) },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
