/**
 * How a tool gateway shows its tools (docs/design/code-mode.md, part E,
 * and decisions 3 and 12): `configuration.exposure` on MCP, UTCP and
 * Skills gateways.
 *
 *   tools   every tool, as before (the default)
 *   code    exactly search_tools, get_tool and run_code
 *   both    every tool, then search_tools, get_tool, call_tool and run_code
 *
 * Scripts from outside clients are off for the install until the sandbox
 * runtime for them is decided (decision 1, the P3 gate): CODE_MODE_GATEWAYS
 * turns them on. Even then `code` and `both` need the gateway to ask its
 * callers who they are (decision 12): a gateway whose only auth is "none"
 * serves its tools as before.
 */
import { GatewayAuthType } from '../../entities/gateway-auth.entity';
import { CALL_TOOL, GET_TOOL, META_TOOL_DEFINITIONS, MetaToolDefinition, RUN_CODE, RUN_CODE_DEFINITION, SEARCH_TOOLS } from '../tool-discovery/meta-tools';
import { codeModeProblems } from './code-write-policy';

export type GatewayExposure = 'tools' | 'code' | 'both';
export const GATEWAY_EXPOSURES: readonly GatewayExposure[] = ['tools', 'code', 'both'];

type Env = Record<string, string | undefined>;

/** Whether this install lets gateways run scripts (CODE_MODE_GATEWAYS, default off). */
export function codeModeGatewaysEnabled(env: Env = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.CODE_MODE_GATEWAYS ?? '').trim());
}

/** A gateway as the exposure rules read it. */
export interface ExposureGateway {
  type?: string | null;
  configuration?: Record<string, any> | null;
  authConfigs?: Array<{ type: string; isActive?: boolean | null }> | null;
}

/**
 * Whether a gateway asks its callers who they are: one of its auth methods
 * is not "none". A Skills gateway is always reached by a signed-in member.
 */
export function gatewayHasAuth(gateway: ExposureGateway): boolean {
  if (gateway.type === 'skills') return true;
  return (gateway.authConfigs ?? []).some((a) => a && a.isActive !== false && a.type !== GatewayAuthType.NONE);
}

/**
 * What a gateway actually serves: its setting, unless scripts are off for
 * the install or the gateway admits anonymous callers, then `tools`.
 */
export function effectiveExposure(gateway: ExposureGateway, env: Env = process.env): GatewayExposure {
  const wanted = gateway.configuration?.exposure;
  if (wanted !== 'code' && wanted !== 'both') return 'tools';
  if (!codeModeGatewaysEnabled(env) || !gatewayHasAuth(gateway)) return 'tools';
  return wanted;
}

/** What is wrong with a gateway's exposure settings, one sentence each. */
export function exposureProblems(configuration: Record<string, any> | null | undefined, env: Env = process.env): string[] {
  const problems: string[] = [];
  const exposure = configuration?.exposure;
  if (exposure !== undefined && exposure !== null && !GATEWAY_EXPOSURES.includes(exposure)) {
    problems.push('How the gateway shows its tools must be tools, code or both');
  }
  if ((exposure === 'code' || exposure === 'both') && !codeModeGatewaysEnabled(env)) {
    problems.push('Scripts on gateways are not turned on for this server (CODE_MODE_GATEWAYS)');
  }
  problems.push(...codeModeProblems(configuration?.codeMode));
  return problems;
}

/** The meta-tools a gateway lists for an exposure, after its own tools in `both`. */
export function gatewayMetaTools(exposure: GatewayExposure): MetaToolDefinition[] {
  if (exposure === 'tools') return [];
  const meta = new Map(META_TOOL_DEFINITIONS.map((d) => [d.name, d]));
  if (exposure === 'both') return [...[SEARCH_TOOLS, GET_TOOL, CALL_TOOL].map((n) => meta.get(n)!), GATEWAY_RUN_CODE_DEFINITION];
  // No call_tool in `code`: a single call is a one-line script.
  const search = meta.get(SEARCH_TOOLS)!;
  return [
    { ...search, description: search.description.replace('and call_tool to run it.', 'and call it from a script with run_code.') },
    meta.get(GET_TOOL)!,
    GATEWAY_RUN_CODE_DEFINITION,
  ];
}

/**
 * run_code as a gateway lists it: the agent's definition, plus the way
 * back for a caller whose changes wait for a person (it cannot pause, so it
 * calls again with the approval id).
 */
export const GATEWAY_RUN_CODE_DEFINITION: MetaToolDefinition = {
  name: RUN_CODE,
  description:
    RUN_CODE_DEFINITION.description +
    ' When changes wait for a person, the answer says so and carries an approvalId; call run_code again with only that approvalId to get the outcome once they decide.',
  parameters: {
    type: 'object',
    properties: {
      ...(RUN_CODE_DEFINITION.parameters as any).properties,
      approvalId: { type: 'string', description: 'The approvalId of an earlier run_code whose changes waited for a person: returns what happened to them.' },
    },
  },
};

/**
 * The names UTCP's code-mode library uses for the same tools (decision 2:
 * one canonical set, these accepted as aliases on UTCP gateways only).
 */
export const UTCP_CODE_MODE_ALIASES: Readonly<Record<string, string>> = {
  tool_info: GET_TOOL,
  call_tool_chain: RUN_CODE,
};

export const GATEWAY_META_NAMES: ReadonlySet<string> = new Set([SEARCH_TOOLS, GET_TOOL, CALL_TOOL, RUN_CODE]);
