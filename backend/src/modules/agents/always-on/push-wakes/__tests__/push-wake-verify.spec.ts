import { createHmac } from 'crypto';
import { generateKeyPair } from 'jose';

import { failedRule, ignored, verifyPush } from '../push-wake-verify';
import { checkSpec } from '../push-wake.types';
import { fakeIssuer } from './push-wakes.harness';

const URL_ = 'https://api.example.test/push-wakes/1b2c';
const ctx = (secret: string | null, settings: Record<string, string> = {}) => ({
  secret,
  endpointUrl: URL_,
  templateContext: { endpoint: { url: URL_ }, settings, state: { subscription: { id: 'chan-1' } } },
});

describe('push verification: a shared value in a header', () => {
  const v = checkSpec({ verification: { method: 'shared_token', headerName: 'X-Goog-Channel-Token', generated: true }, summary: 'x' }).verification;

  it('accepts the value it handed out, in the configured header', async () => {
    expect(await verifyPush(v, { headers: { 'x-goog-channel-token': 's3cret' }, rawBody: '' }, ctx('s3cret'))).toEqual({ ok: true });
  });

  it('refuses a wrong value, a missing header, and a source with no value set up', async () => {
    expect((await verifyPush(v, { headers: { 'x-goog-channel-token': 's3creT' }, rawBody: '' }, ctx('s3cret'))).ok).toBe(false);
    expect((await verifyPush(v, { headers: {}, rawBody: '' }, ctx('s3cret'))).ok).toBe(false);
    // Another header with the right value is not the configured header.
    expect((await verifyPush(v, { headers: { 'x-other-token': 's3cret' }, rawBody: '' }, ctx('s3cret'))).ok).toBe(false);
    expect((await verifyPush(v, { headers: { 'x-goog-channel-token': '' }, rawBody: '' }, ctx(null))).ok).toBe(false);
  });
});

