import { AgentValidationHelper } from './agent-validation.helper';
import { AgentReadinessService } from './agent-readiness.service';
import { AgentTemplate, getAgentTemplates } from './agent-templates';
import { EstimatedCost, estimateAgentCost } from './agent-cost-estimator';
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { validateUrl } from '../../common/security/url-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Tool } from '../../entities/tool.entity';

import { Agent, AgentStatus, AgentPipeline } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { AgentAuditService } from './agent-audit.service';
import { AgentCollaboration, collaborationProblems } from './collaboration-participants';
import { AgentModels, agentModelsProblems, syncMainRole } from './autonomous-models';
import { AccessPolicyService, ResourceVisibility } from '../../common/authorization/access-policy.service';
import {
  assertAttachable,
  resolveVisibilityWrite,
} from '../../common/authorization/private-visibility';
import { assertManageable, canRead } from '../../common/authorization/read-rule';
import { assertNoSharedDependents } from '../../common/authorization/private-dependents';
import { collectAgentReferences, collectProviderReferences } from './agent-references';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { providerUsableBy } from '../llm-providers/private-provider';

export interface AgentSearchFilters {
  search?: string;
  status?: AgentStatus;
  organizationId: string;
  // Required so getAgents can apply the team-scope visibility filter
  // via AccessPolicyService.applyListFilter. Without this, a
  // team_member sees every team-scoped agent in the org instead of
  // just the agents on their own teams.
  caller: { id: string };
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'totalExecutions';
  sortOrder?: 'ASC' | 'DESC';
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  status?: AgentStatus;
  version?: string;
  mode?: 'workflow' | 'autonomous';
  pipeline?: AgentPipeline;
  instructions?: string;
  personality?: string;
  heartbeat?: { enabled: boolean; intervalMinutes: number; prompt: string };
  toolIds?: string[];
  modelConfig?: { providerId?: string; model?: string; temperature?: number; maxTokens?: number };
  memoryConfig?: { enabled?: boolean; autoSave?: boolean; scopes?: string[] };
  agentConfig?: { canCallAgents?: boolean; canCreateAgents?: boolean };
  collaboration?: AgentCollaboration | null;
  models?: AgentModels | null;
  variables?: Record<string, any>;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
  webhookUrl?: string;
  // Team-scoping fields from the dashboard's VisibilityField.
  visibility?: ResourceVisibility;
  teamId?: string | null;
}
export interface UpdateAgentInput {
  name?: string;
  description?: string;
  status?: AgentStatus;
  version?: string;
  mode?: 'workflow' | 'autonomous';
  pipeline?: AgentPipeline;
  instructions?: string;
  personality?: string;
  heartbeat?: { enabled: boolean; intervalMinutes: number; prompt: string };
  toolIds?: string[];
  modelConfig?: { providerId?: string; model?: string; temperature?: number; maxTokens?: number };
  memoryConfig?: { enabled?: boolean; autoSave?: boolean; scopes?: string[] };
  agentConfig?: { canCallAgents?: boolean; canCreateAgents?: boolean };
  collaboration?: AgentCollaboration | null;
  models?: AgentModels | null;
  variables?: Record<string, any>;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
  webhookUrl?: string;
  // Team-scoping fields from the dashboard's VisibilityField.
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

export { AgentTemplate } from './agent-templates';

export interface AgentVersionSnapshot {
  version: string;
  pipeline: AgentPipeline;
  savedAt: string;
  changelog: string;
}

/**
 * How many inline pipeline snapshots an agent keeps in `metadata.versions`.
 *
 * The array used to grow forever: every pipeline update, every explicit
 * saveVersion and every rollback pushed a full deep copy of the pipeline
 * into the agent row, so a 20-node pipeline (~50-100 KB) edited a couple of
 * hundred times turned into a multi-megabyte `metadata` column that every
 * read of the agent had to load.
 *
 * Nothing is lost by trimming: Agent is a `@VersionedEntity`, so the version
 * subscriber already writes the complete agent JSON — pipeline included — to
 * the `version` table on every save, and that history is served by
 * `GET /versions/Agent/:id`. The inline array only backs the builder's quick
 * "recent versions" rollback list, which shows a short window.
 */
export const MAX_INLINE_AGENT_VERSIONS = 10;

/**
 * Trim an inline version list to the newest MAX_INLINE_AGENT_VERSIONS entries.
 * Returns a new array; the input is not mutated.
 */
export function trimAgentVersions(
  versions: AgentVersionSnapshot[],
): AgentVersionSnapshot[] {
  if (versions.length <= MAX_INLINE_AGENT_VERSIONS) return versions;
  return versions.slice(versions.length - MAX_INLINE_AGENT_VERSIONS);
}

/**
 * Columns the agents list response emits. `metadata` is deliberately absent:
 * it carries the inline version history and no list consumer reads it.
 */
export const AGENT_LIST_COLUMNS = [
  'id',
  'name',
  'description',
  'organizationId',
  'visibility',
  'teamId',
  'status',
  'version',
  'pipeline',
  'variables',
  'settings',
  'mode',
  'instructions',
  'personality',
  'heartbeat',
  'toolIds',
  'modelConfig',
  'memoryConfig',
  'agentConfig',
  'isTemporary',
  'parentRunId',
  'collaboration',
  'models',
  'webhookUrl',
  'totalExecutions',
  'successfulExecutions',
  'totalCost',
  'averageExecutionTime',
  'lastExecutedAt',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/** Page size for GET /agents/:id/executions when none is asked for. */
export const DEFAULT_EXECUTIONS_PAGE_SIZE = 20;
/** Hard ceiling on one page of executions. */
export const MAX_EXECUTIONS_PAGE_SIZE = 100;

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
    @InjectRepository(AgentExecution)
    private agentExecutionRepository: Repository<AgentExecution>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private auditService: AgentAuditService,
    private readonly validation: AgentValidationHelper,
    private readonly accessPolicy: AccessPolicyService,
    private readonly readiness: AgentReadinessService,
  ) {}

