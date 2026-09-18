import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  SUBCOMMANDS,
  BUILTIN_COMMANDS,
  allCommandNames,
  helpText,
  tourText,
  suggestCommand,
  completionScript,
  isCompletionShell,
  COMPLETION_SHELLS,
} from '../commands';
import { readVersion } from '../version';
import { EXIT, EXIT_CODE_HELP } from '../exit-codes';

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../package.json'), 'utf-8'),
) as { version: string; dependencies: Record<string, string> };

describe('subcommand table', () => {
  it('only delegates to packages @almyty/cli actually depends on', () => {
    // `almyty models` and `almyty connections` were advertised in --help
    // while the umbrella did not depend on either package, so both
    // answered "package is not installed".
    for (const [name, sub] of Object.entries(SUBCOMMANDS)) {
      expect(pkg.dependencies[sub.pkg], `${name} -> ${sub.pkg}`).toBeDefined();
    }
  });

  it('lists every sibling CLI, models and connections included', () => {
    const packages = new Set(Object.values(SUBCOMMANDS).map((s) => s.pkg));
    for (const expected of [
      '@almyty/auth',
      '@almyty/agents',
      '@almyty/chat',
      '@almyty/skills',
      '@almyty/models',
      '@almyty/connections',
      '@almyty/runner',
      '@almyty/mcp-server',
      '@almyty/acp-server',
    ]) {
      expect(packages).toContain(expected);
    }
  });

  it('gives every command a non-empty one-line description', () => {
    for (const [name, sub] of Object.entries(SUBCOMMANDS)) {
      expect(sub.help.length, name).toBeGreaterThan(5);
      expect(sub.help, name).not.toContain('\n');
      expect(sub.group.length, name).toBeGreaterThan(0);
    }
  });
});

describe('helpText', () => {
  const help = helpText('9.9.9');

  it('documents every delegated command', () => {
    for (const name of Object.keys(SUBCOMMANDS)) {
      expect(help).toContain(`  ${name}`);
    }
  });

  it('documents the builtins', () => {
    for (const name of BUILTIN_COMMANDS) {
      expect(help).toContain(name);
    }
  });

  it('documents the shared exit-code table', () => {
    for (const line of EXIT_CODE_HELP.split('\n')) {
      expect(help).toContain(line.trim());
    }
  });

  it('shows the version it was given', () => {
    expect(help).toContain('v9.9.9');
  });
});

describe('tourText', () => {
  it('is short enough to read at a glance', () => {
    const tour = tourText('1.0.0');
    expect(tour.split('\n').length).toBeLessThan(20);
  });

  it('points at login first and at help last', () => {
    const tour = tourText('1.0.0');
    expect(tour.indexOf('almyty login')).toBeLessThan(tour.indexOf('almyty help'));
  });
});

describe('readVersion', () => {
  it('reports the package.json version, not a hardcoded string', () => {
    expect(readVersion()).toBe(pkg.version);
  });

  it('falls back rather than throwing', () => {
    expect(readVersion('x')).toBe(pkg.version);
  });
});

describe('suggestCommand', () => {
  it('suggests the singular/plural neighbour', () => {
    expect(suggestCommand('agent')).toBe('agents');
    expect(suggestCommand('skill')).toBe('skills');
  });

  it('suggests for a one-character typo', () => {
    expect(suggestCommand('loginn')).toBe('login');
  });

  it('stays quiet for something unrelated', () => {
    expect(suggestCommand('kubernetes')).toBeNull();
  });
});

describe('completion', () => {
  it('accepts exactly bash, zsh and fish', () => {
    for (const shell of COMPLETION_SHELLS) expect(isCompletionShell(shell)).toBe(true);
    expect(isCompletionShell('powershell')).toBe(false);
  });

  it.each(COMPLETION_SHELLS)('names every command in the %s script', (shell) => {
    const script = completionScript(shell);
    for (const name of allCommandNames()) {
      expect(script, name).toContain(name);
    }
  });
});

