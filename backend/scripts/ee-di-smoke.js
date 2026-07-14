#!/usr/bin/env node
/**
 * EE assembly DI smoke — catches require-cycle breakage without a database.
 *
 * When a circular require leaves a class undefined at decoration time,
 * TypeScript emits `undefined` into that constructor's design:paramtypes.
 * Nest then fails at boot with "Nest can't resolve dependencies of X (?)"
 * — which is exactly how the dev/staging CrashLoop after the EE relocation
 * manifested (PromotedSkillsService's LlmProvidersService came in undefined
 * only in the dist-ee require order).
 *
 * This script loads the FULL EE module graph (app.module pulls in
 * loadEeModules()) and walks require.cache checking every decorated class:
 * a paramtypes entry that is `undefined` and not covered by an explicit
 * @Inject()/forwardRef self-declared dependency is a boot-crash-in-waiting.
 *
 * Usage: npm run build:ee && node scripts/ee-di-smoke.js
 */
require('reflect-metadata');
const path = require('path');

const root = path.resolve(__dirname, '..', 'dist-ee');
try {
  require(path.join(root, 'src', 'app.module.js'));
} catch (e) {
  console.error('FAILED to load the EE module graph at all:', e.message);
  process.exit(1);
}

const problems = [];
for (const [file, mod] of Object.entries(require.cache)) {
  if (!file.startsWith(root)) continue;
  const exps = mod.exports;
  if (!exps || typeof exps !== 'object') continue;
  for (const [name, exp] of Object.entries(exps)) {
    if (typeof exp !== 'function') continue;
    const params = Reflect.getMetadata('design:paramtypes', exp);
    if (!Array.isArray(params)) continue;
    const selfDeclared = Reflect.getMetadata('self:paramtypes', exp) || [];
    const covered = new Set(selfDeclared.map((d) => d && d.index));
    params.forEach((p, i) => {
      if (p === undefined && !covered.has(i)) {
        problems.push(
          `${name} (${path.relative(root, file)}): constructor param [${i}] is undefined at decoration time (require cycle) and has no @Inject()/forwardRef`,
        );
      }
    });
  }
}

if (problems.length) {
  console.error(`EE DI smoke FAILED — ${problems.length} undefined constructor param(s):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('EE DI smoke passed: no undefined constructor params in the EE assembly.');
