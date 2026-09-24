import { membershipFixture } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';
import { readFileSync } from 'fs';
import { join } from 'path';

import axios from 'axios';

import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * `gateway_tools.transformations` is applied to real calls.
 *
 * The column was writable through both halves of the gateway-tool DTO,
 * listed in UPDATABLE_GATEWAY_TOOL_FIELDS and copied by
 * gateway-tool-transfer -- and `transformInput`/`transformOutput` had no
 * caller anywhere in src or ee. The two methods had thorough unit tests
 * of their own, which is precisely why this survived: the mapping was
 * saved, echoed back by the API, and then dropped on every call.
 *
 * Third instance of the same shape on the same row, after securityPolicy
 * and permissions, so the fix follows theirs: read at the one gateway
 * choke point in ToolExecutorService.
 *
 * The behavioural arms prove the wiring. The source-reading arms pin the
 * two things a behavioural test cannot see: that the column is still
 * SELECTed (a `select:` list that drops it makes every mapping silently
 * undefined while every behavioural test that builds its own row keeps
 * passing), and that the input mapping still runs ahead of validation
 * and the cache key.
 */
describe('gateway tool transformations reach execution', () => {
  const mockedAxios = axios as unknown as jest.Mock;

  function buildExecutor(
    gatewayTool: any,
    over: { validate?: any; cache?: any; toolConfiguration?: any } = {},
  ) {
    const tool = {
      id: 'tool-1',
      name: 'fixture',
      organizationId: 'org-1',
      status: ToolStatus.ACTIVE,
      type: ToolType.API,
      httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
      configuration: over.toolConfiguration ?? {},
      api: null,
      operation: null,
    } as any;

    return new ToolExecutorService(
      { findOne: jest.fn().mockResolvedValue(tool) } as any,
      {} as any,
      { findOne: jest.fn() } as any,
      {} as any,
      new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any),
      {} as any,
      {} as any,
      {} as any,
      {
        checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
        getCachedResult: jest.fn().mockResolvedValue(null),
        cacheResult: jest.fn().mockResolvedValue(undefined),
        ...(over.cache ?? {}),
      } as any,
      {
        validateParameters: over.validate ?? jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
        recordExecution: jest.fn().mockResolvedValue(undefined),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      // The tool attached, switched on, to an org-wide gw-1: the gateway
      // serves it, so what is under test is only the row's transformations.
      fakeRepository<GatewayTool>({
        seed: [Object.assign(gatewayTool, { gatewayId: 'gw-1', toolId: 'tool-1', isActive: true, gateway: { id: 'gw-1', visibility: 'org' } })],
        make: () => new GatewayTool(),
      }) as any,
      undefined,
      // The real execution gate; these calls carry no user, so org tools pass.
      membershipFixture().executionAccess,
    );
  }

  /** A real entity, so the executor calls the real transform methods. */
  const gatewayToolWith = (transformations: any): GatewayTool => {
    const row = new GatewayTool();
    row.id = 'gt-1';
    row.transformations = transformations;
    return row;
  };

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { legacy_id: 7 }, headers: {} });
  });

  const gatewayCall = { userId: '', organizationId: 'org-1', gatewayId: 'gw-1' };

  it('renames request parameters before the call goes out', async () => {
    const service = buildExecutor(gatewayToolWith({ inputMapping: { q: 'query' } }));

    const result = await service.executeTool('tool-1', { q: 'boots' }, gatewayCall);

    expect(result.success).toBe(true);
    const sent = mockedAxios.mock.calls[0][0];
    expect(JSON.stringify(sent)).toContain('query');
    expect(sent.params ?? {}).not.toHaveProperty('q');
  });

  it('validates the parameters the tool will actually receive, not the caller names', async () => {
    const validate = jest.fn().mockResolvedValue({ isValid: true, errors: [] });
    const service = buildExecutor(gatewayToolWith({ inputMapping: { q: 'query' } }), { validate });

    await service.executeTool('tool-1', { q: 'boots' }, gatewayCall);

    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0][1]).toEqual({ query: 'boots' });
  });

  it('renames response fields on the way back', async () => {
    const service = buildExecutor(gatewayToolWith({ outputMapping: { legacy_id: 'id' } }));

    const result = await service.executeTool('tool-1', {}, gatewayCall);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 7 });
  });

  it('maps a cache hit too, so a cached answer and a fresh one agree', async () => {
    const service = buildExecutor(gatewayToolWith({ outputMapping: { legacy_id: 'id' } }), {
      toolConfiguration: { cache: { enabled: true } },
      cache: {
        getCachedResult: jest
          .fn()
          .mockResolvedValue({ success: true, data: { legacy_id: 7 }, executionTime: 1 }),
      },
    });

    const result = await service.executeTool('tool-1', {}, gatewayCall);

    expect(result.cached).toBe(true);
    expect(result.data).toEqual({ id: 7 });
  });

  it('leaves a call that never came through a gateway alone', async () => {
    // The mapping belongs to one tool on one gateway. A direct API call or
    // an agent node that did not come through a gateway is not governed by
    // it -- same rule as securityPolicy and permissions.
    const service = buildExecutor(gatewayToolWith({ outputMapping: { legacy_id: 'id' } }));

    const result = await service.executeTool('tool-1', {}, {
      userId: '',
      organizationId: 'org-1',
    });

    expect(result.data).toEqual({ legacy_id: 7 });
  });

  describe('the source still reads the column', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');

    it('the gateway_tool lookup selects transformations', () => {
      const source = src('modules/tools/tool-executor.service.ts');
      const at = source.indexOf('this.gatewayToolRepository.findOne({');
      expect(at).toBeGreaterThan(-1); // update this guard if the lookup moved
      expect(source.slice(at, at + 300)).toContain('transformations: true');
    });

    it('the input mapping runs before validation and the cache key', () => {
      const source = src('modules/tools/tool-executor.service.ts');
      const transform = source.indexOf('gatewayTool.transformInput(');
      const validate = source.indexOf('this.stats.validateParameters(');
      const cacheKey = source.indexOf('this.cacheRateLimit.getCachedResult(');
      expect(transform).toBeGreaterThan(-1);
      expect(validate).toBeGreaterThan(transform);
      expect(cacheKey).toBeGreaterThan(transform);
    });

    it('every successful return goes through the output transform', () => {
      const source = src('modules/tools/tool-executor.service.ts');
      const body = source.slice(
        source.indexOf('async executeTool('),
        source.indexOf('private applyOutputTransform('),
      );
      // Each `return { ... success-shaped result }` in executeTool must be
      // wrapped; a new dispatch branch that forgets is the next instance
      // of this bug.
      const wrapped = body.match(/return this\.applyOutputTransform\(gatewayTool, \{/g) ?? [];
      expect(wrapped.length).toBe(3);
    });
  });
});
