import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Team and private scope are enforced where things RUN, in one place.
 *
 * ExecutionAccessService is the gate. The three executors every execution
 * path ends in -- AgentExecutionEngine.execute (workflow runs, sub_agent
 * nodes, schedules, compat APIs), AgentRuntimeService.startRun (autonomous
 * runs, invoke_agent, collaboration, heartbeats, A2A/ACP/channels/hosted
 * chat) and ToolExecutorService.executeTool (REST, tool_call nodes, an
 * autonomous run's tool calls, MCP/UTCP/Skills, sandboxed tools.invoke) --
 * ask it before doing anything, and every call into them states whose
 * scope it runs in (`principal`), so nested work inherits the scope of
 * whoever started the run instead of re-deriving one.
 *
 * This is a SOURCE-READING guard, because the defect class it prevents is
 * "unwired units": a check that exists, is unit-tested, and is simply not
 * on the path a new surface takes. A behavioural test of today's paths
 * says nothing about the next `startRun(` somebody writes. It fails when:
 *   - an executor stops asking the gate before it does work;
 *   - a production call into an executor does not name a principal;
 *   - something other than an executor reaches the layer below it (node
 *     dispatch, per-type tool executors, a run's step processing).
 */
const SRC = join(__dirname, '..', '..', '..');
const ROOTS = [SRC, join(SRC, '..', 'ee')];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '__tests__' || name === 'test' || name === 'migrations') continue;
        walk(full);
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  ROOTS.forEach(walk);
  return out;
}

