import { encodeMcpHeaderValue, mcpHeaderAnnotations, mcpParamHeaders } from '../mcp-client-headers';

/**
 * Client-side `x-mcp-header` (MCP 2026-07-28, Streamable HTTP, "Custom
 * Headers from Tool Parameters"): which tool definitions are refused, and how
 * argument values become `Mcp-Param-*` headers.
 */
describe('Mcp-Param headers, client side', () => {
  it.each([
    ['us-west1', 'us-west1'],
    ['Hello, 世界', '=?base64?SGVsbG8sIOS4lueVjA==?='],
    [' padded ', '=?base64?IHBhZGRlZCA=?='],
    ['line1\nline2', '=?base64?bGluZTEKbGluZTI=?='],
    ['=?base64?literal?=', '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?='],
    ['', ''],
  ])('encodes %j as the spec table does', (value, encoded) => {
    expect(encodeMcpHeaderValue(value)).toBe(encoded);
  });

  it('accepts annotations on statically reachable integer, string and boolean properties', () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        limit: { type: 'integer', 'x-mcp-header': 'Limit' },
        options: { type: 'object', properties: { dryRun: { type: 'boolean', 'x-mcp-header': 'DryRun' } } },
      },
    };
    expect(mcpHeaderAnnotations(schema)).toEqual({
      params: [
        { path: ['region'], name: 'Region', type: 'string' },
        { path: ['limit'], name: 'Limit', type: 'integer' },
        { path: ['options', 'dryRun'], name: 'DryRun', type: 'boolean' },
      ],
    });
  });

  it.each([
    ['an empty name', { properties: { a: { type: 'string', 'x-mcp-header': '' } } }, 'not a valid header name'],
    ['a name with a space', { properties: { a: { type: 'string', 'x-mcp-header': 'My Region' } } }, 'not a valid header name'],
    ['a name with CR/LF', { properties: { a: { type: 'string', 'x-mcp-header': 'A\r\nB' } } }, 'not a valid header name'],
    ['a number parameter', { properties: { a: { type: 'number', 'x-mcp-header': 'A' } } }, 'number parameter'],
    ['an object parameter', { properties: { a: { type: 'object', 'x-mcp-header': 'A' } } }, 'object parameter'],
    ['an untyped parameter', { properties: { a: { 'x-mcp-header': 'A' } } }, 'untyped parameter'],
    ['a duplicate, case-insensitively', { properties: { a: { type: 'string', 'x-mcp-header': 'Region' }, b: { type: 'string', 'x-mcp-header': 'region' } } }, 'used twice'],
    ['one under items', { properties: { a: { type: 'array', items: { type: 'string', 'x-mcp-header': 'A' } } } }, 'statically reachable'],
    ['one under oneOf', { oneOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] }, 'statically reachable'],
    ['one under $defs', { $defs: { x: { type: 'string', 'x-mcp-header': 'A' } }, properties: {} }, 'statically reachable'],
    ['one on the root', { type: 'string', 'x-mcp-header': 'A' }, 'statically reachable'],
  ])('refuses %s', (_label, schema, reason) => {
    const found = mcpHeaderAnnotations(schema);
    expect('invalid' in found && found.invalid).toEqual(expect.stringContaining(reason));
  });

  it('mirrors present values, converted and encoded, and omits absent ones', () => {
    const schema = {
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        limit: { type: 'integer', 'x-mcp-header': 'Limit' },
        dry: { type: 'boolean', 'x-mcp-header': 'Dry' },
        nested: { type: 'object', properties: { zone: { type: 'string', 'x-mcp-header': 'Zone' } } },
        missing: { type: 'string', 'x-mcp-header': 'Missing' },
      },
    };
    expect(mcpParamHeaders(schema, { region: 'eu', limit: -7, dry: false, nested: { zone: 'b ' }, missing: null })).toEqual({
      'Mcp-Param-Region': 'eu',
      'Mcp-Param-Limit': '-7',
      'Mcp-Param-Dry': 'false',
      'Mcp-Param-Zone': `=?base64?${Buffer.from('b ').toString('base64')}?=`,
    });
  });

  it('sends nothing for a schema without annotations, or an invalid one', () => {
    expect(mcpParamHeaders({ properties: { a: { type: 'string' } } }, { a: 'x' })).toEqual({});
    expect(mcpParamHeaders({ properties: { a: { type: 'number', 'x-mcp-header': 'A' } } }, { a: 1 })).toEqual({});
    expect(mcpParamHeaders(undefined, { a: 1 })).toEqual({});
  });
});
