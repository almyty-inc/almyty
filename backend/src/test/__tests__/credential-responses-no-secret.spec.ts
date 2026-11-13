/**
 * Guard: no list or read of a credential hands back any part of a secret.
 *
 * The staging gate found `credentials list --json` returning each stored
 * key as its first and last four characters (credentials.service.ts kept
 * `config`, masking a long value to `abcd****wxyz`; the per-API credential
 * service kept the first four). This holds every response path that
 * returns a credential's config to the same rule, by running the real
 * services over stored secrets of every shape and scanning what comes back
 * for any four characters in a row of any of them. A new masker has to go
 * through redactSecrets() (the source check at the bottom).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Credential } from '../../entities/credential.entity';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { CredentialService } from '../../modules/apis/credential.service';
import { SECRET_PRESENT, redactSecrets, secretFingerprint } from '../../modules/credentials/secret-redaction';

// Distinctive, fixed secrets: no four characters of any occur in a
// response by chance, so a window found there was leaked.
const SECRETS = {
  apiKey: 'sk-proj-QUOKKAalpha7731zeta',
  snakeToken: 'xoxb-PLATYPUS-bravo-5521',
  password: 'Wombat!charlie#4410',
  // Joined at run time so secret scanners do not read a fixture as a token.
  headerValue: ['Bearer', 'NUMBAT-delta-9906'].join(' '),
  mapHeader: 'Basic KOALA-echo-3317',
  listHeader: 'ECHIDNA-foxtrot-2284',
  nestedSecret: 'DINGO-golf-6650-kilo',
  privateKey: '-----BEGIN PRIVATE KEY-----\nWALLABY-hotel-1123\n-----END PRIVATE KEY-----',
  shortSecret: 'Qx9!',
  listed: 'BILBY-india-8842',
  xApiKey: 'CASSOWARY-juliet-0071',
};

/** Config with a secret in every place one has been stored. */
function storedConfig(): Record<string, any> {
  return {
    apiKey: SECRETS.apiKey,
    bot_token: SECRETS.snakeToken,
    password: SECRETS.password,
    headerValue: SECRETS.headerValue,
    headers: { Authorization: SECRETS.mapHeader, 'Content-Type': 'application/json' },
    extraHeaders: [{ name: 'X-Signature', value: SECRETS.listHeader }],
    oauth: { clientSecret: SECRETS.nestedSecret, tokenUrl: 'https://auth.example.com/token' },
    private_key: SECRETS.privateKey,
    secret: SECRETS.shortSecret,
    refreshTokens: [SECRETS.listed],
    'x-api-key': SECRETS.xApiKey,
    username: 'service-user',
    baseUrl: 'https://api.example.com',
  };
}

/** Every 4-character run of every secret found in `response`. */
function leaks(response: unknown): string[] {
  const text = JSON.stringify(response);
  const found: string[] = [];
  for (const secret of Object.values(SECRETS)) {
    for (let i = 0; i + 4 <= secret.length; i++) {
      const window = secret.slice(i, i + 4);
      if (/^[-\s]+$|-----|BEGI|PRIV|RIVA|IVAT|VATE|KEY-|END |EGIN/.test(window)) continue; // PEM framing, not the key
      if (text.includes(window)) found.push(window);
    }
  }
  return found;
}

const envelope = { encryptForOrg: async (_org: string, plain: string) => `encrypted:gcm:00:00:${Buffer.from(plain).toString('hex')}` };

function row(id: string, config = storedConfig()): Credential {
  return Object.assign(new Credential(), { id, name: id, type: 'api_key', organizationId: 'org-1', visibility: 'org', config });
}

function vaultService(rows: Credential[]): CredentialsService {
  const qb = { orderBy: () => qb, getMany: async () => rows };
  const repo: any = {
    createQueryBuilder: () => qb,
    findOne: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
    create: (data: any) => Object.assign(new Credential(), data),
    save: async (r: any) => r,
  };
  const providers: any = { createQueryBuilder: () => ({ getMany: async () => [{ id: 'p1', name: 'OpenAI', type: 'openai', status: 'active', configuration: { apiKey: SECRETS.apiKey } }] }) };
  const accessPolicy: any = { applyListFilter: async () => undefined, assertCanScopeToTeam: async () => undefined };
  const audit: any = { log: () => undefined };
  const none: any = {};
  return new CredentialsService(repo, none, providers, none, none, none, audit, accessPolicy, envelope as any);
}

function apiCredentialService(rows: Credential[]): CredentialService {
  const repo: any = {
    find: async () => rows,
    findOne: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
    create: (data: any) => Object.assign(new Credential(), data),
    save: async (r: any) => r,
  };
  const apis: any = { findOne: async () => ({ id: 'api-1', organizationId: 'org-1' }) };
  return new CredentialService(repo, apis, envelope as any);
}

describe('credential responses carry no part of a secret', () => {
  it('redactSecrets shows each secret only as present and keeps what is not one', () => {
    const out = redactSecrets(storedConfig());
    expect(leaks(out)).toEqual([]);
    expect(out).toMatchObject({
      apiKey: SECRET_PRESENT,
      bot_token: SECRET_PRESENT,
      secret: SECRET_PRESENT,
      headers: { Authorization: SECRET_PRESENT },
      extraHeaders: [{ name: 'X-Signature', value: SECRET_PRESENT }],
      oauth: { clientSecret: SECRET_PRESENT, tokenUrl: 'https://auth.example.com/token' },
      refreshTokens: [SECRET_PRESENT],
      username: 'service-user',
      baseUrl: 'https://api.example.com',
    });
    // Pointers to a secret are not secrets.
    expect(redactSecrets({ keyName: 'X-API-Key', keyLocation: 'header', credentialId: 'c1', tokenEndpoint: 'https://t' }))
      .toEqual({ keyName: 'X-API-Key', keyLocation: 'header', credentialId: 'c1', tokenEndpoint: 'https://t' });
  });

  it('the vault list, read, create and update', async () => {
    const service = vaultService([row('c1'), row('c2', { token: SECRETS.apiKey })]);
    expect(leaks(await service.findAll({ id: 'u1' }, 'org-1'))).toEqual([]);
    expect(leaks(await service.findById('c1', 'org-1'))).toEqual([]);
    expect(leaks(await service.create({ name: 'n', type: 'api_key', config: storedConfig() }, 'org-1'))).toEqual([]);
    expect(leaks(await service.update('c2', { config: storedConfig() }, 'org-1'))).toEqual([]);
  });

  it("an API's credentials: list, create and update", async () => {
    const service = apiCredentialService([row('c1')]);
    expect(leaks(await service.getCredentials('api-1', 'org-1'))).toEqual([]);
    expect(leaks(await service.createCredential('api-1', 'org-1', { name: 'n', type: 'api_key' as any, config: storedConfig() }))).toEqual([]);
    expect(leaks(await service.updateCredential('c1', 'org-1', { config: storedConfig() }))).toEqual([]);
  });

  it('a fingerprint is not made of the secret', () => {
    const fp = secretFingerprint(SECRETS.apiKey);
    expect(fp).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(leaks(fp)).toEqual([]);
  });

  it('every credential masker goes through redactSecrets', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const src = fs.readFileSync(full, 'utf8');
          const masker = /private\s+mask\w*Credential\w*\s*\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/g;
          for (const m of src.matchAll(masker)) {
            if (!m[1].includes('redactSecrets(')) offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
