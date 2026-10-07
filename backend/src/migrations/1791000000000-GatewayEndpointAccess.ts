import { MigrationInterface, QueryRunner } from 'typeorm';
export class GatewayEndpointAccess1791000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agents ADD COLUMN "apiGatewayId" uuid NULL REFERENCES gateways(id) ON DELETE SET NULL, ADD COLUMN "apiAccessScope" varchar(24) NOT NULL DEFAULT 'org', ADD COLUMN "apiAccessTeamId" uuid NULL`);
    await q.query(`ALTER TABLE agents ADD CONSTRAINT agent_api_access CHECK (("apiAccessScope"='team' AND "apiAccessTeamId" IS NOT NULL) OR ("apiAccessScope" IN ('private','org','external_open','external_protected') AND "apiAccessTeamId" IS NULL))`);
    await q.query(`ALTER TABLE gateways ADD COLUMN "accessScope" varchar(24) NOT NULL DEFAULT 'org', ADD COLUMN "accessTeamId" uuid NULL`);
    await q.query(`UPDATE gateways SET "accessScope" = CASE WHEN visibility IN ('private','team') THEN visibility WHEN EXISTS (SELECT 1 FROM gateway_auth a WHERE a."gatewayId"=gateways.id AND a."isActive"=true AND a.type='none') THEN 'external_open' ELSE 'external_protected' END, "accessTeamId" = CASE WHEN visibility='team' THEN "teamId" ELSE NULL END`);
    await q.query(`ALTER TABLE oauth_authorization_codes ADD COLUMN "companyGrant" json NULL`);
    await q.query(`ALTER TABLE oauth_access_tokens ADD COLUMN "companyGrant" json NULL`);
    await q.query(`CREATE UNIQUE INDEX gateway_active_auth_type ON gateway_auth ("gatewayId", type) WHERE "isActive"=true`);
    await q.query(`ALTER TABLE gateways ADD CONSTRAINT gateway_endpoint_access CHECK (("accessScope"='team' AND "accessTeamId" IS NOT NULL) OR ("accessScope" IN ('private','org','external_open','external_protected') AND "accessTeamId" IS NULL))`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agents DROP CONSTRAINT agent_api_access, DROP COLUMN "apiGatewayId", DROP COLUMN "apiAccessScope", DROP COLUMN "apiAccessTeamId"`);
    await q.query(`DROP INDEX gateway_active_auth_type`);
    await q.query(`ALTER TABLE oauth_authorization_codes DROP COLUMN "companyGrant"`);
    await q.query(`ALTER TABLE oauth_access_tokens DROP COLUMN "companyGrant"`);
    await q.query(`ALTER TABLE gateways DROP CONSTRAINT gateway_endpoint_access, DROP COLUMN "accessTeamId", DROP COLUMN "accessScope"`);
  }
}
