import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { BuildPanel } from '../build-panel'
import { agentAppsApi, formatBytes, isBuildable, type AgentApp } from '@/lib/agent-apps'

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return {
    ...actual,
    agentAppsApi: {
      platforms: vi.fn(),
      builds: vi.fn(),
      requestBuild: vi.fn(),
      downloadUrl: vi.fn(),
    },
  }
})

const app = { slug: 'acme-support' } as AgentApp

const macPlatform = {
  id: 'macos-arm64',
  label: 'macOS (Apple silicon)',
  extension: 'zip',
  unsignedConsequence: 'macOS refuses to open it.',
  signing: {
    kind: 'apple' as const,
    needs: ['A Developer ID Application certificate (.p12) and its password'],
    note: 'Stored in your credential vault.',
  },
}

const linuxPlatform = {
  id: 'linux-x64',
  label: 'Linux (x64)',
  extension: 'AppImage',
  unsignedConsequence: 'Runs normally.',
  signing: null,
}

describe('formatBytes', () => {
  it('reads an artifact size in the units a person expects', () => {
    // The API returns bigint as a string, which Number() must handle.
    expect(formatBytes('65115890')).toBe('65.1 MB')
    expect(formatBytes('4200')).toBe('4 kB')
  })

  it('says nothing rather than "0 MB" when there is no artifact', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes('0')).toBe('')
  })
})

describe('isBuildable', () => {
  it('is true only for targets that compile to a file', () => {
    expect(isBuildable('tui')).toBe(true)
    expect(isBuildable('desktop')).toBe(true)
    expect(isBuildable('binary')).toBe(true)
    // A web app is served and Slack is someone else's client.
    expect(isBuildable('web')).toBe(false)
    expect(isBuildable('slack')).toBe(false)
  })
})

