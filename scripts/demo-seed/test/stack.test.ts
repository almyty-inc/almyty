import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { HERE } from '../engine/env.ts'
import { stackEnv } from '../engine/env.ts'

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
  assert.throws(() => stackEnv({}), /DEMO_WEB_URL, DEMO_API_URL, PG_NAME not set/)
  assert.equal(stackEnv({ DEMO_WEB_URL: 'http://w', DEMO_API_URL: 'http://a', PG_NAME: 'pg' }).api, 'http://a')
})
