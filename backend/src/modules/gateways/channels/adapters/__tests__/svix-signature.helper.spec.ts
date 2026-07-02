import * as crypto from 'crypto';
import {
  verifySvixSignature,
  SVIX_TIMESTAMP_TOLERANCE_SECONDS,
} from '../svix-signature.helper';

describe('verifySvixSignature', () => {
  const secretBytes = Buffer.from('svix-helper-test-secret');
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const rawBody = '{"type":"email.received"}';
  const nowMs = 1_750_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));

  const sign = (id: string, ts: string, body: string, key: Buffer = secretBytes) =>
    crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');

  const headers = (over: Record<string, string> = {}) => ({
    'svix-id': 'msg_1',
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${sign('msg_1', timestamp, rawBody)}`,
    ...over,
  });

  it('accepts a valid v1 signature', () => {
    expect(verifySvixSignature(rawBody, headers(), secret, nowMs)).toBe(true);
  });

  it('accepts when any entry of a rotated signature list matches', () => {
    const rotated = `v1,${sign('msg_1', timestamp, 'other')} v1,${sign('msg_1', timestamp, rawBody)}`;
    expect(
      verifySvixSignature(rawBody, headers({ 'svix-signature': rotated }), secret, nowMs),
    ).toBe(true);
  });

  it('accepts a secret without the whsec_ prefix', () => {
    expect(
      verifySvixSignature(rawBody, headers(), secretBytes.toString('base64'), nowMs),
    ).toBe(true);
  });

  it('rejects a wrong secret, tampered body, and missing headers', () => {
    expect(
      verifySvixSignature(rawBody, headers(), `whsec_${Buffer.from('nope').toString('base64')}`, nowMs),
    ).toBe(false);
    expect(verifySvixSignature(rawBody + 'x', headers(), secret, nowMs)).toBe(false);
    expect(verifySvixSignature(rawBody, { 'svix-id': 'msg_1' }, secret, nowMs)).toBe(false);
    expect(verifySvixSignature(rawBody, headers(), '', nowMs)).toBe(false);
  });

  it('rejects timestamps outside the replay tolerance window', () => {
    const staleTs = String(Math.floor(nowMs / 1000) - SVIX_TIMESTAMP_TOLERANCE_SECONDS - 1);
    const stale = {
      'svix-id': 'msg_1',
      'svix-timestamp': staleTs,
      'svix-signature': `v1,${sign('msg_1', staleTs, rawBody)}`,
    };
    expect(verifySvixSignature(rawBody, stale, secret, nowMs)).toBe(false);
    expect(
      verifySvixSignature(rawBody, headers({ 'svix-timestamp': 'garbage' }), secret, nowMs),
    ).toBe(false);
  });
});
