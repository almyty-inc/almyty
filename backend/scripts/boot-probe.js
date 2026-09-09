require('reflect-metadata');
const path = require('path');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(path.resolve(__dirname, '..', 'dist-ee', 'src', 'app.module.js'));
const t = setTimeout(() => { console.log('PROBE: HUNG (no app after 120s)'); process.exit(2); }, 120000);
NestFactory.create(AppModule, { logger: ['error', 'warn'] })
  .then(async (app) => { clearTimeout(t); console.log('PROBE: created OK'); await app.close(); process.exit(0); })
  .catch((e) => { clearTimeout(t); console.log('PROBE: ERROR', String(e.message).slice(0, 300)); process.exit(1); });
