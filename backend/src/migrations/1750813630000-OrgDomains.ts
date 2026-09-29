import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email domains an organization has proven it controls (DNS TXT), which
 * SSO provisioning is limited to. See entities/org-domain.entity.ts.
 */
export class OrgDomains1750813630000 implements MigrationInterface {
  name = 'OrgDomains1750813630000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "org_domains" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "domain" character varying(253) NOT NULL,
        "verificationToken" character varying(64) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "verifiedAt" TIMESTAMP WITH TIME ZONE,
        "lastCheckedAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_org_domains_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_org_domains_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_org_domains_org_domain" ON "org_domains" ("organizationId", "domain")`);
    // A verified domain belongs to one organization.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_org_domains_verified_domain" ON "org_domains" ("domain") WHERE "status" = 'verified'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "org_domains"`);
  }
}
