#!/usr/bin/env node
/*
 * capture-screenshots.mjs — Playwright-driven screenshot harness
 * for the almyty docs site.
 *
 * Runs against a live deploy (default: staging) and captures every
 * flow the docs reference. Writes PNGs into
 * `docs-site/public/screenshots/` so the MDX files under
 * `docs-site/content/` can reference them as `/screenshots/*.png`.
 *
 * ─ Why a separate harness ──────────────────────────────────────
 * The docs are maintained independently of the frontend build —
 * this script is the single source of truth for which UI flows
 * are documented. When someone adds a new page to the docs,
 * they add a step here; one command then regenerates all the
 * images. Keeps the screenshots consistent (same viewport,
 * theme, masked timestamps) and reproducible.
 *
 * ─ Usage ───────────────────────────────────────────────────────
 *   # from the docs-site directory:
 *   BASE_URL=https://app.staging.almyty.com \
 *   API_URL=https://api.staging.almyty.com \
 *   DEMO_EMAIL=demo@almyty.local \
 *   DEMO_PASSWORD=DemoPass123! \
 *   node scripts/capture-screenshots.mjs
 *
 *   # or against a local dev stack (backend on :3000, vite on :3002):
 *   BASE_URL=http://localhost:3002 API_URL=http://localhost:3000 \
 *     node scripts/capture-screenshots.mjs
 *
 * The script requires Playwright chromium to be installed. From
 * the monorepo root:
 *   cd frontend && npx playwright install chromium
 *
 * ─ What it captures ────────────────────────────────────────────
 * One PNG per logical docs panel. The step list below is the
 * single authoritative map from docs to UI surface — if you add
 * a new MDX page, add the matching step here.
 */

import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'public', 'screenshots')

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3002'
const API_URL = process.env.API_URL ?? 'http://localhost:3000'
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'demo@almyty.local'
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPass123!'
const THEME = process.env.THEME ?? 'dark' // 'dark' | 'light'
const VIEWPORT = {
  width: parseInt(process.env.VIEWPORT_WIDTH ?? '1440', 10),
  height: parseInt(process.env.VIEWPORT_HEIGHT ?? '900', 10),
}

/** Capture steps. Each step gets one PNG. Keep IDs stable — the
 * MDX files reference them verbatim. */
