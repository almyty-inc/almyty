import axios from 'axios';
import { buildHarness, httpTool, jsTool } from './nested-tool-invoke.harness';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * A call that arrives through a gateway carries `gatewayId`, and
 * executeTool uses it to load that tool's gateway_tools row: its access
 * list (`permissions`) and its outbound `securityPolicy`. The nested call
 * a sandboxed tool makes with `tools.invoke` passed userId and
 * organizationId and nothing else -- so the second tool ran as if no
 * gateway were involved. A tool the gateway restricts to named users
 * answered anyone who could reach ANY tool on that gateway that calls it,
 * and an allowed-domains policy stopped applying one hop in.
 */
describe('nested tools.invoke keeps the gateway context of the call that made it', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  const opts = { userId: 'u1', organizationId: 'org-1', gatewayId: 'gw-1' };

  jest.setTimeout(60_000);

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { secret: true }, headers: {} });
  });

  it("applies the nested tool's own access list on that gateway", async () => {
    const { service, executeSpy } = buildHarness(
      {
        front: jsTool('front', "return await tools.invoke('restricted', {});"),
        restricted: httpTool('restricted', 'https://api.example.com/secret'),
      },
      {
        'gw-1/front': { id: 'gt-front', permissions: null, securityPolicy: null },
        'gw-1/restricted': {
          id: 'gt-restricted',
          permissions: { allowedUsers: ['someone-else'] },
          securityPolicy: null,
        },
      },
    );

    const result = await service.executeTool('front', {}, opts);

    expect(result.data).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain('allowed-user list');
    expect(mockedAxios).not.toHaveBeenCalled();
    // The nested call was made with the gateway it came through.
    expect(executeSpy.mock.calls[1][2]).toMatchObject({ gatewayId: 'gw-1', userId: 'u1' });
  });

  it("carries the caller's scopes, so requiredScopes is judged on what was presented", async () => {
    const { service } = buildHarness(
      {
        front: jsTool('front', "return await tools.invoke('scoped', {});"),
        scoped: httpTool('scoped', 'https://api.example.com/scoped'),
      },
      {
        'gw-1/front': { id: 'gt-front', permissions: null, securityPolicy: null },
        'gw-1/scoped': {
          id: 'gt-scoped',
          permissions: { requiredScopes: ['tools:admin'] },
          securityPolicy: null,
        },
      },
    );

    const allowed = await service.executeTool('front', {}, { ...opts, scopes: ['tools:admin'] });
    expect(allowed.error).toBeUndefined();
    expect(allowed.data).toEqual({ secret: true });

    const refused = await service.executeTool('front', {}, { ...opts, scopes: ['tools:read'] });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('tools:admin');
  });

  it("holds a nested tool that is not on the gateway to the calling tool's security policy", async () => {
    const { service } = buildHarness(
      {
        front: jsTool('front', "return await tools.invoke('offsite', {});"),
        offsite: httpTool('offsite', 'https://elsewhere.example.net/data'),
      },
      {
        'gw-1/front': {
          id: 'gt-front',
          permissions: null,
          securityPolicy: { allowedDomains: ['api.example.com'] },
        },
      },
    );

    const result = await service.executeTool('front', {}, opts);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/elsewhere\.example\.net/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('a nested call outside any gateway is unaffected', async () => {
    const { service } = buildHarness({
      front: jsTool('front', "return await tools.invoke('plain', {});"),
      plain: httpTool('plain', 'https://api.example.com/plain'),
    });

    const result = await service.executeTool('front', {}, { userId: 'u1', organizationId: 'org-1' });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ secret: true });
  });
});
