import { ToolCategory } from './tool-category.entity';
import { Tool } from './tool.entity';

describe('ToolCategory Entity', () => {
  let category: ToolCategory;

  beforeEach(() => {
    category = new ToolCategory();
    category.id = 'cat-1';
    category.name = 'Test Category';
    category.slug = 'test-category';
    category.organizationId = 'org-1';
    category.description = 'Test description';
    category.isActive = true;
    category.sortOrder = 0;
  });

  describe('getFullPath', () => {
    it('should return name for root category', () => {
      expect(category.getFullPath()).toBe('Test Category');
    });

    it('should return path with parent', () => {
      const parent = new ToolCategory();
      parent.name = 'Parent';
      category.parent = parent;

      expect(category.getFullPath()).toBe('Parent > Test Category');
    });

    it('should return full path with multiple ancestors', () => {
      const grandparent = new ToolCategory();
      grandparent.name = 'Grandparent';

      const parent = new ToolCategory();
      parent.name = 'Parent';
      parent.parent = grandparent;

      category.parent = parent;

      expect(category.getFullPath()).toBe('Grandparent > Parent > Test Category');
    });

    it('should handle deep nesting', () => {
      const root = new ToolCategory();
      root.name = 'Root';

      const level1 = new ToolCategory();
      level1.name = 'Level 1';
      level1.parent = root;

      const level2 = new ToolCategory();
      level2.name = 'Level 2';
      level2.parent = level1;

      const level3 = new ToolCategory();
      level3.name = 'Level 3';
      level3.parent = level2;

      category.parent = level3;

      expect(category.getFullPath()).toBe('Root > Level 1 > Level 2 > Level 3 > Test Category');
    });
  });

  describe('isChildOf', () => {
    it('should return false when no parent', () => {
      const otherCategory = new ToolCategory();
      otherCategory.id = 'cat-2';

      expect(category.isChildOf(otherCategory)).toBe(false);
    });

    it('should return true when direct parent', () => {
      const parent = new ToolCategory();
      parent.id = 'parent-1';
      category.parent = parent;

      expect(category.isChildOf(parent)).toBe(true);
    });

    it('should return false when not a parent', () => {
      const parent = new ToolCategory();
      parent.id = 'parent-1';
      category.parent = parent;

      const otherCategory = new ToolCategory();
      otherCategory.id = 'other-1';

      expect(category.isChildOf(otherCategory)).toBe(false);
    });

    it('should return true when ancestor (grandparent)', () => {
      const grandparent = new ToolCategory();
      grandparent.id = 'grandparent-1';

      const parent = new ToolCategory();
      parent.id = 'parent-1';
      parent.parent = grandparent;

      category.parent = parent;

      expect(category.isChildOf(grandparent)).toBe(true);
    });

    it('should return true when distant ancestor', () => {
      const root = new ToolCategory();
      root.id = 'root-1';

      const level1 = new ToolCategory();
      level1.id = 'level1-1';
      level1.parent = root;

      const level2 = new ToolCategory();
      level2.id = 'level2-1';
      level2.parent = level1;

      category.parent = level2;

      expect(category.isChildOf(root)).toBe(true);
      expect(category.isChildOf(level1)).toBe(true);
      expect(category.isChildOf(level2)).toBe(true);
    });

    it('should return false when sibling', () => {
      const parent = new ToolCategory();
      parent.id = 'parent-1';

      const sibling = new ToolCategory();
      sibling.id = 'sibling-1';
      sibling.parent = parent;

      category.parent = parent;

      expect(category.isChildOf(sibling)).toBe(false);
    });
  });

  describe('getDepth', () => {
    it('should return 0 for root category', () => {
      expect(category.getDepth()).toBe(0);
    });

    it('should return 1 for direct child', () => {
      const parent = new ToolCategory();
      parent.id = 'parent-1';
      category.parent = parent;

      expect(category.getDepth()).toBe(1);
    });

    it('should return 2 for grandchild', () => {
      const grandparent = new ToolCategory();
      grandparent.id = 'grandparent-1';

      const parent = new ToolCategory();
      parent.id = 'parent-1';
      parent.parent = grandparent;

      category.parent = parent;

      expect(category.getDepth()).toBe(2);
    });

    it('should return correct depth for deep nesting', () => {
      const root = new ToolCategory();
      root.id = 'root-1';

      const level1 = new ToolCategory();
      level1.id = 'level1-1';
      level1.parent = root;

      const level2 = new ToolCategory();
      level2.id = 'level2-1';
      level2.parent = level1;

      const level3 = new ToolCategory();
      level3.id = 'level3-1';
      level3.parent = level2;

      const level4 = new ToolCategory();
      level4.id = 'level4-1';
      level4.parent = level3;

      category.parent = level4;

      expect(category.getDepth()).toBe(5);
    });
  });

  describe('hasTools', () => {
    it('should return false when tools is undefined', () => {
      expect(category.hasTools()).toBeFalsy();
    });

    it('should return false when tools is empty array', () => {
      category.tools = [];

      expect(category.hasTools()).toBe(false);
    });

    it('should return true when tools array has items', () => {
      const tool1 = new Tool();
      tool1.id = 'tool-1';
      const tool2 = new Tool();
      tool2.id = 'tool-2';

      category.tools = [tool1, tool2];

      expect(category.hasTools()).toBe(true);
    });

    it('should return true when tools has single item', () => {
      const tool = new Tool();
      tool.id = 'tool-1';

      category.tools = [tool];

      expect(category.hasTools()).toBe(true);
    });
  });

  describe('Tree Structure Integration', () => {
    it('should handle complex tree with multiple branches', () => {
      // Create a tree:
      //       Root
      //      /    \
      //    A       B
      //   / \       \
      //  C   D       E
      //
      // Testing category C's relationships

      const root = new ToolCategory();
      root.id = 'root';
      root.name = 'Root';

      const a = new ToolCategory();
      a.id = 'a';
      a.name = 'A';
      a.parent = root;

      const b = new ToolCategory();
      b.id = 'b';
      b.name = 'B';
      b.parent = root;

      const c = new ToolCategory();
      c.id = 'c';
      c.name = 'C';
      c.parent = a;

      const d = new ToolCategory();
      d.id = 'd';
      d.name = 'D';
      d.parent = a;

      const e = new ToolCategory();
      e.id = 'e';
      e.name = 'E';
      e.parent = b;

      // Test C's properties
      expect(c.getDepth()).toBe(2);
      expect(c.getFullPath()).toBe('Root > A > C');
      expect(c.isChildOf(root)).toBe(true);
      expect(c.isChildOf(a)).toBe(true);
      expect(c.isChildOf(b)).toBe(false);
      expect(c.isChildOf(d)).toBe(false);
      expect(c.isChildOf(e)).toBe(false);

      // Test D's relationship with C (siblings)
      expect(d.isChildOf(c)).toBe(false);

      // Test E's relationships
      expect(e.isChildOf(root)).toBe(true);
      expect(e.isChildOf(b)).toBe(true);
      expect(e.isChildOf(a)).toBe(false);
    });
  });
});
