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
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { MemoryRouter } from './memory-router.service';
import { DocumentChunkerService } from './document-chunker.service';
import { ConsolidationService } from './consolidation.service';
import { MemorySyncService } from './memory-sync.service';

/**
 * Canonical memory HTTP API. Mounts under `/memory/canonical` so it
 * lives alongside the legacy `/memories` endpoints during the cutover
 * window — once consumers move over the legacy controller comes out
 * (planned in the same release branch).
 */
@Controller('memory/canonical')
@ApiTags('Memory (Canonical v1)')
@ApiBearerAuth()
// Org scope here is genuinely well defended -- ownScope/assertScope substitute
// the caller's own org by construction -- but until now nothing checked the
// caller's ROLE. With only JwtAuthGuard, a `viewer` (permissions: ['read',
// 'connections:read']) could POST config and repoint the org's memory backend,
// embedding provider and softcap behaviour, run a transfer between backends,
// or delete memory rows. Every comparable config surface -- kms.controller.ts,
// retention.controller.ts, sso-config -- is admin/owner, so config, transfer,
// sync, consolidate, delete and supersede sit there; reads and ordinary writes
// sit at member+.
//
// RolesGuard returns true when neither @Roles nor @Permissions is present, so
// the guard below does nothing on its own: the per-route decorator is the gate.
@UseGuards(JwtAuthGuard, RolesGuard)
export class CanonicalMemoryController {
  /**
   * The organization this request is allowed to touch.
   *
   * Every route here took its scope from the path or the body and never
   * compared it to the caller. With only JwtAuthGuard on the class, any
   * authenticated user on the instance could read, overwrite, delete or
   * bulk-transfer any other tenant's memory by pasting their scope_id.
   * The service layer's comment said the controller checked this. It did
   * not, so the check lives here now and the service refuses to look
   * anything up without it.
   */
  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  /** Refuse a scope that is not the caller's own. */
  private assertScope(req: any, scope: { scope_type?: string; scope_id?: string } | undefined): void {
    const organizationId = this.orgId(req);
    if (scope?.scope_id && scope.scope_id !== organizationId) {
      throw new HttpException(
        {
          success: false,
          message: 'That scope belongs to another organization',
          error: 'SCOPE_FORBIDDEN',
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * The caller's own scope, whatever they asked for.
   *
   * `scope_id` IS the organization id (see scopeToOrganizationId), and
   * every handler here used to pass the client's value straight through
   * to a service that scoped on it and nothing else. Pasting another
   * tenant's org id -- not a secret; it travels in headers, invite links
   * and gateway URLs -- read their memory, wrote rows into it, or
   * repointed their memory backend, with the audit row filed under the
   * victim's org so it did not show up in the attacker's log.
   *
   * A mismatch is refused loudly rather than quietly corrected, so a
   * confused client hears about it; the returned scope is then the
   * caller's own by construction, so a handler cannot forget.
   */
  private ownScope(
    req: any,
    scope: { scope_type?: ScopeType; scope_id?: string } | undefined,
  ): { scope_type: ScopeType; scope_id: string } {
    this.assertScope(req, scope);
    return { scope_type: (scope?.scope_type ?? 'org') as ScopeType, scope_id: this.orgId(req) };
  }

  constructor(
    private readonly service: CanonicalMemoryService,
    private readonly router: MemoryRouter,
    private readonly chunker: DocumentChunkerService,
    private readonly consolidation: ConsolidationService,
    private readonly memorySync: MemorySyncService,
  ) {}

  // ── backends list / health ────────────────────────────────────────

  @Get('backends')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List configured memory backends + capabilities' })
  async listBackends() {
    return { success: true, data: this.router.list_backends() };
  }

  @Get('backends/health')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Run a health check against every backend' })
  async healthAll() {
    return { success: true, data: await this.router.healthAll() };
  }

  // ── workspace config (per-scope routing + softcap) ────────────────

  @Get('config')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get the canonical-memory config for a scope' })
  async getConfig(
    @Query('scope_type') scopeType: ScopeType,
    @Query('scope_id') scopeId: string,
    @Request() req: any,
  ) {
    if (!scopeType || !scopeId) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'scope_type and scope_id are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const scope = this.ownScope(req, { scope_type: scopeType, scope_id: scopeId });
    const cfg = await this.service.getOrCreateConfig(scope.scope_type, scope.scope_id);
    return { success: true, data: cfg };
  }

  @Post('config')
  @Roles('admin', 'owner')
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
    const scope = this.ownScope(req, body);
    const updated = await this.service.updateConfig(
      scope.scope_type,
      scope.scope_id,
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
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Recent soft-cap warnings for a scope (audit dashboard)' })
  async listSoftcapWarnings(
    @Query('scope_type') scopeType: ScopeType,
    @Query('scope_id') scopeId: string,
    @Request() req?: any,
    @Query('limit') limitRaw?: string,
  ) {
    if (!scopeType || !scopeId) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'scope_type and scope_id are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const scope = this.ownScope(req, { scope_type: scopeType, scope_id: scopeId });
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 500);
    const rows = await this.service.listSoftcapWarnings(scope.scope_type, scope.scope_id, limit);
    return { success: true, data: rows };
  }

  // ── consolidation ─────────────────────────────────────────────────

  @Post('consolidate')
  @Roles('admin', 'owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run consolidation now for a scope (a model extracts durable facts from short-scope rows and supersedes them)',
  })
  async consolidate(
    @Body() body: { scope_type: ScopeType; scope_id: string; force?: boolean },
    @Request() req: any,
  ) {
    if (!body?.scope_type || !body?.scope_id) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'scope_type and scope_id are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await this.consolidation.run(
      this.ownScope(req, body),
      { force: !!body.force },
    );
    return { success: true, data: result };
  }

  // ── continuous sync (primary ↔ mirror) ────────────────────────────

  @Post('sync')
  @Roles('admin', 'owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconcile primary↔mirror for a scope. Last-write-wins by updated_at.',
  })
  async syncScope(
    @Body() body: { scope_type: ScopeType; scope_id: string; force?: boolean },
    @Request() req: any,
  ) {
    if (!body?.scope_type || !body?.scope_id) {
      throw new HttpException(
        { success: false, error: 'BAD_REQUEST', message: 'scope_type and scope_id are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await this.memorySync.sync(
      this.ownScope(req, body),
      { force: !!body.force },
    );
    return { success: true, data: result };
  }

  // ── transfer between backends ─────────────────────────────────────

  @Post('transfer')
  @Roles('admin', 'owner')
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
    @Request() req: any,
  ) {
    try {
      const report = await this.router.transfer(
        this.ownScope(req, body),
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
  @Roles('member', 'admin', 'owner')
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
        scope: this.ownScope(req, body),
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
  @Roles('member', 'admin', 'owner')
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
          scope: this.ownScope(req, body.scope),
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
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get a memory item by id' })
  async get(@Param('id') id: string, @Request() req: any) {
    const item = await this.service.get(id, this.orgId(req));
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
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Soft-delete a memory item (default) or hard-delete' })
  async remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' | undefined,
    @Request() req: any,
  ) {
    const ok = await this.service.delete(id, this.orgId(req), mode ?? 'soft', { user_id: req.user?.sub ?? req.user?.id });
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
  @Roles('member', 'admin', 'owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List memory items in a scope' })
  async list(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: ListMemoryDto,
    @Request() req: any,
  ) {
    const page = await this.service.list({
      scope: this.ownScope(req, body.scope),
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
  @Roles('member', 'admin', 'owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hybrid search (vector + FTS)' })
  async search(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: SearchMemoryDto,
    @Request() req: any,
  ) {
    const results = await this.service.search({
      scope: this.ownScope(req, body.scope),
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

  /**
   * `member+`, matching the write route it corrects.
   *
   * Supersession is bi-temporal: it closes `valid_until` on the old row
   * and writes a new one, so nothing is destroyed and the history stays
   * readable. It is the correction half of the write path, not a
   * destructive admin action — and gating it above `POST /` would mean
   * somebody could record a fact and then be unable to fix it, which is
   * how wrong memories become permanent.
   *
   * `consolidate` is the one that stays `admin+`: it runs a model over
   * the org's short-term rows and supersedes them in bulk, so it costs
   * money and rewrites things the caller never looked at.
   */
  @Post(':id/supersede')
  @Roles('member', 'admin', 'owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bi-temporal supersession: replace an item with a new one' })
  async supersede(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: SupersedeMemoryDto,
    @Request() req: any,
  ) {
    try {
      this.assertScope(req, body.new_item.scope);
      const result = await this.service.supersede(
        id,
        this.orgId(req),
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
