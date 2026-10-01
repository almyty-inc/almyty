import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import { createHash } from 'crypto';

import { McpSource, McpSourceStatus, McpSourceAuthType } from '../../entities/mcp-source.entity';
import { Tool, ToolType, ToolStatus } from '../../entities/tool.entity';
import { JsonSchema, JsonSchemaType } from '../../entities/json-schema.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { McpChangeBus } from '../mcp-events/mcp-change-bus.service';
import { McpOAuthClientService } from '../connections/mcp-oauth/mcp-oauth-client.service';
import { CredentialType } from '../../entities/credential.entity';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { CredentialRefResolver, type ResolveOptions } from '../credentials/credential-ref.resolver';
import { computeToolHash } from '../../common/security/tool-integrity';
import { assertWithinPerSchemaCap, capGeneratedDescription, withToolQuota } from '../tools/tool-quota';
import {
  McpCallOptions,
  McpClientService,
  McpClientError,
  McpConnectionConfig,
  McpInitializeInfo,
  McpInputRequests,
  McpRemoteTool,
  McpToolCallResult,
  describeInputRequired,
} from './mcp-client.service';
import { mcpClientSettings } from './mcp-client-settings';

export interface CreateMcpSourceInput {
  name: string;
  description?: string;
  url: string;
  authType?: McpSourceAuthType;
  /** A pasted token; becomes a Credential row the source manages. */
  bearerToken?: string;
  /** Pasted custom headers; same, as one custom-type row. */
  headers?: Record<string, string>;
  /** An existing connection to use instead of pasting a secret. */
  credentialId?: string;
}

export interface McpSyncSummary {
  added: number;
  updated: number;
  removed: number;
  total: number;
  /** Tools the server listed that the client refused (invalid x-mcp-header), with why. */
  rejected?: Array<{ name: string; reason: string }>;
}

export interface McpExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Who the call acts as: the run's principal for a tool call, the person
   * for a sync. The source's connection is resolved as them, so a team
   * connection reaches the server only for its team.
   */
  principal?: ResolveOptions['principal'];
  /** The agent run making the call, if any. */
  runId?: string | null;
  /**
   * The caller can put a question to a person and call again (the
   * autonomous runtime, which has ask_user). Only then does the client
   * declare elicitation and keep a remote's question for the run.
   */
  canAskPerson?: boolean;
}

/** Run states after which nothing the run started should keep working. */
const ENDED_RUN_STATUSES: ReadonlySet<string> = new Set([
  AgentRunStatus.CANCELLED,
  AgentRunStatus.FAILED,
  AgentRunStatus.TIMEOUT,
  AgentRunStatus.COMPLETED,
]);

