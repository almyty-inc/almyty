import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { SkillGeneratorService } from '../skill-generator.service';
import { Tool, ToolType, ToolStatus } from '../../../entities/tool.entity';
import { Gateway, GatewayType, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';

describe('SkillGeneratorService', () => {
  let service: SkillGeneratorService;
  let toolRepository: any;
  let gatewayRepository: any;
  let gatewayToolRepository: any;

  const mockTool: Partial<Tool> = {
    id: 'tool-1',
    name: 'getPetById',
    description: 'Find pet by ID',
    type: ToolType.QUERY,
    status: ToolStatus.ACTIVE,
    version: '1.0.0',
    parameters: {
      type: 'object',
      properties: {
        petId: { type: 'integer', description: 'ID of pet to return' },
        format: { type: 'string', description: 'Response format' },
      },
      required: ['petId'],
    },
    categories: [{ id: 'cat-1', name: 'Pets' } as any],
    operation: {
      id: 'op-1',
      method: 'GET',
      endpoint: '/pet/{petId}',
      api: { baseUrl: 'https://petstore.swagger.io/v2' },
    } as any,
  };

  const mockMutationTool: Partial<Tool> = {
    id: 'tool-2',
    name: 'addPet',
    description: 'Add a new pet to the store',
    type: ToolType.MUTATION,
    status: ToolStatus.ACTIVE,
    version: '1.0.0',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pet name' },
        status: { type: 'string', description: 'Pet status' },
      },
      required: ['name'],
    },
    categories: [],
    operation: {
      id: 'op-2',
      method: 'POST',
      endpoint: '/pet',
      api: { baseUrl: 'https://petstore.swagger.io/v2' },
    } as any,
  };

  const mockGateway = {
    id: 'gw-1',
    name: 'Petstore Gateway',
    endpoint: '/petstore',
    type: GatewayType.MCP,
    status: GatewayStatus.ACTIVE,
  };

  beforeEach(async () => {
    toolRepository = {
      findOne: jest.fn(),
    };
    gatewayRepository = {
      findOne: jest.fn(),
    };
    gatewayToolRepository = {
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillGeneratorService,
        { provide: getRepositoryToken(Tool), useValue: toolRepository },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepository },
        { provide: getRepositoryToken(GatewayTool), useValue: gatewayToolRepository },
      ],
    }).compile();

    service = module.get<SkillGeneratorService>(SkillGeneratorService);
  });

  describe('generateToolSkill', () => {
    it('should generate a SKILL.md with Agent Skills standard format', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolSkill('tool-1', 'org-1');

      expect(result.name).toBe('getpetbyid');
      expect(result.toolCount).toBe(1);
      // YAML frontmatter — Agent Skills standard
      expect(result.content).toContain('---');
      expect(result.content).toContain('name: getpetbyid');
      expect(result.content).toContain('description:');
      expect(result.content).toContain('Find pet by ID');
      // Metadata
      expect(result.content).toContain('metadata:');
      expect(result.content).toContain('author: almyty');
      expect(result.content).toContain('generated: "true"');
      // Content sections
      expect(result.content).toContain('# getPetById');
      expect(result.content).toContain('## When to use');
      expect(result.content).toContain('Find pet by ID');
      // HTTP endpoint
      expect(result.content).toContain('## HTTP endpoint');
      expect(result.content).toContain('GET https://petstore.swagger.io/v2/pet/{petId}');
      // Parameters
      expect(result.content).toContain('## Parameters');
      expect(result.content).toContain('`petId` (integer, **required**)');
      expect(result.content).toContain('`format` (string)');
      // Curl example
      expect(result.content).toContain('## Example');
      expect(result.content).toContain('curl');
      expect(result.content).toContain('petstore.swagger.io');
    });

    it('should generate a skill for a mutation tool with POST curl', async () => {
      toolRepository.findOne.mockResolvedValue(mockMutationTool);

      const result = await service.generateToolSkill('tool-2', 'org-1');

      expect(result.content).toContain('Add a new pet to the store');
      expect(result.content).toContain('curl -X POST');
      expect(result.content).toContain('Content-Type: application/json');
    });

    it('should generate a skill for an action tool', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        type: ToolType.ACTION,
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      expect(result.content).toContain('## When to use');
    });

    it('should handle tool with no parameters', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        parameters: {},
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // Should not have parameters section
      expect(result.content).not.toContain('## Parameters');
    });

    it('should throw NotFoundException for missing tool', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(service.generateToolSkill('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should escape YAML special characters in description', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        description: 'Find pet: by "ID"',
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // Description should be YAML-escaped (quoted)
      expect(result.content).toMatch(/description: ".*Find pet.*"/);
    });

    it('should not include generic trigger boilerplate in description', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // Description should be clean — no "Use when you need to call this API"
      expect(result.content).not.toContain('Use when you need to');
      expect(result.content).toContain('description: Find pet by ID');
    });

    it('should handle tool with no operation (custom tool)', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        operation: null,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name to greet' },
          },
          required: ['name'],
        },
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // No HTTP endpoint section
      expect(result.content).not.toContain('## HTTP endpoint');
      // No error handling (only for API tools)
      expect(result.content).not.toContain('## Error handling');
      // JSON example instead of curl
      expect(result.content).toContain('```json');
    });
  });

  describe('generateGatewaySkills', () => {
    it('should generate a skill bundle for a gateway with tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.name).toBe('petstore-gateway');
      expect(result.toolCount).toBe(2);
      expect(result.content).toContain('# Petstore Gateway');
      expect(result.content).toContain('This gateway provides 2 API tools.');
      expect(result.content).toContain('## Available tools');
      expect(result.content).toContain('**getPetById**');
      expect(result.content).toContain('**addPet**');
      expect(result.content).toContain('### getPetById');
      expect(result.content).toContain('### addPet');
      // Should have HTTP endpoints, not almyty_execute
      expect(result.content).toContain('GET https://petstore.swagger.io/v2/pet/{petId}');
      expect(result.content).toContain('curl');
      // Metadata
      expect(result.content).toContain('metadata:');
      expect(result.content).toContain('author: almyty');
    });

    it('should generate an empty skill for a gateway with no tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.toolCount).toBe(0);
      expect(result.content).toContain('No tools are currently assigned');
      expect(result.content).toContain('metadata:');
    });

    it('should throw NotFoundException for missing gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.generateGatewaySkills('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should filter out null tools from gateway tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: null, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.toolCount).toBe(1);
    });

    it('should include parameter details in per-tool sections', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.content).toContain('**Parameters:**');
      expect(result.content).toContain('`petId` (integer, required)');
      expect(result.content).toContain('`format` (string)');
    });
  });

  describe('generateIndividualSkills', () => {
    it('multi-tool gateway: prefixes each skill name with the gateway slug', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');

      expect(result).toHaveLength(2);
      // Each skill gets `<gateway-slug>-<tool-suffix>`. Names are
      // both kebab and start with the gateway endpoint slug, so a
      // skill is unambiguously traceable to its source gateway.
      for (const skill of result) {
        expect(skill.name).toMatch(/^petstore-/);
        expect(skill.name).toMatch(/^[a-z0-9-]+$/);
        expect(skill.fileName).toBe(skill.name);
        expect(skill.content).toContain(`name: ${skill.name}`);
      }
      // No `almyty-` prefix on the directory or in frontmatter.
      expect(result[0].name.startsWith('almyty-')).toBe(false);
      expect(result[0].content).not.toMatch(/^name: almyty-/m);
    });

    it('single-tool gateway still gets `{gateway}-{op}` shape (deterministic)', async () => {
      // Critical: a 1-tool gateway must produce the same shape as a
      // multi-tool gateway. If we collapsed to just `gateway-slug`
      // for the 1-tool case, adding a 2nd tool would silently rename
      // the existing skill — that breaks idempotence and confuses
      // users who scripted `npx @almyty/skills run <name>`.
      gatewayRepository.findOne.mockResolvedValue({
        ...mockGateway,
        endpoint: '/open-meteo-skills',
      });
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');

      expect(result).toHaveLength(1);
      // The op suffix is derived from operation.summary or tool.name,
      // never empty — so the resulting slug always has the
      // `<gateway>-<suffix>` shape.
      expect(result[0].name.startsWith('open-meteo-skills-')).toBe(true);
      expect(result[0].name).not.toBe('open-meteo-skills');
      expect(result[0].fileName).toBe(result[0].name);
      expect(result[0].content).toContain(`name: ${result[0].name}`);
    });

    it('multi-tool gateway: uses operation.summary when available', async () => {
      const toolWithSummary = {
        ...mockTool,
        name: 'something_else',
        operation: { ...mockTool.operation, summary: 'Find pet by ID' },
      };
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: toolWithSummary, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');
      expect(result[0].name).toBe('petstore-find-pet-by-id');
    });

    it('dedupes shared kebab segments between gateway slug and tool name', async () => {
      // Real-world case from staging: gateway endpoint is
      // `/open-meteo-skills` and the tool was auto-named
      // `open-meteo-weather-get-v1-forecast` during schema import.
      // Naive concat → `open-meteo-skills-open-meteo-weather-...`
      // (the `open-meteo` segment repeats). Dedup → drop the
      // duplicated head segments.
      const dupTool = {
        ...mockTool,
        name: 'open-meteo-weather-get-v1-forecast',
        // No summary so the fallback (tool.name) path runs.
        operation: { ...mockTool.operation, summary: undefined },
      };
      gatewayRepository.findOne.mockResolvedValue({
        ...mockGateway,
        endpoint: '/open-meteo-skills',
      });
      gatewayToolRepository.find.mockResolvedValue([
        { tool: dupTool, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');
      expect(result[0].name).toBe('open-meteo-skills-weather-get-v1-forecast');
    });

    it('caps composed slugs at 64 chars per agentskills.io spec', async () => {
      const longTool = {
        ...mockTool,
        name: 'a-very-long-tool-name-that-exceeds-the-budget-when-prefixed-with-the-gateway-slug',
        operation: { ...mockTool.operation, summary: undefined },
      };
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: longTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');
      expect(result[0].name.length).toBeLessThanOrEqual(64);
      expect(result[0].name).toMatch(/^petstore-/);
      expect(result[0].name.endsWith('-')).toBe(false);
    });

    it('GraphQL operation: SKILL.md includes a starter query template', async () => {
      const graphqlTool = {
        ...mockTool,
        name: 'country',
        operation: {
          id: 'op-gql',
          name: 'country',
          method: 'POST',
          endpoint: '/graphql',
          type: 'query',
          parameters: {
            body: {
              query: { type: 'string', required: true },
              variables: {
                type: 'object',
                properties: { code: { type: 'string' } },
                required: ['code'],
              },
            },
          },
          // Parser-emitted return-type structure used by the
          // skill-generator to render a useful selection set.
          responses: {
            '200': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'object',
                    properties: {
                      name:    { type: 'string' },
                      code:    { type: 'string' },
                      emoji:   { type: 'string' },
                      capital: { type: 'string' },
                      languages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
                      continent: { type: 'object', properties: { name: { type: 'string' } } },
                    },
                  },
                },
              },
            },
          },
          api: { baseUrl: 'https://countries.example/graphql', type: 'graphql' },
        } as any,
      };
      gatewayRepository.findOne.mockResolvedValue({
        ...mockGateway,
        endpoint: '/countries',
      });
      gatewayToolRepository.find.mockResolvedValue([
        { tool: graphqlTool, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');
      const md = result[0].content;
      expect(md).toContain('## GraphQL operation');
      expect(md).toContain('```graphql');
      expect(md).toContain('query country($code: String!)');
      expect(md).toContain('country(code: $code)');
      // Scalar return-type fields should land directly in the selection.
      expect(md).toContain('name');
      expect(md).toContain('emoji');
      expect(md).toContain('capital');
      // Object / array-of-object fields get a stub subselection so
      // the query parses but the agent knows to expand them.
      expect(md).toMatch(/continent\s*\{\s*__typename/);
      expect(md).toMatch(/languages\s*\{\s*__typename/);
    });

    it('GraphQL: falls back to __typename stub when parser did not capture return fields', async () => {
      const graphqlTool = {
        ...mockTool,
        name: 'legacyOp',
        operation: {
          id: 'op-gql-legacy',
          name: 'legacyOp',
          method: 'POST',
          endpoint: '/graphql',
          type: 'query',
          parameters: {
            body: {
              query: { type: 'string', required: true },
              variables: { type: 'object', properties: {} },
            },
          },
          // Pre-walk parser output: data.type=object but no
          // properties — represents tools imported before the
          // depth-walk change.
          responses: {
            '200': { schema: { type: 'object', properties: { data: { type: 'object' } } } },
          },
          api: { baseUrl: 'https://example.com/graphql', type: 'graphql' },
        } as any,
      };
      gatewayRepository.findOne.mockResolvedValue({ ...mockGateway, endpoint: '/legacy' });
      gatewayToolRepository.find.mockResolvedValue([{ tool: graphqlTool, isActive: true }]);
      const result = await service.generateIndividualSkills('gw-1', 'org-1');
      expect(result[0].content).toContain('__typename');
    });

    it('truncation keeps the unique tail when many tools share a long prefix', async () => {
      // Real-world Translate case: ~40 gRPC methods all named
      // `real_google_translate_protobuf_translation_service_<method>`.
      // Naive head-keeping truncation collapsed every method to the
      // same 64-char prefix because the unique `<method>` got cut
      // off the end.
      const detect = {
        ...mockTool,
        name: 'real_google_translate_protobuf_translation_service_detect_language',
        operation: { ...mockTool.operation, summary: undefined },
      };
      const translate = {
        ...mockTool,
        id: 'tool-translate',
        name: 'real_google_translate_protobuf_translation_service_translate_text',
        operation: { ...mockTool.operation, summary: undefined },
      };
      gatewayRepository.findOne.mockResolvedValue({
        ...mockGateway,
        endpoint: '/translate-grpc',
      });
      gatewayToolRepository.find.mockResolvedValue([
        { tool: detect, isActive: true },
        { tool: translate, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');
      // Both must produce DIFFERENT slugs. Tail-keeping preserves
      // `detect-language` and `translate-text`.
      expect(result[0].name).not.toBe(result[1].name);
      expect(result[0].name.length).toBeLessThanOrEqual(64);
      expect(result[1].name.length).toBeLessThanOrEqual(64);
      // Method-name segments must survive in both.
      expect(result[0].name).toContain('detect');
      expect(result[1].name).toContain('translate-text');
    });

    it('should throw NotFoundException for missing gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.generateIndividualSkills('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should return empty array for gateway with no tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');

      expect(result).toHaveLength(0);
    });
  });
});
