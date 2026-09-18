import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import {
  formatAgentDetail,
  formatAgentLine,
  formatCost,
  formatDuration,
  formatExecutionSummary,
  formatNodeResults,
  formatRouting,
  formatRunDetail,
  formatRunSummary,
  formatStep,
  formatTokens,
  formatTrace,
  modelOf,
  notActiveMessage,
  routingOfStep,
  runSucceeded,
} from '../format';
import { EXIT } from '../exit-codes';
import { readVersion } from '../version';
import { parseArgs, flagNumber, flagString } from '../args';

const SRC = join(import.meta.dirname, '..');
const INDEX = readFileSync(join(SRC, 'index.ts'), 'utf-8');
const HELP_TEXT = INDEX.slice(
  INDEX.indexOf('function printHelp'),
  INDEX.indexOf('function emitJson'),
);
const ANSI = new RegExp(String.fromCharCode(27) + '\\[');

const routing = {
  modelId: 'card-sonnet',
  vendorModelId: 'claude-sonnet-4-5',
  providerId: 'prov-1',
  rationale: 'cheapest card that met the policy',
  attempt: 2,
  tried: [{ modelId: 'card-haiku', reason: 'rate limited' }],
  rejected: [{ modelId: 'card-opus', reason: 'over budget' }],
};

describe('runSucceeded', () => {
  it('accepts only the statuses that mean the work was done', () => {
    expect(runSucceeded('completed')).toBe(true);
    expect(runSucceeded('succeeded')).toBe(true);
    for (const bad of ['failed', 'cancelled', 'timeout', 'waiting_input', undefined]) {
      expect(runSucceeded(bad as any), String(bad)).toBe(false);
    }
  });
});

describe('formatCost', () => {
  it('shows a real zero as $0, and nothing recorded as a dash', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost(NaN)).toBe('—');
  });

  it('keeps sub-cent amounts visible instead of rounding them to $0.00', () => {
    expect(formatCost(0.000123)).toBe('$0.000123');
    expect(formatCost(1.5)).toBe('$1.5000');
  });
});

