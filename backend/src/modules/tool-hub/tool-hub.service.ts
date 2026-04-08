import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, IsNull, In } from 'typeorm';

import { ToolTemplate } from '../../entities/tool-template.entity';
import { Tool, ToolStatus, ToolType, ToolExecutionMethod } from '../../entities/tool.entity';
import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

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
    const { category, provider, search, page = 1, limit = 20 } = filters;

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
        if (!existing) {
          throw new BadRequestException('Specified API not found in your organization');
        }
        api = existing;
      } else {
        // Check for existing Api with same baseUrl in org
        const existing = await this.apiRepository.findOne({
          where: { baseUrl: template.apiConfig.baseUrl, organizationId: orgId },
        });

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
            headers: template.apiConfig.headers || {},
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
}
