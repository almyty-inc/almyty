import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentTemplateResolver } from '../agent-template-resolver';

/**
 * The published node reference has to describe the executor that exists.
 *
 * It documented four config keys nothing reads — Transform `code`, Parallel
 * `branches` and `aggregation`, Merge `sources` — and three merge strategies
 * the switch has no case for. Following it produced a node that either threw
 * on save-and-run or silently did something else. Each pair below pins the
 * behaviour first and then the sentence that describes it, so neither can
 * drift without the other.
 */
import { readdirSync } from 'fs';

const CONTENT = join(__dirname, '../../../../../docs-site/content/agents');
const nodeTypesDoc = readFileSync(join(CONTENT, 'node-types.mdx'), 'utf8');
const expressionsDoc = readFileSync(join(CONTENT, 'template-expressions.mdx'), 'utf8');

/** Prose assertions run against these, so a reflow is not a test failure. */
const nodeTypesProse = nodeTypesDoc.replace(/\s+/g, ' ');
const expressionsProse = expressionsDoc.replace(/\s+/g, ' ');

const executor = Object.create(AgentNodeExecutor.prototype) as AgentNodeExecutor;
(executor as any).templateResolver = new AgentTemplateResolver();

const ctx = (nodes: Record<string, { output: any }> = {}) => ({
  input: { items: ['a', 'b'] },
  nodes,
});

describe('Transform is a template, not JavaScript', () => {
  it('rejects the documented `code` key at run time', async () => {
    await expect(
      (executor as any).executeTransformNode(
        { id: 'transform_1', data: { code: 'return 1 + 1' } },
        ctx(),
      ),
    ).rejects.toThrow(/missing 'expression'/);
  });

  it('outputs a rendered string, so a JSON-shaped template is a JSON string', async () => {
    const result = await (executor as any).executeTransformNode(
      { id: 'transform_1', data: { expression: '{"summary": "{{input.items}}"}' } },
      ctx(),
    );

    expect(typeof result.output).toBe('string');
    // Substituted raw, not re-escaped: the result is not even valid JSON.
    expect(result.output).toBe('{"summary": "["a","b"]"}');
  });

  it('throws on a call expression rather than evaluating it', async () => {
    await expect(
      (executor as any).executeTransformNode(
        { id: 'transform_1', data: { expression: '{{Date.now()}}' } },
        ctx(),
      ),
    ).rejects.toThrow(/invalid characters/);
  });

  it('is documented by the key it reads', () => {
    expect(nodeTypesDoc).toContain('| `expression` | string | Template rendered against the execution context. Required. |');
    expect(nodeTypesDoc).not.toMatch(/\|\s*`code`\s*\|/);
    expect(nodeTypesProse).toContain('It is a template language, not JavaScript');
  });
});

describe('Parallel reads nothing from its config', () => {
  it('ignores `branches` and `aggregation`', async () => {
    const result = await (executor as any).executeParallelNode(
      {
        id: 'parallel_1',
        data: { branches: ['llm_1', 'llm_2'], aggregation: 'array' },
      },
      ctx({ llm_1: { output: 'first' }, llm_2: { output: 'second' } }),
      { edges: [{ source: 'llm_1', target: 'parallel_1' }, { source: 'llm_2', target: 'parallel_1' }] },
    );

    // `aggregation: "array"` would have to produce both. It produces neither
    // setting's result: the node is a pass-through of its first incoming edge.
    expect(result.output).toBe('first');
  });

  it('is documented as configuration-free', () => {
    expect(nodeTypesProse).toContain('A Parallel node reads nothing from its config');
    expect(nodeTypesDoc).not.toMatch(/\|\s*`branches`\s*\|/);
    expect(nodeTypesDoc).not.toMatch(/\|\s*`aggregation`\s*\|/);
  });
});

