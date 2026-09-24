/**
 * A model's settings edit inline on its page. An unsaved edit asks before
 * a navigation throws it away; an untouched form does not.
 */
import { describe, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { EditModelForm } from '../edit-model-form'
import type { ModelCard } from '@/types/models'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

const card = {
  id: 'm1',
  name: 'GPT prod',
  privacyTier: 'standard',
  region: '',
  contextLength: 128000,
  capabilities: { tools: true },
  pricing: null,
  pricingSource: 'feed',
  pricingOverride: null,
  updatedAt: '2026-09-01T00:00:00.000Z',
} as unknown as ModelCard

const at = () =>
  renderAtRoute(<EditModelForm card={card} onSubmit={vi.fn()} />, { path: '/models/m1', paths: ['/elsewhere'] })

describe('model settings', () => {
  it('asks once the name is edited and not saved', async () => {
    const { router } = at()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GPT staging' } })
    await expectLeaveAsks(router)
  })

  it('leaves untouched settings without asking', async () => {
    const { router } = at()
    await expectLeavesWithoutAsking(router)
  })
})
