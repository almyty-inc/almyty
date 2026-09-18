/**
 * Slash command resolution.
 *
 * The same ground coding.test.tsx covers, minus the ink imports, so it
 * runs wherever the package's logic runs. The new commands (/cost,
 * /model, /trace, /resume, /new) must not make an existing shortcut
 * ambiguous: `/c` meaning /clear and `/r` meaning /runners are muscle
 * memory, and /cost and /resume both collide with them on prefix.
 */
import { describe, it, expect } from 'vitest';

import { ALIASES, COMMAND_DESCS, SLASH_COMMANDS, getSuggestion, resolveSlash } from '../commands.js';

describe('the command table', () => {
  it('describes every command', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(COMMAND_DESCS[cmd], `/${cmd} has no description`).toBeTruthy();
    }
  });

  it('describes nothing that is not a command', () => {
    for (const key of Object.keys(COMMAND_DESCS)) {
      expect(SLASH_COMMANDS as readonly string[]).toContain(key);
    }
  });

  it('points every alias at a real command', () => {
    for (const [alias, cmd] of Object.entries(ALIASES)) {
      expect(SLASH_COMMANDS as readonly string[], `${alias} -> ${cmd}`).toContain(cmd);
    }
  });
});

describe('resolveSlash', () => {
  it('resolves every command by its exact name', () => {
    for (const cmd of SLASH_COMMANDS) expect(resolveSlash(cmd)).toBe(cmd);
  });

  it('resolves the commands added for visibility', () => {
    expect(resolveSlash('cost')).toBe('cost');
    expect(resolveSlash('model')).toBe('model');
    expect(resolveSlash('trace')).toBe('trace');
    expect(resolveSlash('resume')).toBe('resume');
    expect(resolveSlash('new')).toBe('new');
  });

  it('keeps the shortcuts that predate them', () => {
    expect(resolveSlash('c')).toBe('clear');
    expect(resolveSlash('r')).toBe('runners');
    expect(resolveSlash('q')).toBe('quit');
    expect(resolveSlash('t')).toBe('tools');
    expect(resolveSlash('?')).toBe('help');
  });

  it('resolves unique prefixes and refuses ambiguous ones', () => {
    expect(resolveSlash('co')).toBeNull(); // cost vs code vs code-stop
    expect(resolveSlash('code-')).toBe('code-stop');
    expect(resolveSlash('res')).toBe('resume');
    expect(resolveSlash('tr')).toBe('trace');
    expect(resolveSlash('n')).toBe('new');
    expect(resolveSlash('m')).toBe('model');
  });

  it('resolves the coding-bridge aliases', () => {
    expect(resolveSlash('runner')).toBe('runners');
    expect(resolveSlash('stop')).toBe('code-stop');
    expect(resolveSlash('detach')).toBe('esc');
  });

  it('is case-insensitive', () => {
    expect(resolveSlash('QUIT')).toBe('quit');
  });

  it('refuses a name that is not a command', () => {
    expect(resolveSlash('zzz')).toBeNull();
  });
});

describe('getSuggestion', () => {
  it('completes a partial command', () => {
    expect(getSuggestion('/ag')).toBe('/agents');
  });
  it('suggests nothing once the name is complete or has arguments', () => {
    expect(getSuggestion('/agents')).toBe('');
    expect(getSuggestion('/code fix the build')).toBe('');
    expect(getSuggestion('hello')).toBe('');
  });
});
