// The demo people's password. Nothing in the source: it is made at random
// the first time a stack needs it and kept in that stack's LOG_DIR, so every
// walk on the stack (and a rerun) signs in with the same one. Without a
// stack (tests, `check`) it is random for the process and never stored.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let cached: string | undefined

/** Upper and lower case, a digit and a symbol, so every password rule the product has is met. */
export const makePassword = () => `Demo-${randomBytes(12).toString('base64url')}-9a`

export function demoPassword(dir = process.env.LOG_DIR): string {
  if (cached && !dir) return cached
  if (!dir) return (cached = makePassword())
  const file = join(dir, 'demo-password')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const made = makePassword()
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, made, { mode: 0o600 })
  return made
}
