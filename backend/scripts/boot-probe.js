/**
 * Does the whole app assemble?
 *
 * Every unit test builds a module with mocks, so a wrong DI token, a
 * circular module import or a provider nobody registered passes the
 * entire suite and fails at boot. This repo has had that exact failure
 * (a governance module importing the connections cycle), which is why
 * this exists.
 *
 * Run it with `npm run verify:boot`, which builds the EE overlay first
 * because this reads `dist-ee`. It connects for real, so it needs the
 * database and Redis reachable with the env the app expects — a
 * `28P01` means your credentials, not your wiring.
 */
require('reflect-metadata');
const path = require('path');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(path.resolve(__dirname, '..', 'dist-ee', 'src', 'app.module.js'));
const t = setTimeout(() => { console.log('PROBE: HUNG (no app after 120s)'); process.exit(2); }, 120000);
NestFactory.create(AppModule, { logger: ['error', 'warn'] })
  .then(async (app) => { clearTimeout(t); console.log('PROBE: created OK'); await app.close(); process.exit(0); })
  .catch((e) => { clearTimeout(t); console.log('PROBE: ERROR', String(e.message).slice(0, 300)); process.exit(1); });
