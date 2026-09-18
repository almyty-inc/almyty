/**
 * The CLI's own surface: how it parses argv, when it may prompt, and
 * whether --help still describes what the code does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { parseArgs, getRef, parseRunParams } from '../cli-args';
import { helpText } from '../help';
import { isInteractive, useColor } from '../tty';
import { EXIT } from '../exit-codes';
import { readVersion } from '../version';
import { AGENT_CONFIGS } from '../agents';
import { generateMetaSkill } from '../meta-skill';

const SRC = join(import.meta.dirname, '..');
const ANSI = new RegExp(String.fromCharCode(27) + '\\[');
const INDEX = readFileSync(join(SRC, 'index.ts'), 'utf-8');
const HELP = helpText();

describe('parseArgs', () => {
  it('reads a command, a ref, and flags', () => {
    const a = parseArgs(['install', 'acme/petstore', '--agent', 'codex']);
    expect(a.command).toBe('install');
    expect(a.ref).toBe('acme/petstore');
    expect(a.flags.agent).toBe('codex');
  });

  it('accepts --flag=value', () => {
    // `--agent=codex` used to become a flag whose NAME was
    // "agent=codex", so the target was silently ignored.
    const a = parseArgs(['install', '--agent=codex', '--url=https://x']);
    expect(a.flags.agent).toBe('codex');
    expect(a.flags.url).toBe('https://x');
  });

  it('accumulates a repeatable flag in either syntax', () => {
    expect(parseArgs(['install', '-a', 'codex', '-a', 'claude']).flags.agent).toEqual([
      'codex',
      'claude',
    ]);
    expect(parseArgs(['install', '--agent=codex', '--agent=claude']).flags.agent).toEqual([
      'codex',
      'claude',
    ]);
  });

  it('never lets a switch swallow the next token', () => {
    const a = parseArgs(['install', '--dry-run', 'acme/petstore']);
    expect(a.flags['dry-run']).toBe(true);
    expect(a.ref).toBe('acme/petstore');

    const b = parseArgs(['install', '--json', '--all']);
    expect(b.flags.json).toBe(true);
    expect(b.flags.all).toBe(true);
  });

  it('keeps a slash-bearing flag value as a value, not as the ref', () => {
    const a = parseArgs(['install', 'acme/petstore', '--path', './tmp/skills']);
    expect(a.flags.path).toBe('./tmp/skills');
    expect(a.ref).toBe('acme/petstore');
  });

  it('passes everything after -- through untouched', () => {
    const a = parseArgs(['run', 'acme/pet/get', '--', '--literal']);
    expect(a.positional).toEqual(['--literal']);
  });

  it('resolves the ref from the bare word, -g, or a positional', () => {
    expect(getRef(parseArgs(['install', 'acme/petstore']))).toBe('acme/petstore');
    expect(getRef(parseArgs(['install', '-g', 'acme/petstore']))).toBe('acme/petstore');
    expect(getRef(parseArgs(['search', 'weather']))).toBe('weather');
    expect(getRef(parseArgs(['list']))).toBeNull();
  });
});

describe('parseRunParams', () => {
  it('forwards only the skill parameters', () => {
    const args = parseArgs([
      'run',
      'acme/pet/get-pet',
      '--petId',
      '123',
      '--json',
      '--dry-run',
      '--url',
      'https://x',
      '--dir',
      '/tmp',
    ]);
    const params = parseRunParams(args);
    expect(params).toEqual({ petId: '123' });
  });

  it('does not send the CLI’s own switches to the skill', () => {
    // --json and --dry-run were added after parseRunParams' reserved
    // list, so `run x --json` would have sent the skill a parameter
    // called "json".
    for (const flag of ['json', 'dry-run', 'all', 'yes', 'global', 'agent', 'path']) {
      const args = parseArgs(['run', 'acme/pet/get', `--${flag}`]);
      expect(Object.keys(parseRunParams(args)), flag).not.toContain(flag);
    }
  });
});

describe('isInteractive', () => {
  const ATTACHED = { stdin: true, stdout: true };

  it('may prompt when both streams are terminals', () => {
    expect(isInteractive({}, ATTACHED)).toBe(true);
  });

  it('refuses to prompt under CI even with a pseudo-terminal attached', () => {
    // process.stdin.isTTY is true inside most CI runners' pseudo-tty,
    // so a scripted install could stop on a picker nobody could answer.
    expect(isInteractive({ CI: 'true' }, ATTACHED)).toBe(false);
    expect(isInteractive({ CI: '1' }, ATTACHED)).toBe(false);
    expect(isInteractive({ ALMYTY_NON_INTERACTIVE: '1' }, ATTACHED)).toBe(false);
  });

  it('ignores CI=false', () => {
    expect(isInteractive({ CI: 'false' }, ATTACHED)).toBe(true);
    expect(isInteractive({ CI: '0' }, ATTACHED)).toBe(true);
  });

  it('refuses to prompt when either stream is piped', () => {
    expect(isInteractive({}, { stdin: true, stdout: false })).toBe(false);
    expect(isInteractive({}, { stdin: false, stdout: true })).toBe(false);
  });
});

describe('useColor', () => {
  const ATTACHED = { stdin: true, stdout: true };
  const PIPED = { stdin: false, stdout: false };

  it('honours NO_COLOR over everything', () => {
    expect(useColor({ NO_COLOR: '1' }, ATTACHED)).toBe(false);
    expect(useColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, ATTACHED)).toBe(false);
  });

  it('honours FORCE_COLOR when NO_COLOR is unset', () => {
    expect(useColor({ FORCE_COLOR: '1' }, PIPED)).toBe(true);
    expect(useColor({ FORCE_COLOR: '0' }, PIPED)).toBe(false);
  });

  it('treats an empty NO_COLOR as unset, per no-color.org', () => {
    expect(useColor({ NO_COLOR: '' }, ATTACHED)).toBe(true);
    expect(useColor({ NO_COLOR: '' }, PIPED)).toBe(false);
  });

  it('drops colour when stdout is a pipe', () => {
    expect(useColor({}, PIPED)).toBe(false);
    expect(useColor({}, ATTACHED)).toBe(true);
  });
});

describe('--help describes the real surface', () => {
  const dispatched = [...INDEX.matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1]);

  it('found the dispatch table', () => {
    expect(dispatched.length).toBeGreaterThan(8);
  });

  it('documents every command the switch handles', () => {
    // `watch` was implemented and dispatched but appeared nowhere in
    // --help's command list, so the only way to find it was to read
    // the source. Matching the command table line rather than the whole
    // text: "daemon/watch poll interval" mentions `watch` without
    // listing it as a command.
    const commands = dispatched.filter((c) => !['login', 'logout', 'whoami'].includes(c));
    for (const command of commands) {
      expect(HELP, `command table entry for ${command}`).toMatch(
        new RegExp(`^  ${command}(?: |$)`, 'm'),
      );
    }
  });

  it('documents every flag the parser recognises', () => {
    for (const flag of [
      '--agent',
      '--path',
      '--all',
      '--global',
      '--yes',
      '--dry-run',
      '--interval',
      '--url',
      '--dir',
      '--json',
      '--help',
      '--version',
    ]) {
      expect(HELP, flag).toContain(flag);
    }
  });

  it('documents the env vars the code reads', () => {
    for (const name of [
      'ALMYTY_TOKEN',
      'ALMYTY_URL',
      'ALMYTY_SKILLS_DIR',
      'ALMYTY_NON_INTERACTIVE',
      'NO_COLOR',
      'CI',
    ]) {
      expect(HELP, name).toContain(name);
    }
  });

  it('documents only the .almytyrc keys the parser reads', () => {
    for (const key of ['skillsDir', 'agents', 'url', 'interval']) {
      expect(HELP, key).toContain(key);
    }
    // The README advertised a `token` key that nothing ever read, which
    // is worse than no documentation: it looks like a supported way to
    // store a credential outside ~/.almyty.
    const config = readFileSync(join(SRC, 'config.ts'), 'utf-8');
    expect(config).not.toContain('parsed.token');
  });

  it('says that install overwrites, and documents the exit codes', () => {
    expect(HELP).toContain('overwrites');
    expect(HELP).toContain('Exit codes');
  });

  it('claims an agent count the registry actually supports', () => {
    const claimed = HELP.match(/(\d+) agents are recognised/);
    expect(claimed, 'help should state the agent count').not.toBeNull();
    expect(Number(claimed![1])).toBe(AGENT_CONFIGS.length);
  });
});

describe('source hygiene', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  it('emits no ANSI colour of its own', () => {
    for (const file of files) {
      expect(ANSI.test(readFileSync(join(SRC, file), 'utf-8')), file).toBe(false);
    }
  });

  it('gives every relative import a .js specifier', () => {
    const pattern = /(?:from|import)\s*\(?\s*'(\.[^']*)'/g;
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf-8');
      for (const [, spec] of text.matchAll(pattern)) {
        expect(spec.endsWith('.js'), `${file}: ${spec}`).toBe(true);
      }
    }
  });
});

describe('version and exit codes', () => {
  it('reports the package.json version rather than a hardcoded string', () => {
    // This said 1.0.12 while the package was 1.2.0.
    const pkg = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf-8'));
    expect(readVersion()).toBe(pkg.version);
  });

  it('shares the suite-wide exit-code table', () => {
    expect(EXIT).toMatchObject({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 });
  });
});

describe('the meta-skill the daemon installs', () => {
  const content = generateMetaSkill().content;
  const dispatched = new Set(
    [...INDEX.matchAll(/^\s+case '([a-z-]+)':/gm)]
      .map((m) => m[1])
      .filter((c) => !['login', 'logout', 'whoami'].includes(c)),
  );

  it('names only commands the CLI actually dispatches', () => {
    // A coding agent reads this file and copies commands out of it, so a
    // command here that does not exist becomes a failing suggestion in
    // somebody's editor.
    const named = [...content.matchAll(/npx @almyty\/skills ([a-z-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(4);
    for (const command of named) {
      expect(dispatched, command).toContain(command);
    }
  });

  it('covers every command, not just the five it used to', () => {
    for (const command of dispatched) {
      expect(content, command).toContain(`npx @almyty/skills ${command}`);
    }
  });

  it('carries the marker `remove` and `installed` identify our files by', () => {
    expect(content).toMatch(/^\s*author:\s*almyty\s*$/m);
  });
});

describe('README matches the code', () => {
  const readme = readFileSync(join(SRC, '../README.md'), 'utf-8');
  const dispatched = [...INDEX.matchAll(/^\s+case '([a-z-]+)':/gm)]
    .map((m) => m[1])
    .filter((c) => !['login', 'logout', 'whoami'].includes(c));

  it('documents every command the code dispatches', () => {
    for (const name of dispatched) {
      expect(readme, name).toMatch(new RegExp(`\\|\\s*\`${name}[ /\`]`));
    }
  });

  it('documents every flag --help documents', () => {
    const helpFlags = new Set([...HELP.matchAll(/--[a-z][a-z-]+/g)].map((m) => m[0]));
    for (const flag of helpFlags) {
      expect(readme, flag).toContain(flag);
    }
  });

  it('documents the exit-code table the code uses', () => {
    for (const code of Object.values(EXIT)) {
      expect(readme, `exit code ${code}`).toContain(`| \`${code}\` |`);
    }
  });

  it('documents only the .almytyrc keys the config parser reads', () => {
    // The README advertised a `token` key nothing ever read, which looks
    // like a supported place to keep a credential outside ~/.almyty.
    const configTable = readme.slice(readme.indexOf('## Configuration'), readme.indexOf('## Environment variables'));
    for (const key of ['skillsDir', 'agents', 'url', 'interval']) {
      expect(configTable, key).toContain(key);
    }
    expect(configTable).not.toMatch(/"token"/);
    expect(configTable).toContain('no credential key');
  });

  it('claims the agent count the registry supports', () => {
    const claimed = readme.match(/(\d+) agents are recognised/);
    expect(claimed, 'README should state the agent count').not.toBeNull();
    expect(Number(claimed![1])).toBe(AGENT_CONFIGS.length);
  });

  it('says that install overwrites, since it writes into editor config dirs', () => {
    expect(readme.toLowerCase()).toContain('overwrites');
    expect(readme).toContain('--dry-run');
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