describe('exit codes', () => {
  it('keeps distinct codes so scripts can branch on them', () => {
    const values = Object.values(EXIT);
    expect(new Set(values).size).toBe(values.length);
    expect(EXIT.OK).toBe(0);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.AUTH).toBe(3);
    expect(EXIT.NOT_FOUND).toBe(4);
    expect(EXIT.FAILED).toBe(5);
  });
});

describe('README matches the code', () => {
  const readme = readFileSync(join(import.meta.dirname, '../../README.md'), 'utf-8');

  it('lists every delegated command, and delegates it to the package the README claims', () => {
    // The README's table omitted `models` and `connections` while
    // --help listed both, so the two documents disagreed about what
    // the CLI could do.
    for (const [name, sub] of Object.entries(SUBCOMMANDS)) {
      const row = readme
        .split('\n')
        .find((line) => line.startsWith(`| \`almyty ${name}`));
      expect(row, `README row for \`almyty ${name}\``).toBeDefined();
      expect(row, `README row for ${name} names ${sub.pkg}`).toContain(sub.pkg);
    }
  });

  it('claims no command the code does not route', () => {
    const claimed = [...readme.matchAll(/^\| `almyty ([a-z]+)/gm)].map((m) => m[1]);
    expect(claimed.length).toBeGreaterThan(5);
    for (const name of claimed) {
      expect(allCommandNames(), name).toContain(name);
    }
  });

  it('documents the exit-code table the code uses', () => {
    for (const [name, code] of Object.entries(EXIT)) {
      expect(readme, `exit code ${name}`).toContain(`| \`${code}\` |`);
    }
  });

  it('documents shell completion for every shell the code emits', () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(readme, shell).toContain(`almyty completion ${shell}`);
    }
  });
});

/**
 * The completion table is a hand-written copy of what each sibling CLI
 * dispatches, so it goes stale silently: `almyty agents <TAB>` offered
 * five of the eight commands, and inspect, executions and trace — the
 * three you need when a run went wrong — completed to nothing.
 *
 * These read the sibling's source rather than importing it, because a
 * sibling's entry point runs main() on import.
 */
describe('completion offers the subcommands each sibling CLI really has', () => {
  const sibling = (path: string) =>
    readFileSync(join(import.meta.dirname, '../../..', path), 'utf-8');

  /** The literal list in a CLI's "Unknown command" message. */
  function commandsFromUnknownMessage(source: string): string[] {
    const match = source.match(/'Commands: ([^.']+)\./);
    expect(match, 'the CLI prints a literal Commands: line').not.toBeNull();
    return match![1].split(',').map((s) => s.trim()).filter(Boolean);
  }

  it('covers every command @almyty/agents dispatches', () => {
    const source = sibling('agents-cli/src/index.ts');
    const start = source.indexOf('const COMMANDS');
    expect(start).toBeGreaterThan(-1);
    const table = source.slice(start, source.indexOf('};', start));
    const dispatched = [...table.matchAll(/^ {2}([a-z][a-z-]*):/gm)].map((m) => m[1]);
    expect(dispatched.length).toBeGreaterThan(5);
    expect(SUBCOMMANDS.agents.subcommands ?? []).toEqual(expect.arrayContaining(dispatched));
  });

  it('covers every command @almyty/skills dispatches', () => {
    const dispatched = commandsFromUnknownMessage(sibling('skills-cli/src/index.ts'));
    expect(dispatched.length).toBeGreaterThan(5);
    expect(SUBCOMMANDS.skills.subcommands ?? []).toEqual(expect.arrayContaining(dispatched));
  });

  it('covers every command @almyty/auth dispatches', () => {
    const dispatched = commandsFromUnknownMessage(sibling('auth-cli/src/index.ts'));
    expect(dispatched).toEqual(['login', 'logout', 'whoami']);
    expect(SUBCOMMANDS.auth.subcommands ?? []).toEqual(expect.arrayContaining(dispatched));
  });

  it('claims no subcommand that is not dispatched anywhere', () => {
    // The other direction: a completion entry for a command that does not
    // exist is a suggestion that fails when you press enter.
    const source = sibling('agents-cli/src/index.ts');
    for (const name of SUBCOMMANDS.agents.subcommands ?? []) {
      expect(source, name).toContain(`  ${name}: cmd`);
    }
  });
});
