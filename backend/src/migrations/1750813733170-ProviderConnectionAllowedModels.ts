import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provider connections: which models each one may be used for, and one
 * name for the connection and its key.
 *
 * `allowNewModels` defaults to true and both lists to null, which is the
 * default the product wants for every existing row: every model the key
 * reaches stays allowed, and so do models the vendor lists later. Nothing
 * to backfill.
 *
 * A key a provider created for itself (metadata.managedBy.kind =
 * 'llm_provider') was named "<provider> API key". The connection and its
 * key are one thing to a person now, listed under Credentials by the
 * connection's name, so the key takes the provider's name. A shared
 * credential a provider points at keeps its own name.
 *
 * An Ollama connection with no URL now means Ollama Cloud. One saved
 * before meant a local install, so it is given that URL and keeps
 * reaching the same server.
 */
export class ProviderConnectionAllowedModels1750813733170 implements MigrationInterface {
  name = 'ProviderConnectionAllowedModels1750813733170';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "allowNewModels" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "hiddenModels" jsonb`);
    await queryRunner.query(`ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "allowedModels" jsonb`);
    await queryRunner.query(`
      UPDATE "credentials" AS c
         SET "name" = p."name"
        FROM "llm_providers" AS p
       WHERE p."credentialId" = c."id"
         AND (c."metadata"::jsonb -> 'managedBy' ->> 'kind') = 'llm_provider'
         AND (c."metadata"::jsonb -> 'managedBy' ->> 'id') = p."id"::text
         AND c."name" IS DISTINCT FROM p."name"
    `);
    await queryRunner.query(`
      UPDATE "llm_providers"
         SET "configuration" = ("configuration"::jsonb || '{"apiUrl": "http://localhost:11434"}'::jsonb)::json
       WHERE "type" = 'ollama'
         AND COALESCE("configuration"::jsonb ->> 'apiUrl', '') = ''
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "credentials" AS c
         SET "name" = p."name" || ' API key'
        FROM "llm_providers" AS p
       WHERE p."credentialId" = c."id"
         AND (c."metadata"::jsonb -> 'managedBy' ->> 'kind') = 'llm_provider'
         AND (c."metadata"::jsonb -> 'managedBy' ->> 'id') = p."id"::text
         AND c."name" = p."name"
    `);
    await queryRunner.query(`ALTER TABLE "llm_providers" DROP COLUMN IF EXISTS "allowedModels"`);
    await queryRunner.query(`ALTER TABLE "llm_providers" DROP COLUMN IF EXISTS "hiddenModels"`);
    await queryRunner.query(`ALTER TABLE "llm_providers" DROP COLUMN IF EXISTS "allowNewModels"`);
  }
}
