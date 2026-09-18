import { DataSource } from 'typeorm';

import { CanonicalSearchHelper } from '../canonical-search.helper';
import { SearchQuery } from '../canonical.types';

/**
 * The lexical half of memory search must apply the same filters the
 * hybrid half does.
 *
 * `ftsSearch` is not a fallback curiosity: it is what `fts_only: true`
 * asks for, what runs when the org has no embedding-capable provider,
 * and what `search()` drops to whenever the vector half returns nothing.
 * It applied `mode` and silently dropped `tier` and `tags`, so a caller
 * narrowing to `{ tier: 'short', tags: ['pii'] }` got every tier and
 * every tag back -- indistinguishable, from the caller's side, from a
 * filter that simply matched everything.
 */
describe('CanonicalSearchHelper.ftsSearch filter parity', () => {
  const scope = { scope_type: 'workspace' as const, scope_id: 'org-1' };

  function helperWith(query: jest.Mock) {
    return new CanonicalSearchHelper({ query } as unknown as DataSource);
  }

  it('applies the tier filter', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await helperWith(query).ftsSearch(
      { scope, query: 'q', tier: 'short' } as SearchQuery,
      10,
    );

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.tier = $5');
    expect(params[4]).toBe('short');
  });

  it('applies the tags overlap filter', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await helperWith(query).ftsSearch(
      { scope, query: 'q', tags: ['pii', 'hr'] } as SearchQuery,
      10,
    );

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.tags && $5');
    expect(params[4]).toEqual(['pii', 'hr']);
  });

  it('numbers mode, tier and tags after the four fixed params', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await helperWith(query).ftsSearch(
      { scope, query: 'q', mode: 'memory', tier: 'long', tags: ['a'] } as SearchQuery,
      10,
    );

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.mode = $5');
    expect(sql).toContain('m.tier = $6');
    expect(sql).toContain('m.tags && $7');
    expect(params).toHaveLength(7);
  });

  it('adds no filter clause when none was asked for', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await helperWith(query).ftsSearch({ scope, query: 'q' } as SearchQuery, 10);

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('m.tier =');
    expect(sql).not.toContain('m.tags &&');
    expect(params).toHaveLength(4);
  });

  it('ignores an empty tags array rather than matching nothing', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await helperWith(query).ftsSearch(
      { scope, query: 'q', tags: [] } as SearchQuery,
      10,
    );

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('m.tags &&');
    expect(params).toHaveLength(4);
  });
});
