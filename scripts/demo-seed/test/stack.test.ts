import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { HERE } from '../engine/env.ts'
import { stackEnv } from '../engine/env.ts'
import { demoPassword, makePassword } from '../engine/password.ts'
import { readFileSync, statSync } from 'node:fs'

test('the demo password is made once per stack, kept in its log directory, and never in the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-pw-'))
  const first = demoPassword(dir)
  assert.equal(demoPassword(dir), first)
  assert.equal(readFileSync(join(dir, 'demo-password'), 'utf8'), first)
  assert.equal(statSync(join(dir, 'demo-password')).mode & 0o777, 0o600)
  assert.notEqual(demoPassword(mkdtempSync(join(tmpdir(), 'demo-pw-'))), first)
  assert.match(makePassword(), /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{20,}$/)
})

test('stack.sh env exports what the walks read, so eval reaches child processes', () => {
  const logs = mkdtempSync(join(tmpdir(), 'demo-env-'))
  const out = execFileSync('bash', [join(HERE, 'stack.sh'), 'env'], { encoding: 'utf8', env: { ...process.env, LOG_DIR: logs, PROFILE: 'northwind', API_PORT: '4999' } })
  const lines = out.trim().split('\n')
  assert.ok(lines.length >= 5)
  for (const line of lines) assert.match(line, /^export [A-Z_]+=\S+$/)
  const env = execFileSync('bash', ['-c', `eval "$(bash ${join(HERE, 'stack.sh')} env)"; node -e 'console.log(process.env.DEMO_API_URL)'`], { encoding: 'utf8', env: { ...process.env, LOG_DIR: logs, API_PORT: '4999', DEMO_API_URL: '' } })
  assert.equal(env.trim(), 'http://localhost:4999')
})

test('seeding and capturing refuse to guess which stack to write to', () => {
  assert.throws(() => stackEnv({}), /DEMO_WEB_URL, DEMO_API_URL, PG_NAME, LOG_DIR not set/)
  assert.equal(stackEnv({ DEMO_WEB_URL: 'http://w', DEMO_API_URL: 'http://a', PG_NAME: 'pg', LOG_DIR: '/x' }).api, 'http://a')
})
