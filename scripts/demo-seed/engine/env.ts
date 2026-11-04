// Where the local demo stack is. stack.sh env prints these.
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ROOT = join(HERE, '../..')

export interface Env {
  web: string
  api: string
  /** The Northwind fake (model vendors and company APIs). */
  fake: string
  /** The profile's fake upstream (Google, HubSpot, Stripe, ...). */
  upstream: string
  pgContainer: string
  database: string
  out: string
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    web: source.DEMO_WEB_URL || 'http://localhost:3210',
    api: source.DEMO_API_URL || 'http://localhost:4210',
    fake: source.DEMO_FAKE_URL || 'http://localhost:4290',
    upstream: source.DEMO_USECASE_URL || 'http://localhost:4291',
    pgContainer: source.PG_NAME || 'almyty-demo-pg',
    database: source.DB_NAME || 'almyty_qa',
    out: source.SHOT_DIR || '/tmp/almyty-demo/shots',
  }
}

/** Run SQL in the stack's Postgres and return the bare result (psql -tA). */
export function sql(env: Env, query: string): string {
  return execFileSync('docker', ['exec', '-i', env.pgContainer, 'psql', '-U', 'postgres', '-d', env.database, '-v', 'ON_ERROR_STOP=1', '-tA'], { input: query, encoding: 'utf8' }).trim()
}
