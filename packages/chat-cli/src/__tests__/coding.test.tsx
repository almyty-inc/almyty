/**
 * Chat-side coding bridge: slash-command resolution for the new commands,
 * coding-mode input routing, /code target expansion, and the distinct
 * transcript styling + mode indicator.
 *
 * Note: like history.test.tsx, arrow-key driven flows can't run under
 * ink-testing-library's mock stdin; the routing/selection logic is pure and
 * tested directly, the components are render-tested.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';

import { resolveSlash, classifyInput, buildCodeChoices } from '../commands.js';
import { MessageView, CodingModeIndicator, ChoiceSelector } from '../components.js';
import type { Message } from '../components.js';

describe('slash command resolution', () => {
  it('resolves the coding-bridge commands', () => {
    expect(resolveSlash('runners')).toBe('runners');
    expect(resolveSlash('code')).toBe('code');
    expect(resolveSlash('code-stop')).toBe('code-stop');
    expect(resolveSlash('esc')).toBe('esc');
  });

  it('resolves aliases', () => {
    expect(resolveSlash('runner')).toBe('runners');
    expect(resolveSlash('stop')).toBe('code-stop');
    expect(resolveSlash('detach')).toBe('esc');
  });

  it('unique prefixes resolve, ambiguous ones do not', () => {
    expect(resolveSlash('r')).toBe('runners');
    expect(resolveSlash('run')).toBe('runners');
    expect(resolveSlash('co')).toBeNull(); // code vs code-stop
    expect(resolveSlash('code-')).toBe('code-stop');
  });

  it('pre-existing commands still resolve', () => {
    expect(resolveSlash('agents')).toBe('agents');
    expect(resolveSlash('c')).toBe('clear'); // alias wins over code/code-stop prefix
    expect(resolveSlash('q')).toBe('quit');
  });
});

describe('coding-mode input routing', () => {
  it('slash commands are commands in both modes', () => {
    expect(classifyInput('/help', false)).toBe('command');
    expect(classifyInput('/code-stop', true)).toBe('command');
    expect(classifyInput('  /esc', true)).toBe('command');
  });

  it('plain input routes to the coding session only while active', () => {
    expect(classifyInput('run the tests again', true)).toBe('coding');
    expect(classifyInput('run the tests again', false)).toBe('chat');
    expect(classifyInput('y', true)).toBe('coding');
  });
});

describe('buildCodeChoices', () => {
  const runners = [
    {
      id: 'r1', name: 'mac-studio', state: 'online',
      codingAgents: [
        { id: 'claude', displayName: 'Claude Code', binary: 'claude' },
        { id: 'codex', displayName: 'Codex', binary: 'codex' },
      ],
    },
    {
      id: 'r2', name: 'linux-box', state: 'offline',
      codingAgents: [{ id: 'claude', displayName: 'Claude Code', binary: 'claude' }],
    },
    { id: 'r3', name: 'bare-metal', state: 'online', codingAgents: [] },
  ] as any;

  it('expands online runners x detected CLIs and skips offline/empty ones', () => {
    const choices = buildCodeChoices(runners);
    expect(choices).toEqual([
      { runnerId: 'r1', runnerName: 'mac-studio', agentId: 'claude', agentName: 'Claude Code' },
      { runnerId: 'r1', runnerName: 'mac-studio', agentId: 'codex', agentName: 'Codex' },
    ]);
  });

  it('busy runners still accept coding work', () => {
    const choices = buildCodeChoices([{ ...runners[0], state: 'busy' }]);
    expect(choices).toHaveLength(2);
  });
});

describe('coding transcript style', () => {
  it('renders coding output with the cyan gutter, distinct from agent messages', () => {
    const msg: Message = { role: 'coding', text: 'npm test\nall green' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    expect(frame).toContain('▍');
    expect(frame).toContain('npm test');
    expect(frame).toContain('all green');
  });
});

describe('CodingModeIndicator', () => {
  it('shows the active agent@runner and how to leave', () => {
    const { lastFrame } = render(<CodingModeIndicator agent="claude" runner="mac-studio" />);
    const frame = lastFrame()!;
    expect(frame).toContain('coding');
    expect(frame).toContain('claude@mac-studio');
    expect(frame).toContain('/esc');
    expect(frame).toContain('/code-stop');
  });
});

describe('ChoiceSelector', () => {
  it('renders the title and all runner x CLI choices', () => {
    const choices = [
      { key: 'r1:claude', label: 'Claude Code', hint: 'on mac-studio' },
      { key: 'r1:codex', label: 'Codex', hint: 'on mac-studio' },
    ];
    const { lastFrame } = render(
      <ChoiceSelector title="Pick a coding CLI + runner:" choices={choices} onSelect={() => {}} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Pick a coding CLI + runner:');
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('Codex');
    expect(frame).toContain('on mac-studio');
  });
});
