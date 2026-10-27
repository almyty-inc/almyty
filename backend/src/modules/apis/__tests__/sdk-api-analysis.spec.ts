import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

import { ApisSdkAnalysisHelper, SDK_ANALYSIS_JOB } from '../apis-sdk-analysis.helper';
import { ApisController } from '../apis.controller';
import { SchemaImportProcessor } from '../../jobs/processors/schema-import.processor';
import { DependencyManagerService } from '../../tools/node-sandbox/dependency-manager.service';
import { SdkIntrospectorService } from '../../tools/node-sandbox/sdk-introspector.service';
import { SdkCodeAssemblerService } from '../../tools/node-sandbox/sdk-code-assembler.service';
import type { SdkConfig } from '../../tools/node-sandbox/types';
import type { SdkPackageMap } from '../sdk-package-map';

/**
 * An SDK API used to be created with `sdkMaps: {}` and nothing ever filled
 * it: SdkIntrospectorService was registered and never called, so the
 * Create tool form said "No SDK maps found" for every SDK API.
 *
 * This walks the whole path with a real (tiny) npm package checked in
 * under fixtures/greeter-sdk: the real DependencyManagerService installs
 * it (npm itself is replaced by a copy of the fixture, so no network), the
 * real introspector reads its declarations, the map lands on the API, and
 * a tool config built from that map -- in the shape the Create tool form
 * sends -- is assembled by the real assembler and actually calls the
 * package.
 */
const FIXTURE = path.join(__dirname, 'fixtures', 'greeter-sdk');

function fakeRepo(api: any) {
  return {
    findOne: jest.fn(async () => api),
    save: jest.fn(async (row: any) => Object.assign(api, row)),
    update: jest.fn(async (_where: any, patch: any) => Object.assign(api, patch)),
  };
}

