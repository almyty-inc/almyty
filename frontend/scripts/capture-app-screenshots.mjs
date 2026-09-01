// Capture the Agent Factory (/apps) documentation screenshots and refresh
// the docs-site manifest, so the apps-* set stops being a manual chore that
// silently rots on the next UI change.
//
// Auth: staging sign-in is CAPTCHA-gated, so this reuses a Playwright
// storageState you produce ONCE by logging in by hand:
//
//   npx playwright open --save-storage=.auth/staging.json https://app.staging.almyty.com
//   # sign in, solve the CAPTCHA, then close the window
//
// Then run:
//
//   SCREENSHOT_STORAGE_STATE=.auth/staging.json \
//   SCREENSHOT_APP_SLUG=acme-support \
//   node frontend/scripts/capture-app-screenshots.mjs
//
// Only the apps-* entries are rewritten; every other manifest entry is left
// untouched.
import { chromium } from '@playwright/test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const shotsDir = resolve(repo, 'docs-site', 'public', 'screenshots')
const manifestPath = resolve(shotsDir, 'manifest.json')

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? 'https://app.staging.almyty.com'
const STORAGE_STATE = process.env.SCREENSHOT_STORAGE_STATE
const APP_SLUG = process.env.SCREENSHOT_APP_SLUG ?? 'acme-support'
const EMPTY_SLUG = process.env.SCREENSHOT_EMPTY_APP_SLUG ?? APP_SLUG
const VIEWPORT = { width: 1440, height: 1100 }
const THEME = process.env.SCREENSHOT_THEME ?? 'dark'

if (!STORAGE_STATE) {
  console.error('Set SCREENSHOT_STORAGE_STATE to a Playwright storageState JSON (see header).')
  process.exit(1)
}

// One entry per shot: the manifest id/title and how to reach the frame.
// `settle` runs after navigation to open a tab or dialog before the shot.
const shots = [
  { id: 'apps-list', title: 'Apps list with a customer-facing product', go: '/apps' },
  { id: 'apps-detail', title: 'App detail page with its distribution cards', go: `/apps/${APP_SLUG}` },
  { id: 'apps-empty', title: 'Empty app: not shipping anywhere yet', go: `/apps/${EMPTY_SLUG}` },
  { id: 'apps-agents', title: 'App Agents tab with the product default', go: `/apps/${APP_SLUG}`,
    settle: (p) => p.getByRole('tab', { name: /agents/i }).click() },
  { id: 'apps-settings', title: 'App Settings tab with cost ceiling and rate limits', go: `/apps/${APP_SLUG}`,
    settle: (p) => p.getByRole('tab', { name: /settings/i }).click() },
]

const run = async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: VIEWPORT,
    colorScheme: THEME === 'dark' ? 'dark' : 'light',
    baseURL: BASE_URL,
  })
  const page = await context.newPage()
  const captured = []

  for (const shot of shots) {
    try {
      await page.goto(shot.go, { waitUntil: 'networkidle' })
      if (shot.settle) await shot.settle(page)
      await page.waitForTimeout(400)
      const rel = `screenshots/${shot.id}.png`
      await page.screenshot({ path: resolve(shotsDir, `${shot.id}.png`) })
      captured.push({ id: shot.id, title: shot.title, path: rel })
      console.log(`captured ${shot.id}`)
    } catch (err) {
      console.error(`FAILED ${shot.id}: ${err.message}`)
    }
  }

  await browser.close()

  // Merge: replace apps-* entries with what we captured, keep the rest.
  await mkdir(shotsDir, { recursive: true })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const capturedIds = new Set(captured.map((c) => c.id))
  const kept = manifest.screenshots.filter(
    (s) => !s.id.startsWith('apps-') || !capturedIds.has(s.id),
  )
  manifest.capturedAt = new Date().toISOString()
  manifest.baseUrl = BASE_URL
  manifest.theme = THEME
  manifest.viewport = VIEWPORT
  manifest.screenshots = [...kept, ...captured].sort((a, b) => a.id.localeCompare(b.id))
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`\nupdated ${manifestPath} (${captured.length} apps-* shots)`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
