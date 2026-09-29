import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { runtimeConfigScript } from '../../vite.config'

/**
 * index.html loads /runtime-config.js before the app. In a container the
 * entrypoint writes it and nginx serves it; in dev vite serves the same
 * script, so a dev page load has no 404 in the console.
 */
describe('/runtime-config.js in dev', () => {
  const root = join(__dirname, '..', '..')

  it('is the script the container entrypoint writes', () => {
    const entrypoint = readFileSync(join(root, 'docker-entrypoint.sh'), 'utf8')
    const template = entrypoint.match(/^window\.__ALMYTY_RUNTIME__ = .*$/m)?.[0]
    expect(template).toBeDefined()
    expect(runtimeConfigScript('chat.example.test').trim()).toBe(template!.replace('${domain}', 'chat.example.test'))
  })

  it('keeps a bad value inside the string literal', () => {
    expect(runtimeConfigScript('x"; alert(1); "')).toBe('window.__ALMYTY_RUNTIME__ = { hostedChatBaseDomain: "xalert1" };\n')
  })

  it('is served by the dev server', () => {
    const config = readFileSync(join(root, 'vite.config.ts'), 'utf8')
    expect(config).toMatch(/plugins: \[react\(\), devRuntimeConfig\]/)
    expect(config).toMatch(/middlewares\.use\('\/runtime-config\.js'/)
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('<script src="/runtime-config.js"></script>')
  })
})
