/**
 * One refused request showed two toasts: the app-wide "Permission denied"
 * the 403 interceptor raises, and the page's own "Could not add the
 * channel", both with the server's reason. The page's message is kept.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useAppStore } from '../app'

const REASON = 'You do not have permission to change this agent.'
const toasts = () => useAppStore.getState().notifications.map((n) => n.title)

describe('one failure, one toast', () => {
  beforeEach(() => useAppStore.setState({ notifications: [] }))

  it('replaces the generic permission toast with the page message about the same failure', () => {
    const { addNotification } = useAppStore.getState()
    addNotification({ type: 'warning', title: 'Permission denied', message: REASON, generic: true })
    addNotification({ type: 'error', title: 'Could not add the channel', message: REASON, duration: 10000 })
    expect(toasts()).toEqual(['Could not add the channel'])
  })

  it('drops the generic toast when the page already said it', () => {
    const { addNotification } = useAppStore.getState()
    addNotification({ type: 'error', title: 'Could not add the channel', message: REASON })
    addNotification({ type: 'warning', title: 'Permission denied', message: REASON, generic: true })
    expect(toasts()).toEqual(['Could not add the channel'])
  })

  it('keeps the generic toast when nothing else reports the failure, and keeps unrelated toasts', () => {
    const { addNotification } = useAppStore.getState()
    addNotification({ type: 'warning', title: 'Permission denied', message: REASON, generic: true })
    addNotification({ type: 'error', title: 'Could not save', message: 'Something else went wrong.' })
    addNotification({ type: 'success', title: 'Saved', message: REASON })
    expect(toasts()).toEqual(['Permission denied', 'Could not save', 'Saved'])
  })
})
