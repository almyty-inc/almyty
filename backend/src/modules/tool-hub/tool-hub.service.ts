import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, IsNull, In } from 'typeorm';

import { ToolTemplate } from '../../entities/tool-template.entity';
import { Tool, ToolStatus, ToolType, ToolExecutionMethod } from '../../entities/tool.entity';
import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isOthersPrivate } from '../../common/authorization/private-visibility';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import {
  sanitizeConfiguration,
  sanitizeExamples,
  sanitizeHttpConfig,
  scrubStringMap,
} from './template-sanitizer';
import { PublishToolTemplateDto, UpdateToolTemplateDto } from './dto/tool-hub.dto';

export interface ListTemplatesFilters {
  category?: string;
  provider?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface InstallTemplateOptions {
  existingApiId?: string;
  credentialId?: string;
}

/** Page size when the caller asks for none. */
const DEFAULT_PAGE_SIZE = 20;
/** Hard ceiling on one page, whatever the caller asks for. */
const MAX_PAGE_SIZE = 100;
/** Hard ceiling on the page number, so OFFSET stays sane. */
const MAX_PAGE = 10_000;

/**
 * `page` and `limit` come straight off the query string via `parseInt`,
 * so they arrive as NaN (`?limit=abc`), zero, negative or arbitrarily
 * large. NaN used to reach `.skip()`/`.take()` and produce invalid SQL;
 * `?limit=1000000` asked Postgres for every template in the instance in
 * one response. Clamp both to a sane integer range here — in the
 * service, so every caller is covered, not just the HTTP controller.
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

@Injectable()
export class ToolHubService {
  private readonly logger = new Logger(ToolHubService.name);

  constructor(
    @InjectRepository(ToolTemplate)
    private templateRepository: Repository<ToolTemplate>,
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async listTemplates(
    filters: ListTemplatesFilters,
    orgId?: string,
  ): Promise<{ templates: ToolTemplate[]; total: number }> {
    const { category, provider, search } = filters;
    const limit = clampInt(filters.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = clampInt(filters.page, 1, 1, MAX_PAGE);

    const queryBuilder = this.templateRepository.createQueryBuilder('t');

    // Show global (no org) + org-specific templates
    if (orgId) {
      queryBuilder.where('(t.organizationId IS NULL OR t.organizationId = :orgId)', { orgId });
    } else {
      queryBuilder.where('t.organizationId IS NULL');
    }

    if (category) {
      queryBuilder.andWhere('t.category = :category', { category });
    }

    if (provider) {
      queryBuilder.andWhere('t.provider = :provider', { provider });
    }

    if (search) {
      queryBuilder.andWhere(
        '(t.name ILIKE :search OR t.description ILIKE :search OR t.provider ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy('t.installCount', 'DESC')
      .addOrderBy('t.name', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [templates, total] = await queryBuilder.getManyAndCount();

    return { templates, total };
  }

  async getTemplate(id: string, orgId?: string): Promise<ToolTemplate> {
    const template = await this.templateRepository.findOne({ where: { id } });
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    // A template is visible when it's global (organizationId IS NULL)
    // or when it belongs to the caller's org. Without this check, any
    // authenticated user could install another org's private template
    // — potentially exposing the template's apiConfig and configuration.
    // Returns "not found" rather than "forbidden" so the endpoint can't
    // be used to probe for private template ids.
    if (template.organizationId && template.organizationId !== orgId) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  async getProviders(orgId?: string): Promise<Array<{ provider: string; providerIcon: string | null; count: number }>> {
    const queryBuilder = this.templateRepository.createQueryBuilder('t');

    if (orgId) {
      queryBuilder.where('(t.organizationId IS NULL OR t.organizationId = :orgId)', { orgId });
    } else {
      queryBuilder.where('t.organizationId IS NULL');
    }

    queryBuilder
      .select('t.provider', 'provider')
      .addSelect('t.providerIcon', 'providerIcon')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('t.provider')
      .addGroupBy('t.providerIcon')
      .orderBy('count', 'DESC');

    return queryBuilder.getRawMany();
  }

  async getCategories(orgId?: string): Promise<Array<{ category: string; count: number }>> {
    // Same visibility rule as getProviders() above: public templates
    // (organizationId IS NULL) are always visible; private templates
    // are only visible to members of their owning org. Without this
    // filter, the category name + count of every private template
    // in every other tenant leaked to any authenticated caller.
    const queryBuilder = this.templateRepository.createQueryBuilder('t');
    if (orgId) {
      queryBuilder.where('(t.organizationId IS NULL OR t.organizationId = :orgId)', { orgId });
    } else {
      queryBuilder.where('t.organizationId IS NULL');
    }

    return queryBuilder
      .select('t.category', 'category')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('t.category')
      .orderBy('count', 'DESC')
      .getRawMany();
  }

  async installTemplate(
    templateId: string,
    orgId: string,
    userId: string,
    options: InstallTemplateOptions = {},
  ): Promise<{ tool: Tool; api?: Api }> {
    // Pass orgId so cross-org templates are rejected up front.
    const template = await this.getTemplate(templateId, orgId);
    let api: Api | undefined;

    // If template has apiConfig, resolve or create an Api
    if (template.apiConfig) {
      if (options.existingApiId) {
        // Use provided API
        const existing = await this.apiRepository.findOne({
          where: { id: options.existingApiId, organizationId: orgId },
        });
        if (!existing || isOthersPrivate(existing, userId)) {
          throw new BadRequestException('Specified API not found in your organization');
        }
        api = existing;
      } else {
        // Check for existing Api with same baseUrl in org
        // Another member's private API is not reusable (nor visible) here.
        const existing = (await this.apiRepository.find({
          where: { baseUrl: template.apiConfig.baseUrl, organizationId: orgId },
        })).find((a) => !isOthersPrivate(a, userId));

        if (existing) {
          api = existing;
        } else {
          // Create new Api
          const newApi = this.apiRepository.create({
            name: template.apiConfig.name,
            baseUrl: template.apiConfig.baseUrl,
            type: ApiType.HTTP,
            status: ApiStatus.ACTIVE,
            organizationId: orgId,
            ownerUserId: userId,
            // Scrubbed on the way in as well as on the way out. The
            // publish path never writes apiConfig.headers, but a template
            // is data another party may have authored, and this is the
            // one place a header on it becomes a live default header on
            // an Api inside the installing organization.
            headers: scrubStringMap(template.apiConfig.headers) || {},
            version: '1.0.0',
          });
          api = await this.apiRepository.save(newApi);
          this.logger.log(`Created API '${api.name}' for template '${template.name}' in org ${orgId}`);
        }
      }
    }

    // Create the Tool from the template
    const tool = this.toolRepository.create({
      name: template.name,
      description: template.description,
      type: ToolType.FUNCTION,
      executionMethod: template.executionMethod as ToolExecutionMethod || ToolExecutionMethod.HTTP,
      httpConfig: template.httpConfig || null,
      parameters: template.parameters || {},
      configuration: template.configuration || {},
      examples: template.examples || [],
      apiId: api?.id || null,
      organizationId: orgId,
      createdBy: userId,
      // A tool installed onto the caller's private API is private with it.
      ...(api?.visibility === 'private' ? { visibility: 'private' as const, teamId: null } : {}),
      status: ToolStatus.ACTIVE,
      version: '1.0.0',
      metadata: {
        sourceTemplate: {
          id: template.id,
          name: template.name,
          provider: template.provider,
          version: template.version,
        },
        ...(options.credentialId ? { credentialId: options.credentialId } : {}),
      },
    });

    const savedTool = await this.toolRepository.save(tool);

    // Increment install count
    await this.templateRepository.increment({ id: templateId }, 'installCount', 1);

    this.logger.log(`Installed template '${template.name}' as tool '${savedTool.id}' in org ${orgId}`);

    // Audit log (fire-and-forget)
    this.auditLogService.logCreate(orgId, userId, AuditResource.TOOL, savedTool.id, savedTool.name, {
      source: 'tool-hub',
      templateId: template.id,
      provider: template.provider,
    });

    return { tool: savedTool, api };
  }

  async installProviderTemplates(
    provider: string,
    orgId: string,
    userId: string,
    options: InstallTemplateOptions = {},
  ): Promise<{ tools: Tool[]; api?: Api }> {
    // Find all templates for this provider that are visible to the
    // caller — global templates (organizationId IS NULL) OR templates
    // owned by the caller's org. Previously this fetched every
    // matching template regardless of ownership.
    const templates = await this.templateRepository
      .createQueryBuilder('t')
      .where('t.provider = :provider', { provider })
      .andWhere('(t.organizationId IS NULL OR t.organizationId = :orgId)', { orgId })
      .getMany();

    if (templates.length === 0) {
      throw new NotFoundException(`No templates found for provider '${provider}'`);
    }

    const tools: Tool[] = [];
    let sharedApi: Api | undefined;

    for (const template of templates) {
      const result = await this.installTemplate(template.id, orgId, userId, {
        ...options,
        // After first install, reuse the created API for subsequent templates
        existingApiId: options.existingApiId || sharedApi?.id,
      });
      tools.push(result.tool);
      if (result.api && !sharedApi) {
        sharedApi = result.api;
      }
    }

    this.logger.log(`Installed ${tools.length} templates from provider '${provider}' in org ${orgId}`);

    return { tools, api: sharedApi };
  }

  /**
   * Publish one of the caller's tools into the hub as a template.
   *
   * Tenancy. The source tool is read with `organizationId` in the WHERE
   * clause, not checked after the fact, so a tool id belonging to another
   * tenant is a 404 and not a publish. The new template's
   * `organizationId` is the caller's org, always: it is never taken from
   * the request and is never NULL, so no org user can publish into the
   * public catalog every other tenant reads.
   *
   * Secrets. Everything the template carries goes through
   * template-sanitizer, which copies named fields only. `authConfig`,
   * `metadata` (which is where an installed tool's `credentialId` lives),
   * `code`, `llmConfig`, `runnerConfig` and `memoryConfig` are not copied
   * at all, `httpConfig.headers` is dropped whole, and the source Api
   * contributes its name, base URL and the *type* of auth it needs --
   * never its headers and never `authentication.config`.
   *
   * Execution method. Only `http` publishes. `installTemplate` rebuilds a
   * tool from `httpConfig`, `parameters`, `configuration` and `examples`
   * and nothing else, so a GraphQL, SOAP, gRPC, custom-code, LLM, runner
   * or memory tool would round-trip into a tool that cannot execute.
   * Refusing is the honest answer; a template that installs broken is
   * worse than no template.
   */
  async publishTool(
    orgId: string,
    userId: string,
    dto: PublishToolTemplateDto,
  ): Promise<ToolTemplate> {
    const tool = await this.toolRepository.findOne({
      where: { id: dto.toolId, organizationId: orgId },
      relations: { api: true },
    });
    // Another member's private tool is "not found" here too: publishing it
    // to the hub would hand it to every tenant.
    if (!tool || isOthersPrivate(tool, userId)) {
      // 404 rather than 403: a 403 would confirm the id exists in some
      // other organization.
      throw new NotFoundException('Tool not found');
    }

    if (tool.executionMethod !== ToolExecutionMethod.HTTP) {
      throw new BadRequestException(
        `Only HTTP tools can be published to the hub. '${tool.name}' executes via ` +
          `'${tool.executionMethod ?? 'none'}', which a template cannot carry.`,
      );
    }

    const httpConfig = sanitizeHttpConfig(tool.httpConfig);
    if (!httpConfig?.path || !httpConfig?.method) {
      throw new BadRequestException(
        `'${tool.name}' has no HTTP method and path to publish.`,
      );
    }

    const name = (dto.name ?? tool.name).trim();
    const provider = (dto.provider ?? tool.api?.name ?? 'custom').trim();

    const clash = await this.templateRepository.findOne({
      where: { name, organizationId: orgId },
    });
    if (clash) {
      throw new ConflictException(
        `Your organization already publishes a template named '${name}'.`,
      );
    }

    const template = this.templateRepository.create({
      name,
      description: dto.description ?? tool.description ?? null,
      provider,
      providerIcon: dto.providerIcon ?? null,
      category: dto.category.trim(),
      tags: dto.tags ?? [],
      executionMethod: ToolExecutionMethod.HTTP,
      httpConfig,
      parameters: tool.parameters ?? {},
      configuration: sanitizeConfiguration(tool.configuration),
      examples: sanitizeExamples(tool.examples),
      apiConfig: tool.api
        ? {
            name: tool.api.name,
            baseUrl: tool.api.baseUrl,
            // No `headers`, and no `authentication.config`. The installing
            // organization learns which kind of credential it needs, and
            // supplies its own.
            authRequirements: { type: tool.api.authentication?.type ?? 'none' },
          }
        : null,
      sdkConfig: null,
      sdkMap: null,
      isBuiltIn: false,
      organizationId: orgId,
      version: dto.version ?? tool.version ?? '1.0.0',
      installCount: 0,
      createdBy: userId,
      sourceToolId: tool.id,
    });

    let saved: ToolTemplate;
    try {
      saved = await this.templateRepository.save(template);
    } catch (error: any) {
      // The partial unique index is the real arbiter; the check above only
      // turns the common case into a readable message.
      if (error?.code === '23505') {
        throw new ConflictException(
          `Your organization already publishes a template named '${name}'.`,
        );
      }
      throw error;
    }

    this.logger.log(
      `Published tool '${tool.id}' as template '${saved.id}' in org ${orgId}`,
    );

    this.auditLogService.logCreate(
      orgId,
      userId,
      AuditResource.TOOL_TEMPLATE,
      saved.id,
      saved.name,
      { source: 'tool-hub', sourceToolId: tool.id, provider: saved.provider },
    );

    return saved;
  }

