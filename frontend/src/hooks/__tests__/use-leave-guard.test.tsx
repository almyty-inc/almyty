/**
 * A router honours only its most recently mounted blocker. A detail page
 * can carry several inline forms at once, so a clean form mounted after a
 * dirty one must not switch the dirty one's guard off.
 */
import { describe, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { useLeaveGuard } from '../use-leave-guard'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

function InlineField({ label }: { label: string }) {
  const [value, setValue] = useState('')
  const guard = useLeaveGuard(value !== '')
  return (
    <>
      <label>
        {label}
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      {guard.element}
    </>
  )
}

function TwoForms() {
  return (
    <>
      <InlineField label="First" />
      <InlineField label="Second" />
    </>
  )
}

describe('useLeaveGuard with several inline forms on one page', () => {
  it('asks when the first form is dirty and a later one is clean', async () => {
    const { router } = renderAtRoute(<TwoForms />, { path: '/page', paths: ['/elsewhere'] })
    fireEvent.change(screen.getByLabelText('First'), { target: { value: 'typed' } })
    await expectLeaveAsks(router)
  })

  it('asks when only the later form is dirty', async () => {
    const { router } = renderAtRoute(<TwoForms />, { path: '/page', paths: ['/elsewhere'] })
    fireEvent.change(screen.getByLabelText('Second'), { target: { value: 'typed' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking when both are clean', async () => {
    const { router } = renderAtRoute(<TwoForms />, { path: '/page', paths: ['/elsewhere'] })
    await expectLeavesWithoutAsking(router)
  })
})
