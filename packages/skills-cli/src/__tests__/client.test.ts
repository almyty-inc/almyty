import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRef } from '../client.js';
import { generateMetaSkill } from '../meta-skill.js';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// parseRef()
// ---------------------------------------------------------------------------
describe('parseRef', () => {
  it('parses @org/gateway as a gateway ref', () => {
    const result = parseRef('@org/gateway');
    expect(result).toEqual({
      type: 'gateway',
      orgSlug: 'org',
      gatewaySlug: 'gateway',
      raw: '@org/gateway',
    });
  });

  it('parses @org/gateway/skill as a skill ref', () => {
    const result = parseRef('@org/gateway/skill');
    expect(result).toEqual({
      type: 'skill',
      orgSlug: 'org',
      gatewaySlug: 'gateway',
      skillName: 'skill',
      raw: '@org/gateway/skill',
    });
  });

  it('parses a UUID string as a uuid ref', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = parseRef(uuid);
    expect(result).toEqual({
      type: 'uuid',
      uuid,
      raw: uuid,
    });
  });

  it('parses uppercase UUID correctly', () => {
    const uuid = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
    const result = parseRef(uuid);
    expect(result.type).toBe('uuid');
    expect(result.uuid).toBe(uuid);
  });

  it('returns search for a random string', () => {
    const result = parseRef('some-random-query');
    expect(result).toEqual({
      type: 'search',
      raw: 'some-random-query',
    });
  });

  it('returns search for an empty string', () => {
    const result = parseRef('');
    expect(result).toEqual({
      type: 'search',
      raw: '',
    });
  });

  it('returns search for @ with only one segment', () => {
    const result = parseRef('@org');
    expect(result).toEqual({
      type: 'search',
      raw: '@org',
    });
  });

  it('returns search for @ with more than three segments', () => {
    const result = parseRef('@org/gw/skill/extra');
    expect(result).toEqual({
      type: 'search',
      raw: '@org/gw/skill/extra',
    });
  });
});

// ---------------------------------------------------------------------------
// generateMetaSkill()
// ---------------------------------------------------------------------------
describe('generateMetaSkill', () => {
  it('returns a SkillFile with name "skills" and fileName "almyty-skills"', () => {
    const skill = generateMetaSkill();
    expect(skill.name).toBe('skills');
    expect(skill.fileName).toBe('almyty-skills');
  });

  it('content includes npx @almyty/skills commands', () => {
    const { content } = generateMetaSkill();
    expect(content).toContain('npx @almyty/skills');
  });

  it('content references daemon command', () => {
    const { content } = generateMetaSkill();
    expect(content).toContain('daemon');
  });

  it('content references search command', () => {
    const { content } = generateMetaSkill();
    expect(content).toContain('search');
  });

  it('content references install command', () => {
    const { content } = generateMetaSkill();
    expect(content).toContain('install');
  });

  it('content references run command', () => {
    const { content } = generateMetaSkill();
    expect(content).toContain('run');
  });

  it('content includes SKILL.md front-matter', () => {
    const { content } = generateMetaSkill();
    expect(content).toContain('---');
    expect(content).toContain('name: almyty-skills');
    expect(content).toContain('description:');
  });
});

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------
describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env between tests
    process.env = { ...originalEnv };
    delete process.env.APIFAI_SKILLS_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns empty config when no .almytyrc exists and no env var', () => {
    // Use a temp directory that definitely has no .almytyrc
    const config = loadConfig('/tmp/nonexistent-dir-' + Date.now());
    expect(config).toEqual({});
  });

  it('uses APIFAI_SKILLS_DIR env var when set', () => {
    process.env.APIFAI_SKILLS_DIR = '/custom/skills/dir';
    const config = loadConfig();
    expect(config).toEqual({ skillsDir: '/custom/skills/dir' });
  });

  it('env var takes precedence over .almytyrc files', () => {
    process.env.APIFAI_SKILLS_DIR = '/env/override';
    // Even if we pass a projectDir, env should take priority
    const config = loadConfig('/some/project');
    expect(config.skillsDir).toBe('/env/override');
  });

  it('returns empty config for a directory with no rc file and no home rc', () => {
    // Use a deeply nested temp path that certainly has no .almytyrc anywhere
    // and also won't match ~/.almytyrc (already handled by the missing file)
    const fakePath = `/tmp/almyty-test-${Date.now()}/deeply/nested/project`;
    const config = loadConfig(fakePath);
    expect(config).toEqual({});
  });
});