/** A remote's question kept for the agent run that asked, until the person answers. */
interface PendingRemoteInput {
  inputRequests: McpInputRequests;
  requestState?: string;
  taskId?: string;
  askedAt: string;
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
    private readonly credentialRefs: CredentialRefResolver,
    // MCP listen streams of the gateways serving these tools. Optional for
    // the positional spec harnesses.
    @Optional() private readonly changeBus?: McpChangeBus,
    // A remote's question inside an agent run: the person's answer is the
    // run's next user message, and the question waits in Redis meanwhile.
    // Without either, a remote that asks gets the "nobody can answer" error.
    @Optional() @InjectRepository(Message) private readonly messageRepository?: Repository<Message>,
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
    // A call for an agent run watches the run, to cancel a remote task when the run ends.
    @Optional() @InjectRepository(AgentRun) private readonly runRepository?: Repository<AgentRun>,
    // Signing in to OAuth-protected servers: refresh, and renew on a 401.
    @Optional() private readonly mcpOAuth?: McpOAuthClientService,
  ) {}

  /**
   * Which auth shape a new source uses: explicit, else implied by what
   * was pasted, else by the type of the connection it points at.
   */
  private async resolveAuthType(organizationId: string, input: CreateMcpSourceInput): Promise<McpSourceAuthType> {
    if (input.authType) return input.authType;
    if (input.bearerToken) return 'bearer';
    if (input.headers) return 'headers';
    if (input.credentialId) {
      const row = await this.credentialRefs.load(organizationId, input.credentialId);
      return row.type === CredentialType.CUSTOM ? 'headers' : 'bearer';
    }
    return 'none';
  }

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

    // A connection is attached only by someone who may use it: another
    // team's or another user's row is "not found" here, not at first sync.
    if (input.credentialId && userId) {
      await this.credentialRefs.resolve(organizationId, input.credentialId, {
        principal: { id: userId },
        context: { purpose: 'mcp_call', resourceType: 'mcp_source' },
      });
    }
    // An MCP source is org-wide: its tools are the organization's, and every
    // call through them resolves this connection. A team or private one would
    // fail for everyone it does not cover, so it is refused now, with who.
    if (input.credentialId) {
      const row = await this.credentialRefs.load(organizationId, input.credentialId);
      await this.credentialRefs.assertAttachable(row, { organizationId, visibility: 'org', noun: 'MCP source' }, { actorId: userId ?? null });
    }
    const authType = await this.resolveAuthType(organizationId, input);
    const source = this.sourceRepository.create({
      name,
      description: input.description?.trim() || null,
      url,
      authType,
      authConfig: null,
      credentialId: null,
      status: McpSourceStatus.ACTIVE,
      organizationId,
      createdBy: userId ?? null,
      toolCount: 0,
    });
    // Saved first so the credential row can name the source it belongs
    // to; a failure to store the secret removes the half-made source.
    let saved = await this.sourceRepository.save(source);
    try {
      await this.attachCredential(saved, authType, input);
    } catch (err) {
      await this.sourceRepository.remove(saved).catch(() => undefined);
      throw err;
    }
    if (saved.credentialId) saved = await this.sourceRepository.save(saved);

    let sync: McpSyncSummary | null = null;
    let syncError: string | null = null;
    try {
      sync = await this.sync(saved.id, organizationId, userId);
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
    // The token row this source created goes with it; a shared connection stays.
    await this.credentialRefs.releaseManaged(organizationId, source.credentialId, { kind: 'mcp_source', id: source.id });
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
  async sync(id: string, organizationId: string, userId?: string): Promise<McpSyncSummary> {
    const source = await this.getOwned(id, organizationId);

    try {
      // Discovery calls the server as the person who asked for it: a team
      // or private connection they may not use is not sent for them.
      // Through withSignIn: a source signed in with OAuth renews on a 401.
      const { tools: remoteTools, init, rejected = [] } = await this.withSignIn(
        source,
        { principal: userId ? { id: userId } : null },
        (config) => this.mcpClient.listTools(config),
      );

      const mine = await this.findMaterializedTools(source);
      const byRemoteName = new Map(
        mine.map((t) => [t.configuration!.mcp!.remoteName, t] as const),
      );

      // A remote server decides how many tools it lists; the quota and
      // the per-server cap decide how many we materialize. Checked for
      // the whole list before any row is written (reject, not truncate
      // -- see tools/tool-quota.ts). Remote tools we already hold are
      // updated in place and add no row.
      assertWithinPerSchemaCap(remoteTools.length, `MCP server '${source.name}'`);
      const newRemoteNames = new Set(
        remoteTools.map((r) => r.name).filter((name) => !byRemoteName.has(name)),
      );
      let added = 0;
      let updated = 0;

      // Check and inserts share one transaction under the organization's
      // tool-quota lock, so two syncs (or a sync and an import) cannot
      // both take the last slots.
      await withToolQuota(this.toolRepository.manager, source.organizationId, newRemoteNames.size, async (tx) => {
        const tools = tx.getRepository(Tool);
        for (const remote of remoteTools) {
          const existing = byRemoteName.get(remote.name);
          if (existing) {
            existing.description = capGeneratedDescription(remote.description ?? existing.description);
            existing.parameters = remote.inputSchema ?? { type: 'object', properties: {} };
            existing.configuration = {
              ...(existing.configuration ?? {}),
              mcp: this.remoteConfig(source, remote),
            };
            existing.metadata = this.remoteMetadata(source, remote, existing.metadata);
            await this.syncOutputSchema(tx, existing, source, remote);
            existing.status = ToolStatus.ACTIVE;
            existing.definitionHash = computeToolHash(existing).hash;
            await tools.save(existing);
            updated++;
          } else {
            const tool = tools.create({
              name: this.toolName(source, remote.name),
              description: capGeneratedDescription(remote.description ?? `Tool '${remote.name}' from MCP server '${source.name}'`),
              type: ToolType.MCP,
              status: ToolStatus.ACTIVE,
              version: '1.0.0',
              organizationId: source.organizationId,
              parameters: remote.inputSchema ?? { type: 'object', properties: {} },
              configuration: {
                timeout: 30000,
                mcp: this.remoteConfig(source, remote),
              },
              metadata: this.remoteMetadata(source, remote, {
                autoGenerated: true,
                generatedAt: new Date(),
              }),
              createdBy: source.createdBy ?? undefined,
              generated: true,
            });
            await this.syncOutputSchema(tx, tool, source, remote);
            tool.definitionHash = computeToolHash(tool).hash;
            await tools.save(tool);
            added++;
          }
        }
      });

      // Remote tools that disappeared, or that the client refused (invalid
      // x-mcp-header): keep the row (execution history, gateway
      // associations) but mark it inactive so it stops serving.
      const remoteNames = new Set(remoteTools.map((t) => t.name));
      let removed = 0;
      for (const tool of mine) {
        if (!remoteNames.has(tool.configuration!.mcp!.remoteName) && tool.status !== ToolStatus.INACTIVE) {
          tool.status = ToolStatus.INACTIVE;
          await this.toolRepository.save(tool);
          removed++;
        }
      }

      // The source's existing tools may have changed on every gateway that
      // serves them (new tools are not attached anywhere yet).
      await this.changeBus?.toolsChanged(mine.map((tool) => tool.id));

      source.status = McpSourceStatus.ACTIVE;
      source.lastSyncAt = new Date();
      source.lastError = rejected.length
        ? `${rejected.length} tool(s) left out: ${rejected.map((r) => `${r.name} (${r.reason})`).join('; ')}`.slice(0, 2000)
        : null;
      source.toolCount = remoteTools.length;
      source.serverInfo = {
        name: init.serverInfo?.name,
        version: init.serverInfo?.version,
        protocolVersion: init.protocolVersion,
        era: init.era,
      };
      await this.sourceRepository.save(source);

      this.logger.log(
        `Synced MCP source '${source.name}' (${source.id}, MCP ${init.protocolVersion}): +${added} ~${updated} -${removed} (${remoteTools.length} remote tools${rejected.length ? `, ${rejected.length} refused` : ''})`,
      );
      return { added, updated, removed, total: remoteTools.length, ...(rejected.length ? { rejected } : {}) };
    } catch (err: any) {
      source.status = McpSourceStatus.ERROR;
      source.lastError = err?.message ?? String(err);
      await this.sourceRepository.save(source).catch(() => undefined);
      throw err;
    }
  }

  /**
   * What the tool row keeps of the remote definition to call it and present
   * it: the remote name and input schema (for tools/call and its
   * Mcp-Param-* headers), and the annotations and icons the server declared
   * (tool-presentation.ts serves them to our own MCP clients, and the
   * annotations decide the tool's side-effect class there).
   */
  private remoteConfig(source: McpSource, remote: McpRemoteTool): NonNullable<Tool['configuration']>['mcp'] {
    return {
      sourceId: source.id,
      remoteName: remote.name,
      inputSchema: remote.inputSchema,
      ...(remote.annotations ? { annotations: remote.annotations } : {}),
      ...(remote.icons?.length ? { icons: remote.icons } : {}),
    };
  }

  /** The tool's metadata with the source it came from and the remote's own title. */
  private remoteMetadata(source: McpSource, remote: McpRemoteTool, base: Record<string, any> | null | undefined): Record<string, any> {
    const { title: _old, ...rest } = base ?? {};
    return {
      ...rest,
      mcpSource: { id: source.id, name: source.name, url: source.url },
      ...(remote.title ? { title: remote.title } : {}),
    };
  }

  /**
   * The remote's outputSchema, as the tool's output schema row (the same
   * relation generated API tools use, so it is declared on our gateways and
   * results are checked against it). A row this source made is updated in
   * place; one it did not make is never touched. A remote that drops its
   * outputSchema drops ours.
   */
  private async syncOutputSchema(tx: EntityManager, tool: Tool, source: McpSource, remote: McpRemoteTool): Promise<void> {
    const schemas = tx.getRepository(JsonSchema);
    const current = tool.outputSchemaId ? await schemas.findOne({ where: { id: tool.outputSchemaId } }) : null;
    const ours = !!current && current.metadata?.mcpSourceId === source.id;
    if (!remote.outputSchema) {
      if (ours) {
        tool.outputSchemaId = null as unknown as string;
        tool.outputSchema = null as unknown as JsonSchema;
        await schemas.remove(current!);
      }
      return;
    }
    if (ours) {
      current!.schema = remote.outputSchema;
      await schemas.save(current!);
      return;
    }
    const row = await schemas.save(
      schemas.create({
        name: `${this.toolName(source, remote.name)} output`.slice(0, 255),
        schema: remote.outputSchema,
        type: JsonSchemaType.OUTPUT,
        description: `Output schema of '${remote.name}' on MCP server '${source.name}'`,
        metadata: { mcpSourceId: source.id, remoteName: remote.name },
      }),
    );
    tool.outputSchemaId = row.id;
    tool.outputSchema = row;
  }

  // ─── execution bridge (called by ToolExecutorService) ─────────────

  /**
   * tools/call against the tool's source. Returns the mapped result;
   * content mapping to a plain tool payload happens in mapCallResult.
   * Throws McpClientError (typed) — never a bare 500-shaped error.
   *
   * A 2026-07-28 server may stop to ask a person something
   * (`input_required` with an elicitation, directly or inside a task):
   *
   *  - Inside an autonomous agent run (`canAskPerson`), the question is kept
   *    for the run (MCP_CLIENT_PENDING_INPUT_SECONDS) and the call answers
   *    with a tool error telling the model to put it to the person with
   *    ask_user and call again with the same arguments. That call does not
   *    go to the server until the person has answered; then it carries the
   *    answer (`inputResponses`) and the server's `requestState`, or answers
   *    the task (tasks/update), and returns what the server returns.
   *  - Anywhere else (the Test button, a gateway passing a call through, a
   *    workflow step) nobody can be asked: a tool error says what the server
   *    wanted.
   */
  async executeToolCall(
    organizationId: string,
    mcpConfig: { sourceId: string; remoteName: string; inputSchema?: Record<string, any> },
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
    const callArgs = args ?? {};
    const canAsk = !!options.runId && !!options.canAskPerson && !!this.redis;
    const key = canAsk ? this.pendingKey(options.runId as string, source.id, mcpConfig.remoteName, callArgs) : null;

    let retry: Pick<McpCallOptions, 'inputResponses' | 'requestState' | 'taskId'> = {};
    if (key) {
      const pending = await this.readPending(key);
      if (pending) {
        const answer = await this.answerSince(options.runId as string, pending.askedAt);
        if (!answer) return this.needsAnswer(mcpConfig.remoteName, pending.inputRequests);
        await this.redis!.del(key).catch(() => undefined);
        retry = {
          inputResponses: inputResponsesFrom(pending.inputRequests, answer),
          ...(pending.requestState !== undefined ? { requestState: pending.requestState } : {}),
          ...(pending.taskId ? { taskId: pending.taskId } : {}),
        };
      }
    }

    const watch = this.watchRun(options.runId, options.signal);
    let called: Awaited<ReturnType<McpClientService['callToolOutcome']>>;
    try {
      // Through withSignIn: a source signed in with OAuth renews on a 401.
      called = await this.withSignIn(source, { ...options, signal: watch.signal }, (config) =>
        this.mcpClient.callToolOutcome(
          config,
          mcpConfig.remoteName,
          callArgs,
          { tool: { inputSchema: mcpConfig.inputSchema }, canElicit: canAsk, ...retry },
        ),
      );
    } finally {
      watch.stop();
    }
    const { outcome, init } = called;
    await this.rememberEra(source, init);
    if (outcome.kind === 'result') return this.mapCallResult(outcome.result);

    const asks = Object.values(outcome.inputRequests).some((r) => r?.method === 'elicitation/create');
    if (key && asks) {
      const kept = await this.savePending(key, {
        inputRequests: outcome.inputRequests,
        ...(outcome.requestState !== undefined ? { requestState: outcome.requestState } : {}),
        ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
        askedAt: new Date().toISOString(),
      });
      if (kept) return this.needsAnswer(mcpConfig.remoteName, outcome.inputRequests);
    }
    // Nobody to ask: a task that waits for input would wait forever.
    if (outcome.taskId) {
      const taskId = outcome.taskId;
      await this.withSignIn(source, options, (config) => this.mcpClient.cancelTask(config, taskId)).catch(() => undefined);
    }
    const message = describeInputRequired(outcome.inputRequests);
    return { success: false, data: { inputRequired: questionsOf(outcome.inputRequests) }, error: message };
  }

  /**
   * A signal that also fires when the agent run making the call ends from
   * outside (cancelled, timed out): the runtime cancels runs by writing the
   * row, not by aborting a signal, so the call looks at the row every
   * MCP_CLIENT_RUN_CANCEL_CHECK_MS. A remote task followed under it is then
   * cancelled on the server (tasks/cancel), not left running.
   */
  private watchRun(runId: string | null | undefined, outer?: AbortSignal): { signal?: AbortSignal; stop: () => void } {
    if (!runId || !this.runRepository) return { signal: outer, stop: () => undefined };
    const controller = new AbortController();
    const onOuter = () => controller.abort(outer?.reason);
    outer?.addEventListener('abort', onOuter, { once: true });
    if (outer?.aborted) controller.abort(outer.reason);
    const timer = setInterval(() => {
      this.runRepository!
        .findOne({ where: { id: runId }, select: { id: true, status: true } })
        .then((run) => {
          if (!run || ENDED_RUN_STATUSES.has(run.status)) controller.abort(new Error('the agent run ended'));
        })
        .catch(() => undefined);
    }, mcpClientSettings().runCancelCheckMs);
    timer.unref?.();
    return {
      signal: controller.signal,
      stop: () => {
        clearInterval(timer);
        outer?.removeEventListener('abort', onOuter);
      },
    };
  }

  /** The tool error that sends the model to the person with the server's question. */
  private needsAnswer(remoteName: string, inputRequests: McpInputRequests): { success: boolean; data: any; error: string } {
    const questions = questionsOf(inputRequests);
    const asked = questions.map((q) => (q.url ? `${q.message} (${q.url})` : q.message)).join(' / ');
    return {
      success: false,
      data: { inputRequired: questions },
      error:
        `The MCP tool '${remoteName}' needs the person's input before it can finish: ${asked}${/[.?!]$/.test(asked) ? '' : '.'} ` +
        'Ask them with ask_user (use this question), then call this tool again with exactly the same arguments; ' +
        'their answer is passed on to the server.',
    };
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
      headers: await this.authHeaders(source, options.principal),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      // The era the last sync or call found: no probe per call. A cached era
      // that stops working is probed again by the client.
      era: source.serverInfo?.era ?? null,
      protocolVersion: source.serverInfo?.protocolVersion ?? null,
    };
  }

  /** Keep the source's era current when a call found the server changed. */
  private async rememberEra(source: McpSource, init: McpInitializeInfo): Promise<void> {
    if (source.serverInfo?.era === init.era && source.serverInfo?.protocolVersion === init.protocolVersion) return;
    source.serverInfo = { ...(source.serverInfo ?? {}), era: init.era, protocolVersion: init.protocolVersion };
    await this.sourceRepository.save(source).catch((err: any) => {
      this.logger.warn(`Could not record the MCP era of source ${source.id}: ${err?.message ?? err}`);
    });
  }

  // ─── a remote's question, inside an agent run ─────────────────────

  private pendingKey(runId: string, sourceId: string, remoteName: string, args: Record<string, any>): string {
    return `mcp:input:${runId}:${sourceId}:${createHash('sha256').update(`${remoteName}\n${stableJson(args)}`).digest('hex').slice(0, 32)}`;
  }

  private async readPending(key: string): Promise<PendingRemoteInput | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as PendingRemoteInput) : null;
    } catch {
      return null;
    }
  }

  private async savePending(key: string, pending: PendingRemoteInput): Promise<boolean> {
    if (!this.redis) return false;
    try {
      await this.redis.set(key, JSON.stringify(pending), 'EX', mcpClientSettings().pendingInputSeconds);
      return true;
    } catch (err: any) {
      this.logger.warn(`Could not keep a remote MCP question for the run: ${err?.message ?? err}`);
      return false;
    }
  }

  /** The person's answer: the run's latest user message after the question was asked. */
  private async answerSince(runId: string, since: string): Promise<string | null> {
    if (!this.messageRepository) return null;
    const latest = await this.messageRepository.findOne({
      where: { runId, role: MessageRole.USER, createdAt: MoreThan(new Date(since)) },
      order: { createdAt: 'DESC' },
    });
    if (!latest) return null;
    const text = latest.content ?? (Array.isArray(latest.contentParts)
      ? latest.contentParts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
      : '');
    return text && text.trim() ? text.trim() : null;
  }

  /**
   * One call to the source's server. A source signed in with OAuth
   * (connections/mcp-oauth) whose server answers 401 gets one retry after
   * the sign-in is renewed; when it cannot be renewed (or the server now
   * signs in elsewhere), the error says to sign in again.
   */
  private async withSignIn<T>(source: McpSource, options: McpExecuteOptions, call: (config: McpConnectionConfig) => Promise<T>): Promise<T> {
    try {
      return await call(await this.connectionConfig(source, options));
    } catch (err) {
      if (!this.mcpOAuth || !source.credentialId || !(err instanceof McpClientError) || err.data?.status !== 401) throw err;
      const renewed = await this.mcpOAuth.ensureFresh(source.organizationId, source.credentialId, { force: true });
      if (renewed.status === 'reconnect') throw new McpClientError('MCP_HTTP_ERROR', renewed.error, err.data);
      if (renewed.status !== 'refreshed') throw err;
      return call(await this.connectionConfig(source, options));
    }
  }

  /**
   * The credential a source was created with. A pasted token or header
   * map becomes a row this source manages; a credentialId points at a
   * shared connection (its type decides the auth shape).
   */
  private async attachCredential(source: McpSource, authType: McpSourceAuthType, input: CreateMcpSourceInput): Promise<void> {
    const managedBy = { kind: 'mcp_source' as const, id: source.id };
    if (input.credentialId) {
      const row = await this.credentialRefs.load(source.organizationId, input.credentialId);
      source.credentialId = row.id;
      return;
    }
    if (authType === 'bearer') {
      const token = (input.bearerToken ?? '').trim();
      if (!token) throw new BadRequestException('bearerToken is required for bearer auth');
      const row = await this.credentialRefs.createManaged(source.organizationId, {
        name: `${source.name} MCP token`,
        description: `Bearer token for the MCP server "${source.name}"`,
        type: CredentialType.BEARER_TOKEN,
        config: { token },
        connectorKey: null,
        managedBy,
      });
      source.credentialId = row.id;
      return;
    }
    if (authType === 'headers') {
      const headers = input.headers ?? {};
      if (Object.keys(headers).length === 0) {
        throw new BadRequestException('headers are required for header auth');
      }
      for (const [key, value] of Object.entries(headers)) {
        if (/[\r\n]/.test(key) || /[\r\n]/.test(String(value))) {
          throw new BadRequestException('header names/values must not contain newlines');
        }
      }
      const row = await this.credentialRefs.createManaged(source.organizationId, {
        name: `${source.name} MCP headers`,
        description: `Auth headers for the MCP server "${source.name}"`,
        type: CredentialType.CUSTOM,
        config: { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])) },
        secretKeys: ['headers'],
        connectorKey: null,
        managedBy,
      });
      source.credentialId = row.id;
    }
  }

  /**
   * Auth headers for a call. The credential reference is the source of
   * truth; `authConfig` is the read-through shim for rows the startup
   * backfill has not moved yet.
   */
  private async authHeaders(source: McpSource, principal: McpExecuteOptions['principal']): Promise<Record<string, string>> {
    if (source.credentialId) {
      // A sign-in that has expired is renewed first (connections/mcp-oauth);
      // one that cannot be renewed says to sign in again.
      const fresh = await this.mcpOAuth?.ensureFresh(source.organizationId, source.credentialId);
      if (fresh?.status === 'reconnect') throw new McpClientError('MCP_HTTP_ERROR', fresh.error);
      const resolved = await this.credentialRefs.resolve(source.organizationId, source.credentialId, {
        principal: principal ?? null,
        context: { purpose: 'mcp_call', resourceType: 'mcp_source', resourceId: source.id },
      });
      const headers: Record<string, string> = { ...resolved.credential.getAuthHeaders() };
      const custom = resolved.config.headers;
      if (custom && typeof custom === 'object') {
        for (const [key, value] of Object.entries(custom)) {
          if (typeof value === 'string' && !/[\r\n]/.test(key) && !/[\r\n]/.test(value)) headers[key] = value;
        }
      }
      return headers;
    }
    return this.decryptLegacyAuthHeaders(source);
  }

  /** Shim: rows whose secret is still in authConfig. TODO(2026-12-01): drop with the column. */
  private async decryptLegacyAuthHeaders(source: McpSource): Promise<Record<string, string>> {
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
    const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|(?<!_)_+$/g, '');
    const name = `${slug(source.name)}_${slug(remoteName)}`;
    return name.slice(0, 128);
  }

  private redact(source: McpSource): RedactedMcpSource {
    const { authConfig, organization, ...rest } = source as McpSource & { organization?: any };
    return { ...rest, hasAuth: source.authType !== 'none' } as RedactedMcpSource;
  }
}

