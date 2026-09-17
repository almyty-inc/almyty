import { describe, it, expect, beforeEach } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { Toaster } from '../toaster'
import { useAppStore, useNotifications } from '../../../store/app'

// Regression for #121: the Toaster + useNotifications used to read
// useAppStore() with no selector. In zustand v5 that snapshot stopped
// re-rendering reliably on every set(), so successful mutations'
// success() calls added a notification to the store but the Toaster
// never showed it. Selectors fix the subscription.

function HookProbe() {
  const { success } = useNotifications()
  return (
    <button onClick={() => success('hello title', 'hello body')}>fire</button>
  )
}

describe('Toaster (zustand selector subscription)', () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState({ notifications: [] })
    })
  })

  it('renders a notification that is added after mount', async () => {
    render(
      <>
        <HookProbe />
        <Toaster />
      </>,
    )

    expect(screen.queryByText('hello title')).not.toBeInTheDocument()

    act(() => {
      useAppStore.getState().addNotification({
        title: 'hello title',
        message: 'hello body',
        type: 'success',
      })
    })

    await waitFor(() => {
      expect(screen.getByText('hello title')).toBeInTheDocument()
      expect(screen.getByText('hello body')).toBeInTheDocument()
    })
  })

  it('renders a notification added via the useNotifications.success helper', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(
      <>
        <HookProbe />
        <Toaster />
      </>,
    )

    await user.click(screen.getByText('fire'))

    await waitFor(() => {
      expect(screen.getByText('hello title')).toBeInTheDocument()
    })
  })
})

// The tinted variants (success / warning / info) were light-only:
// `bg-green-50 text-green-900` with no dark: pair, so in dark mode a
// success toast was a near-white block on a near-black page. The tint
// has to carry both halves, the way badge.tsx does.
describe('Toaster tinted variants carry a dark half', () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState({ notifications: [] })
    })
  })

  const toastFor = (type: 'success' | 'warning' | 'info') => {
    render(<Toaster />)
    act(() => {
      useAppStore.getState().addNotification({ title: `${type} title`, type })
    })
    return screen.getByText(`${type} title`).closest('li') as HTMLElement
  }

  it.each([
    ['success', 'green'],
    ['warning', 'yellow'],
    ['info', 'blue'],
  ] as const)('%s has a dark background and text tint', (type, hue) => {
    const toast = toastFor(type)
    expect(toast.className).toContain(`bg-${hue}-50`)
    expect(toast.className).toContain(`dark:bg-${hue}-900/30`)
    expect(toast.className).toContain(`dark:text-${hue}-400`)
  })
})