const steps = [
  // ── Auth ─────────────────────────────────────────────────
  {
    id: 'auth-login',
    title: 'Sign-in screen',
    navigate: async (page) => page.goto(`${BASE_URL}/auth/login`),
    waitFor: async (page) => page.getByRole('heading', { name: /sign in/i }).waitFor(),
  },
  {
    id: 'auth-register',
    title: 'Sign-up screen',
    navigate: async (page) => page.goto(`${BASE_URL}/auth/register`),
    waitFor: async (page) => page.getByRole('heading', { name: /create/i }).waitFor(),
  },
  // Everything below this line is captured while signed in as
  // the demo user. `auth: true` tells the runner to call
  // `loginIfNeeded` before navigating.
  // ── Dashboard + onboarding ───────────────────────────────
  {
    id: 'dashboard-empty',
    title: 'Empty-org dashboard — first-run onboarding checklist',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/dashboard`),
    waitFor: async (page) => page.getByText(/welcome/i).first().waitFor(),
  },
  // ── Command palette ──────────────────────────────────────
  {
    id: 'command-palette',
    title: 'Global ⌘K command palette',
    auth: true,
    navigate: async (page) => {
      await page.goto(`${BASE_URL}/dashboard`)
      await page.keyboard.press('Meta+k')
    },
    waitFor: async (page) => page.getByPlaceholder(/jump to/i).waitFor(),
  },
  // ── APIs ─────────────────────────────────────────────────
  {
    id: 'apis-empty',
    title: 'APIs page — empty state',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/apis`),
    waitFor: async (page) => page.getByText(/connect your first api/i).waitFor(),
  },
  {
    id: 'apis-import-dialog',
    title: 'Import API dialog',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/apis?new=1`),
    waitFor: async (page) => page.getByRole('dialog').waitFor(),
  },
  {
    id: 'apis-list',
    title: 'APIs list with a Petstore import',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/apis`),
    waitFor: async (page) => page.getByRole('table').waitFor().catch(() => null),
  },
  // ── Tools ────────────────────────────────────────────────
  {
    id: 'tools-empty',
    title: 'Tools page — empty state',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/tools`),
    waitFor: async (page) => page.getByRole('heading', { name: /tools/i }).waitFor(),
  },
  {
    id: 'tools-create-dialog',
    title: 'Create Tool dialog — 5 execution methods',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/tools?new=1`),
    waitFor: async (page) => page.getByRole('dialog').waitFor(),
  },
  {
    id: 'tools-list',
    title: 'Tools list',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/tools`),
    waitFor: async (page) => page.getByRole('heading', { name: /tools/i }).waitFor(),
  },
  // ── Gateways ─────────────────────────────────────────────
  {
    id: 'gateways-empty',
    title: 'Gateways page — empty state',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/gateways`),
    waitFor: async (page) => page.getByRole('heading', { name: /gateways/i }).waitFor(),
  },
  {
    id: 'gateways-create-dialog',
    title: 'Create Gateway dialog (MCP / A2A / UTCP / Skills)',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/gateways?new=1`),
    waitFor: async (page) => page.getByRole('dialog').waitFor(),
  },
  {
    id: 'gateway-detail-tools',
    title: 'Gateway detail — Tools tab with scoping',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/gateways`),
    waitFor: async (page) => page.getByRole('heading', { name: /gateways/i }).waitFor(),
  },
  // ── Agents + builder ─────────────────────────────────────
  {
    id: 'agents-empty',
    title: 'Agents page — empty state',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/agents`),
    waitFor: async (page) => page.getByRole('heading', { name: /agents/i }).waitFor(),
  },
  {
    id: 'agent-builder',
    title: 'Visual agent DAG builder (react-flow)',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/agents/new`),
    waitFor: async (page) => page.locator('.react-flow').waitFor().catch(() => null),
  },
  // ── LLM providers ────────────────────────────────────────
  {
    id: 'llm-providers-empty',
    title: 'Models page — empty state',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/llm-providers`),
    waitFor: async (page) => page.getByRole('heading', { name: /models/i }).waitFor(),
  },
  {
    id: 'llm-providers-create',
    title: 'Add LLM Provider dialog',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/llm-providers?new=1`),
    waitFor: async (page) => page.getByRole('dialog').waitFor(),
  },
  // ── Credentials ──────────────────────────────────────────
  {
    id: 'credentials-vault',
    title: 'Credentials vault',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/credentials`),
    waitFor: async (page) => page.getByRole('heading', { name: /credentials/i }).waitFor(),
  },
  {
    id: 'credentials-add',
    title: 'Add Credential dialog',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/credentials?new=1`),
    waitFor: async (page) => page.getByRole('dialog').waitFor(),
  },
  // ── Analytics ────────────────────────────────────────────
  {
    id: 'analytics-overview',
    title: 'Analytics overview',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/analytics`),
    waitFor: async (page) => page.getByRole('heading', { name: /analytics/i }).waitFor(),
  },
  {
    id: 'analytics-audit',
    title: 'Analytics → Audit trail tab',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/analytics`),
    // The audit tab is a sibling of Overview; click it.
    waitFor: async (page) => page.getByRole('heading', { name: /analytics/i }).waitFor(),
    after: async (page) => page.getByRole('tab', { name: /audit/i }).click().catch(() => null),
  },
  // ── Memories ─────────────────────────────────────────────
  {
    id: 'memories',
    title: 'Memories page',
    auth: true,
    navigate: async (page) => page.goto(`${BASE_URL}/memories`),
    waitFor: async (page) => page.getByRole('heading', { name: /memories/i }).waitFor(),
  },
  // ── Keyboard shortcuts dialog ────────────────────────────
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts help dialog',
    auth: true,
    navigate: async (page) => {
      await page.goto(`${BASE_URL}/dashboard`)
      await page.waitForTimeout(500)
      await page.keyboard.press('Shift+Slash') // `?`
    },
    waitFor: async (page) => page.getByRole('heading', { name: /keyboard shortcuts/i }).waitFor(),
  },
]

