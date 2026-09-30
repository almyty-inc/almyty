/**
 * The app icon on Branding and visitor rules: upload one (made a square
 * PNG first), see it, remove it. What is stored is the uploaded file's id,
 * and it goes out with the rest of the branding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'

import { render } from '../../../test/setup'
import { AppIconField } from '../app-icon-field'
import { formFromEffective, overridesFromForm, settingsFromForm } from '../public-settings-fields'
import { filesApi } from '../../../lib/api'
import { AppIconError, appIconProblem, fitInSquare, toSquarePng } from '../../../lib/app-icon'

vi.mock('../../../lib/api', () => ({
  filesApi: { upload: vi.fn(), download: vi.fn() },
}))

vi.mock('../../../lib/app-icon', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/app-icon')>('../../../lib/app-icon')
  return { ...actual, toSquarePng: vi.fn() }
})

const PNG = new Blob(['png-bytes'], { type: 'image/png' })

function Host({ initial = null as string | null, onValue = (_v: string | null) => {} }) {
  const [value, setValue] = useState<string | null>(initial)
  return (
    <AppIconField
      id="icon"
      value={value}
      agentId="agent-1"
      onChange={(next) => {
        setValue(next)
        onValue(next)
      }}
    />
  )
}

const pick = (file: File) => fireEvent.change(screen.getByLabelText('App icon file'), { target: { files: [file] } })

beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  vi.mocked(toSquarePng).mockResolvedValue(PNG)
  vi.mocked(filesApi.upload).mockResolvedValue({ id: 'file-1' })
  vi.mocked(filesApi.download).mockResolvedValue({ data: PNG } as any)
})

describe('AppIconField', () => {
  it('uploads the chosen image as a square PNG under the agent, shows it, and keeps its id', async () => {
    const onValue = vi.fn()
    render(<Host onValue={onValue} />)
    expect(screen.getByLabelText('No app icon')).toBeInTheDocument()

    pick(new File(['jpeg'], 'logo.jpg', { type: 'image/jpeg' }))

    await waitFor(() => expect(onValue).toHaveBeenCalledWith('file-1'))
    expect(toSquarePng).toHaveBeenCalled()
    const [sent, agentId] = vi.mocked(filesApi.upload).mock.calls[0]
    expect(sent).toMatchObject({ name: 'app-icon.png', type: 'image/png' })
    expect(agentId).toBe('agent-1')
    expect(await screen.findByAltText('App icon')).toHaveAttribute('src', 'blob:preview')
    expect(screen.getByRole('button', { name: 'Replace icon' })).toBeInTheDocument()
    // Shown from memory, not fetched back.
    expect(filesApi.download).not.toHaveBeenCalled()
  })

  it('shows a saved icon by fetching its bytes with the session', async () => {
    render(<Host initial="file-saved" />)
    expect(await screen.findByAltText('App icon')).toHaveAttribute('src', 'blob:preview')
    expect(filesApi.download).toHaveBeenCalledWith('file-saved')
  })

  it('removes the icon without a dialog', async () => {
    const onValue = vi.fn()
    render(<Host initial="file-saved" onValue={onValue} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onValue).toHaveBeenCalledWith(null)
    expect(screen.getByRole('button', { name: 'Upload icon' })).toBeInTheDocument()
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  })

  it('refuses another kind of file, or a huge one, before uploading anything', async () => {
    render(<Host />)
    pick(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Use a PNG, JPG or WebP image.')
    const huge = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(huge, 'size', { value: 5 * 1024 * 1024 })
    pick(huge)
    expect(await screen.findByRole('alert')).toHaveTextContent('Use an image under 4 MB.')
    expect(filesApi.upload).not.toHaveBeenCalled()
  })

  it('says why a too small image cannot be the icon', async () => {
    vi.mocked(toSquarePng).mockRejectedValue(new AppIconError('Use an image at least 512 pixels wide and tall.'))
    render(<Host />)
    pick(new File(['png'], 'tiny.png', { type: 'image/png' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 512 pixels')
    expect(filesApi.upload).not.toHaveBeenCalled()
  })
})

describe('the icon in the branding', () => {
  const effective = (iconFileId: string | null) => ({
    branding: { appName: 'Help', iconFileId },
    visitorRules: {
      authMode: 'public_link',
      limits: {},
      caps: { dailyCents: null, monthlyCents: null },
      privacy: { retentionDays: null, visitorCanDelete: true, visitorCanExport: true, visitorMemory: false },
      ownSpend: false,
    },
  }) as any

  it('is read into the form and saved with it', () => {
    const form = formFromEffective(effective('file-1'))
    expect(form.iconFileId).toBe('file-1')
    expect(settingsFromForm(form).branding.iconFileId).toBe('file-1')
    expect(settingsFromForm({ ...form, iconFileId: null }).branding.iconFileId).toBeNull()
  })

  it('is a channel override only when the channel has its own', () => {
    const inherited = effective('file-1')
    expect(overridesFromForm(formFromEffective(inherited), inherited).branding).toBeNull()
    expect(overridesFromForm({ ...formFromEffective(inherited), iconFileId: 'file-2' }, inherited).branding).toEqual({ iconFileId: 'file-2' })
  })
})

describe('app icon helpers', () => {
  it('takes PNG, JPG and WebP under 4 MB', () => {
    expect(appIconProblem({ type: 'image/png', size: 10 })).toBeNull()
    expect(appIconProblem({ type: 'image/jpeg', size: 10 })).toBeNull()
    expect(appIconProblem({ type: 'image/webp', size: 10 })).toBeNull()
    expect(appIconProblem({ type: 'image/gif', size: 10 })).toMatch(/PNG, JPG or WebP/)
    expect(appIconProblem({ type: 'image/png', size: 4 * 1024 * 1024 + 1 })).toMatch(/under 4 MB/)
  })

  it('fits a wide or tall image inside the square, centered, uncropped', () => {
    expect(fitInSquare(1024, 512)).toEqual({ x: 0, y: 128, width: 512, height: 256 })
    expect(fitInSquare(600, 1200)).toEqual({ x: 128, y: 0, width: 256, height: 512 })
    expect(fitInSquare(512, 512)).toEqual({ x: 0, y: 0, width: 512, height: 512 })
  })
})
