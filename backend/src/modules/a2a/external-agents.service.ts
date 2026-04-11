import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';

import { ExternalAgent } from '../../entities/external-agent.entity';
import { validateUrl } from '../../common/security/url-validator';

@Injectable()
export class ExternalAgentsService {
  private readonly logger = new Logger(ExternalAgentsService.name);

  constructor(
    @InjectRepository(ExternalAgent)
    private readonly externalAgentRepository: Repository<ExternalAgent>,
  ) {}

  /**
   * Fetch an agent card from a URL. Tries the URL as-is first,
   * then appends .well-known/agent-card.json if the first attempt fails.
   */
  async importFromUrl(
    orgId: string,
    userId: string,
    url: string,
  ): Promise<any> {
    const validation = validateUrl(url);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const sanitizedUrl = validation.sanitizedUrl!;

    // Try the URL as-is first
    let card: any;
    let resolvedUrl = sanitizedUrl;
    try {
      const response = await axios.get(sanitizedUrl, { timeout: 10_000 });
      card = response.data;
    } catch {
      // Try .well-known/agent-card.json
      const wellKnownUrl = sanitizedUrl.replace(/\/?$/, '/.well-known/agent-card.json');
      const wkValidation = validateUrl(wellKnownUrl);
      if (!wkValidation.valid) {
        throw new BadRequestException(wkValidation.error);
      }
      try {
        const response = await axios.get(wkValidation.sanitizedUrl!, { timeout: 10_000 });
        card = response.data;
        resolvedUrl = wkValidation.sanitizedUrl!;
      } catch (err: any) {
        throw new BadRequestException(
          `Failed to fetch agent card from ${sanitizedUrl} or ${wellKnownUrl}: ${err.message}`,
        );
      }
    }

    if (!card || typeof card !== 'object') {
      throw new BadRequestException('Invalid agent card: expected a JSON object');
    }

    return {
      card,
      resolvedUrl,
      name: card.name || 'Unknown Agent',
      description: card.description || null,
      baseRpcUrl: card.url || null,
      capabilities: card.capabilities || null,
      securitySchemes: card.securitySchemes || null,
    };
  }

  async create(
    orgId: string,
    data: {
      name: string;
      description?: string;
      agentCardUrl: string;
      cachedCard?: Record<string, any>;
      baseRpcUrl?: string;
      credentialId?: string;
      selectedSecurityScheme?: string;
    },
  ): Promise<ExternalAgent> {
    const agent = this.externalAgentRepository.create({
      organizationId: orgId,
      name: data.name,
      description: data.description || null,
      agentCardUrl: data.agentCardUrl,
      cachedCard: data.cachedCard || null,
      cardLastFetchedAt: data.cachedCard ? new Date() : null,
      baseRpcUrl: data.baseRpcUrl || null,
      credentialId: data.credentialId || null,
      selectedSecurityScheme: data.selectedSecurityScheme || null,
      capabilities: data.cachedCard?.capabilities || null,
      status: 'active',
    });

    return this.externalAgentRepository.save(agent);
  }

  async findAll(orgId: string): Promise<ExternalAgent[]> {
    return this.externalAgentRepository.find({
      where: { organizationId: orgId },
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: string, orgId: string): Promise<ExternalAgent> {
    const agent = await this.externalAgentRepository.findOne({
      where: { id, organizationId: orgId },
    });
    if (!agent) {
      throw new NotFoundException(`External agent '${id}' not found`);
    }
    return agent;
  }

  async update(
    id: string,
    orgId: string,
    data: Partial<{
      name: string;
      description: string;
      agentCardUrl: string;
      cachedCard: Record<string, any>;
      baseRpcUrl: string;
      credentialId: string;
      selectedSecurityScheme: string;
      status: 'active' | 'error' | 'card_stale';
    }>,
  ): Promise<ExternalAgent> {
    const agent = await this.findById(id, orgId);
    Object.assign(agent, data);
    return this.externalAgentRepository.save(agent);
  }

  async delete(id: string, orgId: string): Promise<void> {
    const agent = await this.findById(id, orgId);
    await this.externalAgentRepository.remove(agent);
  }

  async refreshCard(id: string, orgId: string): Promise<ExternalAgent> {
    const agent = await this.findById(id, orgId);

    const validation = validateUrl(agent.agentCardUrl);
    if (!validation.valid) {
      agent.status = 'error';
      return this.externalAgentRepository.save(agent);
    }

    try {
      const response = await axios.get(validation.sanitizedUrl!, { timeout: 10_000 });
      const card = response.data;

      agent.cachedCard = card;
      agent.cardLastFetchedAt = new Date();
      agent.baseRpcUrl = card.url || agent.baseRpcUrl;
      agent.capabilities = card.capabilities || agent.capabilities;
      agent.status = 'active';
    } catch (err: any) {
      this.logger.warn(`Failed to refresh card for external agent '${id}': ${err.message}`);
      agent.status = 'card_stale';
    }

    return this.externalAgentRepository.save(agent);
  }
}
