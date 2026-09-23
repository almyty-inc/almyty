import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useCopySensitive, isMaskedSecret } from '../clipboard'

const warning = vi.fn()
const error = vi.fn()

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ warning, error, success: vi.fn(), info: vi.fn() }),
}))

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
})

/**
 * Stored secrets are never sent back to the browser. Every read path masks
 * them: LlmProvider.maskSensitiveData() answers '***masked***',
 * MASKED_CHANNEL_SECRET is '********', maskAuthSecrets() is a bullet run.
 *
 * A copy button handed one of those used to put the placeholder on the
 * clipboard and raise the same "copied, this value is sensitive" toast as a
 * real secret. The user pastes it into a CI secret or a .env and the
 * integration fails with an opaque auth error, days later, blamed on the
 * wrong thing.
 */
describe('useCopySensitive', () => {
  it.each(['***masked***', '********', '••••••••', ''])(
    'refuses to copy the placeholder %j and says so',
    async (masked) => {
      const { result } = renderHook(() => useCopySensitive())
      await result.current(masked, 'API key')

      expect(writeText).not.toHaveBeenCalled()
      expect(warning).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(
        "API key can't be copied",
        expect.stringContaining('never sent back to the browser'),
      )
    },
  )

  it('copies a real secret and warns that it is now on the clipboard', async () => {
    const { result } = renderHook(() => useCopySensitive())
    await result.current('sk-live-abc123', 'API key')

    expect(writeText).toHaveBeenCalledWith('sk-live-abc123')
    expect(warning).toHaveBeenCalledWith('API key copied', expect.stringContaining('Clear your clipboard'))
    expect(error).not.toHaveBeenCalled()
  })

  it('reports a denied clipboard rather than claiming success', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const { result } = renderHook(() => useCopySensitive())
    await result.current('sk-live-abc123', 'API key')

    expect(warning).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('Failed to copy API key', expect.stringContaining('denied'))
  })
})

describe('isMaskedSecret', () => {
  it('does not mistake a real secret that merely contains asterisks', () => {
    expect(isMaskedSecret('sk-***-live')).toBe(false)
    expect(isMaskedSecret('***masked***')).toBe(true)
  })
})