/** JSON with sorted keys: the same arguments give the same string. */
function stableJson(value: unknown): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.keys(v).sort().reduce((o, k) => ({ ...o, [k]: sort(v[k]) }), {} as Record<string, any>)
        : v;
  return JSON.stringify(sort(value ?? {}));
}

/** What the server asked, for the model and the person. */
function questionsOf(inputRequests: McpInputRequests): Array<{ message: string; url?: string }> {
  return Object.values(inputRequests)
    .filter((r) => r?.method === 'elicitation/create')
    .map((r) => ({
      message: typeof r.params?.message === 'string' && r.params.message.trim() ? r.params.message.trim() : 'The server needs more information.',
      ...(r.params?.mode === 'url' && typeof r.params?.url === 'string' ? { url: r.params.url } : {}),
    }));
}

const YES = /^(y|yes|true|1|ok|okay|sure|approve|approved|confirm|confirmed)$/i;

/** One answer as the value a form field wants. */
function fieldValue(answer: string, schema: Record<string, any> | undefined): unknown {
  const type = schema?.type;
  if (type === 'boolean') return YES.test(answer.trim());
  if (type === 'integer' || type === 'number') {
    const n = Number(answer.trim().replace(/,/g, ''));
    return Number.isFinite(n) ? (type === 'integer' ? Math.trunc(n) : n) : answer;
  }
  const options: string[] = Array.isArray(schema?.enum)
    ? schema!.enum
    : Array.isArray(schema?.oneOf)
      ? schema!.oneOf.map((o: any) => o?.const).filter((c: unknown) => typeof c === 'string')
      : [];
  if (options.length) return options.find((o) => o.toLowerCase() === answer.trim().toLowerCase()) ?? answer.trim();
  if (type === 'array') return answer.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return answer;
}

