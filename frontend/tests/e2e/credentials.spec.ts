import { test, expect } from './setup/test-hooks'

/**
 * Credentials became Connections. The old addresses only redirect: the
 * list to Connections, "Add credential" to connecting another service, and
 * access keys to the gateways they unlock.
 */
test.describe('Credentials redirects', () => {
  test('the list lands on Connections', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials')
    await expect(page).toHaveURL(/\/connections$/)
    await expect(page.getByRole('heading', { name: 'Connections', level: 1 })).toBeVisible()
  })

  test('adding a credential lands on connecting another service', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials/new')
    await expect(page).toHaveURL(/\/connections\/connect\?service=other$/)
    await expect(page.getByRole('heading', { name: 'Connect a service', level: 1 })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('access keys land on the gateways they unlock', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials/access-keys/new')
    await expect(page).toHaveURL(/\/gateways$/)
  })
})
