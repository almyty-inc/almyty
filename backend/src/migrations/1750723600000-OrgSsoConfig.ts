import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SSO/SAML/OIDC + SCIM (P4, first EE feature). Per-org identity-provider
 * settings and the SCIM bearer-token lookup hash. Secrets in this table
 * (oidcClientSecret, scimTokenEncrypted) are AES-256-GCM encrypted by the
 * service layer; the plaintext never reaches the DB.
 */
export class OrgSsoConfig1750723600000 implements MigrationInterface {
  name = 'OrgSsoConfig1750723600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS org_sso_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "protocol" VARCHAR NOT NULL DEFAULT 'saml',
        "enabled" BOOLEAN NOT NULL DEFAULT false,
        "jitProvisioning" BOOLEAN NOT NULL DEFAULT false,
        "defaultRole" VARCHAR NOT NULL DEFAULT 'member',
        "samlEntryPoint" TEXT,
        "samlIssuer" TEXT,
        "samlCert" TEXT,
        "oidcIssuerUrl" TEXT,
        "oidcClientId" TEXT,
        "oidcClientSecret" TEXT,
        "oidcRedirectUri" TEXT,
        "scimEnabled" BOOLEAN NOT NULL DEFAULT false,
        "scimTokenHash" VARCHAR,
        "scimTokenEncrypted" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX org_sso_configs_org_uidx ON org_sso_configs ("organizationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX org_sso_configs_scim_token_idx ON org_sso_configs ("scimTokenHash")`,
    );
    await queryRunner.query(`
      ALTER TABLE org_sso_configs
      ADD CONSTRAINT org_sso_configs_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS org_sso_configs CASCADE`);
  }
}
