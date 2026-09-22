import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * `gateway_tools.securityPolicy` has a column, a PATCH endpoint that writes
 * it and a dashboard form that fills it. Until this was wired, nothing in
 * `backend/src` ever read it: a user could set allowed domains, require-HTTPS
 * and a max response size on a gateway tool, watch it save, and have every
 * setting ignored on the very next call.
 *
 * Source-reading on purpose. The failure mode is the ABSENCE of a call, and
 * every behavioural test of the decision function passes just as happily when
 * nothing invokes it -- which is exactly why this class of bug survives. Two
 * others were found the same week on this codebase: an `executeHook` with no
 * callers, and a pii-filter plugin with no hook at the only hook point that
 * ran. A test that reads the tree is the one that catches the third.
 *
 * What it guards:
 *   1. the reader module exists and is the one the entity's shape describes;
 *   2. the orchestrator resolves the policy from `gateway_tools` before it
 *      dispatches to any executor;
 *   3. EVERY executor that builds an outbound request runs the policy gate
 *      and clamps its response cap -- so a new executor added later cannot
 *      quietly reopen the hole;
 *   4. the gateway-facing call sites hand the executor a gatewayId, without
 *      which the lookup in (2) never fires.
 */
const SRC = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const POLICY_MODULE = join('common', 'security', 'gateway-tool-policy.ts');
const EXECUTORS_DIR = join(SRC, 'modules', 'tools', 'executors');

