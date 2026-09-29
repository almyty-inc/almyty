import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Channels live on the agent.
 *
 * An agent's Channels tab is the only place a channel is added or edited:
 * there is no Apps page, no sidebar entry for one, and no "places" or
 * "Where people use it" left in what anyone reads. Chat apps are not in
 * the Connections gallery; their keys are entered or picked on the
 * channel. These read the source, with comments stripped, so a page that
 * brings any of it back fails here rather than in review.
 */
const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
const withoutComments = (text: string) =>
  text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const CHANNEL_FILES = [
  ...readdirSync(join(SRC, 'components/channels'))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `components/channels/${f}`),
  'pages/agent-channel.tsx',
  'pages/agent-channel-new.tsx',
  'pages/agent-channel-signing-new.tsx',
  'pages/agent-public-settings.tsx',
  'lib/agent-channels.ts',
]

describe('channels are on the agent, and nowhere else', () => {
  it('has no Apps pages, route or sidebar entry', () => {
    for (const page of ['apps', 'app-detail', 'app-new', 'app-distribution', 'app-distribution-new', 'app-signing-new']) {
      expect(existsSync(join(SRC, 'pages', `${page}.tsx`)), page).toBe(false)
    }
    expect(existsSync(join(SRC, 'components/agent-apps'))).toBe(false)
    const routes = withoutComments(read('App.tsx'))
    expect(routes).not.toMatch(/path="\/apps(?!\/\*")/)
    expect(withoutComments(read('components/layout/dashboard-layout.tsx'))).not.toMatch(/href: '\/apps'/)
    expect(withoutComments(read('components/command-palette.tsx'))).not.toMatch(/'\/apps/)
  })

  it('adds and edits channels from the agent, at /agents/:id/channels', () => {
    const routes = read('App.tsx')
    for (const path of ['/agents/:id/channels/new', '/agents/:id/channels/settings', '/agents/:id/channels/:channelId']) {
      expect(routes).toContain(`path="${path}"`)
    }
    const detail = read('pages/agent-detail.tsx')
    expect(detail).toMatch(/<TabsTrigger value="channels">Channels<\/TabsTrigger>/)
    expect(detail).toMatch(/<ChannelsTab /)
  })

  it.each(CHANNEL_FILES)('%s never says "place", "distribution" or "Where people use it"', (file) => {
    const source = withoutComments(read(file))
    // Only what a person reads: strings and JSX text.
    const words = [...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
    for (const text of words) {
      expect(text, file).not.toMatch(/\bplaces?\b|\bdistributions?\b|where people use it/i)
    }
  })

  it('uses the shared page, tile, table and disclosure components', () => {
    expect(read('pages/agent-channel-new.tsx')).toMatch(/<ChoiceTiles[\s\S]*<ChoiceTile\b/)
    expect(read('pages/agent-channel-new.tsx')).toMatch(/<FormPage\b/)
    expect(read('components/channels/channel-settings.tsx')).toMatch(/<FormPage\b/)
    expect(read('pages/agent-public-settings.tsx')).toMatch(/<FormPage\b/)
    expect(read('components/channels/channels-tab.tsx')).toMatch(/<DataTable\b/)
    expect(read('components/channels/public-settings-fields.tsx')).toMatch(/<Disclosure\b[^>]*title="Advanced"/)
  })

  it('keeps chat apps out of the Connections gallery', () => {
    expect(withoutComments(read('pages/connections-connect.tsx'))).toMatch(/c\.kind !== 'channel'/)
  })

  it('takes a channel’s keys with the shared credential choice, on the channel form', () => {
    expect(read('components/channels/channel-settings.tsx')).toMatch(/<CredentialChoice\b/)
  })
})