  /**
   * Refuse a collaboration the engine cannot run: an unknown strategy, a
   * participant of unknown kind, an agent participant with no agentId, or a
   * model participant with nothing to call it through (no providerId and no
   * routing policy). Checked at save time so the run does not fail later.
   */
  private assertCollaboration(collaboration: unknown): void {
    const problems = collaborationProblems(collaboration);
    if (problems.length) {
      throw new BadRequestException(`Invalid collaboration: ${problems.join('; ')}`);
    }
  }

  /**
   * Refuse models the autonomous engine cannot run: a strategy whose slots
   * are not all filled, a role with nothing to call, an agent where a model
   * has to be. Checked at save time, where somebody is looking, so the page
   * and the API get the same sentences (agentModelsProblems).
   */
  private assertModels(models: unknown): void {
    const problems = agentModelsProblems(models);
    if (problems.length) {
      throw new BadRequestException(`Invalid models: ${problems.join('; ')}`);
    }
  }

  /**
   * The models and modelConfig an agent is saved with. On an autonomous
   * agent the main role and modelConfig are kept equal (syncMainRole), so
   * a client that still writes modelConfig alone moves the main role, and
   * the page, which writes models, moves modelConfig. A workflow agent has
   * no models: its multi-model shape is its graph.
   */
  private modelsFor(
    mode: 'workflow' | 'autonomous',
    models: AgentModels | null | undefined,
    modelConfig: Agent['modelConfig'] | null | undefined,
    modelsWritten: boolean,
  ): { models: AgentModels | null; modelConfig: Agent['modelConfig'] | null } {
    if (mode !== 'autonomous') return { models: null, modelConfig: modelConfig ?? null };
    const synced = syncMainRole({ models, modelConfig, modelsWritten });
    return { models: synced.models, modelConfig: (synced.modelConfig as Agent['modelConfig']) ?? null };
  }

  /**
   * Refuse a webhook URL the delivery path will silently drop.
   *
   * agent-webhook.service runs this same check at delivery time and, on
   * failure, logs a warning and returns. Nothing surfaces that anywhere:
   * the agent saved cleanly, the UI said "Webhook URL updated", and every
   * run afterwards posted nowhere with no toast, no run detail and no
   * delivery record. Say no at save time, where somebody is looking.
   */
  private assertWebhookUrl(webhookUrl?: string | null): void {
    if (!webhookUrl) return;
    const validation = validateUrl(webhookUrl);
    if (!validation.valid) {
      throw new BadRequestException(
        `That webhook URL cannot be used: ${validation.error}`,
      );
    }
  }

