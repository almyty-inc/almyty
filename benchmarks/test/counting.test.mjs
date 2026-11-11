import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetTool } from '../lib/almyty.mjs';
import { renderTables, stats } from '../lib/report.mjs';
import { countOperations, subsetByTag } from '../lib/subset.mjs';
import { accumulate, callText, countTokens, countTools, modelFacingTool, toolsText } from '../lib/tokens.mjs';

test('countTokens uses o200k_base', () => {
  // Reference counts from tiktoken's o200k_base.
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens('hello world'), 2);
  assert.equal(countTokens('{"name":"get_weather"}'), 6);
  assert.throws(() => countTokens(undefined), TypeError);
});

test('a tool is counted as name, description and input schema only', () => {
  const tool = {
    name: 'get_pet',
    title: 'Get a pet',
    description: 'Fetch one pet.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { huge: { type: 'string', description: 'x'.repeat(500) } } },
    annotations: { readOnlyHint: true },
  };
  assert.deepEqual(modelFacingTool(tool), {
    name: 'get_pet',
    description: 'Fetch one pet.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
  });
  assert.equal(countTools([tool]), countTokens(toolsText([tool])));
  // The output schema, title and annotations add nothing.
  assert.equal(countTools([tool]), countTools([{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }]));
});

test('a tool without an input schema counts an empty object schema', () => {
  assert.deepEqual(modelFacingTool({ name: 'ping' }).input_schema, { type: 'object', properties: {} });
});

test('more tools, more tokens; the count is additive up to the array punctuation', () => {
  const a = { name: 'a', description: 'first', inputSchema: { type: 'object' } };
  const b = { name: 'b', description: 'second', inputSchema: { type: 'object' } };
  const both = countTools([a, b]);
  assert.ok(both > countTools([a]));
  assert.ok(Math.abs(both - (countTools([a]) + countTools([b]))) <= 2);
});

test('callText is the name and the arguments', () => {
  assert.equal(callText('search_tools', { query: 'x' }), '{"name":"search_tools","arguments":{"query":"x"}}');
  assert.equal(callText('noop'), '{"name":"noop","arguments":{}}');
});

test('accumulate: context grows by each call and result; the last result is left out', () => {
  const r = accumulate(100, [
    { call: 10, result: 50 },
    { call: 5, result: 200 },
    { call: 20, result: 9999 },
  ]);
  assert.deepEqual(r.perTurnInput, [100, 160, 365]);
  assert.equal(r.finalContext, 385);
  assert.equal(r.cumulativeInput, 625);
  assert.equal(r.outputTokens, 35);
  assert.equal(r.turns, 3);
});

test('accumulate: one call straight away', () => {
  const r = accumulate(400, [{ call: 12 }]);
  assert.deepEqual(r.perTurnInput, [400]);
  assert.equal(r.finalContext, 412);
  assert.equal(r.cumulativeInput, 400);
});

test('accumulate refuses a bad initial count', () => {
  assert.throws(() => accumulate(-1, []), TypeError);
  assert.throws(() => accumulate(1.5, []), TypeError);
});

const spec = {
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  tags: [{ name: 'issues' }, { name: 'repos' }],
  paths: {
    '/issues/{n}': {
      parameters: [{ $ref: '#/components/parameters/n' }],
      get: { tags: ['issues'], responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/issue' } } } } } },
      delete: { tags: ['repos'], responses: { 204: {} } },
    },
    '/repos': { get: { tags: ['repos'], responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/repo' } } } } } } },
  },
  components: {
    parameters: { n: { name: 'n', in: 'path', required: true, schema: { type: 'integer' } } },
    schemas: {
      issue: { type: 'object', properties: { user: { $ref: '#/components/schemas/user' }, label: { $ref: '#/components/schemas/label/properties/name' } } },
      user: { type: 'object', properties: { name: { type: 'string' } } },
      label: { type: 'object', properties: { name: { type: 'string' } } },
      repo: { type: 'object', properties: { owner: { $ref: '#/components/schemas/user' } } },
    },
    securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
  },
};

test('subsetByTag keeps the tagged operations and the components they reach', () => {
  const cut = subsetByTag(spec, 'issues');
  assert.deepEqual(Object.keys(cut.paths), ['/issues/{n}']);
  assert.deepEqual(Object.keys(cut.paths['/issues/{n}']).sort(), ['get', 'parameters']);
  assert.equal(countOperations(cut), 1);
  assert.deepEqual(Object.keys(cut.components.schemas).sort(), ['issue', 'label', 'user']);
  assert.deepEqual(Object.keys(cut.components.parameters), ['n']);
  assert.ok(cut.components.securitySchemes.token);
  assert.deepEqual(cut.tags, [{ name: 'issues' }]);
});

test('subsetByTag is deterministic and does not touch its input', () => {
  const before = JSON.stringify(spec);
  assert.equal(JSON.stringify(subsetByTag(spec, 'issues')), JSON.stringify(subsetByTag(spec, 'issues')));
  assert.equal(JSON.stringify(spec), before);
});

test('countOperations counts path + method pairs', () => {
  assert.equal(countOperations(spec), 3);
  assert.equal(countOperations({}), 0);
});

test('targetTool matches on method and path, from the operation or the metadata', () => {
  const tools = [
    { name: 'a', operation: { method: 'get', endpoint: '/x' } },
    { name: 'b', metadata: { sourceOperation: { method: 'POST', endpoint: '/x' } } },
  ];
  assert.equal(targetTool(tools, { method: 'GET', endpoint: '/x' }).name, 'a');
  assert.equal(targetTool(tools, { method: 'POST', endpoint: '/x' }).name, 'b');
  assert.equal(targetTool(tools, { method: 'GET', endpoint: '/y' }), undefined);
});

test('stats: min, median, max', () => {
  assert.deepEqual(stats([3, 1, 2]), { n: 3, min: 1, median: 2, max: 3 });
  assert.deepEqual(stats([4, 1, 2, 3]), { n: 4, min: 1, median: 2.5, max: 4 });
  assert.deepEqual(stats([]), { n: 0, min: null, median: null, max: null });
});

test('renderTables renders every spec in every table', () => {
  const step = { turns: 1, finalContext: 10, cumulativeInput: 9 };
  const md = renderTables({
    specs: [{
      label: 'Demo', operations: 2, toolCount: 2, bytes: 4096, targetTool: 'demo_get',
      tokens: { full: { initial: 1000 }, proxy: { initialAll: 300, initialGatewayOnly: 100 }, code: { initial: 200 } },
      task: {
        what: 'do it', full: step, code: { ...step, searches: [{ query: 'q', rank: 2 }], getToolResultTokens: 50 },
        proxyNoSkill: { ...step, searches: [{ query: 'k', found: false }] }, proxyWithSkill: { ...step, skillPromptTokens: 70 },
      },
      import: { stats: { n: 1, min: 1500, median: 1500, max: 1500 } },
    }],
  });
  assert.match(md, /\| Demo \| 2 \| 2 \| 1,000 \| 300 \| 100 \| 200 \| 5\.0x \|/);
  assert.match(md, /"q": 2/);
  assert.match(md, /"k": not found/);
  assert.match(md, /\| Demo \| 4 KiB \| 1 \| 1\.50 s \| 1\.50 s \| 1\.50 s \| 2 \|/);
});
