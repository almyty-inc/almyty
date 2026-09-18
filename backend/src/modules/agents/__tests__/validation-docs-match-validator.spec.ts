import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';

import { AgentValidationHelper } from '../agent-validation.helper';

/**
 * The published validation page has to describe the validator that exists.
 *
 * It described red node borders, edge warning icons and a clickable error
 * panel, none of which the builder has; an `errors: [{nodeId, field, message}]`
 * response the validator never produces; a draft that can be saved with
 * warnings, which no code path allows; and a "all nodes must be reachable"
 * rule that is not enforced. Someone reading it could not tell why their save
 * was refused, or why a node they thought was rejected had just run.
 *
 * Each case below pins the behaviour and the sentence describing it together.
 */
const DOC = readFileSync(
  join(__dirname, '../../../../../docs-site/content/agents/pipeline-validation.mdx'),
  'utf8',
);

/** Prose assertions run against this, so a reflow is not a test failure. */
const FLAT = DOC.replace(/\s+/g, ' ');

const validator = new AgentValidationHelper();

const node = (id: string, type: string, data: Record<string, any> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as any;
const edge = (source: string, target: string, sourceHandle?: string) =>
  ({ id: `${source}-${target}-${sourceHandle ?? ''}`, source, target, sourceHandle }) as any;

const straightLine = () => ({
  nodes: [node('input_1', 'input'), node('llm_1', 'llm_call'), node('output_1', 'output')],
  edges: [edge('input_1', 'llm_1'), edge('llm_1', 'output_1')],
});

describe('what the validator refuses', () => {
  it('names the node and what to change', () => {
    const pipeline = straightLine();
    pipeline.nodes.push(node('cond_1', 'condition'), node('a', 'llm_call'), node('b', 'llm_call'), node('c', 'llm_call'));
    pipeline.edges.push(
      edge('llm_1', 'cond_1'),
      edge('cond_1', 'a', 'true'),
      edge('cond_1', 'b', 'true'),
      edge('cond_1', 'c', 'false'),
    );

    // "On true, do A and B" is drawable on the canvas and refused on save.
    expect(() => validator.validatePipeline(pipeline as any)).toThrow(
      "Condition node 'cond_1' must have exactly 2 outgoing edges, found 3",
    );
  });

  it('raises one message, not a list of {nodeId, field, message}', () => {
    const pipeline = straightLine();
    pipeline.nodes.push(node('tool_1', 'tool_call'));
    pipeline.edges.push(edge('llm_1', 'tool_1'));

    let thrown: BadRequestException | undefined;
    try {
      validator.validatePipeline(pipeline as any);
    } catch (err: any) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = thrown!.getResponse() as any;
    expect(typeof body.message).toBe('string');
    expect(body).not.toHaveProperty('errors');

    expect(FLAT).toContain('The validator raises one message, not a list.');
    expect(DOC).not.toContain('"errors": [');
  });

  it('stops at the first problem', () => {
    const pipeline = {
      nodes: [node('input_1', 'input'), node('output_1', 'output'), node('tool_1', 'tool_call'), node('sub_1', 'sub_agent')],
      edges: [edge('input_1', 'tool_1'), edge('tool_1', 'sub_1'), edge('sub_1', 'output_1')],
    };

    // Two nodes are misconfigured; one message comes back.
    expect(() => validator.validatePipeline(pipeline as any)).toThrow(
      "Tool call node 'tool_1' must have 'toolId' in config",
    );
    expect(FLAT).toContain('expect one message at a time, since validation stops at the first failure');
  });
});

describe('every node must be reachable', () => {
  it('refuses an orphan node, naming it, and the page says so', () => {
    const pipeline = straightLine();
    // Dropped on the canvas and never wired up. The engine seeds its first
    // layer with every node of in-degree 0, so this one used to run first,
    // and bill, while no edge carried its output anywhere.
    pipeline.nodes.push(node('orphan_llm', 'llm_call', { userPromptTemplate: 'hi' }));

    expect(() => validator.validatePipeline(pipeline as any)).toThrow(
      /Node\(s\) 'orphan_llm' are not reachable from the input node/,
    );

    expect(FLAT).toContain('Every node must be reachable from the Input node');
    expect(FLAT).not.toContain('A node with no edges at all does not fail validation today');
  });
});

describe('what the validator does not check', () => {

  it('accepts an LLM Call node with no provider and an Output node with no mapping', () => {
    expect(() => validator.validatePipeline(straightLine() as any)).not.toThrow();
    expect(FLAT).toContain('a save succeeds when an LLM Call node has no provider, an Output node has no mapping');
  });

  it('still requires an Output reachable from the Input', () => {
    const pipeline = {
      nodes: [node('input_1', 'input'), node('llm_1', 'llm_call'), node('output_1', 'output')],
      edges: [edge('input_1', 'llm_1')],
    };

    // 'output_1' is unreachable and so is nothing else, so the output rule
    // is the one that fires -- it runs before the general unreachable-node
    // check precisely so the more specific message wins.
    expect(() => validator.validatePipeline(pipeline as any)).toThrow(
      /output node\(s\) 'output_1' are not reachable from the input node 'input_1'/i,
    );
  });

  it('accepts a Transform node with no expression and a Loop node with no iterable', () => {
    const pipeline = straightLine();
    pipeline.nodes.push(node('transform_1', 'transform'), node('loop_1', 'loop'));
    pipeline.edges.push(edge('llm_1', 'transform_1'), edge('transform_1', 'loop_1'));

    // Both throw at run time, on the node, with nothing said at save time.
    expect(() => validator.validatePipeline(pipeline as any)).not.toThrow();
    expect(FLAT).toContain('a Transform node has no expression, a Loop node has no iterable');
  });
});

describe('what the page claims about the builder', () => {
  it('no longer describes canvas affordances that do not exist', () => {
    expect(FLAT).not.toMatch(/Nodes with configuration errors display/i);
    expect(FLAT).not.toMatch(/Edges with expression issues show/i);
    expect(FLAT).not.toMatch(/lists all validation problems with clickable links/i);
    // The builder does run a few pre-save checks of its own — the page says
    // which, and says plainly that they are not the server's rules.
    expect(FLAT).toContain('That list is not the server\'s');
    expect(FLAT).toContain('nodes keep their normal border and edges have no warning markers');
  });

  it('no longer offers a draft saved with warnings', () => {
    expect(FLAT).not.toMatch(/can be saved with validation warnings/i);
    expect(FLAT).toContain('an invalid graph cannot be stored, as a draft or otherwise');
  });
});
