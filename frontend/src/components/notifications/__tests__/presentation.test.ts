import { describe, it, expect } from 'vitest'
import { getNotificationPresentation } from '../presentation'

describe('hosted environment notifications', () => {
  it('reads in plain words, not the event type', () => {
    expect(getNotificationPresentation('environments.handed_over').label).toBe('Hosted environment handed to you')
    expect(getNotificationPresentation('environments.handed_over').description).toMatch(/A member left the organization/)
    expect(getNotificationPresentation('environments.unshared').label).toBe('Hosted environment private again')
    expect(getNotificationPresentation('environments.unshared').description).toMatch(/only you can see and use it now/)
    expect(getNotificationPresentation('environments.workspace_expiring').label).toBe('Hosted files to be deleted')
  })
})