import { test, expect } from './setup/test-hooks'

test.describe('Organizations - Management', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/organizations')
  })

  test('should display organization page', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.assertPageTitle(/organization/i)
  })

  test('should display current organization details', async ({ page, authHelper }) => {
    // Login with user who has organization
    const testUser = await authHelper.registerViaAPI(authHelper.constructor.generateTestUser())
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/organizations')

    // Should show organization name (use first() to avoid strict mode violation)
    await expect(page.getByText(testUser.organizationName).first()).toBeVisible()
  })

  test('should edit organization name and description', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Get current organization
    const orgs = await apiHelper.getOrganizations()
    if (orgs.data && orgs.data.length > 0) {
      const org = orgs.data[0]

      // Click edit
      await page.getByRole('button', { name: /edit.*organization|settings/i }).click()

      // Update fields
      await page.getByLabel('Organization Name').clear()
      await page.getByLabel('Organization Name').fill('Updated Organization Name')
      await page.getByLabel('Description').clear()
      await page.getByLabel('Description').fill('Updated description')

      await page.getByRole('button', { name: /save|update/i }).click()

      // Should show updated name
      await assertHelper.assertToastMessage(/updated|saved/i)
      await expect(page.getByText('Updated Organization Name')).toBeVisible()
    }
  })

  test('should display organization members list', async ({ authenticatedPage: page }) => {
    // Should show members section (use more specific selector to avoid strict mode violation)
    await expect(page.getByRole('heading', { name: /members/i }).or(page.getByText(/\d+ members?/i).first())).toBeVisible()

    // Should show current user as member
    await expect(page.locator('table tbody tr').first()).toBeVisible()
  })

  test('should invite new member via email', async ({ authenticatedPage: page, assertHelper }) => {
    await page.waitForLoadState('networkidle')

    // Find first organization row and click its action button to open menu
    const orgRow = page.locator('table tbody tr').first()
    await orgRow.getByRole('button', { name: /actions/i }).click()

    // Wait for menu to open
    await page.waitForTimeout(500)

    // Click "View Details" from the actions menu
    await page.getByRole('menuitem', { name: /view details/i }).click()

    // Wait for organization details sheet to open
    await page.waitForTimeout(2000)

    // Navigate to Members tab - find it on the page
    const membersTab = page.getByRole('tab', { name: /members|team/i })
    await expect(membersTab).toBeVisible({ timeout: 10000 })
    await membersTab.click()
    await page.waitForTimeout(1500)

    // Click invite member button
    const inviteButton = page.getByRole('button', { name: /invite.*member|add.*member/i })
    await expect(inviteButton).toBeVisible({ timeout: 10000 })
    await inviteButton.click()

    // Wait for invite dialog to open - match by "Invite" in heading
    await page.waitForTimeout(1500)
    const inviteDialog = page.getByRole('dialog').filter({ hasText: /invite/i })
    await expect(inviteDialog).toBeVisible({ timeout: 10000 })

    // Fill email and role in the scoped invite dialog
    await inviteDialog.getByLabel(/email/i).fill('newmember@example.com')

    // Click the role dropdown (combobox with placeholder)
    await inviteDialog.getByRole('combobox').click()
    await page.waitForTimeout(500)
    await page.getByRole('option', { name: /member/i }).first().click()

    await inviteDialog.getByRole('button', { name: /send.*invitation|invite/i }).click()

    // Should show success
    await assertHelper.assertToastMessage(/invited|sent/i)
  })

  test('should display member roles', async ({ authenticatedPage: page }) => {
    await page.waitForLoadState('networkidle')

    // Find first organization row and click its action button to open menu
    const orgRow = page.locator('table tbody tr').first()
    await orgRow.getByRole('button', { name: /actions/i }).click()

    // Wait for menu to open
    await page.waitForTimeout(500)

    // Click "View Details" from the actions menu
    await page.getByRole('menuitem', { name: /view details/i }).click()

    // Wait for sheet to open
    await page.waitForTimeout(2000)

    // Navigate to Members tab
    const membersTab = page.getByRole('tab', { name: /members|team/i })
    await expect(membersTab).toBeVisible({ timeout: 10000 })
    await membersTab.click()
    await page.waitForTimeout(1500)

    // Should show role text - use page-level locator
    await expect(page.locator('table td, .badge, [class*="badge"]').filter({ hasText: /owner|admin|member/i }).first()).toBeVisible({ timeout: 10000 })
  })

  test('should update member role', async ({ authenticatedPage: page, assertHelper }) => {
    // Find a member row (not owner)
    const memberRows = page.locator('table tbody tr')
    const count = await memberRows.count()

    if (count > 1) {
      // Click on second member's actions
      const secondMember = memberRows.nth(1)
      await secondMember.getByRole('button', { name: /actions|more/i }).click()
      await page.getByRole('menuitem', { name: /change.*role|update.*role/i }).click()

      // Select new role
      await page.getByLabel(/role/i).click()
      await page.getByRole('option', { name: /admin/i }).click()

      await page.getByRole('button', { name: /update|save/i }).click()

      // Should show updated role
      await assertHelper.assertToastMessage(/updated/i)
    }
  })

  test('should remove member with confirmation', async ({ authenticatedPage: page, assertHelper }) => {
    const memberRows = page.locator('table tbody tr')
    const count = await memberRows.count()

    if (count > 1) {
      // Remove second member
      const secondMember = memberRows.nth(1)
      const memberEmail = await secondMember.locator('td').nth(1).textContent()

      await secondMember.getByRole('button', { name: /actions|more/i }).click()
      await page.getByRole('menuitem', { name: /remove|delete/i }).click()

      // Confirm removal
      await assertHelper.assertDialogOpen(/confirm|remove/i)
      await page.getByRole('button', { name: /remove|confirm/i }).click()

      // Should be removed
      if (memberEmail) {
        await expect(page.getByText(memberEmail)).not.toBeVisible()
      }
    }
  })

  test('should not allow removing organization owner', async ({ authenticatedPage: page }) => {
    // Find owner row
    const ownerRow = page.locator('tr').filter({ hasText: /owner/i })

    if (await ownerRow.isVisible()) {
      // Try to open actions menu
      const actionsButton = ownerRow.getByRole('button', { name: /actions|more/i })

      if (await actionsButton.isVisible()) {
        await actionsButton.click()

        // Remove option should be disabled or not present
        const removeOption = page.getByRole('menuitem', { name: /remove|delete/i })
        if (await removeOption.isVisible()) {
          await expect(removeOption).toBeDisabled()
        }
      }
    }
  })

  test('should display organization plan and usage', async ({ authenticatedPage: page }) => {
    await page.waitForLoadState('networkidle')

    // Find first organization row and click its action button to open menu
    const orgRow = page.locator('table tbody tr').first()
    await orgRow.getByRole('button', { name: /actions/i }).click()

    // Wait for menu to open
    await page.waitForTimeout(500)

    // Click "View Details" from the actions menu
    await page.getByRole('menuitem', { name: /view details/i }).click()

    // Wait for sheet to open
    await page.waitForTimeout(2000)

    // Navigate to Billing or Settings tab (use Overview tab which shows plan info)
    const overviewTab = page.getByRole('tab', { name: /overview/i }).first()
    await expect(overviewTab).toBeVisible({ timeout: 10000 })
    // Overview is usually the default active tab, but click it to ensure it's selected
    await overviewTab.click()
    await page.waitForTimeout(1500)

    // Should show plan information - use page-level locators
    await expect(page.getByText(/plan|subscription|free|pro|enterprise/i).first()).toBeVisible({ timeout: 15000 })

    // Should show usage stats
    await expect(page.getByText(/usage|limits|members|storage/i).first()).toBeVisible({ timeout: 15000 })
  })

  test('should create team', async ({ authenticatedPage: page, assertHelper }) => {
    // Navigate to teams tab if exists
    const teamsTab = page.getByRole('tab', { name: /teams/i })
    if (await teamsTab.isVisible()) {
      await teamsTab.click()

      // Create new team
      await page.getByRole('button', { name: /create.*team|new.*team/i }).click()

      await page.getByLabel('Team Name').fill('Engineering Team')
      await page.getByLabel('Description').fill('Engineering team for API development')

      await page.getByRole('button', { name: /create|save/i }).click()

      // Should show new team
      await assertHelper.assertToastMessage(/created/i)
      await expect(page.getByText('Engineering Team')).toBeVisible()
    }
  })

  test('should add members to team', async ({ authenticatedPage: page, assertHelper }) => {
    const teamsTab = page.getByRole('tab', { name: /teams/i })
    if (await teamsTab.isVisible()) {
      await teamsTab.click()

      const teams = page.locator('table tbody tr')
      if (await teams.first().isVisible()) {
        // Open first team
        await teams.first().getByRole('button', { name: /view|manage/i }).click()

        // Add member
        await page.getByRole('button', { name: /add.*member/i }).click()

        // Select member from dropdown
        await page.getByLabel(/member|user/i).click()
        await page.getByRole('option').first().click()

        await page.getByRole('button', { name: /add/i }).click()

        await assertHelper.assertToastMessage(/added/i)
      }
    }
  })

  test('should display team statistics', async ({ authenticatedPage: page }) => {
    const teamsTab = page.getByRole('tab', { name: /teams/i })
    if (await teamsTab.isVisible()) {
      await teamsTab.click()

      // Should show team count
      await expect(page.getByText(/\d+.*teams?/i)).toBeVisible()
    }
  })
})
