/**
 * Tests for the agent → skillsDir mapping. Pins the directory each
 * agent actually reads, so a typo or copy-paste regression in
 * agents.ts can't silently install skills somewhere the agent will
 * never see them (which was the exact bug for Codex — `.agents/
 * skills/` was being written but Codex only reads `.codex/skills/`
 * repo-local or `$CODEX_HOME/skills` user-scoped).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { detectAgents } from '../agents';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skills-agents-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectAgents — agent detection + skillsDir mapping', () => {
  it('Codex installs into .codex/skills (NOT .agents/skills)', () => {
    // Codex reads `.codex/skills/<skill>/SKILL.md` for repo-local
    // skills. The agentskills.io universal `.agents/skills/` path
    // is not consulted. Pin this so a future "harmonize all agents
    // to .agents/skills/" cleanup can't silently break Codex.
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });

    const agents = detectAgents(tmpDir);
    const codex = agents.find(a => a.name === 'Codex');
    expect(codex).toBeDefined();
    expect(codex!.skillsDir).toBe(join(tmpDir, '.codex/skills'));
    expect(codex!.skillsDir).not.toContain('.agents/skills');
  });

  it('Claude Code installs into .claude/skills', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });

    const agents = detectAgents(tmpDir);
    const claude = agents.find(a => a.name === 'Claude Code');
    expect(claude).toBeDefined();
    expect(claude!.skillsDir).toBe(join(tmpDir, '.claude/skills'));
  });

  it('Windsurf installs into .windsurf/skills', () => {
    mkdirSync(join(tmpDir, '.windsurf'), { recursive: true });

    const agents = detectAgents(tmpDir);
    const ws = agents.find(a => a.name === 'Windsurf');
    expect(ws).toBeDefined();
    expect(ws!.skillsDir).toBe(join(tmpDir, '.windsurf/skills'));
  });

  it('returns no agents when nothing is detected', () => {
    expect(detectAgents(tmpDir)).toEqual([]);
  });

  it('detects multiple agents in the same project', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });

    const agents = detectAgents(tmpDir);
    const names = agents.map(a => a.name).sort();
    expect(names).toEqual(['Claude Code', 'Codex']);
  });

  it('dedupes agents that map to the same skillsDir', () => {
    // Cursor, Cline, Gemini CLI, GitHub Copilot, OpenCode, Amp all
    // share the universal `.agents/skills/` path. If two of them
    // are detected we only emit one target (whichever comes first
    // in AGENT_CONFIGS) so the install loop doesn't write the
    // same files twice.
    mkdirSync(join(tmpDir, '.cursor'), { recursive: true });
    mkdirSync(join(tmpDir, '.cline'), { recursive: true });

    const agents = detectAgents(tmpDir);
    const sharedDirs = agents
      .filter(a => a.skillsDir.endsWith('.agents/skills'))
      .map(a => a.skillsDir);
    expect(new Set(sharedDirs).size).toBe(sharedDirs.length); // unique
  });
});
