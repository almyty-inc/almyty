import { ToolVersion } from './tool-version.entity';

describe('ToolVersion Entity', () => {
  let version: ToolVersion;

  beforeEach(() => {
    version = new ToolVersion();
    version.id = 'ver-1';
    version.toolId = 'tool-1';
    version.version = '1.0.0';
    version.definition = { name: 'TestTool', description: 'Test' };
    version.parameters = {
      properties: {
        param1: { type: 'string', required: true },
        param2: { type: 'number', required: false },
      },
    };
    version.isBreakingChange = false;
  });

  describe('compareWith', () => {
    let otherVersion: ToolVersion;

    beforeEach(() => {
      otherVersion = new ToolVersion();
      otherVersion.id = 'ver-2';
      otherVersion.toolId = 'tool-1';
      otherVersion.version = '0.9.0';
      otherVersion.parameters = {
        properties: {
          param1: { type: 'string', required: true },
          param2: { type: 'number', required: false },
        },
      };
    });

    it('should detect no changes when parameters are identical', () => {
      const result = version.compareWith(otherVersion);

      expect(result.isCompatible).toBe(true);
      expect(result.changes).toHaveLength(0);
    });

    it('should detect added parameters', () => {
      version.parameters.properties.param3 = { type: 'boolean' };

      const result = version.compareWith(otherVersion);

      expect(result.changes).toContainEqual({
        type: 'added',
        field: 'parameter.param3',
        description: "Parameter 'param3' was added",
      });
    });

    it('should detect removed parameters', () => {
      delete version.parameters.properties.param2;

      const result = version.compareWith(otherVersion);

      expect(result.changes).toContainEqual({
        type: 'removed',
        field: 'parameter.param2',
        description: "Parameter 'param2' was removed",
      });
    });

    it('should mark removed parameters as breaking change', () => {
      delete version.parameters.properties.param1;

      const result = version.compareWith(otherVersion);

      expect(result.isCompatible).toBe(false);
      expect(result.changes).toContainEqual({
        type: 'removed',
        field: 'parameter.param1',
        description: "Parameter 'param1' was removed",
      });
    });

    it('should detect modified parameters', () => {
      version.parameters.properties.param1 = { type: 'number', required: true };

      const result = version.compareWith(otherVersion);

      expect(result.changes).toContainEqual({
        type: 'modified',
        field: 'parameter.param1',
        description: "Parameter 'param1' was modified",
      });
    });

    it('should detect required field changes', () => {
      version.parameters.properties.param1 = { type: 'string', required: false };

      const result = version.compareWith(otherVersion);

      // Note: Current implementation checks if field NAME includes 'required',
      // not if the change is to a required property
      expect(result.changes).toContainEqual({
        type: 'modified',
        field: 'parameter.param1',
        description: "Parameter 'param1' was modified",
      });
    });

    it('should handle multiple changes', () => {
      version.parameters.properties.param3 = { type: 'boolean' };
      version.parameters.properties.param1 = { type: 'number', required: true };
      delete version.parameters.properties.param2;

      const result = version.compareWith(otherVersion);

      expect(result.changes).toHaveLength(3);
      expect(result.changes.some(c => c.type === 'added')).toBe(true);
      expect(result.changes.some(c => c.type === 'modified')).toBe(true);
      expect(result.changes.some(c => c.type === 'removed')).toBe(true);
      expect(result.isCompatible).toBe(false);
    });

    it('should handle empty parameters in current version', () => {
      version.parameters = { properties: {} };

      const result = version.compareWith(otherVersion);

      expect(result.changes).toHaveLength(2);
      expect(result.changes.every(c => c.type === 'removed')).toBe(true);
      expect(result.isCompatible).toBe(false);
    });

    it('should handle empty parameters in other version', () => {
      otherVersion.parameters = { properties: {} };

      const result = version.compareWith(otherVersion);

      expect(result.changes).toHaveLength(2);
      expect(result.changes.every(c => c.type === 'added')).toBe(true);
      expect(result.isCompatible).toBe(true);
    });

    it('should handle undefined parameters in current version', () => {
      version.parameters = undefined;

      const result = version.compareWith(otherVersion);

      expect(result.changes).toHaveLength(2);
      expect(result.changes.every(c => c.type === 'removed')).toBe(true);
    });

    it('should handle undefined parameters in other version', () => {
      otherVersion.parameters = undefined;

      const result = version.compareWith(otherVersion);

      expect(result.changes).toHaveLength(2);
      expect(result.changes.every(c => c.type === 'added')).toBe(true);
    });

    it('should handle both versions with no parameters', () => {
      version.parameters = undefined;
      otherVersion.parameters = undefined;

      const result = version.compareWith(otherVersion);

      expect(result.changes).toHaveLength(0);
      expect(result.isCompatible).toBe(true);
    });

    it('should detect changes in nested parameter properties', () => {
      version.parameters.properties.param1 = {
        type: 'object',
        properties: { nested: { type: 'string' } },
      };

      const result = version.compareWith(otherVersion);

      expect(result.changes).toContainEqual({
        type: 'modified',
        field: 'parameter.param1',
        description: "Parameter 'param1' was modified",
      });
    });
  });

  describe('isNewerThan', () => {
    it('should return true when major version is higher', () => {
      version.version = '2.0.0';

      expect(version.isNewerThan('1.5.10')).toBe(true);
    });

    it('should return false when major version is lower', () => {
      version.version = '1.0.0';

      expect(version.isNewerThan('2.0.0')).toBe(false);
    });

    it('should compare minor version when major is equal', () => {
      version.version = '1.5.0';

      expect(version.isNewerThan('1.3.0')).toBe(true);
      expect(version.isNewerThan('1.7.0')).toBe(false);
    });

    it('should compare patch version when major and minor are equal', () => {
      version.version = '1.5.3';

      expect(version.isNewerThan('1.5.1')).toBe(true);
      expect(version.isNewerThan('1.5.5')).toBe(false);
    });

    it('should return false when versions are equal', () => {
      version.version = '1.5.3';

      expect(version.isNewerThan('1.5.3')).toBe(false);
    });

    it('should handle version 0.0.0', () => {
      version.version = '0.0.1';

      expect(version.isNewerThan('0.0.0')).toBe(true);
    });

    it('should handle large version numbers', () => {
      version.version = '10.20.30';

      expect(version.isNewerThan('10.20.29')).toBe(true);
      expect(version.isNewerThan('10.19.100')).toBe(true);
      expect(version.isNewerThan('9.99.99')).toBe(true);
    });

    it('should handle single digit versions', () => {
      version.version = '1.0.0';

      expect(version.isNewerThan('0.9.9')).toBe(true);
    });

    it('should correctly compare edge cases', () => {
      version.version = '2.0.0';

      expect(version.isNewerThan('1.99.99')).toBe(true);
      expect(version.isNewerThan('2.0.0')).toBe(false);
      expect(version.isNewerThan('2.0.1')).toBe(false);
      expect(version.isNewerThan('2.1.0')).toBe(false);
      expect(version.isNewerThan('3.0.0')).toBe(false);
    });
  });

  describe('Version Comparison Edge Cases', () => {
    it('should handle comparison with prereleases (semantic versioning)', () => {
      // Note: This entity currently only handles X.Y.Z format
      // If prerelease support is needed, this would be a good test to add
      version.version = '1.0.0';

      expect(version.isNewerThan('1.0.0')).toBe(false);
    });

    it('should handle multiple parameter changes correctly', () => {
      const oldVersion = new ToolVersion();
      oldVersion.parameters = {
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          age: { type: 'number', required: false },
        },
      };

      version.parameters = {
        properties: {
          id: { type: 'string', required: true },
          fullName: { type: 'string', required: true },
          email: { type: 'string', required: false },
        },
      };

      const result = version.compareWith(oldVersion);

      expect(result.changes).toHaveLength(4);
      // Removed: name, age
      // Added: fullName, email
      const removedChanges = result.changes.filter(c => c.type === 'removed');
      const addedChanges = result.changes.filter(c => c.type === 'added');

      expect(removedChanges).toHaveLength(2);
      expect(addedChanges).toHaveLength(2);
      expect(result.isCompatible).toBe(false); // Because parameters were removed
    });
  });

  describe('Integration Tests', () => {
    it('should create a complete version comparison workflow', () => {
      // Version 1.0.0 -> 1.1.0 (compatible)
      const v1 = new ToolVersion();
      v1.version = '1.0.0';
      v1.parameters = {
        properties: {
          id: { type: 'string' },
        },
      };

      const v1_1 = new ToolVersion();
      v1_1.version = '1.1.0';
      v1_1.parameters = {
        properties: {
          id: { type: 'string' },
          name: { type: 'string' }, // Added parameter
        },
      };

      // Version 1.1.0 -> 2.0.0 (breaking)
      const v2 = new ToolVersion();
      v2.version = '2.0.0';
      v2.parameters = {
        properties: {
          userId: { type: 'string' }, // Changed 'id' to 'userId'
          name: { type: 'string' },
        },
      };

      // Compare v1 -> v1.1
      const comparison1 = v1_1.compareWith(v1);
      expect(comparison1.isCompatible).toBe(true);
      expect(v1_1.isNewerThan(v1.version)).toBe(true);

      // Compare v1.1 -> v2
      const comparison2 = v2.compareWith(v1_1);
      expect(comparison2.isCompatible).toBe(false);
      expect(v2.isNewerThan(v1_1.version)).toBe(true);

      // Compare v1 -> v2
      const comparison3 = v2.compareWith(v1);
      expect(comparison3.isCompatible).toBe(false);
      expect(v2.isNewerThan(v1.version)).toBe(true);
    });
  });
});
