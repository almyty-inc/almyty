import {
  GATEWAY_RUN_CODE_DEFINITION,
  UTCP_CODE_MODE_ALIASES,
  codeModeGatewaysEnabled,
  effectiveExposure,
  exposureProblems,
  gatewayHasAuth,
  gatewayMetaTools,
} from '../code-exposure';

/**
 * Gateway exposure (docs/design/code-mode.md, part E, decisions 1, 3 and
 * 12): what a tool gateway lists, and when scripts are on at all.
 */
const ON = { CODE_MODE_GATEWAYS: 'true' };
const OFF = {};
const KEY = [{ type: 'api_key', isActive: true }];
const NONE = [{ type: 'none', isActive: true }];

describe('gateway exposure', () => {
  it('is off for the install unless CODE_MODE_GATEWAYS turns it on', () => {
    expect(codeModeGatewaysEnabled(OFF)).toBe(false);
    expect(codeModeGatewaysEnabled({ CODE_MODE_GATEWAYS: 'false' })).toBe(false);
    expect(codeModeGatewaysEnabled(ON)).toBe(true);
    expect(codeModeGatewaysEnabled({ CODE_MODE_GATEWAYS: '1' })).toBe(true);
  });

  it('serves tools unless the setting, the install switch and an auth method all allow scripts', () => {
    const gw = (exposure: string | undefined, authConfigs = KEY, type = 'mcp') => ({ type, configuration: exposure ? { exposure } : {}, authConfigs });
    expect(effectiveExposure(gw(undefined), ON)).toBe('tools');
    expect(effectiveExposure(gw('code'), OFF)).toBe('tools');
    expect(effectiveExposure(gw('code'), ON)).toBe('code');
    expect(effectiveExposure(gw('both'), ON)).toBe('both');
    expect(effectiveExposure(gw('weird'), ON)).toBe('tools');
    // Decision 12: no scripts for anonymous callers.
    expect(effectiveExposure(gw('code', NONE), ON)).toBe('tools');
    expect(effectiveExposure(gw('code', []), ON)).toBe('tools');
    expect(effectiveExposure(gw('code', [{ type: 'api_key', isActive: false }]), ON)).toBe('tools');
    // A Skills gateway is reached by a signed-in member.
    expect(effectiveExposure(gw('code', [], 'skills'), ON)).toBe('code');
    expect(gatewayHasAuth({ type: 'skills', authConfigs: [] })).toBe(true);
  });

  it('refuses a setting the install cannot serve, in plain words', () => {
    expect(exposureProblems({ exposure: 'tools' }, OFF)).toEqual([]);
    expect(exposureProblems({ exposure: 'code' }, OFF)).toEqual(['Scripts on gateways are not turned on for this server (CODE_MODE_GATEWAYS)']);
    expect(exposureProblems({ exposure: 'code' }, ON)).toEqual([]);
    expect(exposureProblems({ exposure: 'all' }, ON)).toEqual(['How the gateway shows its tools must be tools, code or both']);
    expect(exposureProblems({ codeMode: { writes: { destructive: 'maybe' } } }, ON)).toHaveLength(1);
  });

  it('lists exactly search_tools, get_tool and run_code in code, and call_tool too in both (decision 3)', () => {
    expect(gatewayMetaTools('tools')).toEqual([]);
    expect(gatewayMetaTools('code').map((t) => t.name)).toEqual(['search_tools', 'get_tool', 'run_code']);
    expect(gatewayMetaTools('both').map((t) => t.name)).toEqual(['search_tools', 'get_tool', 'call_tool', 'run_code']);
    // In code exposure nothing points the model at a call_tool it does not have.
    expect(JSON.stringify(gatewayMetaTools('code'))).not.toContain('call_tool');
  });

  it('tells a gateway client how to come back for changes that waited for a person', () => {
    expect(GATEWAY_RUN_CODE_DEFINITION.parameters.properties.approvalId).toBeDefined();
    expect(GATEWAY_RUN_CODE_DEFINITION.parameters.required).toBeUndefined();
    expect(GATEWAY_RUN_CODE_DEFINITION.description).toMatch(/approvalId/);
  });

  it("accepts UTCP code-mode's names for the same tools (decision 2)", () => {
    expect(UTCP_CODE_MODE_ALIASES).toEqual({ tool_info: 'get_tool', call_tool_chain: 'run_code' });
  });
});
