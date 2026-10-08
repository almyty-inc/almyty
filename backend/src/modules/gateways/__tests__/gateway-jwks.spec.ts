import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { verifyGatewayJwt } from '../gateway-jwks';
describe('own-system JWT uses public keys and required issuer/audience/expiry', () => {
 it('validates a signed token and refuses another audience or issuer', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'one', alg: 'RS256', use: 'sig' });
  const fetcher = jest.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'one' }).setSubject('external-user').setIssuer('https://id.example').setAudience('my-api').setExpirationTime('5m').sign(privateKey);
  expect((await verifyGatewayJwt(token, { jwksUrl: 'https://id.example/jwks', issuer: 'https://id.example', audience: 'my-api' }, fetcher)).sub).toBe('external-user');
  await expect(verifyGatewayJwt(token, { jwksUrl: 'https://id.example/jwks', issuer: 'https://other.example', audience: 'my-api' }, fetcher)).rejects.toThrow();
  await expect(verifyGatewayJwt(token, { jwksUrl: 'https://id.example/jwks', issuer: 'https://id.example', audience: 'other' }, fetcher)).rejects.toThrow();
 });
 it('refuses insecure endpoints and incomplete config before fetching', async () => {
  const fetcher = jest.fn();
  await expect(verifyGatewayJwt('token', { jwksUrl: 'http://127.0.0.1/key', issuer: 'id', audience: 'a' }, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
 });
});
