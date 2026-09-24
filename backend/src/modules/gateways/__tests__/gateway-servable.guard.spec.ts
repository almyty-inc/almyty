import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * A gateway executes only what it publishes -- held at the source.
 *
 * The behavioural proof is gateway-executes-only-published-tools.spec.ts
 * and agent-gateway-serves-only-its-agent.spec.ts. What a behavioural test
 * cannot see is the NEXT protocol handler: one that resolves a tool by name
 * across the organization and hands it to the executor compiles, passes its
 * own happy-path test, and serves every org tool through one gateway --
 * which is exactly how MCP tools/call and UTCP /execute shipped.
 *
 * So:
 *  1. every file that calls ToolExecutorService.executeTool is classified
 *     here. A new call site fails this spec until someone decides whether
 *     it is a gateway surface.
 *  2. a gateway surface resolves through gateway-servable (the one set its
 *     listing is built from) and passes `gatewayId` on every call, so the
 *     executor can re-check it.
 *  3. the executor re-checks every top-level gateway call against the same
 *     predicate and answers "not found" -- the backstop for a handler that
 *     forgets step 2.
 *  4. the agent gateways (A2A, ACP) look a caller-named run up only through
 *     findGatewayRun, scoped to the gateway's own agent.
 */
const SRC = join(__dirname, '..', '..', '..');
const ROOT = join(SRC, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === 'test') continue;
      walk(path, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** The argument text of each `.executeTool(` call, parentheses balanced. */
function executeToolCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /\.executeTool\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    calls.push(source.slice(m.index + m[0].length, i - 1));
  }
  return calls;
}

/**
 * Every executeTool call site, and what it is.
 *
 * 'gateway': a call that arrived through a gateway. Must resolve through
 * gateway-servable and pass gatewayId.
 * Anything else: why it is not a gateway surface.
 */
const CALL_SITES: Record<string, 'gateway' | string> = {
  'src/modules/mcp/services/mcp-tool.handler.ts': 'gateway',
  'src/modules/mcp/utcp.service.ts': 'gateway',
  'src/modules/gateways/gateway-protocol.service.ts': 'gateway',
  'src/modules/gateways/gateway-skills.controller.ts': 'gateway',
  'src/modules/tools/tools.controller.ts': 'the dashboard REST API: an authenticated member running a tool as themselves',
  'src/modules/tools/executors/tool-script.executor.ts':
    'a nested tools.invoke inside a tool that is already running (it carries the outer gatewayId for policy)',
  'src/modules/agents/agent-node-executor.ts': 'a pipeline agent node: the agent is what was published, its tools are its own',
  'src/modules/agents/agent-step-processor.ts': 'an autonomous agent step: the agent is what was published',
  'src/modules/llm-providers/llm-chat-runner.helper.ts': 'an LLM chat turn calling the tools it was configured with',
};

describe('a gateway executes only what it publishes (source guard)', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'ee'))]
    .map((f) => relative(ROOT, f))
    .filter((f) => f !== 'src/modules/tools/tool-executor.service.ts')
    .filter((f) => executeToolCalls(readFileSync(join(ROOT, f), 'utf8')).length > 0)
    .sort();

  it('every executeTool call site is classified, and none has gone away unnoticed', () => {
    expect(files).toEqual(Object.keys(CALL_SITES).sort());
  });

  describe.each(Object.entries(CALL_SITES).filter(([, kind]) => kind === 'gateway').map(([f]) => [f]))(
    '%s',
    (file) => {
      const source = read(file);

      it('resolves what it runs through gateway-servable', () => {
        expect(source).toMatch(/from '(\.\/|\.\.\/gateways\/|\.\.\/\.\.\/gateways\/)gateway-servable'/);
      });

      it('passes gatewayId on every executor call, so the executor re-checks it', () => {
        for (const args of executeToolCalls(source)) {
          // Inline options, or an options object declared in the same file.
          const named = /,\s*([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(args)?.[1];
          const declared = named
            ? new RegExp(`const ${named}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`).exec(source)?.[1] ?? ''
            : '';
          expect(`${args}\n${declared}`).toMatch(/\bgatewayId\b/);
        }
      });
    },
  );

  it('the executor refuses a top-level gateway call the gateway does not serve, as not found', () => {
    const source = read('src/modules/tools/tool-executor.service.ts');
    const branch = source.indexOf('if (options.gatewayId) {');
    const policy = source.indexOf('decideToolCaller(gatewayTool?.permissions');
    const check = source.indexOf('isServableGatewayTool(', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(branch);
    // Decided before the access list, the parameters or the network.
    expect(check).toBeLessThan(policy);
    // The whole `if (...)` the check sits in, and what it does.
    const refusal = source.slice(source.lastIndexOf('if (', check), check + 200);
    expect(refusal).toContain('!options.invocation');
    expect(refusal).toContain('notFound = true');
    expect(refusal).toContain("throw new Error('Tool not found')");
  });

  it('the listings of those surfaces read the same set', () => {
    expect(read('src/modules/mcp/services/mcp-tool.handler.ts')).not.toMatch(/servableOnGateway|servableThroughGateway/);
    expect(read('src/modules/mcp/utcp.service.ts')).not.toContain('resourceServableThroughGateway');
    expect(read('src/modules/gateways/gateway-protocol.service.ts')).toContain('servableGatewayTools(');
  });

  describe('agent gateways look a caller-named run up only within their own agent', () => {
    it.each([
      ['src/modules/a2a/a2a-message.handler.ts'],
      ['src/modules/a2a/a2a-task.handler.ts'],
      ['src/modules/a2a/a2a-server.service.ts'],
      ['src/modules/acp/acp-server.service.ts'],
    ])('%s', (file) => {
      const source = read(file);
      // Any direct run lookup is by a run this code already resolved (one it
      // started, or one findGatewayRun returned) -- never by a param.
      const re = /runRepository\.findOne\(\{\s*where:\s*\{\s*([^}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) {
        expect(m[1]).toMatch(/^id:\s*(runId|run\.id)\b/);
      }
      expect(source).not.toMatch(/where:\s*\{\s*(id|conversationId):\s*(params|taskId|sessionId|conversationId)\b/);
    });
  });
});