describe('Merge strategies', () => {
  const merge = (strategy: string) =>
    (executor as any).executeMergeNode(
      { id: 'merge_1', data: { strategy } },
      ctx({ a: { output: 'first' }, b: { output: 'second' } }),
      {
        organizationId: 'org-1',
        edges: [{ source: 'a', target: 'merge_1' }, { source: 'b', target: 'merge_1' }],
      },
    );

  it('has no case for the documented `object` strategy and silently falls back', async () => {
    expect((await merge('object')).output).toBe('first');
    expect((await merge('concat')).output).toBe('first');
    expect((await merge('first_non_null')).output).toBe('first');
  });

  it('does what it says for the strategies that exist', async () => {
    expect((await merge('first_response')).output).toBe('first');
    expect((await merge('concatenate')).output).toEqual(['first', 'second']);
  });

  it('documents the four real strategies and no `sources` key', () => {
    for (const strategy of ['first_response', 'concatenate', 'best_of_n', 'consensus']) {
      expect(nodeTypesDoc).toContain(`\`${strategy}\``);
    }
    expect(nodeTypesDoc).not.toMatch(/\|\s*`sources`\s*\|/);
    expect(nodeTypesDoc).not.toContain('`first_non_null`');
    expect(nodeTypesProse).toContain('There is no `sources` list');
  });
});

describe('Loop has no per-item context', () => {
  it('leaves nothing named `loop` in the execution context', async () => {
    const context = ctx();
    await (executor as any).executeLoopNode(
      { id: 'loop_1', data: { iterableExpression: '{{input.items}}' } },
      context,
    );

    expect(context).not.toHaveProperty('loop');
  });

  it('resolves {{loop.item}} and {{loop.index}} to nothing', () => {
    const resolver = new AgentTemplateResolver();

    expect(resolver.resolve('Summarise: {{loop.item}}', ctx() as any)).toBe('Summarise: ');
    expect(resolver.resolve('#{{loop.index}}', ctx() as any)).toBe('#');
  });

  it('outputs the capped array instead', async () => {
    const result = await (executor as any).executeLoopNode(
      { id: 'loop_1', data: { iterableExpression: '{{input.items}}', maxIterations: 1 } },
      ctx(),
    );

    expect(result.output).toEqual(['a']);
  });

  it('is documented without the promise', () => {
    expect(nodeTypesProse).toContain('It does not run downstream nodes once per item');
    expect(nodeTypesProse).toContain('resolves to an empty string');
    // The one row that offered loop context as a data source is gone.
    expect(expressionsDoc).not.toContain('| **Loop context** |');
    expect(expressionsProse).toContain('There is no loop context');
  });
});

describe('the expression language the docs describe', () => {
  const resolver = new AgentTemplateResolver();

  it('has no array indexing, so the documented example was an error', () => {
    expect(() => resolver.resolve('{{input.items[0]}}', ctx() as any)).toThrow(
      /invalid characters/,
    );
    expect(expressionsProse).toContain('`{{input.items[0].title}}` is an error');
  });

  it('resolves a missing path to an empty string rather than failing', () => {
    expect(resolver.resolve('{{nodes.nonexistent.output}}', ctx() as any)).toBe('');
    expect(expressionsProse).toContain('Resolves to an empty string');
  });

  it('allows a segment that merely contains a blocked word', () => {
    const context = ctx({ processor: { output: 'ok' } });

    expect(resolver.resolve('{{nodes.processor.output}}', context as any)).toBe('ok');
    expect(expressionsProse).toContain('`{{nodes.processor.output}}` and `{{input.importItems}}` both resolve');
  });
});

describe('no agents page still calls the transform a sandbox', () => {
  const pages = readdirSync(CONTENT).filter((f) => f.endsWith('.mdx'));

  it.each(pages)('%s', (page) => {
    const prose = readFileSync(join(CONTENT, page), 'utf8').replace(/\s+/g, ' ');

    // There is no JS engine behind a transform node: the executor resolves a
    // template and returns the string. Calling it sandboxed JavaScript told
    // readers both that they could write code and that something was
    // containing it, and neither is true.
    expect(prose).not.toMatch(/sandboxed JavaScript/i);
    expect(prose).not.toMatch(/Transform nodes run in a \*\*sandboxed environment\*\*/i);
  });
});
