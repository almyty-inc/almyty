/**
 * These cover the parts of the server that can be checked without a live
 * backend and without an MCP client: discovery and its failure modes, the
 * registration full mode builds from a gateway tool, the protocol the proxy
 * speaks upstream, prompt naming, and the text a tool call answers with when
 * almyty says no.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT, EXIT_CODE_HELP, exitCodeFor } from '../exit-codes';
import {
  DiscoverySource,
  ToolCatalog,
  sanitizePromptName,
  searchResultText,
  uniquePromptNames,
  upstreamErrorText,
} from '../catalog';
import { cleanAnnotations, gatewayToolConfig, passThroughResult } from '../registration';
import { AlmytyProxy, encodeMcpHeaderValue, isEraRefusal, upstreamEraFromEnv } from '../proxy';

function source(overrides: Partial<DiscoverySource> = {}): DiscoverySource {
  return {
    fetchTools: async () => [{ name: 'pets_list', description: 'List pets' }],
    fetchSkills: async () => [{ name: 'petstore/pets', content: '# pets', toolCount: 2 }],
    ...overrides,
  };
}

describe('ToolCatalog', () => {
  it('holds nothing until it has asked', () => {
    const catalog = new ToolCatalog(source());
    expect(catalog.discovered).toBe(false);
    expect(catalog.tools).toEqual([]);
    expect(catalog.isStale()).toBe(true);
  });

  it('records what it found', async () => {
    const catalog = new ToolCatalog(source());
    await catalog.refresh();
    expect(catalog.discovered).toBe(true);
    expect(catalog.tools.map((t) => t.name)).toEqual(['pets_list']);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.lastError).toBeNull();
  });

  it('never throws when the backend is down, and says why', async () => {
    // This is the whole reason discovery moved out of startup: an exception
    // here used to kill the process in the middle of the MCP handshake.
    const catalog = new ToolCatalog(
      source({ fetchTools: async () => { throw new Error('Failed to fetch tools (401): unauthorized'); } }),
      { warn: () => {} },
    );
    await expect(catalog.refresh()).resolves.toBeUndefined();
    expect(catalog.discovered).toBe(false);
    expect(catalog.lastError).toContain('401');
    expect(catalog.tools).toEqual([]);
  });

  it('keeps the list it already had when a later refresh fails', async () => {
    let fail = false;
    const catalog = new ToolCatalog(
      source({ fetchTools: async () => { if (fail) throw new Error('fetch failed'); return [{ name: 'pets_list' }]; } }),
      { warn: () => {} },
    );
    await catalog.refresh();
    fail = true;
    await catalog.refresh();
    // A stale tool list is more use to the model than none.
    expect(catalog.tools.map((t) => t.name)).toEqual(['pets_list']);
    expect(catalog.lastError).toBe('fetch failed');
  });

  it('re-asks only once what it holds has gone stale', async () => {
    let clock = 1_000;
    const fetchTools = vi.fn(async () => [{ name: 'pets_list' }]);
    const catalog = new ToolCatalog(source({ fetchTools }), { ttlMs: 60_000, now: () => clock });

    await catalog.ensureFresh();
    expect(fetchTools).toHaveBeenCalledTimes(1);

    clock += 59_000;
    await catalog.ensureFresh();
    expect(fetchTools).toHaveBeenCalledTimes(1);
    expect(catalog.isStale()).toBe(false);

    // A tool added in almyty is picked up without restarting the editor.
    clock += 2_000;
    expect(catalog.isStale()).toBe(true);
    await catalog.ensureFresh();
    expect(fetchTools).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent refreshes into one request', async () => {
    let calls = 0;
    const catalog = new ToolCatalog(source({
      fetchTools: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return [{ name: 'a' }]; },
    }));
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    expect(calls).toBe(1);
  });

  it('searches names and descriptions, and lists everything for an empty query', async () => {
    const catalog = new ToolCatalog(source({
      fetchTools: async () => [
        { name: 'pets_list', description: 'List every pet' },
        { name: 'orders_create', description: 'Place an order' },
      ],
    }));
    await catalog.refresh();
    expect(catalog.search('pet').map((t) => t.name)).toEqual(['pets_list']);
    expect(catalog.search('ORDER').map((t) => t.name)).toEqual(['orders_create']);
    expect(catalog.search('place an').map((t) => t.name)).toEqual(['orders_create']);
    expect(catalog.search('  ')).toHaveLength(2);
    expect(catalog.search('nothing-like-this')).toEqual([]);
  });
});

describe('search result text', () => {
  const tools = Array.from({ length: 30 }, (_, i) => ({ name: `tool_${i}`, description: `does ${i}` }));

  it('lists the matches and points at the next step', () => {
    const text = searchResultText('tool_1', [tools[1]], tools);
    expect(text).toContain('Found 1 tools');
    expect(text).toContain('**tool_1**');
    expect(text).toContain('almyty_execute');
  });

  it('caps a huge result set and says it did', () => {
    const text = searchResultText('tool', tools, tools);
    expect(text).toContain('10 more not shown');
  });

  it('offers a sample when nothing matched', () => {
    const text = searchResultText('zzz', [], tools);
    expect(text).toContain('No tools found matching "zzz"');
    expect(text).toContain('and 20 more');
  });

  it('distinguishes an empty gateway from a failed discovery', () => {
    const text = searchResultText('anything', [], []);
    expect(text).toContain('No tools are available');
    expect(text).toContain('stderr');
  });
});

describe('upstream error text', () => {
  it('turns a 401 into the command that fixes it', () => {
    // A raw 401 body in a tool result tells neither the model nor the reader
    // that the login expired.
    const text = upstreamErrorText(new Error('Tool execution failed (401): {"statusCode":401}'));
    expect(text).toContain('npx @almyty/auth login');
  });

  it('separates "no permission" from "not logged in"', () => {
    expect(upstreamErrorText(new Error('Tool execution failed (403): forbidden'))).toContain('lacks permission');
    expect(upstreamErrorText(new Error('Tool execution failed (403): forbidden'))).not.toContain('auth login');
  });

  it('explains a 404 as the gateway id it probably is', () => {
    expect(upstreamErrorText(new Error('Failed to fetch tools (404): Not Found'))).toContain('orgSlug/gatewaySlug');
  });

  it('says a timeout was abandoned rather than left hanging', () => {
    expect(upstreamErrorText(new Error('almyty backend tools/list timed out after 15s'))).toContain('did not answer in time');
  });

  it('names a network failure as one', () => {
    expect(upstreamErrorText(new Error('fetch failed'))).toContain('Could not reach almyty');
    expect(upstreamErrorText(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toContain('ALMYTY_URL');
  });

  it('passes anything else through, including a non-Error', () => {
    expect(upstreamErrorText(new Error('tool said no'))).toBe('tool said no');
    expect(upstreamErrorText('a bare string')).toBe('a bare string');
  });
});

describe('prompt names', () => {
  it('makes a skill name a safe identifier', () => {
    expect(sanitizePromptName('petstore/pets')).toBe('petstore_pets');
    expect(sanitizePromptName('a  b')).toBe('a_b');
    expect(sanitizePromptName('__weird__')).toBe('weird');
    expect(sanitizePromptName('///')).toBe('skill');
  });

  it('keeps two skills that sanitize alike apart', () => {
    expect(uniquePromptNames(['petstore/pets', 'petstore-pets', 'petstore pets'])).toEqual([
      'skill-petstore_pets',
      'skill-petstore-pets',
      'skill-petstore_pets-2',
    ]);
  });
});

// ── A gateway tool as full mode registers it ──────────────────────

/** Records the schema it was given instead of compiling it. */
const recordSchema = (schema: unknown) => ({ jsonSchema: schema });

