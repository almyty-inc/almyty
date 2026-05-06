import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tool, ToolType, ToolExecutionMethod } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { SkillRendererHelper } from './skill-renderer.helper';
import { dedupeSharedSegments } from './skill-graphql.helper';

export interface SkillOutput {
  name: string;
  content: string;
  toolCount: number;
}

export interface IndividualSkill {
  name: string;
  fileName: string;
  content: string;
}

@Injectable()
export class SkillGeneratorService {
  private readonly logger = new Logger(SkillGeneratorService.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    private readonly renderer: SkillRendererHelper,
  ) {}

  /**
   * Generate a SKILL.md file for a single tool (Agent Skills standard).
   *
   * @param organizationId Required. Without this any authenticated user
   *   could request another org's tool skill just by guessing a UUID.
   */
  async generateToolSkill(toolId: string, organizationId: string): Promise<SkillOutput> {
    if (!organizationId) {
      throw new NotFoundException(`Tool not found: ${toolId}`);
    }
    const tool = await this.toolRepository.findOne({
      where: { id: toolId, organizationId },
      relations: ['categories', 'operation', 'operation.api'],
    });

    if (!tool) {
      throw new NotFoundException(`Tool not found: ${toolId}`);
    }

    const content = this.renderer.renderToolSkillMd(tool);
    return {
      name: this.renderer.slugify(tool.name),
      content,
      toolCount: 1,
    };
  }

  /**
   * Generate a combined skill bundle for a gateway (single markdown file).
   *
   * @param organizationId Required (see generateToolSkill).
   */
  async generateGatewaySkills(gatewayId: string, organizationId: string): Promise<SkillOutput> {
    if (!organizationId) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }

    const tools = await this.getGatewayTools(gatewayId);

    if (tools.length === 0) {
      return {
        name: this.renderer.slugify(gateway.name),
        content: this.renderer.renderEmptyGatewaySkill(gateway),
        toolCount: 0,
      };
    }

    const content = this.renderer.renderGatewaySkill(gateway, tools);
    return {
      name: this.renderer.slugify(gateway.name),
      content,
      toolCount: tools.length,
    };
  }

  /**
   * Generate individual SKILL.md files per tool for a gateway.
   * Used by the skills CLI to install into agent directories.
   *
   * Naming rule (agentskills.io spec — kebab, lowercase, ≤64 chars,
   * no leading/trailing/consecutive hyphens). The user-facing label
   * Codex/Claude shows is the auto Title-Cased form of `name`, so a
   * short slug is what produces a readable label.
   *
   * Always `{gateway-slug}-{op-suffix}`, regardless of how many
   * tools the gateway has. Deterministic — adding a second tool to
   * a gateway never renames the existing one, and the gateway's
   * identity is always visible in every skill the gateway produces.
   * op-suffix prefers the operation's short summary, falling back to
   * the tool's name with any duplicate gateway/api prefix stripped.
   *
   * The frontmatter `name` matches the directory name, which is
   * also what the skills-cli installer uses.
   */
  async generateIndividualSkills(
    gatewayId: string,
    organizationId: string,
    context?: { orgSlug?: string; gatewaySlug?: string },
  ): Promise<IndividualSkill[]> {
    if (!organizationId) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }

    const tools = await this.getGatewayTools(gatewayId);
    const gatewaySlug = this.gatewayEndpointSlug(gateway);

    return tools.map((tool) => {
      const slug = this.composeToolSlug(gatewaySlug, tool);
      return {
        name: slug,
        fileName: slug,
        content: this.renderer.renderToolSkillMd(tool, slug, context),
      };
    });
  }

  /**
   * Pull a kebab-case slug from a gateway. The endpoint field is
   * already `/foo-bar` — drop the leading slash and trailing dashes,
   * fall back to slugified name if endpoint is missing.
   */
  private gatewayEndpointSlug(gateway: Gateway): string {
    const ep = (gateway.endpoint || '').replace(/^\/+|\/+$/g, '').trim();
    if (ep) return this.renderer.slugify(ep);
    return this.renderer.slugify(gateway.name || 'gateway');
  }

  /**
   * Build `{gateway}-{op-suffix}` for a tool. Tries operation.summary
   * first (the most human label), falls back to tool.name. In the
   * fallback case any kebab segments shared between the gateway
   * slug and the tool slug are deduped — without this, a gateway
   * named `open-meteo-skills` paired with a tool named
   * `open-meteo-weather-get-v1-forecast` produced
   * `open-meteo-skills-open-meteo-weather-get-v1-forecast` (the
   * `open-meteo` segment repeats). After dedup it's just
   * `open-meteo-skills-weather-get-v1-forecast`.
   *
   * Capped at 64 chars per spec.
   */
  private composeToolSlug(gatewaySlug: string, tool: Tool): string {
    const summary = (tool.operation as any)?.summary as string | undefined;
    let suffix: string;
    if (summary && summary.trim()) {
      suffix = this.renderer.slugify(summary);
    } else {
      suffix = dedupeSharedSegments(gatewaySlug, this.renderer.slugify(tool.name || ''));
    }
    if (!suffix) suffix = 'tool';
    // If suffix happens to *equal* the gateway slug after dedup
    // (e.g. tool name was identical to gateway endpoint), pick a
    // generic 'tool' to avoid `gateway-gateway` double-up.
    if (suffix === gatewaySlug) suffix = 'tool';

    const combined = `${gatewaySlug}-${suffix}`;
    if (combined.length <= 64) return combined;

    // Trim. Keep the *tail* of the suffix, not the head — for
    // gateways with a long shared prefix (e.g. ~40 Google-Translate
    // gRPC methods named
    // `real_google_translate_protobuf_translation_service_*`) the
    // method name is the tail and that's what makes each slug
    // unique. Cutting from the head would collapse every method
    // to the same truncated string. We drop kebab segments from
    // the head of the suffix until it fits.
    const room = 64 - gatewaySlug.length - 1;
    if (room <= 0) return gatewaySlug.slice(0, 64);
    const segments = suffix.split('-').filter(Boolean);
    let trimmed = segments.join('-');
    while (trimmed.length > room && segments.length > 1) {
      segments.shift();
      trimmed = segments.join('-');
    }
    if (trimmed.length > room) {
      // Single segment longer than the budget — keep the tail of
      // it (last `room` chars) so any unique hash suffix survives.
      trimmed = trimmed.slice(-room);
    }
    return `${gatewaySlug}-${trimmed.replace(/^-+|-+$/g, '')}`;
  }

  /**
   * Build a starter GraphQL query for a parsed GraphQL operation.
   * The agent can edit it to add fields it actually needs; we
   * supply a minimal but valid skeleton so it doesn't have to
   * remember the variable types or operation kind.
   *
   *   query country($code: ID!) {
   *     country(code: $code) {
   *       __typename
   *     }
   *   }
   *
   * The variable list comes from operation.parameters.body.variables;
   * when types are unknown we fall back to `String`.
   */
  private async getGatewayTools(gatewayId: string): Promise<Tool[]> {
    const gatewayTools = await this.gatewayToolRepository.find({
      where: { gatewayId, isActive: true },
      relations: ['tool', 'tool.categories', 'tool.operation', 'tool.operation.api'],
    });

    return gatewayTools.map(gt => gt.tool).filter(Boolean);
  }
}