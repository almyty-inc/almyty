/**
 * These cover the parts of the server that can be checked without a live
 * backend and without an MCP client: discovery and its failure modes, the
 * JSON Schema to Zod mapping full mode depends on, prompt naming, and the
 * text a tool call answers with when almyty says no.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it, vi } from 'vitest';
import { EXIT, EXIT_CODE_HELP, exitCodeFor } from '../exit-codes';
import {
  DiscoverySource,
  ToolCatalog,
  sanitizePromptName,
  searchResultText,
  uniquePromptNames,
  upstreamErrorText,
} from '../catalog';
import { ZodLike, buildZodShape, zodTypeFor } from '../schema';

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

// ── The JSON Schema full mode used to hand straight to the SDK ──────

/** Records what was asked of it, so the mapping can be checked on its own. */
function fakeZod(): ZodLike {
  const node = (kind: string, extra: Record<string, unknown> = {}) => ({
    kind,
    ...extra,
    describe(description: string) { return { ...this, description }; },
    optional() { return { ...this, optional: true }; },
  });
  return {
    string: () => node('string'),
    number: () => node('number'),
    boolean: () => node('boolean'),
    array: (inner: any) => node('array', { inner }),
    record: (inner: any) => node('record', { inner }),
    unknown: () => node('unknown'),
    enum: (values: [string, ...string[]]) => node('enum', { values }),
  } as unknown as ZodLike;
}

describe('buildZodShape', () => {
  const z = fakeZod();

  it('maps each JSON Schema type to a Zod type', () => {
    expect(zodTypeFor({ type: 'string' }, z)).toMatchObject({ kind: 'string' });
    expect(zodTypeFor({ type: 'number' }, z)).toMatchObject({ kind: 'number' });
    expect(zodTypeFor({ type: 'integer' }, z)).toMatchObject({ kind: 'number' });
    expect(zodTypeFor({ type: 'boolean' }, z)).toMatchObject({ kind: 'boolean' });
    expect(zodTypeFor({ type: 'object' }, z)).toMatchObject({ kind: 'record' });
    expect(zodTypeFor({ type: 'array', items: { type: 'string' } }, z)).toMatchObject({ kind: 'array', inner: { kind: 'string' } });
  });

  it('narrows a string enum, because that is how a tool says "one of these"', () => {
    expect(zodTypeFor({ type: 'string', enum: ['a', 'b'] }, z)).toMatchObject({ kind: 'enum', values: ['a', 'b'] });
    // A mixed enum is not one the SDK can express, so it stays unknown.
    expect(zodTypeFor({ enum: ['a', 1] } as any, z)).toMatchObject({ kind: 'unknown' });
  });

  it('takes the concrete member of a nullable union', () => {
    expect(zodTypeFor({ type: ['string', 'null'] }, z)).toMatchObject({ kind: 'string' });
  });

  it('falls back to unknown rather than inventing a type', () => {
    expect(zodTypeFor(undefined, z)).toMatchObject({ kind: 'unknown' });
    expect(zodTypeFor({ type: 'weird' }, z)).toMatchObject({ kind: 'unknown' });
  });

  it('turns a tool schema into one Zod type per property', () => {
    // The old code passed this object itself as the shape, so the SDK saw
    // the string "object" and a plain object where it wanted Zod types.
    const shape = buildZodShape({
      type: 'object',
      required: ['petId'],
      properties: {
        petId: { type: 'string', description: 'The pet' },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
    }, z);

    expect(Object.keys(shape)).toEqual(['petId', 'tags', 'limit']);
    expect(shape).not.toHaveProperty('type');
    expect(shape).not.toHaveProperty('properties');
    expect(shape.petId).toMatchObject({ kind: 'string', description: 'The pet' });
    // Required, so `.optional()` was never called on it (the fake replaces
    // the method with the flag `true` once it is).
    expect(shape.petId.optional).not.toBe(true);
    // Not in `required`, so optional.
    expect(shape.tags).toMatchObject({ kind: 'array', optional: true });
    expect(shape.limit).toMatchObject({ kind: 'number', optional: true });
  });

  it('gives a tool with no parameters an empty shape', () => {
    expect(buildZodShape({ type: 'object', properties: {} }, z)).toEqual({});
    expect(buildZodShape(undefined, z)).toEqual({});
    expect(buildZodShape({ type: 'object' }, z)).toEqual({});
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
