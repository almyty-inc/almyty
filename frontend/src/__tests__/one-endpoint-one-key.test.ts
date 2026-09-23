import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')

/**
 * One endpoint, one cache-key prefix.
 *
 * toolsApi.getAll was read under three unrelated keys: ['tools', ...] on
 * the tools page, ['tools-list', orgId] in the agent builder's tool
 * picker and ['all-tools', orgId] in the gateway tool assigner. The
 * tools page invalidates ['tools'], which covers neither sibling, so a
 * tool created with the toast "It is ready to assign to a gateway" was
 * missing from the builder's picker and a deleted one was still on offer
 * in the gateway dialog.
 *
 * Same shape for the models catalog, whose ['models','catalog'] key is a
 * sibling of ['models','selectable'] and ['models','names'] -- the fix
 * there was to invalidate the ['models'] prefix, which this pins too.
 */
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('tool lists share one key prefix', () => {
  it('no page keeps a tool-list key of its own outside the tools prefix', () => {
    const files = [
      'pages/tools.tsx',
      'pages/gateways.tsx',
      'pages/agent-builder.tsx',
      'pages/api-detail.tsx',
      'pages/tool-detail.tsx',
    ]
    for (const f of files) {
      const source = read(f)
      expect(source, `${f} still has a sibling tool-list key`).not.toMatch(
        /queryKey: \['(tools-list|all-tools)'/,
      )
    }
  })

  it('the builder picker and the gateway assigner read the same key', () => {
    const key = "queryKey: ['tools', currentOrganization?.id, 'all']"
    expect(read('pages/agent-builder.tsx')).toContain(key)
    expect(read('pages/gateways.tsx')).toContain(key)
  })

  it('the tools page invalidates the prefix that covers all of them', () => {
    const source = read('pages/tools.tsx')
    // Both the create and the delete mutation.
    const invalidations = source.match(/invalidateQueries\(\{ queryKey: \['tools'\] \}\)/g) ?? []
    expect(invalidations.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the model catalog invalidates the models prefix', () => {
  it('does not invalidate only its own sibling key', () => {
    const source = read('components/models/models-catalog.tsx')
    expect(source).toContain("invalidateQueries({ queryKey: ['models'] })")
    expect(source).not.toMatch(
      /const invalidate = \(\) => queryClient\.invalidateQueries\(\{ queryKey: MODELS_QUERY_KEY \}\)/,
    )
  })
})
