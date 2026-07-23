import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { McpSource, McpSourceStatus, McpSourceAuthType } from '../../entities/mcp-source.entity';
import { Tool, ToolType, ToolStatus } from '../../entities/tool.entity';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { computeToolHash } from '../../common/security/tool-integrity';
import {
  McpClientService,
  McpClientError,
  McpConnectionConfig,
  McpToolCallResult,
} from './mcp-client.service';

export interface CreateMcpSourceInput {
  name: string;
  description?: string;
  url: string;
  authType?: McpSourceAuthType;
  bearerToken?: string;
  headers?: Record<string, string>;
}

export interface McpSyncSummary {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

export interface McpExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** API-safe view: auth secrets never leave the service. */
export type RedactedMcpSource = Omit<McpSource, 'authConfig' | 'organization'> & {
  hasAuth: boolean;
};

@Injectable()
export class McpSourcesService {
  private readonly logger = new Logger(McpSourcesService.name);

  constructor(
    @InjectRepository(McpSource)
    private readonly sourceRepository: Repository<McpSource>,
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    private readonly mcpClient: McpClientService,
    private readonly envelopeCrypto: EnvelopeCryptoService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────

  /**
   * Register an external MCP server and run the initial discovery
   * sync. A failing initial sync does not roll back the source — it
   * is persisted with status=error so the user can fix auth/URL and
   * re-sync from the UI.
   */
  async create(
    input: CreateMcpSourceInput,
    organizationId: string,
    userId?: string,
  ): Promise<{ source: RedactedMcpSource; sync: McpSyncSummary | null; syncError: string | null }> {
    const name = (input.name ?? '').trim();
    const url = (input.url ?? '').trim();
    if (!name) throw new BadRequestException('MCP source name is required');
    if (!url) throw new BadRequestException('MCP server URL is required');

    // Fail fast on a blocked/invalid URL instead of persisting a
    // source that can never sync.
    this.mcpClient.assertUrlAllowed(url);

    const existing = await this.sourceRepository.findOne({ where: { organizationId, name } });
    if (existing) {
      throw new ConflictException(`An MCP source named '${name}' already exists in this organization`);
    }

    const authType: McpSourceAuthType = input.authType ?? (input.bearerToken ? 'bearer' : input.headers ? 'headers' : 'none');
    const source = this.sourceRepository.create({
      name,
      description: input.description?.trim() || null,
      url,
      authType,
      authConfig: await this.encryptAuthConfig(organizationId, authType, input),
      status: McpSourceStatus.ACTIVE,
      organizationId,
      createdBy: userId ?? null,
      toolCount: 0,
    });
    const saved = await this.sourceRepository.save(source);

    let sync: McpSyncSummary | null = null;
    let syncError: string | null = null;
    try {
      sync = await this.sync(saved.id, organizationId);
    } catch (err: any) {
      syncError = err?.message ?? String(err);
    }

    const fresh = await this.sourceRepository.findOne({ where: { id: saved.id, organizationId } });
    return { source: this.redact(fresh ?? saved), sync, syncError };
  }

  async findAll(organizationId: string): Promise<RedactedMcpSource[]> {
    const sources = await this.sourceRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
    return sources.map((s) => this.redact(s));
  }

  async findOne(id: string, organizationId: string): Promise<RedactedMcpSource> {
    const source = await this.getOwned(id, organizationId);
    return this.redact(source);
  }

  /**
   * Delete a source and every tool materialized from it.
   */
  async remove(id: string, organizationId: string): Promise<{ removedTools: number }> {
    const source = await this.getOwned(id, organizationId);
    const tools = await this.findMaterializedTools(source);
    if (tools.length > 0) {
      await this.toolRepository.remove(tools);
    }
    await this.sourceRepository.remove(source);
    return { removedTools: tools.length };
  }

  // ─── discovery / sync ─────────────────────────────────────────────

  /**
   * initialize + tools/list against the remote server, then reconcile
   * the materialized Tool rows: insert new, update changed, mark
   * removed remote tools inactive. Failures are recorded on the
   * source (status=error, lastError) and rethrown for the caller.
   */
  async sync(id: string, organizationId: string): Promise<McpSyncSummary> {
    const source = await this.getOwned(id, organizationId);

    try {
      const { tools: remoteTools, init } = await this.mcpClient.listTools(
        await this.connectionConfig(source),
      );

      const mine = await this.findMaterializedTools(source);
      const byRemoteName = new Map(
        mine.map((t) => [t.configuration!.mcp!.remoteName, t] as const),
      );

      let added = 0;
      let updated = 0;

      for (const remote of remoteTools) {
        const existing = byRemoteName.get(remote.name);
        if (existing) {
          existing.description = remote.description ?? existing.description;
          existing.parameters = remote.inputSchema ?? { type: 'object', properties: {} };
          existing.configuration = {
            ...(existing.configuration ?? {}),
            mcp: {
              sourceId: source.id,
              remoteName: remote.name,
              inputSchema: remote.inputSchema,
            },
          };
          existing.status = ToolStatus.ACTIVE;
          existing.definitionHash = computeToolHash(existing).hash;
          await this.toolRepository.save(existing);
          updated++;
        } else {
          const tool = this.toolRepository.create({
            name: this.toolName(source, remote.name),
            description: remote.description ?? `Tool '${remote.name}' from MCP server '${source.name}'`,
            type: ToolType.MCP,
            status: ToolStatus.ACTIVE,
            version: '1.0.0',
            organizationId: source.organizationId,
            parameters: remote.inputSchema ?? { type: 'object', properties: {} },
            configuration: {
              timeout: 30000,
              mcp: {
                sourceId: source.id,
                remoteName: remote.name,
                inputSchema: remote.inputSchema,
              },
            },
            metadata: {
              mcpSource: { id: source.id, name: source.name, url: source.url },
              autoGenerated: true,
              generatedAt: new Date(),
            },
            createdBy: source.createdBy ?? undefined,
          });
          tool.definitionHash = computeToolHash(tool).hash;
          await this.toolRepository.save(tool);
          added++;
        }
      }

      // Remote tools that disappeared: keep the row (execution history,
      // gateway associations) but mark it inactive so it stops serving.
      const remoteNames = new Set(remoteTools.map((t) => t.name));
      let removed = 0;
      for (const tool of mine) {
        if (!remoteNames.has(tool.configuration!.mcp!.remoteName) && tool.status !== ToolStatus.INACTIVE) {
          tool.status = ToolStatus.INACTIVE;
          await this.toolRepository.save(tool);
          removed++;
        }
      }

      source.status = McpSourceStatus.ACTIVE;
      source.lastSyncAt = new Date();
      source.lastError = null;
      source.toolCount = remoteTools.length;
      source.serverInfo = {
        name: init.serverInfo?.name,
        version: init.serverInfo?.version,
        protocolVersion: init.protocolVersion,
      };
      await this.sourceRepository.save(source);

      this.logger.log(
        `Synced MCP source '${source.name}' (${source.id}): +${added} ~${updated} -${removed} (${remoteTools.length} remote tools)`,
      );
      return { added, updated, removed, total: remoteTools.length };
    } catch (err: any) {
      source.status = McpSourceStatus.ERROR;
      source.lastError = err?.message ?? String(err);
      await this.sourceRepository.save(source).catch(() => undefined);
      throw err;
    }
  }

  // ─── execution bridge (called by ToolExecutorService) ─────────────

  /**
   * tools/call against the tool's source. Returns the raw MCP result;
   * content mapping to a plain tool payload happens in mapCallResult.
   * Throws McpClientError (typed) — never a bare 500-shaped error.
   */
  async executeToolCall(
    organizationId: string,
    mcpConfig: { sourceId: string; remoteName: string },
    args: Record<string, any>,
    options: McpExecuteOptions = {},
  ): Promise<{ success: boolean; data: any; error?: string }> {
    const source = await this.sourceRepository.findOne({
      where: { id: mcpConfig.sourceId, organizationId },
    });
    if (!source) {
      throw new McpClientError(
        'MCP_CONNECT_FAILED',
        `MCP source ${mcpConfig.sourceId} not found in this organization (was it deleted?)`,
      );
    }

    const result = await this.mcpClient.callTool(
      await this.connectionConfig(source, options),
      mcpConfig.remoteName,
      args ?? {},
    );
    return this.mapCallResult(result);
  }

  /**
   * Map MCP tool-result content onto the standard tool result shape:
   *   - structuredContent wins when present
   *   - a single text item is JSON-parsed when possible, else raw text
   *   - multiple items are returned as an array of content blocks
   *   - isError=true becomes success:false with a readable message
   */
  mapCallResult(result: McpToolCallResult): { success: boolean; data: any; error?: string } {
    const textOf = (items: Array<Record<string, any>>) =>
      items
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');

    if (result.isError) {
      const message = textOf(result.content) || 'MCP tool reported an error';
      return { success: false, data: result.structuredContent ?? result.content, error: message };
    }

    if (result.structuredContent !== undefined) {
      return { success: true, data: result.structuredContent };
    }

    const content = result.content ?? [];
    if (content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
      const text = content[0].text;
      try {
        return { success: true, data: JSON.parse(text) };
      } catch {
        return { success: true, data: text };
      }
    }
    return { success: true, data: content };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private async getOwned(id: string, organizationId: string): Promise<McpSource> {
    const source = await this.sourceRepository.findOne({ where: { id, organizationId } });
    if (!source) {
      throw new NotFoundException(`MCP source ${id} not found`);
    }
    return source;
  }

  /**
   * Tools materialized from this source. Tool counts per org are
   * modest, so filtering the org's MCP tools in memory beats a
   * json-path query that every unit test would have to fake.
   */
  private async findMaterializedTools(source: McpSource): Promise<Tool[]> {
    const candidates = await this.toolRepository.find({
      where: { organizationId: source.organizationId, type: ToolType.MCP },
    });
    return candidates.filter((t) => t.configuration?.mcp?.sourceId === source.id);
  }

  private async connectionConfig(source: McpSource, options: McpExecuteOptions = {}): Promise<McpConnectionConfig> {
    return {
      url: source.url,
      headers: await this.decryptAuthHeaders(source),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    };
  }

  private async encryptAuthConfig(
    organizationId: string,
    authType: McpSourceAuthType,
    input: CreateMcpSourceInput,
  ): Promise<McpSource['authConfig']> {
    if (authType === 'bearer') {
      const token = (input.bearerToken ?? '').trim();
      if (!token) throw new BadRequestException('bearerToken is required for bearer auth');
      return { bearerToken: await this.envelopeCrypto.encryptForOrg(organizationId, token) };
    }
    if (authType === 'headers') {
      const headers = input.headers ?? {};
      if (Object.keys(headers).length === 0) {
        throw new BadRequestException('headers are required for header auth');
      }
      const encrypted: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (/[\r\n]/.test(key) || /[\r\n]/.test(String(value))) {
          throw new BadRequestException('header names/values must not contain newlines');
        }
        encrypted[key] = await this.envelopeCrypto.encryptForOrg(organizationId, String(value));
      }
      return { headers: encrypted };
    }
    return null;
  }

  private async decryptAuthHeaders(source: McpSource): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    const orgId = source.organizationId;
    if (source.authType === 'bearer' && source.authConfig?.bearerToken) {
      const token = await this.envelopeCrypto.decryptForOrg(orgId, source.authConfig.bearerToken);
      headers['Authorization'] = `Bearer ${token}`;
    } else if (source.authType === 'headers' && source.authConfig?.headers) {
      for (const [key, value] of Object.entries(source.authConfig.headers)) {
        headers[key] = await this.envelopeCrypto.decryptForOrg(orgId, value);
      }
    }
    return headers;
  }

  /**
   * Namespaced local tool name: `<source-slug>_<remote-name>`,
   * restricted to [a-zA-Z0-9_-] (the MCP tool-name alphabet) and
   * capped at 128 chars.
   */
  private toolName(source: McpSource, remoteName: string): string {
    const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    const name = `${slug(source.name)}_${slug(remoteName)}`;
    return name.slice(0, 128);
  }

  private redact(source: McpSource): RedactedMcpSource {
    const { authConfig, organization, ...rest } = source as McpSource & { organization?: any };
    return { ...rest, hasAuth: source.authType !== 'none' } as RedactedMcpSource;
  }
}
