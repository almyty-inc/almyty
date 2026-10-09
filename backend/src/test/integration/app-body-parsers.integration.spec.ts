import 'reflect-metadata';
import { AddressInfo } from 'net';
import type { INestApplication } from '@nestjs/common';

import { createApp } from '../../main';

/**
 * Request bodies, through the application exactly as main.ts configures it
 * (createApp: the same NestFactory options, middleware and parsers), on a
 * real port.
 *
 * The model routes take larger JSON bodies than the rest. The first version
 * of that registered express's json() for those paths, and because Nest
 * does not install its own JSON parser when a middleware named
 * `jsonParser` is already there, every other route lost its body: sign-up
 * answered "email should not be empty". Every unit suite stayed green.
 */
const run = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

run('request bodies through the real bootstrap (real Postgres + Redis)', () => {
  jest.setTimeout(180_000);
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    ({ app } = await createApp());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('parses JSON on an ordinary route: sign-up sees the fields it was sent', async () => {
    // A malformed email, so validation answers without touching the
    // database: the complaint is about the email's shape, not its absence.
    const res = await post('/auth/register', { email: 'not-an-email', password: 'plainly-fake-Passw0rd!', firstName: 'Ada', lastName: 'Body', organizationName: 'Body Parsers' });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toMatch(/should not be empty/);
    expect(text).toMatch(/email must be an email/);
  });

  it('keeps the default body limit on ordinary routes', async () => {
    const res = await post('/auth/register', { email: 'big@example.com', password: 'x'.repeat(200 * 1024), firstName: 'A', lastName: 'B' });
    expect(res.status).toBe(413);
  });

  it('takes a model call larger than 100kb on the model routes (parsed, then refused for want of a key)', async () => {
    const big = { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'x'.repeat(200 * 1024) }] };
    for (const path of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
      const res = await post(path, big, { Authorization: 'Bearer almyty_pod_plainly-fake-unknown-token' });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});
