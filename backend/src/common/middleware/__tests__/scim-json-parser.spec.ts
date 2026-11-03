import express from 'express';
import type http from 'http';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { serveOnLoopback } from '../../../test/http';
import { SCIM_ROUTES, scimJsonParser } from '../scim-json-parser';

describe('scimJsonParser', () => {
  const app = express();
  app.use(SCIM_ROUTES, scimJsonParser());
  app.post('/scim/v2/Users', (req, res) => res.json({ received: req.body ?? null }));
  let server: http.Server;
  beforeAll(async () => {
    server = await serveOnLoopback(app);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('reads the application/scim+json body Entra ID and Okta send', async () => {
    const user = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'eva@example.com', active: true };
    const res = await request(server)
      .post('/scim/v2/Users')
      .set('Content-Type', 'application/scim+json')
      .send(JSON.stringify(user));
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual(user);
  });

  it('still reads plain application/json', async () => {
    const res = await request(server).post('/scim/v2/Users').send({ userName: 'tom@example.com' });
    expect(res.body.received).toEqual({ userName: 'tom@example.com' });
  });

  it('is installed on the SCIM routes in main.ts', () => {
    const main = readFileSync(join(__dirname, '../../../main.ts'), 'utf8');
    expect(main).toMatch(/app\.use\(SCIM_ROUTES,\s*scimJsonParser\(\)\)/);
  });
});