describe('SDK API analysis (end to end with a real package)', () => {
  let depsDir: string;
  let prevDepsPath: string | undefined;
  let deps: DependencyManagerService;

  beforeEach(() => {
    depsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-analysis-'));
    prevDepsPath = process.env.SANDBOX_DEPS_PATH;
    process.env.SANDBOX_DEPS_PATH = depsDir;
    deps = new DependencyManagerService();
    // "npm install": copy the fixture package into node_modules.
    jest.spyOn(deps as any, 'runNpmInstall').mockImplementation(async (cwd: any) => {
      const target = path.join(cwd, 'node_modules', 'greeter-sdk');
      fs.mkdirSync(target, { recursive: true });
      for (const f of fs.readdirSync(FIXTURE)) fs.copyFileSync(path.join(FIXTURE, f), path.join(target, f));
    });
  });

  afterEach(() => {
    if (prevDepsPath === undefined) delete process.env.SANDBOX_DEPS_PATH;
    else process.env.SANDBOX_DEPS_PATH = prevDepsPath;
    fs.rmSync(depsDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function sdkApi() {
    return {
      id: 'api-1',
      organizationId: 'org-1',
      name: 'Greeter',
      type: 'sdk',
      dependencies: { 'greeter-sdk': '^1.0.0' },
      npmRegistry: null,
      sdkMaps: {},
      metadata: null,
      ownerUserId: null,
      lastImportError: 'stale',
      lastImportFailedAt: new Date(),
    };
  }

  it('installs the package, reads its declarations into sdkMaps and marks the API ready', async () => {
    const api = sdkApi();
    const helper = new ApisSdkAnalysisHelper(fakeRepo(api) as any, deps, new SdkIntrospectorService());

    const progress: number[] = [];
    const state = await helper.analyse('api-1', 'org-1', (p) => { progress.push(p); });

    expect(state.state).toBe('ready');
    expect(state.packages).toEqual([{ name: 'greeter-sdk', version: '1.0.0', exports: 2, callables: 3 }]);
    expect(progress[progress.length - 1]).toBe(100);
    expect(api.metadata).toEqual(expect.objectContaining({ sdkAnalysis: expect.objectContaining({ state: 'ready' }) }));
    expect(api.lastImportError).toBeNull();

    const map = (api.sdkMaps as Record<string, SdkPackageMap>)['greeter-sdk'];
    expect(map.packageName).toBe('greeter-sdk');
    expect(map.version).toBe('1.0.0');
    const greeter = map.exports.find((e) => e.name === 'Greeter')!;
    expect(greeter.kind).toBe('class');
    expect(greeter.constructorParams).toEqual([
      expect.objectContaining({ name: 'options', required: true, type: expect.objectContaining({ kind: 'object' }) }),
    ]);
    expect(greeter.methods).toEqual([
      expect.objectContaining({ name: 'greet', isAsync: true, params: [expect.objectContaining({ name: 'name', required: true, type: expect.objectContaining({ kind: 'string' }) })] }),
    ]);
    const math = greeter.properties!.find((p) => p.name === 'math')!;
    expect(math.methods!.map((m) => m.name)).toEqual(['add']);
    const shout = map.exports.find((e) => e.name === 'shout')!;
    expect(shout.kind).toBe('function');
    expect(shout.params).toEqual([expect.objectContaining({ name: 'text', required: true })]);
  });

  it('builds tools from the map that really call the package', async () => {
    const api = sdkApi();
    const helper = new ApisSdkAnalysisHelper(fakeRepo(api) as any, deps, new SdkIntrospectorService());
    await helper.analyse('api-1', 'org-1');
    const { installDir } = await deps.ensureInstalled(api.dependencies);
    const assembler = new SdkCodeAssemblerService();
    const run = async (config: SdkConfig, parameters: Record<string, any>) => {
      const code = assembler.assemble(config);
      const req = createRequire(path.join(installDir, 'package.json'));
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
      return new AsyncFunction('parameters', 'credentials', 'require', code)(parameters, {}, req);
    };

    // Class + method, as the Create tool form sends it.
    expect(
      await run(
        {
          packageName: 'greeter-sdk',
          version: '1.0.0',
          imports: [{ name: 'Greeter', isDefault: false }],
          construct: { className: 'Greeter', args: [{ type: 'object', properties: { prefix: { type: 'literal', value: 'Hi' } } }] },
          call: { methodPath: 'greet', args: [{ type: 'parameter', key: 'name' }] },
        },
        { name: 'Ada' },
      ),
    ).toBe('Hi, Ada!');
    // A chained method on a property.
    expect(
      await run(
        {
          packageName: 'greeter-sdk',
          version: '1.0.0',
          imports: [{ name: 'Greeter', isDefault: false }],
          construct: { className: 'Greeter', args: [] },
          call: { methodPath: 'math.add', args: [{ type: 'parameter', key: 'a' }, { type: 'parameter', key: 'b' }] },
        },
        { a: 2, b: 3 },
      ),
    ).toBe(5);
    // A standalone function export: no construction.
    expect(
      await run(
        {
          packageName: 'greeter-sdk',
          version: '1.0.0',
          imports: [{ name: 'shout', isDefault: false }],
          call: { methodPath: 'shout', args: [{ type: 'parameter', key: 'text' }] },
        },
        { text: 'quiet' },
      ),
    ).toBe('QUIET');
  });

  it('records why an analysis failed on the API and marks it failed', async () => {
    const api = sdkApi();
    (deps as any).runNpmInstall.mockRejectedValue(new Error('npm ERR! 404 greeter-sdk not found'));
    const helper = new ApisSdkAnalysisHelper(fakeRepo(api) as any, deps, new SdkIntrospectorService());
    await expect(helper.analyse('api-1', 'org-1')).rejects.toThrow('404');
    expect(api.lastImportError).toContain('404 greeter-sdk not found');
    expect((api.metadata as any).sdkAnalysis.state).toBe('failed');
  });

  it('says so when a package ships no type declarations', async () => {
    const api = sdkApi();
    (deps as any).runNpmInstall.mockImplementation(async (cwd: string) => {
      const target = path.join(cwd, 'node_modules', 'greeter-sdk');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'greeter-sdk', version: '1.0.0' }));
      fs.copyFileSync(path.join(FIXTURE, 'index.js'), path.join(target, 'index.js'));
    });
    jest.spyOn(deps as any, 'installMissingTypes').mockResolvedValue(undefined);
    const helper = new ApisSdkAnalysisHelper(fakeRepo(api) as any, deps, new SdkIntrospectorService());
    const state = await helper.analyse('api-1', 'org-1');
    expect(state.state).toBe('ready');
    expect(api.lastImportError).toMatch(/No type declarations found for greeter-sdk/);
  });
});

describe('SDK analysis wiring', () => {
  it('creating an SDK API queues its analysis', async () => {
    const created = { id: 'api-1', organizationId: 'org-1', type: 'sdk' };
    const apisService = { createSdkApi: jest.fn(async () => created) };
    const queue = { add: jest.fn(async () => ({ id: 'job-7' })) };
    const helper = { markQueued: jest.fn(async () => undefined) };
    const controller = new ApisController(apisService as any, {} as any, queue as any, {} as any, helper as any);

    const res = await controller.createSdkApi(
      { name: 'Greeter', dependencies: { 'greeter-sdk': '^1.0.0' } } as any,
      { user: { currentOrganizationId: 'org-1', id: 'user-1' } },
    );

    expect(queue.add).toHaveBeenCalledWith(SDK_ANALYSIS_JOB, { apiId: 'api-1', organizationId: 'org-1' }, expect.any(Object));
    expect(helper.markQueued).toHaveBeenCalledWith('api-1', 'org-1');
    expect(res.data.sdkAnalysisJobId).toBe('job-7');
  });

  it('the import worker runs the analysis job', async () => {
    const helper = { analyse: jest.fn(async () => ({ state: 'ready', packages: [] })) };
    const processor = new SchemaImportProcessor({} as any, {} as any, helper as any);
    const job: any = { id: 1, data: { apiId: 'api-1', organizationId: 'org-1' }, progress: jest.fn() };
    await processor.handleSdkAnalysis(job);
    expect(helper.analyse).toHaveBeenCalledWith('api-1', 'org-1', expect.any(Function));
  });
});
