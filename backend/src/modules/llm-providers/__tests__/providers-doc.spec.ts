import { readFileSync } from 'fs';
import { join } from 'path';

import { PROVIDER_PROFILES } from '../provider-profile';
import { providersTable, withGeneratedTable, DOC_START, DOC_END } from '../providers-doc';

/**
 * The published provider table matches the registry.
 *
 * It was maintained by hand and had drifted: it claimed 15 providers
 * while the registry held 33, and described a node by a name the UI had
 * stopped using. A table a reader trusts and nobody can keep current is
 * worse than no table.
 *
 * This is a guard over generated CONTENT, not over wording: it fails when
 * the published table stops matching the data it is generated from, which
 * is a fact about the repo rather than a matter of taste.
 */
const DOC = join(__dirname, '../../../../../docs-site/content/llm-providers.mdx');

describe('the published provider table', () => {
  const markdown = readFileSync(DOC, 'utf8');

  it('has the markers the generator writes between', () => {
    expect(markdown).toContain(DOC_START);
    expect(markdown).toContain(DOC_END);
  });

  it('is current: regenerating it changes nothing', () => {
    // If this fails, run the generator rather than editing the table:
    // the table is output, and hand-edits are lost on the next run.
    expect(withGeneratedTable(markdown)).toBe(markdown);
  });

  it('names every provider the registry holds', () => {
    for (const profile of PROVIDER_PROFILES) {
      expect(markdown).toContain(`\`${profile.key}\``);
    }
  });

  it('counts them rather than asserting a number that goes stale', () => {
    expect(providersTable()).toContain(`${PROVIDER_PROFILES.length} providers`);
  });

  it('says which API format each is called through, preferred one first', () => {
    // Which format a vendor is called through decides what survives the
    // call, so a table that omits it is missing the useful column.
    const table = providersTable();
    expect(table).toContain('| Anthropic | `anthropic` | Anthropic messages (preferred) |');
    expect(table).toContain('API format');
  });

  it('refuses to generate into a file whose markers are missing', () => {
    expect(() => withGeneratedTable('# no markers here')).toThrow(/markers are missing/);
  });

  it('uses MDX comments, because an HTML one does not compile', () => {
    // This is not style. `<!-- -->` is a parse error in MDX -- "Unexpected
    // character `!`" -- and it broke the docs build the first time these
    // markers shipped. The guard above only checked that the table
    // matched the registry, which it did, in a file that no longer built.
    expect(DOC_START.startsWith('{/*')).toBe(true);
    expect(DOC_END.startsWith('{/*')).toBe(true);
    expect(markdown).not.toContain('<!--');
  });

  it('generates nothing that MDX reads as a tag', () => {
    // A blurb or display name containing < would be parsed as JSX and
    // fail the build for a reason nobody would connect to the registry.
    const table = providersTable();
    expect(table).not.toMatch(/<[a-zA-Z!/]/);
  });
});
