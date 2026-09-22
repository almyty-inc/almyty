/**
 * The command line, the non-interactive path, and the documentation.
 *
 * chat only worked on a tty and had no --json, so it could not be
 * piped or scripted at all. These lock down the flag surface, the exit
 * codes a shell script depends on, and the rule that --help must
 * describe every slash command that exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo, AgentRun, StreamEvent } from '@almyty/client';

import {
  helpText,
  isNonInteractive,
  parseArgs,
  resolveRef,
  splitRef,
  useColor,
} from '../args.js';
import { COMMAND_DESCS, SLASH_COMMANDS, resolveSlash } from '../commands.js';
import { jsonResult, readStdin, runHeadless } from '../headless.js';
import { EXIT } from '../exit-codes.js';
import type { TurnTarget } from '../turn.js';

describe('parseArgs', () => {
  it('takes an agent reference as the only positional', () => {
    expect(parseArgs(['acme/support-bot']).ref).toBe('acme/support-bot');
  });

  it('parses every documented flag', () => {
    const args = parseArgs([
      'acme/bot', '--resume', 'conv-1', '-m', 'hello there',
      '--json', '--no-stream', '--no-color', '--max-steps', '12', '--max-cost-cents', '50',
    ]);
    expect(args).toMatchObject({
      ref: 'acme/bot',
      resume: 'conv-1',
      message: 'hello there',
      json: true,
      stream: false,
      color: false,
      maxSteps: 12,
      maxCostCents: 50,
    });
  });

  it('rejects an unknown option instead of ignoring it', () => {
    // --json silently did nothing before; a typo has to say so.
    const args = parseArgs(['acme/bot', '--jsonl']);
    expect(args.error).toContain('--jsonl');
  });

  it('rejects a value flag with no value', () => {
    expect(parseArgs(['--resume']).error).toContain('--resume');
    expect(parseArgs(['--resume', '--json']).error).toContain('--resume');
  });

  it('rejects a non-numeric limit', () => {
    expect(parseArgs(['--max-steps', 'lots']).error).toContain('--max-steps');
    expect(parseArgs(['--max-cost-cents', '-4']).error).toContain('--max-cost-cents');
  });

  it('rejects a stray second positional rather than guessing', () => {
    expect(parseArgs(['acme/bot', 'what is up']).error).toContain('--message');
  });

  it('streams by default', () => {
    expect(parseArgs([]).stream).toBe(true);
  });
});

describe('resolveRef', () => {
  it('prefers the argument', () => {
    expect(resolveRef(parseArgs(['acme/a']), { ALMYTY_AGENT: 'other/b' })).toBe('acme/a');
  });

  it('falls back to ALMYTY_AGENT, which is how a compiled terminal app knows its agent', () => {
    expect(resolveRef(parseArgs([]), { ALMYTY_AGENT: 'acme/support-bot' })).toBe('acme/support-bot');
  });

  it('is undefined when neither is given', () => {
    expect(resolveRef(parseArgs([]), {})).toBeUndefined();
  });
});

describe('splitRef', () => {
  it('splits org from slug', () => {
    expect(splitRef('acme/support-bot')).toEqual({ orgSlug: 'acme', agentSlug: 'support-bot' });
  });
  it('leaves a bare slug without an org', () => {
    expect(splitRef('support-bot')).toEqual({ agentSlug: 'support-bot' });
  });
  it('keeps a slug containing a slash intact', () => {
    expect(splitRef('acme/team/bot')).toEqual({ orgSlug: 'acme', agentSlug: 'team/bot' });
  });
});

describe('isNonInteractive', () => {
  it('a one-shot message or --json never draws a UI', () => {
    expect(isNonInteractive(parseArgs(['-m', 'hi']), { stdinTty: true, stdoutTty: true })).toBe(true);
    expect(isNonInteractive(parseArgs(['--json']), { stdinTty: true, stdoutTty: true })).toBe(true);
  });

  it('a piped stdin or stdout is non-interactive', () => {
    expect(isNonInteractive(parseArgs([]), { stdinTty: false, stdoutTty: true })).toBe(true);
    expect(isNonInteractive(parseArgs([]), { stdinTty: true, stdoutTty: false })).toBe(true);
  });

  it('a terminal on both ends gets the REPL', () => {
    expect(isNonInteractive(parseArgs([]), { stdinTty: true, stdoutTty: true })).toBe(false);
  });
});

describe('useColor', () => {
  it('honours NO_COLOR', () => {
    expect(useColor(parseArgs([]), { NO_COLOR: '1' }, true)).toBe(false);
    expect(useColor(parseArgs([]), { NO_COLOR: '' }, true)).toBe(true);
  });

  it('honours --no-color over everything', () => {
    expect(useColor(parseArgs(['--no-color']), { FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('honours FORCE_COLOR on a pipe', () => {
    expect(useColor(parseArgs([]), { FORCE_COLOR: '1' }, false)).toBe(true);
  });

  it('does not colour a pipe by default, nor a dumb terminal', () => {
    expect(useColor(parseArgs([]), {}, false)).toBe(false);
    expect(useColor(parseArgs([]), { TERM: 'dumb' }, true)).toBe(false);
  });
});

describe('--help is the documentation', () => {
  const help = helpText('1.2.0');

  it('documents every slash command that exists, with its description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(help, `/${cmd} missing from --help`).toContain(`/${cmd}`);
      const desc = COMMAND_DESCS[cmd];
      expect(desc, `/${cmd} has no description`).toBeTruthy();
      expect(help).toContain(desc!);
    }
  });

  it('documents every flag the parser accepts', () => {
    for (const flag of ['--message', '--stdin', '--resume', '--json', '--no-stream', '--no-color', '--max-steps', '--max-cost-cents', '--help', '--version']) {
      expect(help, `${flag} missing from --help`).toContain(flag);
    }
  });

  it('documents the environment variables and the keys', () => {
    for (const name of ['ALMYTY_TOKEN', 'ALMYTY_URL', 'ALMYTY_AGENT', 'NO_COLOR']) {
      expect(help).toContain(name);
    }
    expect(help).toContain('Ctrl-C');
    expect(help).toContain('Ctrl-D');
  });

  it('shows a pipe and a --json example, since both now work', () => {
    expect(help).toContain('| almyty chat');
    expect(help).toContain('--json');
  });
});

// ── Non-interactive mode ────────────────────────────────────────

const AGENT: AgentInfo = { id: 'a1', name: 'Support Bot', slug: 'support-bot', mode: 'autonomous' };

function target(script: Array<{ type: string; data?: Record<string, unknown> }>, final?: Partial<AgentRun>): TurnTarget {
  return {
    async startRun() { return { id: 'run_1', status: 'running', conversationId: 'conv_1' } as AgentRun; },
    async streamRun(runId, handler) {
      for (const e of script) handler({ type: e.type, data: e.data ?? {} } as StreamEvent);
      return { id: runId, status: 'completed', ...final } as AgentRun;
    },
    async streamInvoke() {},
    async invoke() { return {}; },
    async sendRunInput() {},
    async cancelRun() {},
    async cancelExecution() {},
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

describe('runHeadless', () => {
  it('writes the answer to stdout and attribution to stderr, so a pipe stays clean', async () => {
    const io = capture();
    const code = await runHeadless({
      message: 'hi',
      agent: AGENT,
      target: target([
        { type: 'llm.chunk', data: { content: 'Hello' } },
        { type: 'llm.response', data: { content: 'Hello', cost: 0.002, usage: { inputTokens: 10, outputTokens: 2 }, routing: { vendorModelId: 'gpt-4o' } } },
        { type: 'run.completed', data: { output: 'Hello' } },
      ]),
      json: false,
      stream: true,
      io: io.io,
    });

    expect(code).toBe(EXIT.OK);
    expect(io.out.join('')).toBe('Hello\n');
    expect(io.err.join('')).toContain('gpt-4o');
    expect(io.err.join('')).toContain('$0.002');
  });

  it('streams the tail only, never repeating what it already printed', async () => {
    const io = capture();
    await runHeadless({
      message: 'hi',
      agent: AGENT,
      target: target([
        { type: 'llm.chunk', data: { content: 'one ' } },
        { type: 'llm.chunk', data: { content: 'two' } },
        { type: 'run.completed', data: { output: 'one two' } },
      ]),
      json: false, stream: true, io: io.io,
    });
    expect(io.out.join('')).toBe('one two\n');
    // Written in pieces as they arrived, not buffered to the end: a
    // blocking REPL is the failure mode this whole path exists to fix.
    expect(io.out.filter((chunk) => chunk.trim()).length).toBeGreaterThan(1);
    expect(io.out[0]).toBe('one ');
  });

  it('--json prints one parseable object with the ids needed to resume', async () => {
    const io = capture();
    const code = await runHeadless({
      message: 'hi',
      agent: AGENT,
      target: target([{ type: 'run.completed', data: { output: 'answer' } }], { totalCost: 0.01, totalTokens: 120 }),
      json: true, stream: false, io: io.io,
    });

    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed.status).toBe('completed');
    expect(parsed.output).toBe('answer');
    expect(parsed.conversationId).toBe('conv_1');
    expect(parsed.runId).toBe('run_1');
    expect(parsed.usage).toEqual({ cost: 0.01, tokens: 120, steps: 0 });
    // Nothing else on stdout: half a JSON object is not JSON.
    expect(io.out.join('')).toBe(JSON.stringify(parsed, null, 2) + '\n');
  });

  it('a failed run exits 1, so `chat ... && ./ship.sh` does not ship', async () => {
    const io = capture();
    const code = await runHeadless({
      message: 'check the deploy',
      agent: AGENT,
      target: target([{ type: 'run.failed', data: { error: 'checks failed' } }], { status: 'failed', error: 'checks failed' }),
      json: false, stream: true, io: io.io,
    });
    expect(code).toBe(EXIT.FAILED);
    expect(io.err.join('')).toContain('checks failed');
  });

  it('explains a failure in a sentence rather than a status code', async () => {
    const io = capture();
    const broken: TurnTarget = {
      ...target([]),
      async startRun() { throw Object.assign(new Error('API error 400: {"error":"AGENT_NOT_ACTIVE"}'), { status: 400, body: '{"error":"AGENT_NOT_ACTIVE"}' }); },
    };
    const code = await runHeadless({
      message: 'hi', agent: AGENT, target: broken, json: false, stream: true, io: io.io,
      errorContext: { agentRef: 'acme/support-bot', appUrl: 'https://app.almyty.com' },
    });
    expect(code).toBe(EXIT.FAILED);
    expect(io.err.join('')).toContain('not active');
    expect(io.err.join('')).not.toContain('API error');
  });

  it('reports an error as JSON when --json was asked for, with the right exit code', async () => {
    const io = capture();
    const broken: TurnTarget = { ...target([]), async startRun() { throw Object.assign(new Error('API error 404: {}'), { status: 404 }); } };
    const code = await runHeadless({ message: 'hi', agent: AGENT, target: broken, json: true, stream: false, io: io.io });
    // 404 is "not found", distinct from a run that failed.
    expect(code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(io.out.join('')).status).toBe('error');
  });

  it('tells the user how to continue a run that is waiting on them', async () => {
    const io = capture();
    const code = await runHeadless({
      message: 'hi', agent: AGENT,
      target: target([{ type: 'step.completed', data: { status: 'waiting_input' } }], { status: 'waiting_input' }),
      json: false, stream: true, io: io.io,
    });
    expect(code).toBe(EXIT.OK);
    expect(io.err.join('')).toContain('--resume conv_1');
  });
});

describe('jsonResult', () => {
  it('reports no model as null rather than omitting the key', () => {
    const json = jsonResult(
      { status: 'completed', text: 'x', usage: { cost: 0, tokens: 0, steps: 0 } },
      AGENT,
    );
    expect(json.model).toBeNull();
    expect(json.routing).toBeNull();
  });
});

describe('readStdin', () => {
  it('reads a piped question in full', async () => {
    async function* chunks() {
      yield Buffer.from('summarise ');
      yield Buffer.from("today's errors\n");
    }
    expect(await readStdin(chunks())).toBe("summarise today's errors");
  });
});

describe('the README matches the real surface', () => {
  const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf-8');

  it('documents every slash command that exists', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(readme, `/${cmd} missing from the README`).toContain(`/${cmd}`);
    }
  });

  it('documents every flag the parser accepts', () => {
    for (const flag of ['--message', '--stdin', '--resume', '--json', '--no-stream', '--no-color', '--max-steps', '--max-cost-cents']) {
      expect(readme, `${flag} missing from the README`).toContain(flag);
    }
  });

  it('documents every environment variable the code reads', () => {
    for (const name of ['ALMYTY_TOKEN', 'ALMYTY_URL', 'ALMYTY_AGENT', 'ALMYTY_APP_URL', 'ALMYTY_CHAT_HISTORY', 'NO_COLOR']) {
      expect(readme, `${name} missing from the README`).toContain(name);
    }
  });
  it('does not document a command that no longer exists', () => {
    // Every command named in a table row has to resolve. Scoped to
    // table rows so a product route like /apps in prose is not read as
    // a slash command.
    const rows = readme.match(/^\| `\/[a-z-]+/gm) ?? [];
    const mentioned = new Set(rows.map((m) => m.replace(/^\| `\//, '')));
    expect(mentioned.size).toBeGreaterThan(5);
    for (const name of mentioned) {
      expect(resolveSlash(name), `the README documents /${name}, which does not resolve`).not.toBeNull();
    }
  });
});
