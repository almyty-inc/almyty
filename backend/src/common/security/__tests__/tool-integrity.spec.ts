import { computeToolHash, verifyToolIntegrity } from '../tool-integrity';

describe('Tool Integrity', () => {
  const mockTool = {
    name: 'getPetById',
    description: 'Find pet by ID',
    parameters: {
      type: 'object',
      properties: {
        petId: { type: 'integer', description: 'ID of pet to return' },
      },
      required: ['petId'],
    },
    code: null,
    executionMethod: 'rest',
  };

  describe('computeToolHash', () => {
    it('should produce a SHA-256 hex hash', () => {
      const result = computeToolHash(mockTool);

      expect(result.algorithm).toBe('sha256');
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.fields).toEqual(['name', 'description', 'parameters', 'code', 'executionMethod']);
    });

    it('should produce deterministic hashes', () => {
      const hash1 = computeToolHash(mockTool);
      const hash2 = computeToolHash(mockTool);

      expect(hash1.hash).toBe(hash2.hash);
    });

    it('should produce different hashes for different tools', () => {
      const tool2 = { ...mockTool, name: 'addPet' };

      expect(computeToolHash(mockTool).hash).not.toBe(computeToolHash(tool2).hash);
    });

    it('should produce different hashes when description changes', () => {
      const modified = { ...mockTool, description: 'Modified description' };

      expect(computeToolHash(mockTool).hash).not.toBe(computeToolHash(modified).hash);
    });

    it('should produce different hashes when parameters change', () => {
      const modified = {
        ...mockTool,
        parameters: {
          type: 'object',
          properties: {
            petId: { type: 'string', description: 'ID of pet to return' },
          },
          required: ['petId'],
        },
      };

      expect(computeToolHash(mockTool).hash).not.toBe(computeToolHash(modified).hash);
    });

    it('should produce different hashes when code changes', () => {
      const withCode = { ...mockTool, code: 'return params.petId;' };

      expect(computeToolHash(mockTool).hash).not.toBe(computeToolHash(withCode).hash);
    });

    it('should produce consistent hash regardless of parameter key order', () => {
      const tool1 = {
        ...mockTool,
        parameters: { b: 1, a: 2, c: 3 },
      };
      const tool2 = {
        ...mockTool,
        parameters: { c: 3, a: 2, b: 1 },
      };

      expect(computeToolHash(tool1).hash).toBe(computeToolHash(tool2).hash);
    });

    it('should handle missing optional fields', () => {
      const minimal = { name: 'test' };
      const result = computeToolHash(minimal);

      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle empty parameters', () => {
      const tool = { ...mockTool, parameters: {} };
      const result = computeToolHash(tool);

      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle deeply nested parameters consistently', () => {
      const tool1 = {
        ...mockTool,
        parameters: {
          type: 'object',
          properties: {
            z: { type: 'string' },
            a: { type: 'object', properties: { y: { type: 'number' }, b: { type: 'string' } } },
          },
        },
      };
      const tool2 = {
        ...mockTool,
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'object', properties: { b: { type: 'string' }, y: { type: 'number' } } },
            z: { type: 'string' },
          },
        },
      };

      expect(computeToolHash(tool1).hash).toBe(computeToolHash(tool2).hash);
    });
  });

  describe('verifyToolIntegrity', () => {
    it('should return valid when hash matches', () => {
      const { hash } = computeToolHash(mockTool);
      const result = verifyToolIntegrity(mockTool, hash);

      expect(result.valid).toBe(true);
      expect(result.currentHash).toBe(hash);
    });

    it('should return invalid when tool has been modified', () => {
      const { hash } = computeToolHash(mockTool);
      const modified = { ...mockTool, description: 'Tampered description' };
      const result = verifyToolIntegrity(modified, hash);

      expect(result.valid).toBe(false);
      expect(result.currentHash).not.toBe(hash);
    });

    it('should return invalid when code has been injected', () => {
      const { hash } = computeToolHash(mockTool);
      const tampered = { ...mockTool, code: 'process.exit(1)' };
      const result = verifyToolIntegrity(tampered, hash);

      expect(result.valid).toBe(false);
    });

    it('should return invalid when parameters schema changed', () => {
      const { hash } = computeToolHash(mockTool);
      const tampered = {
        ...mockTool,
        parameters: {
          ...mockTool.parameters,
          properties: {
            ...mockTool.parameters.properties,
            malicious: { type: 'string' },
          },
        },
      };
      const result = verifyToolIntegrity(tampered, hash);

      expect(result.valid).toBe(false);
    });

    it('should return invalid with garbage hash', () => {
      const result = verifyToolIntegrity(mockTool, 'not-a-real-hash');

      expect(result.valid).toBe(false);
    });
  });
});