describe('BuildPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(agentAppsApi.platforms as any).mockResolvedValue([macPlatform, linuxPlatform])
    ;(agentAppsApi.builds as any).mockResolvedValue([])
  })

  it('will not start a build until a platform is chosen', async () => {
    render(<BuildPanel app={app} target="tui" />)
    expect(await screen.findByRole('button', { name: /Build/ })).toBeDisabled()
  })

  it('warns what an unsigned artifact does before the build, not after', async () => {
    render(<BuildPanel app={app} target="tui" />)
    fireEvent.click(await screen.findByLabelText('Build for'))
    fireEvent.click(await screen.findByText('macOS (Apple silicon)'))

    // The moment to learn this is before sending out the link.
    expect(await screen.findByText(/refuses to open it/)).toBeInTheDocument()
    expect(screen.getByText(/Developer ID Application certificate/)).toBeInTheDocument()
  })

  it('says nothing alarming for a platform that needs no signature', async () => {
    render(<BuildPanel app={app} target="tui" />)
    fireEvent.click(await screen.findByLabelText('Build for'))
    fireEvent.click(await screen.findByText('Linux (x64)'))
    expect(screen.queryByText(/refuses to open it/)).toBeNull()
  })

  it('starts a build for the chosen platform', async () => {
    ;(agentAppsApi.requestBuild as any).mockResolvedValue({ id: 'b-1' })
    render(<BuildPanel app={app} target="tui" />)

    fireEvent.click(await screen.findByLabelText('Build for'))
    fireEvent.click(await screen.findByText('Linux (x64)'))
    fireEvent.click(screen.getByRole('button', { name: /Build/ }))

    await waitFor(() =>
      expect(agentAppsApi.requestBuild).toHaveBeenCalledWith('acme-support', {
        target: 'tui',
        platform: 'linux-x64',
      }),
    )
  })

  it('offers a download only once a build has succeeded', async () => {
    ;(agentAppsApi.builds as any).mockResolvedValue([
      {
        id: 'b-1',
        target: 'tui',
        platform: 'linux-x64',
        status: 'running',
        version: null,
        signed: false,
        artifactBytes: null,
        checksum: null,
        error: null,
        createdAt: '',
        finishedAt: null,
        artifactExpiresAt: null,
      },
    ])
    render(<BuildPanel app={app} target="tui" />)
    expect(await screen.findByText('Building')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })

  it('fetches the link at click time, because it is short lived', async () => {
    ;(agentAppsApi.builds as any).mockResolvedValue([
      {
        id: 'b-1',
        target: 'tui',
        platform: 'macos-arm64',
        status: 'succeeded',
        version: '1.0.0',
        signed: false,
        artifactBytes: '65115890',
        checksum: 'abc',
        error: null,
        createdAt: '',
        finishedAt: '',
        artifactExpiresAt: null,
      },
    ])
    ;(agentAppsApi.downloadUrl as any).mockResolvedValue('https://example.test/artifact')
    const open = vi.fn()
    vi.stubGlobal('open', open)

    render(<BuildPanel app={app} target="tui" />)

    // Not requested while merely rendering the list.
    expect(agentAppsApi.downloadUrl).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: /Download/ }))
    await waitFor(() =>
      expect(agentAppsApi.downloadUrl).toHaveBeenCalledWith('acme-support', 'b-1'),
    )
    await waitFor(() => expect(open).toHaveBeenCalledWith(
      'https://example.test/artifact',
      '_blank',
      'noopener',
    ))
  })

  it('names the platform a build was made for rather than its id', async () => {
    ;(agentAppsApi.builds as any).mockResolvedValue([
      {
        id: 'b-1',
        target: 'tui',
        platform: 'macos-arm64',
        status: 'succeeded',
        version: '1.0.0',
        signed: false,
        artifactBytes: '100',
        checksum: 'abc',
        error: null,
        createdAt: '',
        finishedAt: '',
        artifactExpiresAt: null,
      },
    ])
    render(<BuildPanel app={app} target="tui" />)
    expect(await screen.findByText(/macOS \(Apple silicon\)/)).toBeInTheDocument()
  })

  it('falls back to the id for a platform no longer offered', async () => {
    ;(agentAppsApi.builds as any).mockResolvedValue([
      {
        id: 'b-1',
        target: 'tui',
        platform: 'solaris-sparc',
        status: 'succeeded',
        version: null,
        signed: true,
        artifactBytes: '100',
        checksum: 'abc',
        error: null,
        createdAt: '',
        finishedAt: '',
        artifactExpiresAt: null,
      },
    ])
    render(<BuildPanel app={app} target="tui" />)
    expect(await screen.findByText('solaris-sparc')).toBeInTheDocument()
  })

  it('marks an unsigned artifact as such in the list', async () => {
    ;(agentAppsApi.builds as any).mockResolvedValue([
      {
        id: 'b-1',
        target: 'tui',
        platform: 'macos-arm64',
        status: 'succeeded',
        version: null,
        signed: false,
        artifactBytes: '65115890',
        checksum: 'abc',
        error: null,
        createdAt: '',
        finishedAt: '',
        artifactExpiresAt: null,
      },
    ])
    render(<BuildPanel app={app} target="tui" />)
    expect(await screen.findByText('Unsigned')).toBeInTheDocument()
    expect(screen.getByText('65.1 MB')).toBeInTheDocument()
  })

  it('shows why a build failed rather than only that it did', async () => {
    ;(agentAppsApi.builds as any).mockResolvedValue([
      {
        id: 'b-2',
        target: 'tui',
        platform: 'linux-x64',
        status: 'failed',
        version: null,
        signed: false,
        artifactBytes: null,
        checksum: null,
        error: 'bun is not installed on the build host.',
        createdAt: '',
        finishedAt: '',
        artifactExpiresAt: null,
      },
    ])
    render(<BuildPanel app={app} target="tui" />)
    expect(await screen.findByText(/bun is not installed/)).toBeInTheDocument()
  })

  it('does not list builds belonging to a different target', async () => {
    ;(agentAppsApi.builds as any).mockResolvedValue([
      {
        id: 'b-3',
        target: 'desktop',
        platform: 'linux-x64',
        status: 'succeeded',
        version: null,
        signed: true,
        artifactBytes: '100',
        checksum: 'x',
        error: null,
        createdAt: '',
        finishedAt: '',
        artifactExpiresAt: null,
      },
    ])
    render(<BuildPanel app={app} target="tui" />)
    await screen.findByRole('button', { name: /Build/ })
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })
})