describe('push verification: an HMAC signature', () => {
  const v = checkSpec({
    verification: {
      method: 'hmac',
      headerName: 'X-Signature',
      algorithm: 'sha256',
      encoding: 'hex',
      prefix: 'v0=',
      signedContent: 'v0:{{headers.x-request-timestamp}}:{{body}}',
      timestampHeader: 'X-Request-Timestamp',
    },
    summary: 'x',
  }).verification;
  const now = new Date('2026-10-22T10:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = '{"event":"changed"}';
  const sig = (key: string, t = ts, b = body) => `v0=${createHmac('sha256', key).update(`v0:${t}:${b}`).digest('hex')}`;

  it('accepts a push signed over the configured content with the key', async () => {
    const out = await verifyPush(v, { headers: { 'x-signature': sig('k'), 'x-request-timestamp': ts }, rawBody: body }, ctx('k'), undefined, now);
    expect(out).toEqual({ ok: true });
  });

  it('refuses another key, a changed body, a missing prefix, and an old push', async () => {
    const headers = (s: string, t = ts) => ({ 'x-signature': s, 'x-request-timestamp': t });
    expect((await verifyPush(v, { headers: headers(sig('other')), rawBody: body }, ctx('k'), undefined, now)).ok).toBe(false);
    expect((await verifyPush(v, { headers: headers(sig('k')), rawBody: '{"event":"forged"}' }, ctx('k'), undefined, now)).ok).toBe(false);
    expect((await verifyPush(v, { headers: headers(sig('k').slice(3)), rawBody: body }, ctx('k'), undefined, now)).ok).toBe(false);
    const old = String(Number(ts) - 3600);
    expect((await verifyPush(v, { headers: headers(sig('k', old), old), rawBody: body }, ctx('k'), undefined, now)).ok).toBe(false);
  });
});

describe('push verification: a signed OIDC token', () => {
  const SA = 'almyty-push@my-project.iam.gserviceaccount.com';
  const spec = checkSpec({
    verification: {
      method: 'oidc_jwt',
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      audience: '{{endpoint.url}}',
      claims: { email: '{{settings.pushServiceAccount}}', email_verified: 'true' },
    },
    summary: 'x',
  });
  const settings = { pushServiceAccount: SA };
  const push = (token: string) => ({ headers: { authorization: `Bearer ${token}` }, rawBody: '{}' });
  const good = { email: SA, email_verified: true, sub: '1234' };

  it('accepts a token signed by the issuer, for this address, from the configured account', async () => {
    const issuer = await fakeIssuer();
    const token = await issuer.mint(good, { audience: URL_ });
    const out = await verifyPush(spec.verification, push(token), ctx(null, settings), issuer.keySetFor);
    expect(out.ok).toBe(true);
    // Either spelling Google uses for its issuer.
    const bare = await issuer.mint(good, { audience: URL_, issuer: 'accounts.google.com' });
    expect((await verifyPush(spec.verification, push(bare), ctx(null, settings), issuer.keySetFor)).ok).toBe(true);
  });

  it('refuses the wrong audience', async () => {
    const issuer = await fakeIssuer();
    const token = await issuer.mint(good, { audience: 'https://api.example.test/push-wakes/someone-else' });
    const out = await verifyPush(spec.verification, push(token), ctx(null, settings), issuer.keySetFor);
    expect(out).toEqual({ ok: false, reason: expect.stringMatching(/does not verify/) });
  });

  it('refuses the wrong issuer', async () => {
    const issuer = await fakeIssuer();
    const token = await issuer.mint(good, { audience: URL_, issuer: 'https://evil.example' });
    expect((await verifyPush(spec.verification, push(token), ctx(null, settings), issuer.keySetFor)).ok).toBe(false);
  });

  it('refuses an expired token', async () => {
    const issuer = await fakeIssuer();
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = await issuer.mint(good, { audience: URL_, iat: past, expiresIn: past + 600 });
    const out = await verifyPush(spec.verification, push(token), ctx(null, settings), issuer.keySetFor);
    expect(out).toEqual({ ok: false, reason: expect.stringMatching(/expired/i) });
  });

  it('refuses a token signed by another key, garbage, and no token', async () => {
    const issuer = await fakeIssuer();
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await issuer.mint(good, { audience: URL_, key: privateKey });
    expect((await verifyPush(spec.verification, push(forged), ctx(null, settings), issuer.keySetFor)).ok).toBe(false);
    expect((await verifyPush(spec.verification, push('not.a.jwt'), ctx(null, settings), issuer.keySetFor)).ok).toBe(false);
    expect((await verifyPush(spec.verification, { headers: {}, rawBody: '' }, ctx(null, settings), issuer.keySetFor)).ok).toBe(false);
  });

  it('refuses a valid token from another service account, or an unverified email', async () => {
    const issuer = await fakeIssuer();
    const other = await issuer.mint({ ...good, email: 'someone@else.iam.gserviceaccount.com' }, { audience: URL_ });
    expect(await verifyPush(spec.verification, push(other), ctx(null, settings), issuer.keySetFor)).toEqual({ ok: false, reason: 'email is not the one set up' });
    const unverified = await issuer.mint({ ...good, email_verified: false }, { audience: URL_ });
    expect((await verifyPush(spec.verification, push(unverified), ctx(null, settings), issuer.keySetFor)).ok).toBe(false);
    // Nothing configured to compare with is a refusal, not a pass.
    const token = await issuer.mint(good, { audience: URL_ });
    expect((await verifyPush(spec.verification, push(token), ctx(null, {}), issuer.keySetFor)).ok).toBe(false);
  });
});

describe('header checks and ignored pushes', () => {
  const spec = checkSpec({
    verification: { method: 'shared_token', headerName: 'x-token', generated: true },
    checks: [
      { header: 'X-Goog-Channel-ID', oneOf: ['{{state.subscription.id}}'] },
      { header: 'X-Goog-Resource-State', oneOf: ['sync', 'exists', 'not_exists'] },
    ],
    ignore: [{ header: 'X-Goog-Resource-State', oneOf: ['sync'] }],
    summary: 'x',
  });
  const t = ctx('s').templateContext;

  it('passes the current subscription and a known state', () => {
    expect(failedRule(spec.checks, { headers: { 'x-goog-channel-id': 'chan-1', 'x-goog-resource-state': 'exists' }, rawBody: '' }, t)).toBeNull();
  });

  it('fails a replaced subscription, an unknown state, and a missing header', () => {
    expect(failedRule(spec.checks, { headers: { 'x-goog-channel-id': 'chan-0', 'x-goog-resource-state': 'exists' }, rawBody: '' }, t)?.header).toBe('x-goog-channel-id');
    expect(failedRule(spec.checks, { headers: { 'x-goog-channel-id': 'chan-1', 'x-goog-resource-state': 'weird' }, rawBody: '' }, t)?.header).toBe('x-goog-resource-state');
    expect(failedRule(spec.checks, { headers: { 'x-goog-resource-state': 'exists' }, rawBody: '' }, t)).not.toBeNull();
  });

  it('ignores the hello a channel sends when it opens', () => {
    expect(ignored(spec, { headers: { 'x-goog-resource-state': 'sync' }, rawBody: '' }, t)).toBe(true);
    expect(ignored(spec, { headers: { 'x-goog-resource-state': 'exists' }, rawBody: '' }, t)).toBe(false);
  });
});