/** The text between a call's parentheses, starting at the index of its `(`. */
function argsAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/** The body of `name(` as a method: from its declaration to the matching brace. */
function methodBody(source: string, declaration: RegExp): string {
  const match = declaration.exec(source);
  if (!match) throw new Error(`no declaration matching ${declaration}`);
  const start = source.indexOf('{', source.indexOf(')', match.index + match[0].length - 1));
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/**
 * Calls into an executor (or a thin wrapper that forwards to one). A call
 * passes when its arguments name `principal`, or pass an options object
 * built in the same file with a `principal:` in it.
 */
const ENTRY_CALLS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'ToolExecutorService.executeTool', pattern: /\.executeTool\(/g },
  { name: 'AgentRuntimeService.startRun', pattern: /\.startRun\(/g },
  { name: 'AgentExecutionEngine.execute', pattern: /(?:executionEngine|AgentExecutionEngine\)|\bengine)\.execute\(/g },
  { name: 'UtcpService.executeUtcpTool', pattern: /\.executeUtcpTool\(/g },
];

function namesPrincipal(source: string, args: string): boolean {
  // `principal` itself, or a principal built in place (userPrincipal(...),
  // gatewayPrincipal(...), compatPrincipal(...), principalOfRun(...)).
  if (/\bprincipal\b|[a-z]Principal\(|\bprincipalOfRun\(/.test(args)) return true;
  // An options object built beforehand: `const opts: ToolExecutionOptions = { ..., principal: ... }`.
  for (const ident of args.match(/\b[A-Za-z_]\w*\b/g) ?? []) {
    const decl = new RegExp(`(?:const|let)\\s+${ident}\\b[^=]*=\\s*\\{`).exec(source);
    if (!decl) continue;
    const body = argsAt(source.replace(/\{/g, '(').replace(/\}/g, ')'), decl.index + decl[0].length - 1);
    if (/\bprincipal\s*:/.test(body)) return true;
  }
  return false;
}

describe('every execution path goes through the shared scope check', () => {
  const files = productionFiles();
  const read = (file: string) => stripComments(readFileSync(file, 'utf8'));

  describe('each executor asks ExecutionAccessService before it does any work', () => {
    it('ToolExecutorService.executeTool: before the tool\'s status, gateway row, parameters or dispatch', () => {
      const body = methodBody(read(join(SRC, 'modules/tools/tool-executor.service.ts')), /async executeTool\(/);
      const gate = body.indexOf('this.executionAccess.assertCanExecute(');
      expect(gate).toBeGreaterThan(-1);
      for (const later of [
        'tool.status !== ToolStatus.ACTIVE',
        'this.gatewayToolRepository.findOne(',
        'this.stats.validateParameters(',
        'this.pluginManager.executeHook(',
        'this.cacheRateLimit.',
      ]) {
        expect({ later, afterGate: body.indexOf(later) > gate }).toEqual({ later, afterGate: true });
      }
      // No gate wired, no execution.
      expect(body).toMatch(/if \(!this\.executionAccess\) \{\s*[^}]*throw new Error/);
    });

    it('AgentExecutionEngine.execute: before any execution row, budget or node', () => {
      const body = methodBody(read(join(SRC, 'modules/agents/agent-execution.engine.ts')), /async execute\(/);
      const gate = body.indexOf('this.executionAccess.assertCanExecute(principal, agent');
      expect(gate).toBeGreaterThan(-1);
      for (const later of ['this.budgets.enforceForRun(', 'this.agentExecutionRepository.create(', 'this.nodeExecutor.execute(']) {
        expect({ later, afterGate: body.indexOf(later) > gate }).toEqual({ later, afterGate: true });
      }
      expect(body).toMatch(/if \(!this\.executionAccess\) \{\s*[^}]*throw new Error/);
      // The run's principal is what every node receives.
      expect(body).toMatch(/this\.nodeExecutor\.execute\([\s\S]*?\bprincipal\b/);
    });

    it('AgentRuntimeService.startRun: before any run, conversation or queued step; and the run keeps the principal', () => {
      const body = methodBody(read(join(SRC, 'modules/agents/agent-runtime.service.ts')), /async startRun\(/);
      const gate = body.indexOf('this.executionAccess.assertCanExecute(principal, agent');
      expect(gate).toBeGreaterThan(-1);
      for (const later of ['this.budgets.enforceForRun(', 'this.conversationRepository.save(', 'this.runRepository.create(', 'this.runtimeQueue.add(']) {
        expect({ later, afterGate: body.indexOf(later) > gate }).toEqual({ later, afterGate: true });
      }
      expect(body).toMatch(/this\.runRepository\.create\(\{[\s\S]*?\bprincipal,/);
    });

    it('AgentStepProcessor.processStep: re-checks the run\'s scope against its agent before calling the model or a tool', () => {
      const body = methodBody(read(join(SRC, 'modules/agents/agent-step-processor.ts')), /async processStep\(/);
      const gate = body.indexOf('this.s.executionAccess.canExecute(principal, agent)');
      expect(gate).toBeGreaterThan(-1);
      for (const later of ['this.s.llmProvidersService.chatStream(', 'this.s.toolExecutorService.executeTool(', 'this.s.startRun(']) {
        expect({ later, afterGate: body.indexOf(later) > gate }).toEqual({ later, afterGate: true });
      }
      expect(body).toMatch(/const principal = principalOfRun\(run\)/);
    });
  });

  describe('every production call into an executor names whose scope it runs in', () => {
    const calls: Array<[string, string, string]> = [];
    for (const file of files) {
      const source = read(file);
      for (const { name, pattern } of ENTRY_CALLS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source))) {
          const open = match.index + match[0].length - 1;
          const line = source.slice(0, match.index).split('\n').length;
          calls.push([`${relative(SRC, file)}:${line}`, name, namesPrincipal(source, argsAt(source, open)) ? 'principal' : 'MISSING']);
        }
      }
    }

    it('finds the calls it is guarding (so a renamed method cannot empty this list silently)', () => {
      const byEntry = (n: string) => calls.filter(([, name]) => name === n).length;
      expect(byEntry('ToolExecutorService.executeTool')).toBeGreaterThanOrEqual(9);
      expect(byEntry('AgentRuntimeService.startRun')).toBeGreaterThanOrEqual(20);
      expect(byEntry('AgentExecutionEngine.execute')).toBeGreaterThanOrEqual(9);
    });

    it('none of them leaves the principal to be re-derived', () => {
      expect(calls.filter(([, , verdict]) => verdict === 'MISSING').map(([where, name]) => `${where} ${name}`)).toEqual([]);
    });
  });

  describe('nothing reaches the layer below an executor except the executor', () => {
    const LOWER: Array<{ what: string; pattern: RegExp; allowed: string[] }> = [
      {
        what: 'workflow node dispatch',
        pattern: /\bnodeExecutor\.execute\(/,
        allowed: ['modules/agents/agent-execution.engine.ts'],
      },
      {
        what: 'per-type tool executors',
        pattern: /\b(?:httpExecutor|protocolExecutor|scriptExecutor)\.execute[A-Z]\w*\(/,
        allowed: ['modules/tools/tool-executor.service.ts'],
      },
      {
        what: 'processing an autonomous run\'s step',
        pattern: /\.processStep\(/,
        allowed: [
          'modules/agents/agent-runtime.service.ts',
          'modules/agents/agent-runtime.processor.ts',
          // A strategy's child run (explorer, agent panelist or teammate) is
          // driven inline, and only one startRun has just created -- scope
          // asserted there -- and processStep re-checks the principal on
          // every step it takes.
          'modules/agents/autonomous-strategy.runner.ts',
        ],
      },
      {
        what: 'queueing an autonomous run\'s next step (only for a run startRun created)',
        pattern: /'next-step'/,
        allowed: [
          'modules/agents/agent-runtime.service.ts',
          'modules/agents/agent-runtime.processor.ts',
          'modules/agents/agent-builtin-tools.helper.ts',
        ],
      },
    ];

    it.each(LOWER.map((l) => [l.what, l] as const))('%s', (_what, { pattern, allowed }) => {
      const offenders = files
        .filter((file) => pattern.test(read(file)))
        .map((file) => relative(SRC, file))
        .filter((file) => !allowed.includes(file));
      expect(offenders).toEqual([]);
    });
  });
});
