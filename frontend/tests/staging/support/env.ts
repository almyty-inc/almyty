/**
 * Where the staging gate points, and who it signs in as.
 *
 * The QA user's address and password live in `.env.staging-qa.local` at
 * the main checkout's root (never committed, never printed). Nothing here
 * reads a vendor key: the QA user's organization already has its models
 * connected in the product, the way a customer's would.
 */
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

const FILE = '.env.staging-qa.local'

/** Walk up from here to the first directory holding the QA env file. */
function findEnvFile(): string | null {
  const explicit = process.env.ALMYTY_QA_ENV_FILE
  if (explicit) return existsSync(explicit) ? explicit : null
  let dir = resolve(__dirname)
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, FILE)
    if (existsSync(candidate)) return candidate
    // A git worktree under .claude/worktrees also looks in the main checkout.
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

let cached: Record<string, string> | null = null
function qaEnv(): Record<string, string> {
  if (cached) return cached
  const file = findEnvFile()
  if (!file) {
    throw new Error(`${FILE} not found. The staging gate signs in as the QA user from that file (ALMYTY_QA_*).`)
  }
  cached = parse(readFileSync(file, 'utf-8'))
  return cached
}

export const APP_URL = (process.env.ALMYTY_QA_APP_URL || qaEnvSafe('ALMYTY_QA_APP_URL') || 'https://app.staging.almyty.com').replace(/\/$/, '')
export const API_URL = (process.env.ALMYTY_QA_API_URL || qaEnvSafe('ALMYTY_QA_API_URL') || 'https://api.staging.almyty.com').replace(/\/$/, '')
/** The QA user's organization: the one whose models are connected. */
export const QA_ORG_NAME = process.env.ALMYTY_QA_ORG || qaEnvSafe('ALMYTY_QA_ORG') || 'Northwind AI'

function qaEnvSafe(key: string): string | undefined {
  try {
    return qaEnv()[key]
  } catch {
    return undefined
  }
}

export function qaCredentials(): { email: string; password: string } {
  const env = qaEnv()
  const email = env.ALMYTY_QA_EMAIL
  const password = env.ALMYTY_QA_PASSWORD
  if (!email || !password) throw new Error(`${FILE} must set ALMYTY_QA_EMAIL and ALMYTY_QA_PASSWORD`)
  return { email, password }
}

/** Gate output: storage state, screenshots, the JSON results the report is built from. */
export const GATE_DIR = process.env.GATE_DIR || resolve(__dirname, '../../../../gate-results')
export const QA_STATE_FILE = join(GATE_DIR, '.auth', 'qa.json')
export const QA_ORG_FILE = join(GATE_DIR, '.auth', 'qa-org.json')
export const SHOTS_DIR = join(GATE_DIR, 'shots')

/**
 * One id per gate run, shared by every worker: everything a test creates
 * is named `gate-<run id>-…` so the run's own cleanup and the daily sweep
 * can find it.
 */
export const RUN_ID = process.env.GATE_RUN_ID || (process.env.GATE_RUN_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14))