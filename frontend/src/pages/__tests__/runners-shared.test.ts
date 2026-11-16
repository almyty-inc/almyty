import { describe, expect, it } from 'vitest'
import { runnerLoginCommand, runnerStartCommand } from '../runners-shared'

// The CLI defaults to production. Commands copied from any other install
// have to name it, or `almyty login` signs in to production.
describe('runner commands for the install the page is served from', () => {
  it('stays bare on production', () => {
    const prod = { api: 'https://api.almyty.com', app: 'https://app.almyty.com' }
    expect(runnerLoginCommand(prod)).toBe('almyty login')
    expect(runnerStartCommand(prod)).toBe('almyty runner start')
  })

  it('names the API and the app on staging', () => {
    const staging = { api: 'https://api.staging.almyty.com', app: 'https://app.staging.almyty.com' }
    expect(runnerLoginCommand(staging)).toBe(
      'almyty login --api https://api.staging.almyty.com --frontend https://app.staging.almyty.com',
    )
    expect(runnerStartCommand(staging)).toBe('almyty runner start --url https://api.staging.almyty.com')
  })

  it('names a same-origin self-hosted install', () => {
    const selfHost = { api: 'https://almyty.example.test', app: 'https://almyty.example.test' }
    expect(runnerLoginCommand(selfHost)).toBe(
      'almyty login --api https://almyty.example.test --frontend https://almyty.example.test',
    )
  })
})
