import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Memory, MemoryType, MemoryScope } from '../../entities/memory.entity';
import { EmbeddingService } from './embedding.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

export interface MemorySearchFilters {
  organizationId: string;
  type?: MemoryType;
  scope?: MemoryScope;
  agentId?: string;
  tags?: string[];
  isActive?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @InjectRepository(Memory)
    private readonly memoryRepository: Repository<Memory>,
    private readonly embeddingService: EmbeddingService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(
    organizationId: string,
    data: {
      content: string;
      type: MemoryType;
      scope?: MemoryScope;
      agentIds?: string[];
      tags?: string[];
      source?: { type: string; id?: string; name?: string };
      metadata?: Record<string, any>;
    },
    createdBy?: string,
  ): Promise<Memory> {
    const embedding = await this.embeddingService.generateEmbedding(data.content);

    const memory = this.memoryRepository.create({
      organizationId,
      content: data.content,
      type: data.type,
      scope: data.scope || MemoryScope.SHARED,
      agentIds: data.agentIds || [],
      tags: data.tags || [],
      source: data.source || null,
      metadata: data.metadata || null,
      embedding,
      createdBy,
    });

    const saved = await this.memoryRepository.save(memory);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId: createdBy, action: AuditAction.MEMORY_STORE, resourceType: AuditResource.MEMORY, resourceId: saved.id, resourceName: data.type, details: { scope: data.scope, tags: data.tags } });

    return saved;
  }

  async findAll(filters: MemorySearchFilters) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 50, 100);
    const skip = (page - 1) * limit;

    const qb = this.memoryRepository.createQueryBuilder('memory')
      .where('memory.organizationId = :organizationId', { organizationId: filters.organizationId });

    if (filters.type) {
      qb.andWhere('memory.type = :type', { type: filters.type });
    }
    if (filters.scope) {
      qb.andWhere('memory.scope = :scope', { scope: filters.scope });
    }
    if (filters.isActive !== undefined) {
      qb.andWhere('memory.isActive = :isActive', { isActive: filters.isActive });
    }
    if (filters.agentId) {
      qb.andWhere(':agentId = ANY(memory.agentIds)', { agentId: filters.agentId });
    }
    if (filters.tags && filters.tags.length > 0) {
      qb.andWhere('memory.tags && :tags', { tags: filters.tags });
    }
    if (filters.search) {
      qb.andWhere('memory.content ILIKE :search', { search: `%${filters.search}%` });
    }

    qb.orderBy('memory.createdAt', 'DESC');
    qb.skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findById(id: string, organizationId: string): Promise<Memory> {
    const memory = await this.memoryRepository.findOne({
      where: { id, organizationId },
    });
    if (!memory) {
      throw new NotFoundException('Memory not found');
    }
    return memory;
  }

  async update(id: string, organizationId: string, data: Partial<{
    content: string;
    type: MemoryType;
    scope: MemoryScope;
    agentIds: string[];
    tags: string[];
    isActive: boolean;
    metadata: Record<string, any>;
  }>): Promise<Memory> {
    const memory = await this.findById(id, organizationId);

    // Re-generate embedding if content changed
    if (data.content && data.content !== memory.content) {
      const embedding = await this.embeddingService.generateEmbedding(data.content);
      Object.assign(memory, data, { embedding });
    } else {
      Object.assign(memory, data);
    }

    const saved = await this.memoryRepository.save(memory);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.MEMORY_UPDATE, resourceType: AuditResource.MEMORY, resourceId: saved.id, resourceName: saved.type });

    return saved;
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const memory = await this.findById(id, organizationId);
    await this.memoryRepository.remove(memory);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.MEMORY_DELETE, resourceType: AuditResource.MEMORY, resourceId: id, resourceName: memory.type });
  }

  async bulkCreate(
    organizationId: string,
    items: Array<{
      content: string;
      type: MemoryType;
      scope?: MemoryScope;
      agentIds?: string[];
      tags?: string[];
    }>,
    createdBy?: string,
  ): Promise<Memory[]> {
    const memories: Memory[] = [];
    for (const item of items) {
      const memory = await this.create(organizationId, item, createdBy);
      memories.push(memory);
    }
    return memories;
  }

  /**
   * Semantic search: find relevant memories for a query
   */
  async search(
    organizationId: string,
    query: string,
    options?: {
      agentId?: string;
      limit?: number;
      scope?: MemoryScope;
      type?: MemoryType;
    },
  ): Promise<Array<Memory & { similarity: number }>> {
    const limit = options?.limit || 10;
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);

    // Build filter conditions
    const qb = this.memoryRepository.createQueryBuilder('memory')
      .where('memory.organizationId = :organizationId', { organizationId })
      .andWhere('memory.isActive = true');

    if (options?.scope) {
      qb.andWhere('memory.scope = :scope', { scope: options.scope });
    }
    if (options?.type) {
      qb.andWhere('memory.type = :type', { type: options.type });
    }
    if (options?.agentId) {
      // Agent can access: agent-scoped (if in agentIds) + shared + global
      qb.andWhere(
        '(memory.scope = :shared OR memory.scope = :global OR (memory.scope = :agent AND :agentId = ANY(memory.agentIds)))',
        { shared: MemoryScope.SHARED, global: MemoryScope.GLOBAL, agent: MemoryScope.AGENT, agentId: options.agentId },
      );
    }

    const memories = await qb.getMany();

    // Compute similarity in-memory (upgrade to pgvector for production scale)
    if (!queryEmbedding) {
      // Fallback: text search ranking
      const queryLower = query.toLowerCase();
      return memories
        .map(m => ({
          ...m,
          similarity: m.content.toLowerCase().includes(queryLower) ? 0.8 : 0.1,
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    }

    const results = memories
      .filter(m => m.embedding && m.embedding.length > 0)
      .map(m => ({
        ...m,
        similarity: this.embeddingService.cosineSimilarity(queryEmbedding, m.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // Update access counts
    const ids = results.map(r => r.id);
    if (ids.length > 0) {
      await this.memoryRepository
        .createQueryBuilder()
        .update(Memory)
        .set({
          accessCount: () => '"accessCount" + 1',
          lastAccessedAt: new Date(),
        })
        .where('id IN (:...ids)', { ids })
        .execute();

      // Audit log (fire-and-forget)
      this.auditLogService.log({ organizationId, action: AuditAction.MEMORY_RECALL, resourceType: AuditResource.MEMORY, resourceId: ids[0], details: { query, resultCount: results.length, agentId: options?.agentId } });
    }

    return results;
  }

  /**
   * Recall relevant memories for an agent (convenience wrapper)
   */
  async recall(
    agentId: string,
    organizationId: string,
    query: string,
    limit: number = 10,
  ): Promise<Memory[]> {
    const results = await this.search(organizationId, query, { agentId, limit });
    return results;
  }

  /**
   * Get all unique tags in an organization
   */
  async getTags(organizationId: string): Promise<string[]> {
    const result = await this.memoryRepository
      .createQueryBuilder('memory')
      .select('DISTINCT unnest(memory.tags)', 'tag')
      .where('memory.organizationId = :organizationId', { organizationId })
      .getRawMany();
    return result.map(r => r.tag).sort();
  }

  /**
   * Auto-save: extract key facts from a conversation and store as memories
   */
  async autoSave(
    agentId: string,
    organizationId: string,
    thread: Array<{ role: string; content: any }>,
    source?: { type: string; id?: string; name?: string },
  ): Promise<Memory[]> {
    // Simple approach: save the last assistant message as an episode
    const lastAssistant = [...thread].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant || !lastAssistant.content) return [];

    const content = typeof lastAssistant.content === 'string'
      ? lastAssistant.content
      : JSON.stringify(lastAssistant.content);

    // Only save if substantial (> 50 chars)
    if (content.length < 50) return [];

    const memory = await this.create(
      organizationId,
      {
        content: content.substring(0, 2000), // Cap at 2000 chars
        type: MemoryType.EPISODE,
        scope: MemoryScope.AGENT,
        agentIds: [agentId],
        source: source || { type: 'agent', id: agentId },
        tags: ['auto-saved'],
      },
      'system',
    );

    return [memory];
  }
}
