import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MemoryService } from '../memory.service';
import { EmbeddingService } from '../embedding.service';
import { Memory, MemoryType, MemoryScope } from '../../../entities/memory.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';

/**
 * Integration tests for MemoryService + EmbeddingService.
 *
 * Uses the REAL EmbeddingService (hash-based embedding) to verify that the
 * full pipeline of create -> embed -> search -> rank actually works together.
 * Only the TypeORM repository is mocked.
 */
describe('MemoryService (integration)', () => {
  let memoryService: MemoryService;
  let embeddingService: EmbeddingService;

  // In-memory store to simulate the repository
  let memoryStore: Memory[];
  let idCounter: number;
  let mockRepo: any;
  let mockQb: any;

  beforeEach(async () => {
    memoryStore = [];
    idCounter = 0;

    // Build a query builder mock that operates on memoryStore
    mockQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockImplementation(() => [...memoryStore]),
      getManyAndCount: jest.fn().mockImplementation(() => [[...memoryStore], memoryStore.length]),
      getRawMany: jest.fn().mockReturnValue([]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    mockRepo = {
      create: jest.fn().mockImplementation((data: Partial<Memory>) => {
        const m = new Memory();
        Object.assign(m, {
          id: `mem-${++idCounter}`,
          isActive: true,
          accessCount: 0,
          agentIds: [],
          tags: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        });
        return m;
      }),
      save: jest.fn().mockImplementation((memory: Memory) => {
        const existing = memoryStore.findIndex(m => m.id === memory.id);
        if (existing >= 0) {
          memoryStore[existing] = memory;
        } else {
          memoryStore.push(memory);
        }
        return Promise.resolve(memory);
      }),
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        const found = memoryStore.find(
          m => m.id === where.id && m.organizationId === where.organizationId,
        );
        return Promise.resolve(found || null);
      }),
      remove: jest.fn().mockImplementation((memory: Memory) => {
        memoryStore = memoryStore.filter(m => m.id !== memory.id);
        return Promise.resolve(memory);
      }),
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryService,
        EmbeddingService, // REAL service, not mocked
        {
          provide: getRepositoryToken(Memory),
          useValue: mockRepo,
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(null),
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
            logToolExecution: jest.fn().mockResolvedValue(null),
            logGatewayRequest: jest.fn().mockResolvedValue(null),
            logRunEvent: jest.fn().mockResolvedValue(null),
            computeChanges: jest.fn().mockReturnValue([]),
            findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
            getResourceHistory: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    memoryService = module.get<MemoryService>(MemoryService);
    embeddingService = module.get<EmbeddingService>(EmbeddingService);
  });

  describe('create', () => {
    it('should create a memory with a real embedding vector', async () => {
      const result = await memoryService.create('org-1', {
        content: 'JavaScript is a programming language used for web development',
        type: MemoryType.FACT,
      });

      expect(result.id).toBe('mem-1');
      expect(result.content).toBe('JavaScript is a programming language used for web development');
      expect(result.type).toBe(MemoryType.FACT);
      expect(result.scope).toBe(MemoryScope.SHARED); // default
      expect(result.embedding).toBeDefined();
      expect(result.embedding).not.toBeNull();
      expect(Array.isArray(result.embedding)).toBe(true);
      expect(result.embedding.length).toBe(256); // dimension from simpleTextVector
      // Embedding values should be normalized (L2 norm ~ 1)
      const norm = Math.sqrt(result.embedding.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    });

    it('should generate deterministic embeddings for the same text', async () => {
      const m1 = await memoryService.create('org-1', {
        content: 'the quick brown fox',
        type: MemoryType.FACT,
      });
      const m2 = await memoryService.create('org-1', {
        content: 'the quick brown fox',
        type: MemoryType.FACT,
      });

      expect(m1.embedding).toEqual(m2.embedding);
    });

    it('should generate different embeddings for different text', async () => {
      const m1 = await memoryService.create('org-1', {
        content: 'machine learning algorithms for classification',
        type: MemoryType.FACT,
      });
      const m2 = await memoryService.create('org-1', {
        content: 'baking a chocolate cake recipe instructions',
        type: MemoryType.FACT,
      });

      expect(m1.embedding).not.toEqual(m2.embedding);
    });
  });

  describe('search with real embeddings', () => {
    beforeEach(async () => {
      // Create a small corpus of memories with real embeddings
      await memoryService.create('org-1', {
        content: 'Python is a high level programming language used for data science and machine learning',
        type: MemoryType.FACT,
        scope: MemoryScope.SHARED,
      });
      await memoryService.create('org-1', {
        content: 'TypeScript is a typed superset of JavaScript for building web applications',
        type: MemoryType.FACT,
        scope: MemoryScope.SHARED,
      });
      await memoryService.create('org-1', {
        content: 'Chocolate cake requires flour sugar eggs butter and cocoa powder',
        type: MemoryType.FACT,
        scope: MemoryScope.SHARED,
      });

      // Make getMany return all active memories from the store
      mockQb.getMany.mockImplementation(() =>
        memoryStore.filter(m => m.isActive),
      );
      // Make the update().set().where().execute() chain work for access count
      mockQb.update.mockReturnValue(mockQb);
    });

    it('should rank identical-word query closest to matching memory', async () => {
      // Query that shares many exact words with the Python memory
      const results = await memoryService.search('org-1', 'Python high level programming language data science machine learning');

      expect(results.length).toBe(3);
      // The Python memory should be ranked first since it shares the most n-grams
      const pythonResult = results.find(r => r.content.includes('Python'));
      const cakeResult = results.find(r => r.content.includes('Chocolate'));
      expect(pythonResult).toBeDefined();
      expect(cakeResult).toBeDefined();
      expect(pythonResult!.similarity).toBeGreaterThan(cakeResult!.similarity);
    });

    it('should rank baking query closer to the cake memory', async () => {
      // Query that shares exact words with the cake memory
      const results = await memoryService.search('org-1', 'chocolate cake flour sugar eggs butter cocoa powder');

      const cakeResult = results.find(r => r.content.includes('Chocolate'));
      const pythonResult = results.find(r => r.content.includes('Python'));
      expect(cakeResult).toBeDefined();
      expect(pythonResult).toBeDefined();
      expect(cakeResult!.similarity).toBeGreaterThan(pythonResult!.similarity);
    });

    it('should respect the limit parameter', async () => {
      const results = await memoryService.search('org-1', 'programming', { limit: 2 });
      expect(results.length).toBe(2);
    });

    it('should return similarity scores between 0 and 1', async () => {
      const results = await memoryService.search('org-1', 'programming');
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0);
        expect(r.similarity).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('agent-scoped memory isolation', () => {
    const agentA = 'agent-aaa';
    const agentB = 'agent-bbb';

    beforeEach(async () => {
      // Agent-scoped memory for agent A
      await memoryService.create('org-1', {
        content: 'Secret instructions for agent A only',
        type: MemoryType.INSTRUCTION,
        scope: MemoryScope.AGENT,
        agentIds: [agentA],
      });
      // Shared memory
      await memoryService.create('org-1', {
        content: 'Shared knowledge everyone can see',
        type: MemoryType.FACT,
        scope: MemoryScope.SHARED,
      });
    });

    it('should return agent-scoped memory only when searched with the correct agentId', async () => {
      // Simulate the query builder filter logic:
      // When agentId is provided, the query builder andWhere is called with scope checks.
      // We simulate this by filtering in getMany.
      mockQb.getMany.mockImplementation(() => {
        // Return agent-A-scoped + shared (what the real DB would return for agentA)
        return memoryStore.filter(m =>
          m.isActive &&
          (m.scope === MemoryScope.SHARED ||
           m.scope === MemoryScope.GLOBAL ||
           (m.scope === MemoryScope.AGENT && m.agentIds.includes(agentA))),
        );
      });
      mockQb.update.mockReturnValue(mockQb);

      const results = await memoryService.search('org-1', 'instructions', { agentId: agentA });
      const secretResult = results.find(r => r.content.includes('Secret instructions'));
      expect(secretResult).toBeDefined();
    });

    it('should NOT return agent-A-scoped memory when agent B searches', async () => {
      mockQb.getMany.mockImplementation(() => {
        return memoryStore.filter(m =>
          m.isActive &&
          (m.scope === MemoryScope.SHARED ||
           m.scope === MemoryScope.GLOBAL ||
           (m.scope === MemoryScope.AGENT && m.agentIds.includes(agentB))),
        );
      });
      mockQb.update.mockReturnValue(mockQb);

      const results = await memoryService.search('org-1', 'instructions', { agentId: agentB });
      const secretResult = results.find(r => r.content.includes('Secret instructions'));
      expect(secretResult).toBeUndefined();
    });

    it('shared memory is always returned regardless of agentId', async () => {
      mockQb.getMany.mockImplementation(() => {
        return memoryStore.filter(m =>
          m.isActive &&
          (m.scope === MemoryScope.SHARED ||
           m.scope === MemoryScope.GLOBAL ||
           (m.scope === MemoryScope.AGENT && m.agentIds.includes(agentB))),
        );
      });
      mockQb.update.mockReturnValue(mockQb);

      const results = await memoryService.search('org-1', 'knowledge', { agentId: agentB });
      const sharedResult = results.find(r => r.content.includes('Shared knowledge'));
      expect(sharedResult).toBeDefined();
    });
  });

  describe('autoSave', () => {
    it('should save episode memory from a conversation with long assistant reply', async () => {
      const thread = [
        { role: 'user', content: 'Tell me about TypeScript generics and how they work in practice.' },
        {
          role: 'assistant',
          content: 'TypeScript generics allow you to write reusable code that works with multiple types while maintaining type safety. They are used extensively in utility types and collections.',
        },
      ];

      const result = await memoryService.autoSave('agent-1', 'org-1', thread);

      expect(result.length).toBe(1);
      expect(result[0].type).toBe(MemoryType.EPISODE);
      expect(result[0].scope).toBe(MemoryScope.AGENT);
      expect(result[0].agentIds).toEqual(['agent-1']);
      expect(result[0].tags).toEqual(['auto-saved']);
      expect(result[0].createdBy).toBe('system');
      expect(result[0].embedding).toBeDefined();
      expect(result[0].embedding!.length).toBe(256);
    });

    it('should NOT save when assistant content is too short (< 50 chars)', async () => {
      const thread = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
      ];

      const result = await memoryService.autoSave('agent-1', 'org-1', thread);
      expect(result).toEqual([]);
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('should NOT save when there is no assistant message', async () => {
      const thread = [
        { role: 'user', content: 'Tell me something' },
      ];

      const result = await memoryService.autoSave('agent-1', 'org-1', thread);
      expect(result).toEqual([]);
    });

    it('should truncate content at 2000 characters', async () => {
      const longContent = 'A'.repeat(3000);
      const thread = [
        { role: 'user', content: 'Generate a long response' },
        { role: 'assistant', content: longContent },
      ];

      const result = await memoryService.autoSave('agent-1', 'org-1', thread);

      expect(result.length).toBe(1);
      expect(result[0].content.length).toBe(2000);
    });

    it('should handle non-string assistant content (JSON stringify)', async () => {
      const thread = [
        { role: 'user', content: 'What tools?' },
        {
          role: 'assistant',
          content: { tools: ['tool1', 'tool2'], explanation: 'Here are the available tools for your workflow automation needs' },
        },
      ];

      const result = await memoryService.autoSave('agent-1', 'org-1', thread);
      expect(result.length).toBe(1);
      expect(result[0].content).toContain('tool1');
      expect(result[0].content).toContain('tool2');
    });

    it('should use the LAST assistant message from the thread', async () => {
      const thread = [
        { role: 'user', content: 'First question about APIs' },
        { role: 'assistant', content: 'First answer about APIs that is long enough to be saved by the auto-save mechanism.' },
        { role: 'user', content: 'Second question about databases and data storage solutions' },
        { role: 'assistant', content: 'Second answer about databases and persistence layers that is also long enough to be saved by the mechanism.' },
      ];

      const result = await memoryService.autoSave('agent-1', 'org-1', thread);
      expect(result.length).toBe(1);
      expect(result[0].content).toContain('Second answer about databases');
    });
  });

  describe('update with embedding regeneration', () => {
    it('should regenerate embedding when content changes', async () => {
      const created = await memoryService.create('org-1', {
        content: 'original content about programming',
        type: MemoryType.FACT,
      });
      const originalEmbedding = [...created.embedding];

      const updated = await memoryService.update(created.id, 'org-1', {
        content: 'completely different content about cooking',
      });

      expect(updated.embedding).toBeDefined();
      expect(updated.embedding).not.toEqual(originalEmbedding);
    });

    it('should NOT regenerate embedding when only tags change', async () => {
      const created = await memoryService.create('org-1', {
        content: 'some content about testing',
        type: MemoryType.FACT,
      });
      const originalEmbedding = [...created.embedding];

      const updated = await memoryService.update(created.id, 'org-1', {
        tags: ['new-tag'],
      });

      expect(updated.embedding).toEqual(originalEmbedding);
    });
  });

  describe('bulkCreate', () => {
    it('should create multiple memories each with their own embedding', async () => {
      const items = [
        { content: 'Memory about JavaScript frameworks and libraries', type: MemoryType.FACT },
        { content: 'Memory about Python data analysis and machine learning', type: MemoryType.FACT },
        { content: 'User prefers dark mode themes for the interface', type: MemoryType.PREFERENCE },
      ];

      const results = await memoryService.bulkCreate('org-1', items, 'user-1');

      expect(results.length).toBe(3);
      for (const mem of results) {
        expect(mem.embedding).toBeDefined();
        expect(mem.embedding!.length).toBe(256);
        expect(mem.createdBy).toBe('user-1');
      }
      // Each memory should have a unique embedding
      expect(results[0].embedding).not.toEqual(results[1].embedding);
      expect(results[1].embedding).not.toEqual(results[2].embedding);
    });
  });

  describe('EmbeddingService (direct tests)', () => {
    it('cosineSimilarity of identical vectors should be 1', () => {
      const v = [0.5, 0.3, 0.1, 0.8];
      expect(embeddingService.cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it('cosineSimilarity of orthogonal vectors should be 0', () => {
      const a = [1, 0, 0, 0];
      const b = [0, 1, 0, 0];
      expect(embeddingService.cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    it('cosineSimilarity with mismatched lengths returns 0', () => {
      expect(embeddingService.cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('cosineSimilarity with null/undefined returns 0', () => {
      expect(embeddingService.cosineSimilarity(null as any, [1, 2])).toBe(0);
      expect(embeddingService.cosineSimilarity([1, 2], null as any)).toBe(0);
    });

    it('cosineSimilarity with zero vectors returns 0', () => {
      expect(embeddingService.cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
    });

    it('generateEmbedding returns a 256-dimension normalized vector', async () => {
      const emb = await embeddingService.generateEmbedding('test input string');
      expect(emb).toBeDefined();
      expect(emb!.length).toBe(256);
      const norm = Math.sqrt(emb!.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    });

    it('similar texts produce higher cosine similarity than dissimilar texts', async () => {
      const embA = await embeddingService.generateEmbedding('web development with react');
      const embB = await embeddingService.generateEmbedding('frontend development with react components');
      const embC = await embeddingService.generateEmbedding('deep sea fishing techniques in the ocean');

      const simAB = embeddingService.cosineSimilarity(embA!, embB!);
      const simAC = embeddingService.cosineSimilarity(embA!, embC!);

      // A and B share many words/grams, A and C share very few
      expect(simAB).toBeGreaterThan(simAC);
    });
  });
});