  /**
   * Refuse tool ids that are not this organization's.
   *
   * `agent.toolIds` is a plain `string[]` column with no referential
   * integrity, and the DTO only asserts "array of strings" — so an id
   * from another tenant used to survive the write and then get resolved
   * at run time. The resolvers are org-scoped now too, but that only
   * makes the tool quietly vanish; refusing at save time is what tells
   * the caller their agent is not going to have the tool they asked for.
   *
   * A missing id is refused for the same reason: an agent silently
   * missing a tool it was configured with is a support ticket, and the
   * two cases are indistinguishable from the outside anyway.
   */
  private async assertToolsInOrg(toolIds: string[] | undefined, organizationId: string): Promise<void> {
    if (!toolIds?.length) return;
    const wanted = [...new Set(toolIds)];
    const found = await this.agentRepository.manager.getRepository(Tool).find({
      where: { id: In(wanted), organizationId },
      select: { id: true },
    });
    const have = new Set(found.map((t) => t.id));
    const missing = wanted.filter((id) => !have.has(id));
    if (missing.length) {
      throw new BadRequestException(
        `These tools are not available in this organization: ${missing.join(', ')}. ` +
          'Remove them, or create them here first.',
      );
    }
  }

  /**
   * Refuse wiring another user's private tool or agent -- or any private
   * one into an agent that is not private to the same owner.
   *
   * An org-wide agent that calls a private tool hands that tool to every
   * member who can run the agent, so "just me" would stop meaning it.
   * The references live in `toolIds`, `tool_call` / `sub_agent` pipeline
   * nodes and the collaboration roster; all of them are checked. Ids that
   * do not resolve are left to the existing checks.
   */
  private async assertPrivateReferencesAllowed(
    agent: {
      id?: string;
      visibility?: ResourceVisibility | null;
      createdBy?: string | null;
      toolIds?: string[] | null;
      pipeline?: AgentPipeline | null;
      collaboration?: Agent['collaboration'] | null;
      models?: AgentModels | null;
    },
    organizationId: string,
  ): Promise<void> {
    const { toolIds, agentIds } = collectAgentReferences(agent);
    if (agent.id) agentIds.delete(agent.id);
    const parent = { visibility: agent.visibility ?? 'org', ownerId: agent.createdBy ?? null, noun: 'agent' };
    if (toolIds.size) {
      const tools = await this.agentRepository.manager.getRepository(Tool).find({
        where: { id: In([...toolIds]), organizationId },
        select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
      });
      assertAttachable(parent, tools, 'tool');
    }
    if (agentIds.size) {
      const agents = await this.agentRepository.find({
        where: { id: In([...agentIds]), organizationId },
        select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
      });
      assertAttachable(parent, agents, 'agent');
    }
  }

  /**
   * Refuse naming an LLM provider the saving user cannot use: one that is
   * not in this organization, or another member's private provider. The
   * run would refuse it anyway (llm-provider-secrets, the router), so say
   * no where somebody is looking. Both cases get the same message, so the
   * answer does not tell the caller a private provider with that id exists.
   * A save with no known user cannot own a private provider: fail closed.
   *
   * Only references the save adds are checked (`previous` is the stored
   * agent on update), so an agent whose provider was since deleted can
   * still be edited in other ways.
   */
  private async assertProvidersUsable(
    next: Parameters<typeof collectProviderReferences>[0],
    previous: Parameters<typeof collectProviderReferences>[0] | null,
    organizationId: string,
    userId: string | null | undefined,
  ): Promise<void> {
    const before = previous ? collectProviderReferences(previous) : new Set<string>();
    const added = [...collectProviderReferences(next)].filter((id) => !before.has(id));
    if (added.length === 0) return;
    const found = await this.agentRepository.manager.getRepository(LlmProvider).find({
      where: { id: In(added), organizationId },
      select: { id: true, visibility: true, ownerUserId: true },
    });
    const usable = new Set(found.filter((p) => providerUsableBy(p, userId)).map((p) => p.id));
    const refused = added.filter((id) => !usable.has(id));
    if (refused.length) {
      throw new BadRequestException(
        `These providers are not available in this organization: ${refused.join(', ')}. ` +
          'Choose another provider in Models.',
      );
    }
  }

