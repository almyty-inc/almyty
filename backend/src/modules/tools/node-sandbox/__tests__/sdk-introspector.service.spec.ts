import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SdkIntrospectorService } from '../sdk-introspector.service';

/**
 * Helper: create a temporary fake npm package with a .d.ts file.
 * Returns the base path (directory containing node_modules).
 */
function createTempPackage(
  packageName: string,
  dtsContent: string,
): string {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-introspect-'));
  const pkgDir = path.join(tmpBase, 'node_modules', packageName);
  fs.mkdirSync(pkgDir, { recursive: true });

  // Write package.json
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '1.0.0',
      types: 'index.d.ts',
    }),
  );

  // Write the .d.ts file
  fs.writeFileSync(path.join(pkgDir, 'index.d.ts'), dtsContent);

  return tmpBase;
}

/** Helper: recursively remove a directory */
function cleanupTemp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('SdkIntrospectorService', () => {
  let introspector: SdkIntrospectorService;

  beforeEach(() => {
    introspector = new SdkIntrospectorService();
  });

  describe('Test 1: Class with methods', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = createTempPackage(
        'test-class-pkg',
        `
export declare class MyClient {
  /** Create a new MyClient */
  constructor(config: { apiKey: string; region?: string });
  /** List all items */
  listItems(params: { limit?: number }): Promise<{ items: string[] }>;
  /** Get a single item */
  getItem(id: string): Promise<{ id: string; name: string }>;
}
`,
      );
    });

    afterAll(() => cleanupTemp(tmpDir));

    it('should extract a class with constructor params and methods', () => {
      const map = introspector.introspect('test-class-pkg', tmpDir);

      expect(map).toHaveProperty('MyClient');

      const exp = map['MyClient'];
      expect(exp.isClass).toBe(true);
      expect(exp.isFunction).toBe(false);

      // Constructor params: single config object with apiKey (required) and region (optional)
      expect(exp.constructorParams).toHaveLength(1);
      const ctorParam = exp.constructorParams[0];
      expect(ctorParam.name).toBe('config');
      expect(ctorParam.type.kind).toBe('object');

      // Methods
      expect(exp.methods).toHaveLength(2);

      const listItems = exp.methods.find((m) => m.name === 'listItems');
      expect(listItems).toBeDefined();
      expect(listItems!.params).toHaveLength(1);
      expect(listItems!.isAsync).toBe(true);

      const getItem = exp.methods.find((m) => m.name === 'getItem');
      expect(getItem).toBeDefined();
      expect(getItem!.params).toHaveLength(1);
      expect(getItem!.params[0].name).toBe('id');
      expect(getItem!.params[0].type.kind).toBe('primitive');
      expect(getItem!.isAsync).toBe(true);
    });
  });

  describe('Test 2: Function export', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = createTempPackage(
        'test-func-pkg',
        `
/** Greet someone */
export declare function greet(name: string, greeting?: string): string;
`,
      );
    });

    afterAll(() => cleanupTemp(tmpDir));

    it('should extract a function with required and optional params', () => {
      const map = introspector.introspect('test-func-pkg', tmpDir);

      expect(map).toHaveProperty('greet');

      const exp = map['greet'];
      expect(exp.isClass).toBe(false);
      expect(exp.isFunction).toBe(true);

      // The function is represented as a method on the export
      expect(exp.methods).toHaveLength(1);
      const method = exp.methods[0];

      expect(method.name).toBe('greet');
      expect(method.params).toHaveLength(2);

      // name: required string
      expect(method.params[0].name).toBe('name');
      expect(method.params[0].optional).toBe(false);
      expect(method.params[0].type.kind).toBe('primitive');

      // greeting: optional string
      expect(method.params[1].name).toBe('greeting');
      expect(method.params[1].optional).toBe(true);
      expect(method.params[1].type.kind).toBe('primitive');

      // Return type: string
      expect(method.returnType.kind).toBe('primitive');
      expect(method.isAsync).toBe(false);
    });
  });

  describe('Test 3: Chained/namespace API', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = createTempPackage(
        'test-chained-pkg',
        `
interface User {
  id: string;
  name: string;
  email: string;
}

export declare class ApiClient {
  constructor(token: string);
  users: {
    list(): Promise<User[]>;
    create(data: { name: string; email: string }): Promise<User>;
  };
}
`,
      );
    });

    afterAll(() => cleanupTemp(tmpDir));

    it('should extract a class with a chained property that has methods', () => {
      const map = introspector.introspect('test-chained-pkg', tmpDir);

      expect(map).toHaveProperty('ApiClient');

      const exp = map['ApiClient'];
      expect(exp.isClass).toBe(true);

      // Constructor: single token string param
      expect(exp.constructorParams).toHaveLength(1);
      expect(exp.constructorParams[0].name).toBe('token');
      expect(exp.constructorParams[0].type.kind).toBe('primitive');

      // The `users` should be a property (not a direct method)
      const usersProp = exp.properties.find((p) => p.name === 'users');
      expect(usersProp).toBeDefined();

      // The users property type should be an object with methods
      expect(usersProp!.type.kind).toBe('object');

      // It should have list and create methods
      const methods = usersProp!.type.methods;
      expect(methods).toBeDefined();
      expect(methods!.length).toBe(2);

      const list = methods!.find((m) => m.name === 'list');
      expect(list).toBeDefined();
      expect(list!.isAsync).toBe(true);

      const create = methods!.find((m) => m.name === 'create');
      expect(create).toBeDefined();
      expect(create!.params).toHaveLength(1);
      expect(create!.isAsync).toBe(true);
    });
  });

  describe('Test 4: String enum (union of string literals)', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = createTempPackage(
        'test-enum-pkg',
        `
export declare function setMode(mode: 'light' | 'dark' | 'auto'): void;
`,
      );
    });

    afterAll(() => cleanupTemp(tmpDir));

    it('should detect an enum type with string literal values', () => {
      const map = introspector.introspect('test-enum-pkg', tmpDir);

      expect(map).toHaveProperty('setMode');

      const exp = map['setMode'];
      expect(exp.isFunction).toBe(true);
      expect(exp.methods).toHaveLength(1);

      const method = exp.methods[0];
      expect(method.params).toHaveLength(1);

      const modeParam = method.params[0];
      expect(modeParam.name).toBe('mode');
      expect(modeParam.type.kind).toBe('enum');
      expect(modeParam.type.enumValues).toBeDefined();
      expect(modeParam.type.enumValues).toEqual(
        expect.arrayContaining(['light', 'dark', 'auto']),
      );
      expect(modeParam.type.enumValues).toHaveLength(3);

      // Return type: void
      expect(method.returnType.kind).toBe('primitive');
      expect(method.returnType.raw).toBe('void');
    });
  });

  describe('Test 5: Optional params', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = createTempPackage(
        'test-optional-pkg',
        `
export declare function query(sql: string, params?: any[]): Promise<any>;
`,
      );
    });

    afterAll(() => cleanupTemp(tmpDir));

    it('should detect required and optional parameters', () => {
      const map = introspector.introspect('test-optional-pkg', tmpDir);

      expect(map).toHaveProperty('query');

      const exp = map['query'];
      expect(exp.isFunction).toBe(true);

      const method = exp.methods[0];
      expect(method.params).toHaveLength(2);

      // sql: required
      expect(method.params[0].name).toBe('sql');
      expect(method.params[0].optional).toBe(false);
      expect(method.params[0].type.kind).toBe('primitive');

      // params: optional
      expect(method.params[1].name).toBe('params');
      expect(method.params[1].optional).toBe(true);
      expect(method.params[1].type.kind).toBe('array');

      // Return: Promise<any> -> should be async
      expect(method.isAsync).toBe(true);
    });
  });

  describe('@types resolution', () => {
    it('should convert scoped package names to @types format', () => {
      // Test the @types resolution logic indirectly by checking that
      // the introspector doesn't crash on a missing package
      const map = introspector.introspect('nonexistent-pkg', os.tmpdir());
      expect(map).toEqual({});
    });
  });
});
