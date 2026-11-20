/**
 * A web chat channel's gateway page showed its type as the raw
 * "HOSTED CHAT" in the grey unknown-kind colour; the agent's channels
 * call it "Web chat".
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ProtocolBadge } from '../protocol-badge'

describe('the web chat gateway badge', () => {
  it('says Web chat in the brand colour', () => {
    render(<ProtocolBadge protocol="hosted_chat" />)
    const badge = screen.getByText('Web chat')
    expect(badge).toHaveClass('bg-brand-50')
    expect(screen.queryByText('HOSTED CHAT')).toBeNull()
  })
})
