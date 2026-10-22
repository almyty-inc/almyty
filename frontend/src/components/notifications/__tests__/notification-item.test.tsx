import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { NotificationItem } from '../notification-item'

/**
 * An always-on agent's report reached the bell as raw markdown: the row
 * showed "**Inbox**" and "- 3 new" with the asterisks and dashes. The body
 * is rendered now, with the renderer the chat uses, and stays safe inside
 * the row's button: no links, no images, no raw HTML.
 */
describe('NotificationItem body', () => {
  const base = {
    id: 'n-1',
    type: 'agent.report',
    title: 'Inbox watcher reported',
    link: '/agents/a-1',
    createdAt: new Date().toISOString(),
    readAt: null,
  }

  it('renders the markdown of a report instead of showing its syntax', async () => {
    const { container } = render(
      <NotificationItem
        notification={{
          ...base,
          body: '**Inbox** checked\n\n- 3 new\n- [open](https://example.com)\n\n![x](https://attacker.example/x.png)<img src=x onerror=alert(1)>',
        } as any}
      />,
    )

    expect((await screen.findByText('Inbox', undefined, { timeout: 8000 })).tagName).toBe('STRONG')
    expect(container.textContent).not.toContain('**')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('open').tagName).toBe('SPAN')
  }, 20000)
})