  /**
   * Load a template the caller's organization owns, for writing.
   *
   * `organizationId: orgId` is an equality predicate, so it matches
   * neither another tenant's rows nor the public ones where the column is
   * NULL. That is what stops an org user editing or retracting a public
   * template every other tenant depends on.
   */
  private async getOwnedTemplate(id: string, orgId: string): Promise<ToolTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id, organizationId: orgId },
    });
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  /** Edit the listing metadata of a template the caller's org published. */
  async updateTemplate(
    id: string,
    orgId: string,
    userId: string,
    dto: UpdateToolTemplateDto,
  ): Promise<ToolTemplate> {
    const template = await this.getOwnedTemplate(id, orgId);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== template.name) {
        const clash = await this.templateRepository.findOne({
          where: { name, organizationId: orgId },
        });
        if (clash) {
          throw new ConflictException(
            `Your organization already publishes a template named '${name}'.`,
          );
        }
      }
      template.name = name;
    }
    if (dto.description !== undefined) template.description = dto.description;
    if (dto.category !== undefined) template.category = dto.category.trim();
    if (dto.provider !== undefined) template.provider = dto.provider.trim();
    if (dto.providerIcon !== undefined) template.providerIcon = dto.providerIcon;
    if (dto.tags !== undefined) template.tags = dto.tags;
    if (dto.version !== undefined) template.version = dto.version;

    const saved = await this.templateRepository.save(template);

    this.auditLogService.logUpdate(
      orgId,
      userId,
      AuditResource.TOOL_TEMPLATE,
      saved.id,
      saved.name,
      undefined,
      { source: 'tool-hub' },
    );

    return saved;
  }

  /**
   * Retract a template the caller's org published. Tools already
   * installed from it are untouched -- they are ordinary tools in the
   * organizations that installed them.
   */
  async deleteTemplate(id: string, orgId: string, userId: string): Promise<void> {
    const template = await this.getOwnedTemplate(id, orgId);
    await this.templateRepository.remove(template);

    this.logger.log(`Retracted template '${id}' from org ${orgId}`);

    this.auditLogService.logDelete(
      orgId,
      userId,
      AuditResource.TOOL_TEMPLATE,
      id,
      template.name,
    );
  }
}