describe('formatTokens / formatDuration', () => {
  it('renders in/out token pairs', () => {
    expect(formatTokens({ input: 1200, output: 34 })).toBe('1,200 in / 34 out');
    expect(formatTokens({ input: 0, output: 0 })).toBe('—');
    expect(formatTokens(4096)).toBe('4,096');
    expect(formatTokens(undefined)).toBe('—');
  });

  it('scales the duration unit', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('routing attribution', () => {
  it('names the model that answered', () => {
    expect(modelOf(routing)).toBe('claude-sonnet-4-5');
    expect(modelOf(undefined)).toBeNull();
  });

  it('says which attempt answered and how many candidates were passed over', () => {
    const line = formatRouting(routing)!;
    expect(line).toContain('claude-sonnet-4-5');
    expect(line).toContain('attempt 2');
    expect(line).toContain('cheapest card that met the policy');
    expect(line).toContain('2 candidate(s) passed over');
  });

  it('says nothing rather than inventing attribution for a pinned call', () => {
    // A pinned provider leaves no `routing` on the step. Printing a
    // fabricated model name there would be worse than printing none.
    expect(formatRouting(undefined)).toBeNull();
    expect(formatRouting({})).toBeNull();
  });

  it('finds the attribution wherever the step stamped it', () => {
    expect(routingOfStep({ type: 'llm_call', output: { routing } })).toEqual(routing);
    expect(routingOfStep({ type: 'llm_call', output: {} })).toBeUndefined();
    expect(routingOfStep(undefined)).toBeUndefined();
  });
});

describe('formatStep', () => {
  it('surfaces the model and the cost of an llm_call', () => {
    // The old formatter printed only the content, so a multi-model run
    // never said which model produced which line, nor what it cost.
    const line = formatStep(
      {
        type: 'llm_call',
        output: { content: 'hello', routing },
        cost: 0.0021,
        tokens: { input: 900, output: 12 },
        duration: 1800,
      },
      0,
    )!;
    expect(line).toContain('hello');
    expect(line).toContain('claude-sonnet-4-5');
    expect(line).toContain('$0.0021');
    expect(line).toContain('900 in / 12 out');
    expect(line).toContain('1.8s');
    expect(line).toContain('1.');
  });

  it('names the tools a tool-calling step asked for', () => {
    const line = formatStep({
      type: 'llm_call',
      output: { toolCalls: [{ name: 'get_pet' }, { name: 'list_orders' }] },
    })!;
    expect(line).toContain('get_pet, list_orders');
  });

  it('shows what a run is waiting for', () => {
    expect(
      formatStep({ type: 'llm_call', output: { status: 'waiting_input', question: 'Which env?' } }),
    ).toContain('Which env?');
    expect(
      formatStep({ type: 'llm_call', output: { status: 'sleeping', reason: 'rate limit' } }),
    ).toContain('rate limit');
  });

  it('shows an error step', () => {
    expect(formatStep({ type: 'error', error: 'model retired' })).toContain('model retired');
  });

  it('renders an unknown step type rather than dropping it', () => {
    // The old switch returned null for anything it did not know, so
    // whole classes of step were invisible in --watch.
    expect(formatStep({ type: 'memory_write' })).toContain('memory_write');
    expect(formatStep(undefined)).toBeNull();
  });
});

describe('formatRunSummary', () => {
  it('names every model that answered, the cost and the tokens', () => {
    const summary = formatRunSummary({
      status: 'completed',
      totalCost: 0.0075,
      totalTokens: 5120,
      executionTime: 4200,
      steps: [
        { type: 'llm_call', output: { routing } },
        { type: 'llm_call', output: { routing: { vendorModelId: 'gpt-5-mini' } } },
      ],
    });
    expect(summary).toContain('Run completed');
    expect(summary).toContain('claude-sonnet-4-5');
    expect(summary).toContain('gpt-5-mini');
    expect(summary).toContain('$0.0075');
    expect(summary).toContain('5,120 tokens');
    expect(summary).toContain('4.2s');
  });

  it('still reports status and cost for an unrouted run', () => {
    const summary = formatRunSummary({ status: 'failed', totalCost: 0 });
    expect(summary).toContain('Run failed');
    expect(summary).toContain('$0');
    expect(summary).not.toContain('answered by');
  });
});

describe('formatExecutionSummary / formatNodeResults', () => {
  const execution = {
    status: 'failed',
    totalCost: 0.004,
    totalTokens: 300,
    executionTime: 900,
    nodeResults: {
      llm1: { output: 'x', cost: 0.004, tokens: 300, executionTime: 800, startedAt: 1, routing },
      tool1: {
        error: 'provider timeout',
        errorCode: 'MODEL_NOT_FOUND',
        errorModel: 'gpt-4o',
        startedAt: 2,
        triedModels: [{ modelId: 'card-a', reason: 'timeout' }],
      },
      skipped1: { skipped: true },
    },
  };

  it('counts failed nodes and names the models that answered', () => {
    const summary = formatExecutionSummary(execution);
    expect(summary).toContain('Run failed');
    expect(summary).toContain('claude-sonnet-4-5');
    expect(summary).toContain('1 node(s) failed');
  });

  it('shows per-node failure detail, including what was tried', () => {
    const lines = formatNodeResults(execution.nodeResults).join('\n');
    expect(lines).toContain('llm1  ok');
    expect(lines).toContain('tool1  FAILED  provider timeout');
    expect(lines).toContain('MODEL_NOT_FOUND');
    expect(lines).toContain('tried card-a: timeout');
    expect(lines).toContain('skipped1  skipped');
  });

  it('orders nodes by when they ran, not by key', () => {
    const lines = formatNodeResults(execution.nodeResults);
    expect(lines[0]).toContain('llm1');
    expect(lines[1]).toContain('tool1');
  });
});

describe('formatRunDetail', () => {
  it('shows everything needed to debug a failed run without the UI', () => {
    const detail = formatRunDetail({
      id: 'run-1',
      status: 'failed',
      mode: 'autonomous',
      createdAt: '2026-01-01T00:00:00Z',
      currentStep: 3,
      maxSteps: 50,
      totalCost: 0.02,
      totalTokens: 900,
      executionTime: 12_000,
      error: 'tool get_pet returned 500',
      steps: [
        { type: 'llm_call', output: { content: 'thinking', routing }, cost: 0.02 },
        { type: 'error', error: 'tool get_pet returned 500' },
      ],
      output: { answer: 'none' },
    });
    expect(detail).toContain('run-1');
    expect(detail).toContain('status:    failed');
    expect(detail).toContain('tool get_pet returned 500');
    expect(detail).toContain('claude-sonnet-4-5');
    expect(detail).toContain('$0.02');
    expect(detail).toContain('12.0s');
    expect(detail).toContain('Steps:');
    expect(detail).toContain('Output:');
  });
});

describe('formatTrace', () => {
  it('prints an opaque hop as opaque, never as zero', () => {
    const rendered = formatTrace({
      executionId: 'exec-1',
      strategyKey: 'plan-then-act',
      strategyChosenBy: 'organization default',
      steps: [
        {
          nodeId: 'llm1',
          durationMs: 1200,
          hops: [
            {
              layer: 'routing',
              decidedBy: 'routing policy',
              chosen: 'claude-sonnet-4-5',
              reason: 'cheapest that met the policy',
              alternatives: ['card-haiku'],
              costEstimateCents: 0.21,
              latencyMs: 1100,
            },
            {
              layer: 'provider',
              decidedBy: 'prov-1',
              chosen: 'claude-sonnet-4-5',
              reason: 'served the call',
              costEstimateCents: null,
              opaqueCost: true,
              requestedModel: 'claude-sonnet-4-5',
              servedModel: 'claude-sonnet-4-5-20991231',
              divergent: true,
              capabilitiesDropped: ['prompt-cache'],
            },
          ],
        },
      ],
      summary: { knownCostCents: 0.21, opaqueHops: 1, divergences: [{}], capabilitiesDropped: ['prompt-cache'] },
    });
    expect(rendered).toContain('plan-then-act');
    expect(rendered).toContain('cost opaque');
    expect(rendered).not.toContain('0.0000¢  ');
    expect(rendered).toContain('DIVERGENT');
    expect(rendered).toContain('prompt-cache');
    expect(rendered).toContain('passed over: card-haiku');
    expect(rendered).toContain('opaque hops:  1');
  });

  it('says so when a node recorded no hops', () => {
    const rendered = formatTrace({ executionId: 'e', steps: [{ nodeId: 'n', hops: [] }] });
    expect(rendered).toContain('no hops recorded');
  });
});

describe('agent rendering', () => {
  it('lists mode, status and description', () => {
    const line = formatAgentLine({
      id: 'a1',
      name: 'deploy-check',
      mode: 'workflow',
      status: 'active',
      description: 'gates the deploy',
    });
    expect(line).toContain('deploy-check');
    expect(line).toContain('[workflow]');
    expect(line).toContain('(active)');
    expect(line).toContain('gates the deploy');
  });

  it('shows the pipeline shape and tools in detail view', () => {
    const detail = formatAgentDetail({
      id: 'a1',
      name: 'deploy-check',
      mode: 'workflow',
      status: 'active',
      pipeline: { nodes: [{ id: '1', type: 'input' }, { id: '2', type: 'llm_call' }, { id: '3', type: 'llm_call' }] },
      modelConfig: { routing: { prefer: 'cheap' }, temperature: 0.2 },
      tools: [{ id: 't1', name: 'get_pet' }],
    });
    expect(detail).toContain('3 node(s)');
    expect(detail).toContain('2x llm_call');
    expect(detail).toContain('routed (policy on the agent)');
    expect(detail).toContain('get_pet');
  });

  it('warns about a non-active agent in the detail view', () => {
    const detail = formatAgentDetail({ id: 'a1', name: 'x', status: 'draft' });
    expect(detail).toContain('activate it before running it');
  });
});

describe('notActiveMessage', () => {
  it('says what is wrong and what to do, not the API body', () => {
    // The API answers 400 with
    // {"error":"AGENT_NOT_ACTIVE","message":"Agent must be active to
    // invoke"} and the CLI printed that body verbatim.
    const message = notActiveMessage({ id: 'a1', name: 'nightly', status: 'draft' });
    expect(message).toContain('"nightly" is draft');
    expect(message).toContain('Activate it');
    expect(message).toContain('https://app.almyty.com/agents/a1');
    expect(message).not.toContain('AGENT_NOT_ACTIVE');
    expect(message).not.toContain('API error');
  });
});

describe('the documented surface matches the code', () => {
  const index = INDEX;
  const help = HELP_TEXT;
  const commandNames = [...index.matchAll(/^\s{2}(\w+): cmd\w+,$/gm)].map((m) => m[1]);

  it('found the command table', () => {
    expect(commandNames.length).toBeGreaterThan(5);
  });

  it('documents every command the switch dispatches', () => {
    // The command table line, not the whole help text: `run` appears in
    // "Run options" too, so a substring match would pass for a command
    // that was never listed.
    for (const name of commandNames) {
      expect(help, `command table entry for ${name}`).toMatch(
        new RegExp(`^  ${name}(?: |$)`, 'm'),
      );
    }
  });

  it('documents every flag the code reads', () => {
    for (const flag of [
      '--input',
      '--resume',
      '--max-steps',
      '--max-cost-cents',
      '--max-duration-ms',
      '--watch',
      '--timeout',
      '--limit',
      '--page',
      '--steps',
      '--json',
      '--help',
      '--version',
    ]) {
      expect(help, flag).toContain(flag);
    }
  });

  it('documents the exit codes and the env vars', () => {
    for (const token of ['Exit codes', 'ALMYTY_TOKEN', 'ALMYTY_URL', 'NO_COLOR']) {
      expect(help, token).toContain(token);
    }
  });

  it('emits no ANSI colour, so piping needs no NO_COLOR', () => {
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
      expect(ANSI.test(readFileSync(join(SRC, file), 'utf-8')), file).toBe(false);
    }
  });

  it('gives every relative import a .js specifier', () => {
    const pattern = /(?:from|import)\s*\(?\s*'(\.[^']*)'/g;
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(SRC, file), 'utf-8');
      for (const [, spec] of text.matchAll(pattern)) {
        expect(spec.endsWith('.js'), `${file}: ${spec}`).toBe(true);
      }
    }
  });
});

