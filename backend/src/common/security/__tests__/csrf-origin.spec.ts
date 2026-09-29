import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { csrfOriginCheck } from '../csrf-origin';

/**
 * A page on any subdomain of ours is "same-site" to the API, so the Lax
 * session cookie rides along on a form it submits. Without an origin check
 * such a page could act as whoever is signed in: create API keys, change
 * the profile, delete agents.
 */
describe('cookie-authenticated writes must come from an origin we serve', () => {
  const DASHBOARD = 'https://app.almyty.test';
  const app = express();
  app.use(cookieParser());
  app.use(csrfOriginCheck(new Set([DASHBOARD])));
  app.use((_req, res) => {
    res.status(200).json({ done: true });
  });
  const cookie = 'access_token=session-token';

  it('refuses a cookie-bearing POST from a sibling subdomain', async () => {
    const res = await request(app)
      .post('/auth/api-keys')
      .set('Cookie', cookie)
      .set('Origin', 'https://blog.almyty.test')
      .send({ name: 'exfil' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_ORIGIN_REFUSED');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses %s the same way', async (method) => {
    const res = await (request(app) as any)[method.toLowerCase()]('/agents/a1')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('refuses `Origin: null` and falls back to Referer when Origin is stripped', async () => {
    await request(app).post('/x').set('Cookie', cookie).set('Origin', 'null').expect(403);
    await request(app).post('/x').set('Cookie', cookie).set('Referer', 'https://evil.example/page').expect(403);
    await request(app).post('/x').set('Cookie', cookie).set('Referer', `${DASHBOARD}/settings`).expect(200);
  });

  it('lets the dashboard origin through', async () => {
    await request(app).post('/auth/api-keys').set('Cookie', cookie).set('Origin', DASHBOARD).expect(200);
  });

  it("lets the API's own origin through (the single-image deployment)", async () => {
    await request(app)
      .post('/auth/api-keys')
      .set('Cookie', cookie)
      .set('Host', 'almyty.example.com')
      .set('Origin', 'https://almyty.example.com')
      .expect(200);
  });

  it('leaves requests alone that ride no session or come from no browser', async () => {
    // No cookie: a bearer or API-key client, nothing to forge.
    await request(app).post('/x').set('Origin', 'https://evil.example').expect(200);
    // No Origin and no Referer: not a browser request.
    await request(app).post('/x').set('Cookie', cookie).expect(200);
    // Safe methods change nothing.
    await request(app).get('/x').set('Cookie', cookie).set('Origin', 'https://evil.example').expect(200);
  });

  it('exempts the SAML assertion consumers, which an IdP posts to from its own origin', async () => {
    await request(app)
      .post('/sso/org-1/saml/callback')
      .set('Cookie', cookie)
      .set('Origin', 'https://idp.example')
      .expect(200);
    await request(app)
      .post('/public/chat/my-app/auth/sso/saml/acs')
      .set('Cookie', cookie)
      .set('Origin', 'https://idp.example')
      .expect(200);
  });

  it('is installed on the app with the CORS allowlist, after the cookie parser', () => {
    const main = readFileSync(join(__dirname, '..', '..', '..', 'main.ts'), 'utf8');
    const parser = main.indexOf('app.use(cookieParser())');
    const check = main.indexOf('app.use(csrfOriginCheck(allowedOrigins))');
    expect(parser).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(parser);
  });
});