/**
 * The person's answer as the server's `inputResponses`: an elicitation form
 * with one field gets the answer in that field; with several, a JSON object
 * answer fills them, else the answer goes to the first text field. A URL
 * elicitation (the person did it on the server's page) is accepted as done.
 */
function inputResponsesFrom(inputRequests: McpInputRequests, answer: string): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [key, request] of Object.entries(inputRequests)) {
    if (request?.method === 'roots/list') {
      responses[key] = { roots: [] };
      continue;
    }
    if (request?.method !== 'elicitation/create') continue;
    if (request.params?.mode === 'url') {
      responses[key] = { action: 'accept' };
      continue;
    }
    const properties: Record<string, any> = request.params?.requestedSchema?.properties ?? {};
    const names = Object.keys(properties);
    const content: Record<string, unknown> = {};
    if (names.length === 1) {
      content[names[0]] = fieldValue(answer, properties[names[0]]);
    } else if (names.length > 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const name of names) {
          const value = (parsed as Record<string, unknown>)[name];
          if (value !== undefined) content[name] = typeof value === 'string' ? fieldValue(value, properties[name]) : value;
        }
      } else {
        const first = names.find((n) => (properties[n]?.type ?? 'string') === 'string') ?? names[0];
        content[first] = fieldValue(answer, properties[first]);
      }
    }
    responses[key] = { action: 'accept', content };
  }
  return responses;
}

/** Exported for the spec. */
export const __testing = { inputResponsesFrom, questionsOf, stableJson };
