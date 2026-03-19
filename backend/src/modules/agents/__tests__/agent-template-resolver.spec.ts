import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';

describe('AgentTemplateResolver', () => {
  let resolver: AgentTemplateResolver;

  beforeEach(() => {
    resolver = new AgentTemplateResolver();
  });

  // ── resolve: input.field ──────────────────────────────────────────────────

  describe('resolve {{input.field}}', () => {
    it('should resolve a simple input field', () => {
      const context: ExecutionContext = {
        input: { message: 'Hello world' },
        nodes: {},
      };

      const result = resolver.resolve('User said: {{input.message}}', context);
      expect(result).toBe('User said: Hello world');
    });

    it('should resolve multiple input fields', () => {
      const context: ExecutionContext = {
        input: { firstName: 'Jane', lastName: 'Doe' },
        nodes: {},
      };

      const result = resolver.resolve('Name: {{input.firstName}} {{input.lastName}}', context);
      expect(result).toBe('Name: Jane Doe');
    });

    it('should resolve numeric input values as strings', () => {
      const context: ExecutionContext = {
        input: { count: 42 },
        nodes: {},
      };

      const result = resolver.resolve('Count is {{input.count}}', context);
      expect(result).toBe('Count is 42');
    });

    it('should resolve boolean input values as strings', () => {
      const context: ExecutionContext = {
        input: { enabled: true },
        nodes: {},
      };

      const result = resolver.resolve('Enabled: {{input.enabled}}', context);
      expect(result).toBe('Enabled: true');
    });
  });

  // ── resolve: nodes.nodeId.output ──────────────────────────────────────────

  describe('resolve {{nodes.nodeId.output}}', () => {
    it('should resolve a node output string', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {
          llm_1: { output: 'The answer is 42.' },
        },
      };

      const result = resolver.resolve('LLM said: {{nodes.llm_1.output}}', context);
      expect(result).toBe('LLM said: The answer is 42.');
    });

    it('should JSON-stringify object node outputs', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {
          tool_1: { output: { users: ['Alice', 'Bob'] } },
        },
      };

      const result = resolver.resolve('Result: {{nodes.tool_1.output}}', context);
      expect(result).toBe(`Result: ${JSON.stringify({ users: ['Alice', 'Bob'] })}`);
    });
  });

  // ── resolve: nested paths ─────────────────────────────────────────────────

  describe('resolve nested paths {{nodes.nodeId.output.nested.field}}', () => {
    it('should resolve a deeply nested property', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {
          api_1: { output: { data: { user: { name: 'Alice' } } } },
        },
      };

      const result = resolver.resolve('User: {{nodes.api_1.output.data.user.name}}', context);
      expect(result).toBe('User: Alice');
    });

    it('should resolve nested input fields', () => {
      const context: ExecutionContext = {
        input: { config: { model: 'gpt-4' } },
        nodes: {},
      };

      const result = resolver.resolve('Model: {{input.config.model}}', context);
      expect(result).toBe('Model: gpt-4');
    });

    it('should JSON-stringify nested objects that are not leaf values', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {
          api_1: { output: { data: { user: { name: 'Alice', age: 30 } } } },
        },
      };

      const result = resolver.resolve('{{nodes.api_1.output.data.user}}', context);
      expect(result).toBe(JSON.stringify({ name: 'Alice', age: 30 }));
    });
  });

  // ── resolve: raw value passthrough ────────────────────────────────────────

  describe('returns raw value when template is not a string', () => {
    it('should return null as-is', () => {
      const context: ExecutionContext = { input: {}, nodes: {} };
      const result = resolver.resolve(null as any, context);
      expect(result).toBeNull();
    });

    it('should return undefined as-is', () => {
      const context: ExecutionContext = { input: {}, nodes: {} };
      const result = resolver.resolve(undefined as any, context);
      expect(result).toBeUndefined();
    });

    it('should return a number as-is', () => {
      const context: ExecutionContext = { input: {}, nodes: {} };
      const result = resolver.resolve(123 as any, context);
      expect(result).toBe(123);
    });

    it('should return an empty string unchanged', () => {
      const context: ExecutionContext = { input: {}, nodes: {} };
      const result = resolver.resolve('', context);
      expect(result).toBe('');
    });
  });

  // ── resolve: missing paths ────────────────────────────────────────────────

  describe('handles missing paths gracefully', () => {
    it('should return empty string for a missing input field', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {},
      };

      const result = resolver.resolve('Value: {{input.missing}}', context);
      expect(result).toBe('Value: ');
    });

    it('should return empty string for a missing node', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {},
      };

      const result = resolver.resolve('{{nodes.nonexistent.output}}', context);
      expect(result).toBe('');
    });

    it('should return empty string for a missing nested path', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {
          llm_1: { output: 'just a string' },
        },
      };

      const result = resolver.resolve('{{nodes.llm_1.output.deep.nested}}', context);
      expect(result).toBe('');
    });

    it('should return empty string when intermediate path is null', () => {
      const context: ExecutionContext = {
        input: { config: null },
        nodes: {},
      };

      const result = resolver.resolve('{{input.config.value}}', context);
      expect(result).toBe('');
    });
  });

  // ── resolve: variables ────────────────────────────────────────────────────

  describe('handles {{variables.key}}', () => {
    it('should resolve a variable', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {},
        variables: { apiKey: 'sk-12345' },
      };

      const result = resolver.resolve('Key: {{variables.apiKey}}', context);
      expect(result).toBe('Key: sk-12345');
    });

    it('should return empty string for a missing variable', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {},
        variables: {},
      };

      const result = resolver.resolve('{{variables.missing}}', context);
      expect(result).toBe('');
    });

    it('should resolve nested variable values', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {},
        variables: { db: { host: 'localhost', port: 5432 } },
      };

      const result = resolver.resolve('Host: {{variables.db.host}}', context);
      expect(result).toBe('Host: localhost');
    });
  });

  // ── resolve: complex templates with multiple variables ────────────────────

  describe('handles complex templates with multiple variables', () => {
    it('should resolve a template mixing input, nodes, and variables', () => {
      const context: ExecutionContext = {
        input: { topic: 'AI safety' },
        nodes: {
          llm_1: { output: 'AI safety is crucial.' },
        },
        variables: { format: 'markdown' },
      };

      const template = 'Topic: {{input.topic}}\nSummary: {{nodes.llm_1.output}}\nFormat: {{variables.format}}';
      const result = resolver.resolve(template, context);

      expect(result).toBe('Topic: AI safety\nSummary: AI safety is crucial.\nFormat: markdown');
    });

    it('should handle repeated references to the same path', () => {
      const context: ExecutionContext = {
        input: { name: 'Bob' },
        nodes: {},
      };

      const result = resolver.resolve('Hello {{input.name}}, welcome {{input.name}}!', context);
      expect(result).toBe('Hello Bob, welcome Bob!');
    });

    it('should handle a template with no placeholders', () => {
      const context: ExecutionContext = {
        input: { unused: 'data' },
        nodes: {},
      };

      const result = resolver.resolve('No placeholders here.', context);
      expect(result).toBe('No placeholders here.');
    });

    it('should trim whitespace inside template expressions', () => {
      const context: ExecutionContext = {
        input: { name: 'Alice' },
        nodes: {},
      };

      const result = resolver.resolve('{{ input.name }}', context);
      expect(result).toBe('Alice');
    });
  });

  // ── resolveValue ──────────────────────────────────────────────────────────

  describe('resolveValue', () => {
    it('should return the raw resolved value (not stringified)', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {
          tool_1: { output: { items: [1, 2, 3] } },
        },
      };

      const result = resolver.resolveValue('nodes.tool_1.output', context);
      expect(result).toEqual({ items: [1, 2, 3] });
    });

    it('should return undefined for a missing path', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {},
      };

      const result = resolver.resolveValue('nodes.missing.output', context);
      expect(result).toBeUndefined();
    });

    it('should trim whitespace from path', () => {
      const context: ExecutionContext = {
        input: { key: 'value' },
        nodes: {},
      };

      const result = resolver.resolveValue('  input.key  ', context);
      expect(result).toBe('value');
    });
  });
});