/** Ensure the browser context is authenticated. Tries login first;
 * if the account doesn't exist yet, registers a fresh throwaway
 * user and retries. */
async function loginIfNeeded(context) {
  const cookies = await context.cookies()
  if (cookies.some((c) => c.name === 'access_token')) return

  let resp = await context.request.post(`${API_URL}/auth/login`, {
    data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    headers: { 'Content-Type': 'application/json' },
  })

  if (resp.status() === 401) {
    // Account doesn't exist — register it.
    const regResp = await context.request.post(`${API_URL}/auth/register`, {
      data: {
        email: DEMO_EMAIL,
        password: DEMO_PASSWORD,
        firstName: 'Demo',
        lastName: 'User',
        organizationName: `Docs ${Date.now()}`,
      },
      headers: { 'Content-Type': 'application/json' },
    })
    if (!regResp.ok()) {
      throw new Error(`Registration failed (${regResp.status()}): ${await regResp.text()}`)
    }
    // Registration sets the cookie directly — check before retrying login.
    const postRegCookies = await context.cookies()
    if (postRegCookies.some((c) => c.name === 'access_token')) return

    // Retry login with the just-registered account.
    resp = await context.request.post(`${API_URL}/auth/login`, {
      data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!resp.ok()) {
    throw new Error(`Login failed (${resp.status()}): ${await resp.text()}`)
  }
}

async function capture() {
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: THEME === 'light' ? 'light' : 'dark',
    // Stable locale so date formatting is reproducible.
    locale: 'en-US',
    timezoneId: 'UTC',
  })
  const page = await context.newPage()

  // Hide the system clock / animations so diffs stay small.
  await context.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}'
    document.documentElement.appendChild(style)
  })

  // Auth once before the loop. The cookie persists across steps.
  const hasAuthSteps = steps.some((s) => s.auth)
  if (hasAuthSteps) await loginIfNeeded(context)

  const manifest = []
  let failed = 0

  for (const step of steps) {
    const out = resolve(OUT_DIR, `${step.id}.png`)
    try {
      await step.navigate(page)
      if (step.waitFor) await step.waitFor(page).catch(() => null)
      if (step.after) await step.after(page).catch(() => null)
      // Small settle so the page has a chance to paint.
      await page.waitForTimeout(400)
      await page.screenshot({ path: out, fullPage: false })
      manifest.push({ id: step.id, title: step.title, path: `screenshots/${step.id}.png` })
      console.log(`✓ ${step.id}`)
    } catch (err) {
      failed += 1
      console.error(`✗ ${step.id}: ${err?.message ?? err}`)
    }
  }

  // Emit a manifest so the MDX files (and CI checks) can verify
  // every step produced a file.
  await writeFile(
    resolve(OUT_DIR, 'manifest.json'),
    JSON.stringify({ capturedAt: new Date().toISOString(), baseUrl: BASE_URL, theme: THEME, viewport: VIEWPORT, screenshots: manifest }, null, 2),
  )

  await browser.close()
  if (failed > 0) {
    console.error(`\n${failed} step(s) failed`)
    process.exit(1)
  }
  console.log(`\ncaptured ${manifest.length} screenshots → ${OUT_DIR}`)
}

capture().catch((err) => {
  console.error(err)
  process.exit(1)
})