  async createAgent(
    createDto: CreateAgentInput,
    organizationId: string,
    userId: string,
  ): Promise<Agent> {
    try {
      this.logger.log(`[CREATE_AGENT] Creating agent '${createDto.name}' for org=${organizationId}, user=${userId}`);

      this.assertWebhookUrl(createDto.webhookUrl);
      this.assertCollaboration(createDto.collaboration);
      this.assertModels(createDto.models);
      await this.assertToolsInOrg(createDto.toolIds, organizationId);

      // Verify organization
      const organization = await this.organizationRepository.findOne({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      // Validate team scoping before persisting — without this a
      // caller can mint an agent bound to a team they don't belong
      // to (or a team in a different org).
      await this.accessPolicy.assertCanScopeToTeam(
        userId,
        organizationId,
        createDto.visibility,
        createDto.teamId,
      );
      // The creator owns the agent; 'private' means private to them.
      // Drop a stray teamId unless the agent is team-scoped.
      const scope = resolveVisibilityWrite({
        requestedVisibility: createDto.visibility,
        requestedTeamId: createDto.teamId,
        current: { ownerId: userId },
        callerId: userId,
        noun: 'agent',
      });

      // Validate pipeline (only for workflow mode)
      const mode = createDto.mode || 'workflow';
      if (mode === 'workflow' && createDto.pipeline) {
        this.validation.validatePipeline(createDto.pipeline);
      }

      const next = this.modelsFor(
        mode,
        createDto.models,
        createDto.modelConfig as Agent['modelConfig'],
        createDto.models !== undefined,
      );

      await this.assertPrivateReferencesAllowed(
        {
          visibility: scope.visibility,
          createdBy: userId,
          toolIds: createDto.toolIds,
          pipeline: createDto.pipeline,
          collaboration: createDto.collaboration as Agent['collaboration'],
          models: next.models,
        },
        organizationId,
      );
      await this.assertProvidersUsable(
        {
          modelConfig: next.modelConfig,
          pipeline: createDto.pipeline,
          agentConfig: createDto.agentConfig as Agent['agentConfig'],
          collaboration: createDto.collaboration as Agent['collaboration'],
          models: next.models,
        },
        null,
        organizationId,
        userId,
      );

      const agent = this.agentRepository.create({
        name: createDto.name,
        description: createDto.description,
        organizationId,
        status: createDto.status || AgentStatus.DRAFT,
        version: createDto.version || '1.0.0',
        mode,
        pipeline: createDto.pipeline || { nodes: [], edges: [] },
        instructions: createDto.instructions || null,
        personality: createDto.personality || null,
        heartbeat: createDto.heartbeat || null,
        toolIds: createDto.toolIds || [],
        modelConfig: next.modelConfig,
        models: next.models,
        memoryConfig: createDto.memoryConfig || null,
        agentConfig: createDto.agentConfig || null,
        collaboration: createDto.collaboration || null,
        variables: createDto.variables || {},
        settings: createDto.settings || {},
        metadata: createDto.metadata || {},
        webhookUrl: createDto.webhookUrl || null,
        createdBy: userId,
        visibility: scope.visibility,
        teamId: scope.teamId,
      });

      if (agent.status === AgentStatus.ACTIVE) await this.readiness.assertReady(agent, userId);
      const saved = await this.agentRepository.save(agent);
      this.logger.log(`[CREATE_AGENT] Agent created: id=${saved.id}`);

      await this.auditService.log({
        agentId: saved.id,
        organizationId,
        userId,
        action: 'created',
        details: { name: saved.name, status: saved.status },
      });

      return saved;
    } catch (error) {
      this.logger.error(`[CREATE_AGENT] Failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Fetch an agent by id within an organization. With a `caller`, an
   * agent they may not read (read-rule.ts: another member's private agent,
   * a team agent outside their teams) is "not found" -- the same 404 a
   * missing id gets, never a 403, so its existence is not confirmed. A
   * `null` caller (nobody) reads organization-wide agents only. System
   * paths that act on an agent as its owner (scheduler, heartbeat,
   * runtime) call without a caller.
   */
  async getAgent(id: string, organizationId: string, caller?: { id: string } | null): Promise<Agent> {
    const agent = await this.agentRepository.findOne({
      where: { id, organizationId },
    });

    if (!agent || (caller !== undefined && !(await canRead(this.accessPolicy, caller, agent)))) {
      throw new NotFoundException(`Agent not found: ${id}`);
    }

    return agent;
  }

  /**
   * Resolve an agent by name (exact, case-insensitive, then slug) for
   * the OpenAI/Anthropic-compatible surfaces. Another member's private
   * agent never matches: with no `callerId` no private agent does.
   */
  async findByName(name: string, organizationId: string, callerId?: string | null): Promise<Agent | null> {
    const notOthersPrivate = `(agent.visibility IS DISTINCT FROM 'private' OR agent."createdBy" = :_me)`;
    const me = callerId ?? null;
    // Try exact match first
    let agent = await this.agentRepository
      .createQueryBuilder('agent')
      .where('agent.organizationId = :organizationId', { organizationId })
      .andWhere('agent.name = :name', { name })
      .andWhere(notOthersPrivate, { _me: me })
      .getOne();
    if (agent) return agent;

    // Try case-insensitive match
    agent = await this.agentRepository
      .createQueryBuilder('agent')
      .where('agent.organizationId = :organizationId', { organizationId })
      .andWhere('LOWER(agent.name) = LOWER(:name)', { name })
      .andWhere(notOthersPrivate, { _me: me })
      .getOne();
    if (agent) return agent;

    // Try slug match: "my-agent" matches "My Agent"
    const deslugified = name.replace(/-/g, ' ');
    agent = await this.agentRepository
      .createQueryBuilder('agent')
      .where('agent.organizationId = :organizationId', { organizationId })
      .andWhere('LOWER(agent.name) = LOWER(:name)', { name: deslugified })
      .andWhere(notOthersPrivate, { _me: me })
      .getOne();
    return agent;
  }

  /**
   * Active agents of an organization, as listed by `/v1/models`. Another
   * member's private agents are left out; with no `callerId` every
   * private agent is.
   */
  async findAllActive(organizationId: string, callerId?: string | null): Promise<Agent[]> {
    const agents = await this.agentRepository.find({
      where: { organizationId, status: AgentStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });
    // The list read rule (filterVisible): org agents, the caller's teams'
    // agents (every team's for an org owner/admin) and the caller's own
    // private ones. With no caller, org agents only. It is the same rule
    // that decides whether an agent may be RUN, so /v1/models never lists
    // a model the completion endpoint would then refuse.
    if (!callerId) return agents.filter((a) => (a.visibility ?? 'org') === 'org');
    return this.accessPolicy.filterVisible({ id: callerId }, organizationId, agents);
  }

  async getAgents(filters: AgentSearchFilters): Promise<{
    data: Agent[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.agentRepository.createQueryBuilder('agent')
      .andWhere('agent.isTemporary = false');
    // Apply team-scope visibility BEFORE the additional filters
    // (status, search, sort, paging) so the filter participates in
    // the same WHERE block as the rest of the query.
    await this.accessPolicy.applyListFilter(queryBuilder, filters.caller, filters.organizationId, 'agent', { ownerColumn: 'createdBy' });

    if (filters.search) {
      queryBuilder.andWhere(
        '(agent.name ILIKE :search OR agent.description ILIKE :search)',
        { search: `%${filters.search}%` },
      );
    }

    if (filters.status) {
      queryBuilder.andWhere('agent.status = :status', { status: filters.status });
    }

    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    queryBuilder.orderBy(`agent.${sortBy}`, sortOrder);

    queryBuilder.skip(skip).take(limit);

    // The agents list page never reads `metadata`, and `metadata.versions`
    // holds every retained pipeline snapshot for the agent. Projecting the
    // columns the list response actually emits keeps a page of agents from
    // dragging the version history of every row out of Postgres.
    queryBuilder.select(AGENT_LIST_COLUMNS.map((c) => `agent.${c}`));

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateAgent(
    id: string,
    updateDto: UpdateAgentInput,
    organizationId: string,
    userId?: string,
  ): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId, userId ? { id: userId } : undefined);

    // Permission check: admin+ can update any agent, members can only update their own
    if (userId) {
      await this.checkAgentPermission(agent, userId);
    }

    // Re-validate team scoping if it's being changed on this update.
    if (userId && (updateDto.visibility !== undefined || updateDto.teamId !== undefined)) {
      const nextVis = updateDto.visibility ?? (agent as any).visibility;
      const nextTeamId = updateDto.teamId !== undefined ? updateDto.teamId : (agent as any).teamId;
      await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, nextVis, nextTeamId);
    }

    // If pipeline is being updated, validate it (only for workflow mode) and auto-save a version snapshot
    const effectiveMode = updateDto.mode || agent.mode || 'workflow';
    if (updateDto.pipeline && effectiveMode === 'workflow') {
      this.validation.validatePipeline(updateDto.pipeline, id);

      // Auto-save previous pipeline state as a version snapshot
      if (agent.pipeline && agent.pipeline.nodes && agent.pipeline.nodes.length > 0) {
        const versions: AgentVersionSnapshot[] = agent.metadata?.versions || [];
        versions.push({
          version: agent.version,
          pipeline: JSON.parse(JSON.stringify(agent.pipeline)),
          savedAt: new Date().toISOString(),
          changelog: `Auto-saved before pipeline update`,
        });
        agent.metadata = { ...agent.metadata, versions: trimAgentVersions(versions) };
      }
    }

    this.assertWebhookUrl(updateDto.webhookUrl);
    this.assertCollaboration(updateDto.collaboration);
    this.assertModels(updateDto.models);
    await this.assertToolsInOrg(updateDto.toolIds, agent.organizationId);

    // An autonomous agent's main role and its modelConfig say the same
    // thing, whichever of the two this update writes (syncMainRole).
    const next = this.modelsFor(
      effectiveMode,
      updateDto.models !== undefined ? updateDto.models : agent.models,
      updateDto.modelConfig !== undefined ? (updateDto.modelConfig as Agent['modelConfig']) : agent.modelConfig,
      updateDto.models !== undefined,
    );

    // Only the agent's owner may make it (or keep it) private; an agent
    // with no recorded owner becomes the caller's.
    const scopeChanging = updateDto.visibility !== undefined || updateDto.teamId !== undefined;
    const scope = scopeChanging
      ? resolveVisibilityWrite({
          requestedVisibility: updateDto.visibility,
          requestedTeamId: updateDto.visibility === undefined && agent.visibility !== 'team' ? undefined : updateDto.teamId,
          current: { visibility: agent.visibility, teamId: agent.teamId, ownerId: agent.createdBy ?? null },
          callerId: userId,
          noun: 'agent',
        })
      : null;

    // The agent as it will be saved must not reference a private tool or
    // agent it is not entitled to (a newly attached one, or an existing
    // one when the agent itself stops being private). Checked whenever
    // the scope or any reference changes.
    const referencesChanging =
      updateDto.toolIds !== undefined ||
      updateDto.pipeline !== undefined ||
      updateDto.collaboration !== undefined ||
      updateDto.models !== undefined;
    if (scopeChanging || referencesChanging) {
      await this.assertPrivateReferencesAllowed(
        {
          id: agent.id,
          visibility: scope?.visibility ?? agent.visibility,
          createdBy: scope?.ownerId ?? agent.createdBy,
          toolIds: updateDto.toolIds ?? agent.toolIds,
          pipeline: updateDto.pipeline ?? agent.pipeline,
          collaboration: (updateDto.collaboration as Agent['collaboration']) ?? agent.collaboration,
          models: next.models,
        },
        organizationId,
      );
    }
    // Going private would detach this agent from the shared agents that
    // call it as a sub-agent or collaborator. Refuse and say which.
    if (scope?.visibility === 'private' && agent.visibility !== 'private' && userId) {
      await assertNoSharedDependents(
        this.agentRepository.manager,
        this.accessPolicy,
        { noun: 'agent', organizationId, targets: [{ kind: 'agent', id: agent.id }] },
        userId,
      );
    }
    await this.assertProvidersUsable(
      {
        modelConfig: next.modelConfig as Agent['modelConfig'],
        pipeline: updateDto.pipeline ?? agent.pipeline,
        agentConfig: updateDto.agentConfig !== undefined ? (updateDto.agentConfig as Agent['agentConfig']) : agent.agentConfig,
        collaboration: updateDto.collaboration !== undefined ? (updateDto.collaboration as Agent['collaboration']) : agent.collaboration,
        models: next.models,
      },
      agent,
      organizationId,
      userId,
    );

    const { visibility: _v, teamId: _t, ...rest } = updateDto;
    Object.assign(agent, rest);
    agent.modelConfig = next.modelConfig as Agent['modelConfig'];
    agent.models = next.models;
    if (scope) {
      agent.visibility = scope.visibility;
      agent.teamId = scope.teamId;
      if (scope.ownerId) agent.createdBy = scope.ownerId;
    }
    if (updateDto.status === AgentStatus.ACTIVE) await this.readiness.assertReady(agent, userId);
    const saved = await this.agentRepository.save(agent);

    this.logger.log(`[UPDATE_AGENT] Agent updated: id=${saved.id}`);

    if (userId) {
      await this.auditService.log({
        agentId: saved.id,
        organizationId,
        userId,
        action: 'updated',
        details: { updatedFields: Object.keys(updateDto) },
      });
    }

    return saved;
  }

  async deleteAgent(id: string, organizationId: string, userId?: string): Promise<void> {
    const agent = await this.getAgent(id, organizationId, userId ? { id: userId } : undefined);

    // Permission check: admin+ can delete any agent, members can only delete their own
    if (userId) {
      await this.checkAgentPermission(agent, userId);
    }

    // Log before removal since the agent won't exist after
    if (userId) {
      await this.auditService.log({
        agentId: id,
        organizationId,
        userId,
        action: 'deleted',
        details: { name: agent.name },
      });
    }

    await this.agentRepository.remove(agent);
    this.logger.log(`[DELETE_AGENT] Agent deleted: id=${id}`);
  }

  async activateAgent(id: string, organizationId: string, userId?: string): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId, userId ? { id: userId } : undefined);
    if (userId) await this.checkAgentPermission(agent, userId);
    await this.readiness.assertReady(agent, userId);

    agent.status = AgentStatus.ACTIVE;
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[ACTIVATE_AGENT] Agent activated: id=${id}`);

    if (userId) {
      await this.auditService.log({ agentId: id, organizationId, userId, action: 'activated' });
    }

    return saved;
  }

  async deactivateAgent(id: string, organizationId: string, userId?: string): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId, userId ? { id: userId } : undefined);
    if (userId) await this.checkAgentPermission(agent, userId);
    agent.status = AgentStatus.INACTIVE;
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[DEACTIVATE_AGENT] Agent deactivated: id=${id}`);

    if (userId) {
      await this.auditService.log({ agentId: id, organizationId, userId, action: 'deactivated' });
    }

    return saved;
  }

  async getReadiness(id: string, organizationId: string, userId: string) {
    // Reading the readiness takes reading the agent: getAgent answers an
    // agent the caller may not read with the not-found a missing one gets.
    const agent = await this.getAgent(id, organizationId, { id: userId });
    return this.readiness.inspect(agent, userId);
  }

  /**
   * Execution history for an agent.
   *
   * `limit` comes straight off the query string, so it is clamped to the same
   * ceiling the other list endpoints use. `nodeResults` stays in the
   * projection — the overview tab renders routing attribution out of it.
   */
  async getAgentExecutions(
    agentId: string,
    organizationId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    data: AgentExecution[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    // Verify agent exists
    await this.getAgent(agentId, organizationId);

    const take = Math.min(
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_EXECUTIONS_PAGE_SIZE,
      MAX_EXECUTIONS_PAGE_SIZE,
    );
    const currentPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const skip = (currentPage - 1) * take;
    const [data, total] = await this.agentExecutionRepository.findAndCount({
      where: { agentId, organizationId },
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return {
      data,
      total,
      page: currentPage,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }

  // ── Version Management ──

  async saveVersion(agentId: string, organizationId: string, changelog?: string, userId?: string): Promise<void> {
    const agent = await this.getAgent(agentId, organizationId, userId ? { id: userId } : undefined);
    if (userId) await this.checkAgentPermission(agent, userId);
    const versions: AgentVersionSnapshot[] = agent.metadata?.versions || [];
    versions.push({
      version: agent.version,
      pipeline: JSON.parse(JSON.stringify(agent.pipeline)),
      savedAt: new Date().toISOString(),
      changelog: changelog || `Version ${agent.version}`,
    });
    await this.agentRepository.update(agentId, {
      metadata: { ...agent.metadata, versions: trimAgentVersions(versions) },
    });
    this.logger.log(`[SAVE_VERSION] Saved version for agent=${agentId}, retained versions=${trimAgentVersions(versions).length}`);

    if (userId) {
      await this.auditService.log({
        agentId, organizationId, userId,
        action: 'version_saved',
        details: { version: agent.version, changelog },
      });
    }
  }

  async rollbackToVersion(agentId: string, organizationId: string, versionIndex: number, userId?: string): Promise<Agent> {
    const agent = await this.getAgent(agentId, organizationId, userId ? { id: userId } : undefined);
    if (userId) await this.checkAgentPermission(agent, userId);
    const versions: AgentVersionSnapshot[] = agent.metadata?.versions || [];
    if (versionIndex < 0 || versionIndex >= versions.length) {
      throw new BadRequestException('Invalid version index');
    }

    // Save the current pipeline state before rolling back so the rollback itself can be undone
    if (agent.pipeline && agent.pipeline.nodes && agent.pipeline.nodes.length > 0) {
      versions.push({
        version: agent.version,
        pipeline: JSON.parse(JSON.stringify(agent.pipeline)),
        savedAt: new Date().toISOString(),
        changelog: `Auto-saved before rollback to version index ${versionIndex}`,
      });
    }

    const targetVersion = versions[versionIndex];
    agent.pipeline = JSON.parse(JSON.stringify(targetVersion.pipeline));
    agent.version = targetVersion.version;
    agent.metadata = { ...agent.metadata, versions: trimAgentVersions(versions) };
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[ROLLBACK] Agent=${agentId} rolled back to version index=${versionIndex}, retained versions=${agent.metadata.versions.length}`);

    if (userId) {
      await this.auditService.log({
        agentId, organizationId, userId,
        action: 'rolled_back',
        details: { versionIndex, targetVersion: targetVersion.version, totalVersions: versions.length },
      });
    }

    return saved;
  }

