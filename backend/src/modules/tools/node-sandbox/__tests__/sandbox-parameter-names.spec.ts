import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';
import { SandboxExecutionRequest } from '../types';
import { bareParameterNames } from '../sandbox-parameter-names';

/**
 * Create tool says a JavaScript tool reads a parameter as `params.name`
 * or directly as `name` (tool-form.tsx). The sandbox used to bind only
 * `parameters`, so both failed ("n is not defined") -- the staging gate's
 * "reads a parameter the way the form says" failure.
 *
 * These run real worker threads, as a tool does.
 */

let service: NodeSandboxService;

beforeAll(() => {
  const depManager = {
    ensureInstalled: jest.fn().mockResolvedValue({ installDir: '/tmp/fake-deps', cached: true, installTimeMs: 0 }),
    listCached: jest.fn().mockReturnValue([]),
    clearCache: jest.fn(),
  } as unknown as DependencyManagerService;
  service = new NodeSandboxService(depManager);
});

jest.setTimeout(30_000);

function exec(code: string, parameters: Record<string, any>, opts?: Partial<SandboxExecutionRequest>) {
  return service.execute({ code, parameters, timeoutMs: 5000, memoryLimitMb: 64, ...opts });
}

describe('JavaScript tool parameters', () => {
  it('reads a parameter directly by its name', async () => {
    const r = await exec('return { square: n * n, double: n * 2 }', { n: 7 });
    expect(r.error).toBeUndefined();
    expect(r.data).toEqual({ square: 49, double: 14 });
  });

  it('reads a parameter as params.name, and still as parameters.name', async () => {
    const r = await exec('return [params.n, parameters.n, params === parameters]', { n: 3 });
    expect(r.data).toEqual([3, 3, true]);
  });

  it('runs strict code with bare names bound', async () => {
    const r = await exec('"use strict"; return city.toUpperCase()', { city: 'berlin' });
    expect(r.data).toBe('BERLIN');
  });

  it('a parameter that is not a valid name is read through params only', async () => {
    const r = await exec("return [params['first-name'], params['class'], typeof params.await]", {
      'first-name': 'Ada',
      class: 'x',
      await: 1,
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual(['Ada', 'x', 'number']);
  });

  describe('a parameter cannot replace the sandbox', () => {
    it('a parameter named require does not replace the allowlisted require', async () => {
      const r = await exec(
        "try { require('child_process'); return 'loaded' } catch (e) { return [typeof require, e.message] }",
        { require: 'not a function' },
      );
      expect(r.data[0]).toBe('function');
      expect(r.data[1]).toMatch(/not allowed in the sandbox/);
    });

    it('parameters named parameters / params / credentials / tools do not replace them', async () => {
      const r = await exec('return [typeof parameters, typeof params, credentials, params.credentials]', {
        parameters: 'p',
        params: 'q',
        credentials: 'stolen',
        tools: 'x',
      }, { credentials: { token: 'real' } });
      expect(r.data).toEqual(['object', 'object', { token: 'real' }, 'stolen']);
    });

    it('a parameter named process shadows only the tool code; the worker keeps its scrubbed env', async () => {
      // The bare name is a local of the tool function. Code compiled
      // outside it (Function) sees the real, scrubbed process.
      const r = await exec(
        "return [process, Function('return typeof process.env')(), Function('return process.env.HOME')()]",
        { process: 'shadow' },
      );
      expect(r.error).toBeUndefined();
      expect(r.data[0]).toBe('shadow');
      expect(r.data[1]).toBe('object');
      expect(r.data[2]).toBeUndefined();
    });

    it('a shadowed global changes nothing outside the tool function', async () => {
      const r = await exec("return [fetch, typeof Function('return fetch')()]", { fetch: 'shadow' });
      expect(r.data).toEqual(['shadow', 'function']);
    });

    it('a crafted name cannot inject code into the function signature', async () => {
      const r = await exec('return Object.keys(params).length', {
        'a = (globalThis.pwned = 1)': 1,
        'b){globalThis.pwned=1;(function(': 2,
        'c\n': 3,
      });
      expect(r.success).toBe(true);
      expect(r.data).toBe(3);
      const after = await exec('return typeof globalThis.pwned', {});
      expect(after.data).toBe('undefined');
    });
  });
});

describe('bareParameterNames', () => {
  it('keeps valid names and leaves out reserved words and the sandbox bindings', () => {
    expect(
      bareParameterNames({
        n: 1, $x: 1, _y: 1, city2: 1, 'a-b': 1, '2a': 1, class: 1, await: 1, eval: 1, arguments: 1,
        let: 1, yield: 1, require: 1, tools: 1, params: 1, parameters: 1, credentials: 1, 'a b': 1, '': 1,
      }),
    ).toEqual(['n', '$x', '_y', 'city2']);
  });

  it('takes nothing from a non-object', () => {
    expect(bareParameterNames(null)).toEqual([]);
    expect(bareParameterNames([1, 2])).toEqual([]);
    expect(bareParameterNames('abc')).toEqual([]);
  });
});