describe('the securityPolicy reader exists and matches the column', () => {
  const policy = read(POLICY_MODULE);
  const entity = read('entities', 'gateway-tool.entity.ts');

  it('exports a decision function and a throwing assert', () => {
    expect(policy).toContain('export function decideToolRequest(');
    expect(policy).toContain('export function assertToolRequestAllowed(');
    expect(policy).toContain('export function effectiveMaxResponseBytes(');
  });

  it('reads every field the entity declares -- no field is decorative', () => {
    // Pull the field names out of the entity's securityPolicy column so a
    // field added there later fails here until the reader handles it.
    const column = entity.slice(
      entity.indexOf('securityPolicy: {'),
      entity.indexOf('} | null;', entity.indexOf('securityPolicy: {')),
    );
    expect(column).not.toHaveLength(0);

    const fields = [...column.matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(
      ['allowedDomains', 'allowedHttpMethods', 'blockedDomains', 'maxResponseSizeBytes', 'requireHttps'],
    );

    for (const field of fields) {
      // `policy.x` or `policy?.x` -- both are reads of that field.
      expect(policy).toMatch(new RegExp(`policy\\??\\.${field}\\b`));
    }
  });

  it('only ever narrows the install-wide response cap', () => {
    expect(policy).toContain('Math.min(configured, executorDefault)');
  });
});

describe('the orchestrator resolves the policy before dispatch', () => {
  const executor = read('modules', 'tools', 'tool-executor.service.ts');

  it('injects the gateway_tools repository', () => {
    expect(executor).toContain('@InjectRepository(GatewayTool)');
    expect(executor).toContain('private readonly gatewayToolRepository: Repository<GatewayTool>');
  });

  it('loads the policy for the gateway the call came through', () => {
    expect(executor).toContain('this.gatewayToolRepository.findOne({');
    expect(executor).toContain('where: { gatewayId: options.gatewayId, toolId: tool.id }');
    expect(executor).toContain('securityPolicy: gatewayTool?.securityPolicy ?? null');
  });

  it('resolves it BEFORE anything dispatches the tool', () => {
    const resolve = executor.indexOf('this.gatewayToolRepository.findOne({');
    const dispatch = executor.indexOf('await this.executeRunnerCall(tool,');
    expect(resolve).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(resolve);
  });

  it('the DI token is registered, so the repository is really provided', () => {
    const module = read('modules', 'tools', 'tools.module.ts');
    expect(module).toContain('GatewayTool');
  });

  it('the execution options carry the policy onward to the executors', () => {
    const types = read('modules', 'tools', 'tool-execution.types.ts');
    expect(types).toContain('securityPolicy?: GatewayToolSecurityPolicy | null;');
  });
});

describe('every outbound-request executor enforces the policy', () => {
  // Any file in executors/ that runs validateUrl is building a request that
  // leaves this process. Each one must also run the gateway-tool gate.
  const outbound = readdirSync(EXECUTORS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => ({ name: f, source: readFileSync(join(EXECUTORS_DIR, f), 'utf8') }))
    .filter((f) => f.source.includes('validateUrl(') || f.source.includes('assertSafeNextPageUrl('));

  it('finds the executors it is supposed to be guarding', () => {
    expect(outbound.map((f) => f.name).sort()).toEqual([
      'tool-grpc.executor.ts',
      'tool-http-pagination.ts',
      'tool-http.executor.ts',
      'tool-protocol.executor.ts',
    ]);
  });

  it.each(outbound.map((f) => [f.name]))('%s runs the gateway-tool policy gate', (name) => {
    const source = outbound.find((f) => f.name === name)!.source;
    const gated =
      source.includes('decideToolRequest(') || source.includes('assertToolRequestAllowed(');
    expect(gated).toBe(true);
  });

  // One gate per outbound request path. Hardcoded on purpose: adding a
  // request-building method to one of these files changes the count and
  // fails here, which is the point -- a new path must be gated too.
  const EXPECTED_GATES: Record<string, number> = {
    // executeHttpConfig, executeRestOperation
    'tool-http.executor.ts': 2,
    // executeGraphQLConfig, executeGraphQLOperation, executeSOAPConfig, executeSOAPOperation
    'tool-protocol.executor.ts': 4,
    // executeGrpcConfig, executeProtobufOperation
    'tool-grpc.executor.ts': 2,
    // cursor next-page and link-header next-page
    'tool-http-pagination.ts': 2,
  };

  it.each(outbound.map((f) => [f.name]))(
    '%s gates every outbound request path it builds',
    (name) => {
      const source = outbound.find((f) => f.name === name)!.source;
      const gates = (source.match(/decideToolRequest\(|assertToolRequestAllowed\(/g) ?? []).length;
      expect(gates).toBe(EXPECTED_GATES[name]);
    },
  );

  it.each(outbound.filter((f) => f.source.includes('maxContentLength')).map((f) => [f.name]))(
    '%s clamps its response cap to the policy',
    (name) => {
      const source = outbound.find((f) => f.name === name)!.source;
      const caps = [...source.matchAll(/maxContentLength: (.+),/g)].map((m) => m[1]);
      expect(caps.length).toBeGreaterThan(0);
      for (const cap of caps) {
        expect(cap).toContain('effectiveMaxResponseBytes(options.securityPolicy');
      }
    },
  );
});

describe('the gateway call sites hand the executor a gatewayId', () => {
  // Without a gatewayId the orchestrator has nothing to look the policy up
  // by, so the whole chain above is dead code. These are the paths a call
  // through a gateway actually takes.
  const cases: Array<[string, string[]]> = [
    ['gateway protocol service (MCP + UTCP over a gateway)', ['modules', 'gateways', 'gateway-protocol.service.ts']],
    ['gateway skills controller', ['modules', 'gateways', 'gateway-skills.controller.ts']],
    ['MCP tools/call handler', ['modules', 'mcp', 'services', 'mcp-tool.handler.ts']],
    ['UTCP proxy execution', ['modules', 'mcp', 'utcp.service.ts']],
  ];

  it.each(cases)('%s passes gatewayId into executeTool', (_label, path) => {
    const source = read(...path);
    const call = source.indexOf('executeTool(');
    expect(call).toBeGreaterThan(-1);
    // The options object literal sits either just after the call or just
    // above it (some call sites build a named `executionOptions` first).
    const window = source.slice(Math.max(0, call - 900), call + 900);
    expect(window).toMatch(/gatewayId[:,]/);
  });

  it('the MCP JSON-RPC dispatcher forwards the gateway to tools/call', () => {
    const mcp = read('modules', 'mcp', 'mcp.service.ts');
    expect(mcp).toMatch(/handleToolCall\([^)]*gatewayId\)/);
  });
});
