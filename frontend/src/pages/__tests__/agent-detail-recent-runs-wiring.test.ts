/**
 * Overview's Recent runs lists an autonomous agent's runs (overview-tab's
 * own test covers the rendering). This guards the page's half: the runs
 * are read while Overview is open, not only on the Runs tab, and handed to
 * the Overview. Without it the list renders fine in its test and is
 * empty on the page.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(__dirname, '..', 'agent-detail.tsx'), 'utf8')

describe('agent detail page: autonomous runs on Overview', () => {
  it('reads the runs while Overview is open for an autonomous agent', () => {
    const query = source.slice(source.indexOf("queryKey: ['agent-runs', id]"))
    const enabled = query.slice(0, query.indexOf('})'))
    expect(enabled).toMatch(/activeTab === 'overview' && agent\?\.mode === 'autonomous'/)
  })

  it('hands the runs to the Overview tab', () => {
    const overview = source.slice(source.indexOf('<OverviewTab'), source.indexOf('/>', source.indexOf('<OverviewTab')))
    expect(overview).toMatch(/runs=\{agent\.mode === 'autonomous' \? runs : \[\]\}/)
  })
})