describe('gatewayToolConfig', () => {
  it('carries the gateway\'s schema, title, output schema, annotations and icons', () => {
    // The 1.x registration rebuilt a Zod shape from the top-level
    // properties and dropped everything else the gateway said.
    const config = gatewayToolConfig({
      name: 'orders_get_order',
      title: 'Get order',
      description: 'Look an order up',
      inputSchema: {
        type: 'object',
        properties: { order: { type: 'object', properties: { id: { type: 'string', 'x-mcp-header': 'Order' } } } },
        required: ['order'],
      },
      outputSchema: { type: 'object', properties: { status: { type: 'string' } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: 'yes' },
      icons: [{ src: 'https://cdn.example.com/o.svg', mimeType: 'image/svg+xml' }, { src: 'http://insecure/x.png' }],
    }, recordSchema);

    expect(config).toEqual({
      title: 'Get order',
      description: 'Look an order up',
      inputSchema: {
        jsonSchema: {
          type: 'object',
          properties: { order: { type: 'object', properties: { id: { type: 'string', 'x-mcp-header': 'Order' } } } },
          required: ['order'],
        },
      },
      outputSchema: { jsonSchema: { type: 'object', properties: { status: { type: 'string' } } } },
      // A hint of the wrong type is left out rather than passed on.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      icons: [{ src: 'https://cdn.example.com/o.svg', mimeType: 'image/svg+xml' }],
    });
  });

  it('leaves out what the gateway did not say, and a non-object output schema', () => {
    const config = gatewayToolConfig({ name: 'ping', inputSchema: {}, outputSchema: { type: 'array' } as any }, recordSchema);
    expect(config).toEqual({ description: 'Tool: ping', inputSchema: { jsonSchema: { type: 'object' } } });
  });

  it('gives a tool with a non-object input schema an empty object schema', () => {
    expect(gatewayToolConfig({ name: 'x', inputSchema: { type: 'string' } as any }, recordSchema).inputSchema).toEqual({
      jsonSchema: { type: 'object', properties: {} },
    });
  });

  it('refuses a schema that is not valid JSON Schema, with the real SDK', () => {
    expect(() => gatewayToolConfig({ name: 'broken', inputSchema: { type: 'object', properties: { a: { type: 'nonsense' } } } })).toThrow();
    expect(() => gatewayToolConfig({ name: 'fine', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } })).not.toThrow();
  });

  it('keeps only the annotations MCP defines', () => {
    expect(cleanAnnotations({ readOnlyHint: false, title: 'T', custom: 1 })).toEqual({ readOnlyHint: false, title: 'T' });
    expect(cleanAnnotations('nope')).toBeUndefined();
    expect(cleanAnnotations({})).toBeUndefined();
  });

  it('hands a call back as the gateway answered it, structured content included', () => {
    expect(passThroughResult({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 }, isError: false })).toEqual({
      content: [{ type: 'text', text: '{"a":1}' }],
      structuredContent: { a: 1 },
    });
    expect(passThroughResult({ content: [{ type: 'text', text: 'no' }], isError: true })).toEqual({
      content: [{ type: 'text', text: 'no' }],
      isError: true,
    });
  });
});