  async getVersionHistory(agentId: string, organizationId: string): Promise<AgentVersionSnapshot[]> {
    const agent = await this.getAgent(agentId, organizationId);
    return agent.metadata?.versions || [];
  }

  // ── Templates ──

  getTemplates(): AgentTemplate[] {
    return getAgentTemplates();
  }

  // ── Import / Export ──

  async exportAgent(agentId: string, organizationId: string): Promise<any> {
    const agent = await this.getAgent(agentId, organizationId);
    return {
      name: agent.name,
      description: agent.description,
      pipeline: agent.pipeline,
      variables: agent.variables,
      settings: agent.settings,
      version: agent.version,
      exportedAt: new Date().toISOString(),
      exportVersion: '1.0',
    };
  }

  async importAgent(data: any, organizationId: string, userId: string): Promise<Agent> {
    if (!data || !data.pipeline) {
      throw new BadRequestException('Import data must contain a pipeline');
    }
    return this.createAgent(
      {
        name: (data.name || 'Imported Agent') + ' (Imported)',
        description: data.description,
        pipeline: data.pipeline,
        variables: data.variables,
        settings: data.settings,
      },
      organizationId,
      userId,
    );
  }

  // ── Cost Estimation ──

  /**
   * Estimate the cost per invocation of an agent pipeline based on its nodes.
   * LLM cost is estimated per call based on the model/provider:
   *   - Claude (Anthropic): ~2-4 cents per call
   *   - GPT-4 class (OpenAI): ~3-8 cents per call
   *   - GPT-3.5 / smaller models: ~0.2-1 cent per call
   *   - Unknown/unset: ~1-5 cents per call (conservative range)
   * Tool calls add a small fixed cost (~0.1 cents each).
   */
  async estimateCost(agentId: string, organizationId: string): Promise<EstimatedCost> {
    const agent = await this.getAgent(agentId, organizationId);
    return estimateAgentCost(agent);
  }

  /**
   * The manage gate for an agent (read-rule.ts): an agent the caller may
   * not read is the not-found a missing agent gets; one they may read but
   * not manage is a 403. The creator can always modify their own agent;
   * otherwise org owner/admin pass, team-scoped agents need a team lead.
   */
  private async checkAgentPermission(agent: Agent, userId: string): Promise<void> {
    await assertManageable(this.accessPolicy, userId, agent, 'Agent', { ownerManages: true });
  }

  /**
   * Validate pipeline:
   * - Must have exactly 1 input node
   * - Must have exactly 1 output node
   * - Must have no cycles (topological sort)
   * - All edges must reference existing nodes
   * - Condition nodes must have exactly 2 outgoing edges with sourceHandle 'true' and 'false'
   * - Merge nodes must have 2+ incoming edges
   * - Parallel nodes should have 2+ outgoing edges
   * - Sub-agent references must exist and not reference self
   */
}
