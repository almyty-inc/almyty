import { SsoConfigService } from '../sso-config.service';
import { OrgSsoConfig } from '../../../../src/entities/org-sso-config.entity';
import { isEncrypted, decryptField } from '../../../../src/common/security/field-crypto';

/**
 * In-memory stand-in for the OrgSsoConfig repository. Supports the subset of
 * TypeORM methods the service uses (create/save/findOne by organizationId or
 * scimTokenHash).
 */
function fakeRepo() {
  const rows: OrgSsoConfig[] = [];
  return {
    rows,
    create: (partial: Partial<OrgSsoConfig>) => ({ ...partial }) as OrgSsoConfig,
    save: jest.fn(async (entity: OrgSsoConfig) => {
      const idx = rows.findIndex((r) => r.organizationId === entity.organizationId);
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], ...entity };
        return rows[idx];
      }
      const saved = { id: `id-${rows.length + 1}`, ...entity } as OrgSsoConfig;
      rows.push(saved);
      return saved;
    }),
    findOne: jest.fn(async ({ where }: any) => {
      if (where.organizationId) {
        return rows.find((r) => r.organizationId === where.organizationId) ?? null;
      }
      if (where.scimTokenHash) {
        return rows.find((r) => r.scimTokenHash === where.scimTokenHash) ?? null;
      }
      return null;
    }),
  };
}

describe('SsoConfigService', () => {
  let repo: ReturnType<typeof fakeRepo>;
  let service: SsoConfigService;

  beforeEach(() => {
    repo = fakeRepo();
    service = new SsoConfigService(repo as any);
  });

  it('encrypts the OIDC client secret at rest and decrypts it on read', async () => {
    await service.upsert('org-1', {
      protocol: 'oidc',
      enabled: true,
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'client-abc',
      oidcClientSecret: 'super-secret-value',
      oidcRedirectUri: 'https://api.example.com/sso/org-1/oidc/callback',
    });

    const stored = await service.get('org-1');
    expect(stored?.oidcClientSecret).toBeTruthy();
    // Stored value must be ciphertext, never the plaintext.
    expect(stored?.oidcClientSecret).not.toBe('super-secret-value');
    expect(isEncrypted(stored!.oidcClientSecret!)).toBe(true);
    expect(decryptField(stored!.oidcClientSecret!)).toBe('super-secret-value');

    const decrypted = await service.getDecrypted('org-1');
    expect(decrypted?.oidcClientSecretPlain).toBe('super-secret-value');
  });

  it('masks secrets in the public view but reports whether they are set', async () => {
    await service.upsert('org-1', {
      protocol: 'oidc',
      oidcClientSecret: 'secret',
    });
    const config = await service.get('org-1');
    const view = service.toPublicView(config, 'https://api.example.com');

    expect(view).not.toHaveProperty('oidcClientSecret');
    expect((view as any).oidcClientSecretSet).toBe(true);
    expect(view.scimBaseUrl).toBe('https://api.example.com/scim/v2');
  });

  it('mints a SCIM token and resolves it back to the org', async () => {
    const { token } = await service.rotateScimToken('org-1');
    expect(token).toMatch(/^scim_[0-9a-f]{64}$/);

    const resolved = await service.findOrgByScimToken(token);
    expect(resolved).toBe('org-1');

    // The plaintext token is never stored — only its hash + an encrypted copy.
    const stored = await service.get('org-1');
    expect(stored?.scimTokenHash).toBe(SsoConfigService.hashToken(token));
    expect(stored?.scimTokenEncrypted).not.toBe(token);
    expect(await service.revealScimToken('org-1')).toBe(token);
  });

  it('rejects an unknown SCIM token', async () => {
    await service.rotateScimToken('org-1');
    expect(await service.findOrgByScimToken('scim_deadbeef')).toBeNull();
    expect(await service.findOrgByScimToken('')).toBeNull();
  });

  it('does not resolve a token when SCIM is disabled for the org', async () => {
    const { token } = await service.rotateScimToken('org-1');
    await service.upsert('org-1', { scimEnabled: false });
    expect(await service.findOrgByScimToken(token)).toBeNull();
  });
});
