/**
 * `vite preview` of the built bundle under the production CSP, with the API
 * proxied same-origin like the dev server. The dev server cannot carry the
 * CSP (its HMR preamble is an inline script), so this is how a local stack
 * sees what nginx's policy blocks:
 *
 *   ALMYTY_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx vite build
 *   ALMYTY_API_TARGET=http://localhost:4100 npx vite preview --config vite.csp-preview.config.ts --port 3611
 */
import { readFileSync } from 'fs'
import base from './vite.config'

const inc = readFileSync(new URL('./nginx-security-headers.inc', import.meta.url), 'utf8')
const csp = inc.match(/Content-Security-Policy "([^"]+)"/)![1]

export default {
  ...base,
  preview: { ...base.preview, proxy: base.server!.proxy, headers: { 'Content-Security-Policy': csp } },
}
