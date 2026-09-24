import { describe, it, expect } from 'vitest'
import { normalizeOnboardingState } from '../api'
import { ALL_STEPS, journeyProgress, nextStep, stepsDone } from '@/components/onboarding/guide-steps'

/**
 * The guide read `state.steps.api` straight off the response, so an API older
 * than the web app -- mid rolling deploy, or self-hosted -- returned a state
 * without those fields and the dashboard layout crashed on render.
 */
describe('onboarding state from an API that sends less than the guide expects', () => {
  const partials: unknown[] = [
    {},
    { steps: {} },
    { steps: { provider: true } },
    { links: null },
    { steps: { api: true }, links: { gateway: null } },
    null,
    undefined,
  ]

  it('never lets the guide helpers throw', () => {
    for (const raw of partials) {
      const state = normalizeOnboardingState(raw as never)
      expect(() => stepsDone(state)).not.toThrow()
      expect(() => journeyProgress(state)).not.toThrow()
      expect(() => nextStep(state)).not.toThrow()
    }
  })

  it('reads a missing step as not done and a missing link as none', () => {
    const state = normalizeOnboardingState({ steps: { provider: true } } as never)
    expect(state.steps.provider).toBe(true)
    expect(state.steps.api).toBe(false)
    expect(state.links.gateway).toBeNull()
    expect(state.dismissedIntros).toEqual([])
    expect(state.dismissed).toBe(false)
  })

  it('keeps a complete response intact', () => {
    const full = normalizeOnboardingState({
      steps: { provider: true, api: true, tools: true, gateway: true, first_call: true, external_client: true, agent: true, agent_run: true, app: true, distribution: true, runner: true },
      links: { gateway: { id: 'g', name: 'G', type: 'mcp', endpoint: '/x' }, agent: { id: 'a', name: 'A' }, app: { slug: 's', name: 'S' } },
      dismissed: true,
      dismissedIntros: ['apis'],
      activatedRealAt: '2026-01-01T00:00:00.000Z',
    })
    expect(stepsDone(full)).toBe(ALL_STEPS.length)
    expect(full.links.app?.slug).toBe('s')
    expect(full.dismissedIntros).toEqual(['apis'])
  })
})