describe('version and exit codes', () => {
  it('reports the package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf-8'));
    expect(readVersion()).toBe(pkg.version);
  });

  it('shares the suite-wide exit-code table', () => {
    expect(EXIT).toMatchObject({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 });
  });
});

describe('README matches the code', () => {
  const readme = readFileSync(join(SRC, '../README.md'), 'utf-8');
  const commandNames = [...INDEX.matchAll(/^\s{2}(\w+): cmd\w+,$/gm)].map((m) => m[1]);

  it('documents every command the code dispatches', () => {
    for (const name of commandNames) {
      expect(readme, name).toMatch(new RegExp(`\\|\\s*\`${name}[ <\`]`));
    }
  });

  it('claims no command the code does not have', () => {
    const claimed = [...readme.matchAll(/^\| `([a-z]+)[ <`]/gm)].map((m) => m[1]);
    expect(claimed.length).toBeGreaterThan(5);
    for (const name of claimed) {
      expect(commandNames, name).toContain(name);
    }
  });

  it('documents the exit-code table the code uses', () => {
    for (const code of Object.values(EXIT)) {
      expect(readme, `exit code ${code}`).toContain(`| \`${code}\` |`);
    }
  });

  it('documents every flag --help documents', () => {
    const helpFlags = new Set([...HELP_TEXT.matchAll(/--[a-z][a-z-]+/g)].map((m) => m[0]));
    for (const flag of helpFlags) {
      expect(readme, flag).toContain(flag);
    }
  });
});

