/**
 * `vite preview` of the built bundle under the production CSP, with the API
 * proxied same-origin like the dev server. The dev server cannot carry the
 * CSP (its HMR preamble is an inline script), so this is how a local stack
 * sees what nginx's policy blocks:
 *
 *   ALMYTY_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx vite build
 *   ALMYTY_API_TARGET=http://localhost:4100 npx vite preview --config vite.csp-preview.config.ts --port 3611
 *
 * A bundle built with an absolute ALMYTY_API_BASE_URL calls that API
 * directly, as production does; set the same value when serving it and the
 * policy admits it, exactly as the container's entrypoint does.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import base from './vite.config'

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))

/**
 * The CSP nginx sends for a bundle built against `apiBaseUrl`: the header
 * from nginx-security-headers.inc, with the API variables filled in by the
 * container's own entrypoint script, so this cannot drift from the image.
 */
export function cspFor(apiBaseUrl: string): string {
  const inc = readFileSync(here('./nginx-security-headers.inc'), 'utf8')
  const header = inc.match(/Content-Security-Policy "([^"]+)"/)![1]
  const dir = mkdtempSync(join(tmpdir(), 'almyty-csp-'))
  try {
    execFileSync('sh', [here('./docker-entrypoint.sh')], {
      env: { ...process.env, ALMYTY_RUNTIME_DIR: dir, ALMYTY_API_BASE_URL: apiBaseUrl },
    })
    const conf = readFileSync(join(dir, 'almyty-csp.conf'), 'utf8')
    const vars = Object.fromEntries([...conf.matchAll(/map \$host \$(\w+) \{ default "([^"]*)"; \}/g)].map((m) => [m[1], m[2]]))
    return header.replace(/\$(\w+)/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`docker-entrypoint.sh does not define $${name}`)
      return vars[name]
    }).replace(/ {2,}/g, ' ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export default {
  ...base,
  preview: {
    ...base.preview,
    proxy: base.server!.proxy,
    headers: { 'Content-Security-Policy': cspFor(process.env.ALMYTY_API_BASE_URL || '') },
  },
}
