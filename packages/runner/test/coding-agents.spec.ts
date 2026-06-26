import { describe, it, expect } from 'vitest';

import {
  CODING_AGENT_IDS,
  CODING_AGENTS,
  listCodingAgents,
  getCodingAgent,
  findByBinary,
  allProbeBinaries,
  buildAgentSpawn,
  resumeArgv,
  classifyStatus,
  stripVtEscapes,
  lastFrameResetIndex,
  detectCodingAgents,
} from '../src/coding-agents/index.js';
import type { ProbeExec } from '../src/binaries.js';

/**
 * Coding-agent platform support — the runner's port of maco's driver model.
 * Covers the catalog (every platform maco supports), the spawn-spec wiring
 * (headless auth + isolated config home + auto-approve + resume), the
 * busy-first status classifier (per-CLI VT tables), and binary detection.
 */

describe('registry', () => {
  it('covers every platform maco supports plus aider', () => {
    // 11 maco drivers + aider.
    for (const id of [
      'claude', 'codex', 'gemini', 'cursor', 'opencode', 'crush',
      'copilot', 'grok', 'hermes', 'mistral_vibe', 'openclaw', 'aider',
    ]) {
      expect(CODING_AGENT_IDS).toContain(id);
    }
    expect(listCodingAgents()).toHaveLength(12);
  });

  it('every spec is internally consistent', () => {
    for (const spec of listCodingAgents()) {
      expect(spec.binary.length).toBeGreaterThan(0);
      expect(spec.shortCode.length).toBeGreaterThan(0);
      expect(spec.apiKeyEnvVars.length).toBeGreaterThan(0);
      expect(spec.status.spinnerGlyphs.length).toBeGreaterThan(0);
      // id must round-trip through the lookup.
      expect(getCodingAgent(spec.id)).toBe(spec);
    }
  });

  it('uses the real binary names from the feature matrix', () => {
    expect(CODING_AGENTS.cursor.binary).toBe('cursor-agent');
    expect(CODING_AGENTS.mistral_vibe.binary).toBe('vibe');
    expect(CODING_AGENTS.codex.configDirEnvVar).toBe('CODEX_HOME');
    expect(CODING_AGENTS.claude.configDirEnvVar).toBe('CLAUDE_CONFIG_DIR');
  });

  it('resolves a spec by binary name or alias', () => {
    expect(findByBinary('cursor-agent')?.id).toBe('cursor');
    expect(findByBinary('mistral-vibe')?.id).toBe('mistral_vibe'); // alias
    expect(findByBinary('vibe')?.id).toBe('mistral_vibe'); // primary
    expect(findByBinary('claude')?.id).toBe('claude');
    expect(findByBinary('nope')).toBeUndefined();
  });

  it('does not register the bare "agent" alias (collides with other tools)', () => {
    // Regression: a generic `agent` binary (e.g. grok's) must NOT resolve to cursor.
    expect(findByBinary('agent')).toBeUndefined();
    expect(allProbeBinaries()).not.toContain('agent');
  });

  it('allProbeBinaries includes primaries and aliases, deduped', () => {
    const bins = allProbeBinaries();
    expect(bins).toContain('claude');
    expect(bins).toContain('cursor-agent');
    expect(bins).toContain('vibe');
    expect(bins).toContain('mistral-vibe');
    expect(new Set(bins).size).toBe(bins.length); // no dupes
  });
});

