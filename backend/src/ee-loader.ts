/**
 * Bridges the OSS core to the commercial `ee/` tree WITHOUT a static import,
 * so the community build compiles and boots even when `ee/` is absent.
 *
 * `require('../ee')` is resolved lazily at runtime:
 *   - EE build (tsconfig.ee.json, rootDir `.`): `dist-ee/src/ee-loader.js`
 *     resolves `../ee` → `dist-ee/ee/index.js` → the compiled EE modules.
 *   - OSS build (rootDir `./src`): `dist/ee-loader.js` resolves `../ee` to a
 *     path with no compiled `index.js` (the source `.ts` is never built, or
 *     the tree is stripped entirely), so the require throws and we fall back
 *     to an empty module list.
 *
 * The return type is intentionally `any[]` — the core must not carry a
 * compile-time type dependency on anything under `ee/`.
 */
export function loadEeModules(): any[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ee = require('../ee');
    return Array.isArray(ee?.EE_MODULES) ? ee.EE_MODULES : [];
  } catch {
    return [];
  }
}