describe('parseArgs', () => {
  it('reads the command and positionals', () => {
    const a = parseArgs(['inspect', 'my-agent', 'run-1']);
    expect(a.command).toBe('inspect');
    expect(a.positional).toEqual(['my-agent', 'run-1']);
  });

  it('accepts --flag=value as well as --flag value', () => {
    // Only the space form parsed, so `--input='{"a":1}'` became a flag
    // literally named `input={"a":1}` and the payload was dropped.
    expect(parseArgs(['run', 'a', '--input', '{"a":1}']).flags.input).toBe('{"a":1}');
    expect(parseArgs(['run', 'a', '--input={"a":1}']).flags.input).toBe('{"a":1}');
    expect(parseArgs(['run', 'a', '--input={"a":"b=c"}']).flags.input).toBe('{"a":"b=c"}');
  });

  it('never lets --watch or --json swallow the next token', () => {
    const a = parseArgs(['run', '--watch', 'my-agent'], ['watch']);
    expect(a.flags.watch).toBe(true);
    expect(a.positional).toEqual(['my-agent']);

    const b = parseArgs(['inspect', '--json', 'my-agent', 'run-1']);
    expect(b.flags.json).toBe(true);
    expect(b.positional).toEqual(['my-agent', 'run-1']);
  });

  it('rejects a non-numeric limit rather than sending NaN to the API', () => {
    expect(() => flagNumber({ 'max-cost-cents': 'lots' }, 'max-cost-cents')).toThrow(
      /needs a number/,
    );
    expect(flagNumber({ limit: '50' }, 'limit')).toBe(50);
  });

  it('reads a bare flag as absent, not as the string "true"', () => {
    expect(flagString({ input: true }, 'input')).toBeUndefined();
  });

  it('passes everything after -- through as positional', () => {
    expect(parseArgs(['run', 'a', '--', '--literal']).positional).toEqual(['a', '--literal']);
  });
});

describe('a missing credential is exit 3, not exit 1', () => {
  it('is what this CLI exits with, however it does the check', () => {
    // `@almyty/client`'s resolveCredentialsOrExit used to exit 1 — the
    // same code as an unexpected crash — so this CLI did the check
    // itself to get 3. The shared helper exits 3 now and also treats an
    // expired credential as no credential, so either route is correct
    // and the prohibition this test used to carry is gone. What still
    // matters is the code a script branches on.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const sources = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => stripComments(readFileSync(join(SRC, f), 'utf-8')));
    const all = sources.join('\n');

    // Either it delegates to the shared helper, or it exits EXIT.AUTH itself.
    const delegates = all.includes('resolveCredentialsOrExit');
    const exitsItself = all.includes('EXIT.AUTH');
    expect(delegates || exitsItself).toBe(true);

    // And nothing anywhere exits 1 for it.
    expect(all).not.toMatch(/Not authenticated[\s\S]{0,300}?process\.exit\(1\)/);
  });
});