describe('spawn-spec', () => {
  it('injects the API key on the CLI-specific env var', () => {
    const spec = getCodingAgent('claude')!;
    const out = buildAgentSpawn(spec, { apiKey: 'sk-ant-xxx' });
    expect(out.env?.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
    expect(out.binary).toBe('claude');
  });

  it('honors an explicit apiKeyEnvVar override (opencode multi-provider)', () => {
    const spec = getCodingAgent('opencode')!;
    const out = buildAgentSpawn(spec, { apiKey: 'sk-openai', apiKeyEnvVar: 'OPENAI_API_KEY' });
    expect(out.env?.OPENAI_API_KEY).toBe('sk-openai');
  });

  it('isolates config via the dedicated env var when the CLI has one', () => {
    const out = buildAgentSpawn(getCodingAgent('codex')!, { configDir: '/tmp/m1' });
    expect(out.env?.CODEX_HOME).toBe('/tmp/m1');
    expect(out.env?.HOME).toBeUndefined();
  });

  it('falls back to HOME isolation when the CLI has no config-dir var', () => {
    const out = buildAgentSpawn(getCodingAgent('gemini')!, { configDir: '/tmp/m2' });
    expect(out.env?.HOME).toBe('/tmp/m2');
  });

  it('adds the auto-approve flag by default and omits it when disabled', () => {
    const on = buildAgentSpawn(getCodingAgent('gemini')!);
    expect(on.args).toContain('--yolo');
    const off = buildAgentSpawn(getCodingAgent('gemini')!, { autoApprove: false });
    expect(off.args).not.toContain('--yolo');
  });

  it('prepends baseArgs (openclaw: chat --local)', () => {
    const out = buildAgentSpawn(getCodingAgent('openclaw')!);
    expect(out.args.slice(0, 2)).toEqual(['chat', '--local']);
  });

  it('builds the right resume argv per session flavor', () => {
    expect(resumeArgv(getCodingAgent('claude')!, 'S1')).toEqual(['--resume', 'S1']);
    expect(resumeArgv(getCodingAgent('copilot')!, 'S1')).toEqual(['--session-id', 'S1']);
    expect(resumeArgv(getCodingAgent('opencode')!, 'S1')).toEqual(['--session', 'S1']);
    expect(resumeArgv(getCodingAgent('codex')!, 'S1')).toEqual(['exec', 'resume', 'S1']);
    expect(resumeArgv(getCodingAgent('aider')!, 'S1')).toEqual([]); // no resume
  });

  it('pins a model only where the CLI takes a plain --model flag', () => {
    expect(buildAgentSpawn(getCodingAgent('claude')!, { model: 'opus' }).args).toContain('opus');
    expect(buildAgentSpawn(getCodingAgent('crush')!, { model: 'x' }).args).not.toContain('x');
  });
});

describe('status classifier (busy-first)', () => {
  it('treats an active "esc to interrupt" marker as busy even with a prompt on screen', () => {
    const screen = 'doing work...\n  esc to interrupt\n> ';
    expect(classifyStatus(CODING_AGENTS.claude.status, screen)).toBe('busy');
  });

  it('detects a spinner glyph as busy', () => {
    expect(classifyStatus(CODING_AGENTS.claude.status, '✶ thinking')).toBe('busy');
  });

  it('reads a bare prompt as idle', () => {
    expect(classifyStatus(CODING_AGENTS.claude.status, 'all done\n> ')).toBe('idle');
    expect(classifyStatus(CODING_AGENTS.gemini.status, 'ready\ngemini> ')).toBe('idle');
  });

  it('surfaces an auth gate as awaiting_auth, not idle', () => {
    const screen = 'Welcome\nPlease sign in to continue\n> ';
    expect(classifyStatus(CODING_AGENTS.claude.status, screen)).toBe('awaiting_auth');
  });

  it('surfaces a fatal marker as error', () => {
    expect(classifyStatus(CODING_AGENTS.claude.status, 'panic: boom')).toBe('error');
  });

  it('opencode pulse spinner + "ask anything" prompt', () => {
    expect(classifyStatus(CODING_AGENTS.opencode.status, '█ generating...')).toBe('busy');
    expect(classifyStatus(CODING_AGENTS.opencode.status, 'idle\nask anything')).toBe('idle');
  });

  it('strips VT escape sequences before matching', () => {
    const raw = '\x1b[2J\x1b[1;1H\x1b[32mdone\x1b[0m\n\x1b[1m> \x1b[0m';
    expect(classifyStatus(CODING_AGENTS.claude.status, stripVtEscapes(raw))).toBe('idle');
  });

  it('finds the last frame-reset so stale frames are discardable', () => {
    expect(lastFrameResetIndex('no resets here')).toBe(-1);
    const s = 'busy esc to interrupt\x1b[H\x1b[2Jall done\n> ';
    const idx = lastFrameResetIndex(s);
    expect(idx).toBeGreaterThan(0);
    // Keeping from the reset drops the stale busy marker.
    expect(stripVtEscapes(s.slice(idx))).not.toContain('esc to interrupt');
  });
});

describe('detection', () => {
  function stubExec(present: Record<string, string>): ProbeExec {
    return async (bin) => {
      if (bin in present) {
        return { stdout: present[bin], stderr: '', exitCode: 0, timedOut: false };
      }
      return { stdout: '', stderr: '', exitCode: 127, timedOut: false };
    };
  }

  it('reports only installed platforms, with version + capabilities', async () => {
    const found = await detectCodingAgents(stubExec({ claude: '1.2.3', codex: '0.9' }));
    const ids = found.map((f) => f.id).sort();
    expect(ids).toEqual(['claude', 'codex']);
    const claude = found.find((f) => f.id === 'claude')!;
    expect(claude.version).toBe('1.2.3');
    expect(claude.providerFamily).toBe('anthropic');
    expect(claude.supportsMcp).toBe(true);
  });

  it('resolves a platform via its alias binary', async () => {
    const found = await detectCodingAgents(stubExec({ 'mistral-vibe': '0.3.1' })); // vibe's alias
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('mistral_vibe');
    expect(found[0].resolvedBinary).toBe('mistral-vibe');
  });

  it('returns empty when nothing is installed', async () => {
    expect(await detectCodingAgents(stubExec({}))).toEqual([]);
  });
});