/**
 * This was the one CLI in the family without the shared table: a missing
 * credential left with 1, the same code as a crash, so a supervisor
 * restarted a server that could never start and nothing said to log in.
 */
describe('exit codes', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8');

  it('keeps the same six codes every other almyty CLI uses', () => {
    expect(EXIT).toEqual({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 });
    expect(new Set(Object.values(EXIT)).size).toBe(Object.values(EXIT).length);
  });

  it('classifies a rejected token as not-authenticated, not as a crash', () => {
    expect(exitCodeFor(new Error('Authentication failed. Run: npx @almyty/auth login'))).toBe(EXIT.AUTH);
    expect(exitCodeFor(new Error('API error 401: {}'))).toBe(EXIT.AUTH);
    expect(exitCodeFor(new Error('API error 403: {}'))).toBe(EXIT.AUTH);
    expect(exitCodeFor(new Error('API error 404: no such gateway'))).toBe(EXIT.NOT_FOUND);
    expect(exitCodeFor(new Error('socket hang up'))).toBe(EXIT.ERROR);
  });

  it('leaves with AUTH when there is no credential at all', () => {
    expect(source).toMatch(/no authentication token found[\s\S]{0,200}process\.exit\(EXIT\.AUTH\)/);
  });

  it('treats the auth-subcommand redirect as a usage error', () => {
    expect(source).toMatch(/Authentication moved to @almyty\/auth[\s\S]{0,200}process\.exit\(EXIT\.USAGE\)/);
  });

  it('never exits with a bare number again', () => {
    // Every exit has to name a code from the table, or the table is decoration.
    expect(source).not.toMatch(/process\.exit\(\s*\d/);
  });

  it('documents the table in --help, from the table itself', () => {
    expect(source).toContain('Exit codes (the same in every almyty CLI)');
    // Interpolated, not retyped, so the help text cannot drift from the codes.
    expect(source).toContain('${EXIT_CODE_HELP}');
    expect(EXIT_CODE_HELP).toContain('3  not authenticated');
  });
});

