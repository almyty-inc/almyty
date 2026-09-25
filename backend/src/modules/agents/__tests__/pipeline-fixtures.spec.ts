import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { getAgentTemplates } from '../agent-templates';
import { compileStrategy } from '../strategies/strategy-compiler';
import { STRATEGY_SEEDS } from '../strategies/strategy-seeds';

/**
 * The workflow graphs the frontend's step panels are tested against.
 *
 * The builder's panels must open any saved graph and leave it byte for
 * byte as it was until someone changes a field. The graphs worth checking
 * are the ones almyty itself writes: every starter template and every
 * built-in strategy, compiled. The frontend cannot import this module, so
 * it reads a JSON copy; this spec keeps that copy honest, and fails the
 * moment a template or a strategy changes without it.
 *
 * Regenerate with UPDATE_PIPELINE_FIXTURES=1.
 */
const FIXTURE = join(__dirname, '../../../../../frontend/src/components/agents/__tests__/fixtures/pipelines.json');

function buildFixtures() {
  const bind = (slots: string[] | undefined) => Object.fromEntries((slots ?? []).map((slot) => [slot, `role-${slot}`]));
  return {
    templates: getAgentTemplates().map((t) => ({ name: `template:${t.id}`, pipeline: t.pipeline })),
    strategies: STRATEGY_SEEDS.map((s) => ({ name: `strategy:${s.key}`, pipeline: compileStrategy(s, bind(s.roleSlots)) })),
  };
}

describe('pipeline fixtures for the step panels', () => {
  it('the frontend copy is exactly what the templates and strategies produce', () => {
    const built = JSON.parse(JSON.stringify(buildFixtures()));
    if (process.env.UPDATE_PIPELINE_FIXTURES) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE)).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(built);
  });

  it('covers every node type the strategies and templates emit', () => {
    const { templates, strategies } = buildFixtures();
    const types = new Set([...templates, ...strategies].flatMap((f) => f.pipeline.nodes.map((n: any) => n.type)));
    for (const type of ['input', 'output', 'llm_call', 'verify', 'extract_context']) expect(types).toContain(type);
  });
});