/**
 * The connections CLI became @almyty/credentials, and the provider tool
 * takes a credentialId. Help text and README have to say the same thing,
 * or a user goes looking for a command that no longer exists.
 */
describe('credential wording', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8');
  const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf-8');

  it.each([['index.ts', source], ['README.md', readme]])('%s points at @almyty/credentials, never connections', (_name, text) => {
    expect(text).toContain('npx @almyty/credentials add');
    expect(text).not.toMatch(/@almyty\/connections|almyty connections|connection id|connections flow/i);
  });
});

/**
 * The MCP SDK declares the prompts capability when the first prompt is
 * registered and refuses once the instance is connected. With every prompt
 * added after discovery the server died on startup ("Cannot register
 * capabilities after connecting to transport"). One prompt and the tools
 * have to be registered in the factory, before the instance is returned to
 * serveStdio, and only what discovery found is registered late.
 */
describe('startup order', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8');

  it('registers a prompt and a tool in the factory, before the instance is handed to the SDK', () => {
    const buildAt = source.indexOf('function buildServer(');
    const lateAt = source.indexOf('void Promise.all([discovered, clientReady])');
    const returnAt = source.indexOf('  return server;\n}', buildAt);
    expect(buildAt).toBeGreaterThan(0);
    expect(lateAt).toBeGreaterThan(buildAt);
    for (const marker of ["'almyty-overview'", "server.registerTool(\n      'almyty_execute'", 'server.registerTool(tool.name, { description']) {
      const at = source.indexOf(marker, buildAt);
      expect(at, marker).toBeGreaterThan(buildAt);
      expect(at, marker).toBeLessThan(lateAt);
    }
    expect(returnAt).toBeGreaterThan(lateAt);
    expect(source).toContain('return buildServer(ctx.era');
    expect(source).toContain('serveStdio(async (ctx) =>');
  });
});
// Gateways are MCP, UTCP and Skills. An agent's channels (web chat,
// messaging, A2A) stand up gateways of their own, which are not listed.
describe('almyty_list_gateways', () => {
  it('asks for tool gateways only', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { gateways: [] } }), text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await new AlmytyProxy('https://api.example.com', 't').listGateways();
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/gateways?kind=tool');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── The protocol the proxy speaks to almyty ───────────────────────

describe('upstream protocol', () => {
  type Call = { url: string; headers: Record<string, string>; body: any };

  /** A fetch that records each request and answers from `answer`. */
  function upstream(answer: (call: Call, n: number) => { status?: number; body: unknown }) {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: string, init: any) => {
      const call = { url, headers: init.headers, body: JSON.parse(init.body) };
      calls.push(call);
      const { status = 200, body } = answer(call, calls.length);
      return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  }
  const tools = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'pets_list', title: 'List pets', inputSchema: { type: 'object' } }], resultType: 'complete' } };
  afterEach(() => vi.unstubAllGlobals());

  it('asks in MCP 2026-07-28 by default: _meta in the body, mirrored in the headers', async () => {
    const calls = upstream(() => ({ body: tools }));
    const proxy = new AlmytyProxy('https://api.example.com', 't', 'acme/pets', { warn: () => {}, clientVersion: '9.9.9' });
    expect(await proxy.fetchTools()).toEqual(tools.result.tools);
    expect(calls[0].url).toBe('https://api.example.com/acme/pets');
    expect(calls[0].headers).toMatchObject({
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/list',
      Authorization: 'Bearer t',
      Accept: 'application/json, text/event-stream',
    });
    expect(calls[0].body.params._meta).toEqual({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: '@almyty/mcp-server', version: '9.9.9' },
    });
    expect(proxy.upstreamEra).toBe('modern');
  });

  it('names the tool in Mcp-Name, Base64 when it is not plain ASCII', async () => {
    const calls = upstream(() => ({ body: { result: { content: [{ type: 'text', text: 'ok' }] } } }));
    const proxy = new AlmytyProxy('https://api.example.com', 't', undefined, { warn: () => {} });
    await proxy.callTool('pets_list', {});
    await proxy.callTool('grüße', {});
    expect(calls[0].headers['Mcp-Name']).toBe('pets_list');
    expect(calls[1].headers['Mcp-Name']).toBe(`=?base64?${Buffer.from('grüße').toString('base64')}?=`);
    expect(encodeMcpHeaderValue(' padded')).toMatch(/^=\?base64\?/);
    expect(encodeMcpHeaderValue('=?base64?abc?=')).toMatch(/^=\?base64\?PT9/);
  });

  it.each([
    ['-32022', { jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version' } }],
    ['-32600 naming the version', { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Unsupported protocol version: 2026-07-28' } }],
  ])('falls back to the earlier protocol, once and for good, when almyty refuses 2026-07-28 (%s)', async (_label, refusal) => {
    const warn = vi.fn();
    const calls = upstream((call) => (call.headers['MCP-Protocol-Version'] ? { status: 400, body: refusal } : { body: tools }));
    const proxy = new AlmytyProxy('https://api.example.com', 't', undefined, { warn });
    expect(await proxy.fetchTools()).toEqual(tools.result.tools);
    await proxy.fetchTools();
    expect(calls.map((c) => c.headers['MCP-Protocol-Version'] ?? 'none')).toEqual(['2026-07-28', 'none', 'none']);
    expect(calls[1].body.params._meta).toBeUndefined();
    expect(proxy.upstreamEra).toBe('legacy');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not fall back on an error that is not about the version', async () => {
    const calls = upstream(() => ({ status: 400, body: { jsonrpc: '2.0', id: 1, error: { code: -32020, message: 'Header mismatch' } } }));
    const proxy = new AlmytyProxy('https://api.example.com', 't', undefined, { warn: () => {} });
    await expect(proxy.fetchTools()).rejects.toThrow('Failed to fetch tools (400)');
    expect(calls).toHaveLength(1);
    expect(isEraRefusal(400, { error: { code: -32600, message: 'Invalid request body' } })).toBe(false);
    expect(isEraRefusal(500, { error: { code: -32022 } })).toBe(false);
  });

  it('asks skills/list the earlier way: it is almyty\'s own method, not served to 2026-07-28 requests', async () => {
    const calls = upstream(() => ({ body: { result: { skills: [] } } }));
    await new AlmytyProxy('https://api.example.com', 't', undefined, { warn: () => {} }).fetchSkills();
    expect(calls[0].headers['MCP-Protocol-Version']).toBeUndefined();
    expect(calls[0].body.params._meta).toBeUndefined();
  });

  it('never tries 2026-07-28 with ALMYTY_MCP_PROTOCOL=legacy, nor falls back with modern', async () => {
    const calls = upstream(() => ({ status: 400, body: { error: { code: -32022, message: 'Unsupported protocol version' } } }));
    await new AlmytyProxy('https://x', 't', undefined, { era: upstreamEraFromEnv('legacy'), warn: () => {} }).fetchTools().catch(() => {});
    expect(calls[0].headers['MCP-Protocol-Version']).toBeUndefined();
    await new AlmytyProxy('https://x', 't', undefined, { era: upstreamEraFromEnv(' MODERN '), warn: () => {} }).fetchTools().catch(() => {});
    expect(calls.slice(1).map((c) => c.headers['MCP-Protocol-Version'])).toEqual(['2026-07-28']);
    expect(upstreamEraFromEnv('bogus')).toBe('auto');
    expect(upstreamEraFromEnv(undefined)).toBe('auto');
  });

  it('hands back a call result without the 2026 envelope fields', async () => {
    upstream(() => ({
      body: { result: { content: [{ type: 'text', text: '{"n":1}' }], structuredContent: { n: 1 }, isError: false, resultType: 'complete', _meta: { a: 1 } } },
    }));
    const proxy = new AlmytyProxy('https://x', 't', undefined, { warn: () => {} });
    expect(await proxy.callToolResult('t', {})).toEqual({ content: [{ type: 'text', text: '{"n":1}' }], structuredContent: { n: 1 }, isError: false });
    expect(await proxy.callTool('t', {})).toEqual({ n: 1 });
  });
});
