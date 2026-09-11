import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Strategies: an execution shape over role slots, as data.
 *
 * `organizationId` is nullable because the built-in shapes belong to
 * nobody: every organization can use them and none can edit them. An
 * organization that wants a variant copies one, which is why the unique
 * index is on the pair rather than on the key alone.
 *
 * Reversible: down drops only what up created.
 */
export class Strategies1750768000000 implements MigrationInterface {
  name = 'Strategies1750768000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "strategies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid,
        "key" character varying(64) NOT NULL,
        "displayName" character varying(128) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "roleSlots" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "shape" jsonb NOT NULL,
        "builtIn" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_strategies" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_strategies_org" ON "strategies" ("organizationId")`);
    // A built-in and an organization's own strategy may share a key; two
    // rows for the same organization may not.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_strategies_org_key" ON "strategies" (COALESCE("organizationId", '00000000-0000-0000-0000-000000000000'::uuid), "key")`,
    );
    await queryRunner.query(`
      ALTER TABLE "strategies"
      ADD CONSTRAINT "FK_strategies_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);

    /**
     * A strategy must never name a concrete model. The application
     * refuses it, and this is the same rule at the storage layer so a
     * direct write cannot smuggle one in. Deliberately narrow: it catches
     * the keys, and the application check catches model-shaped values.
     */
    await queryRunner.query(`
      ALTER TABLE "strategies"
      ADD CONSTRAINT "CHK_strategies_no_model_id"
      CHECK (
        "shape"::text !~* '"(model|modelId|modelName|vendorModelId|providerId|pinnedModel)"[[:space:]]*:'
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "strategies" DROP CONSTRAINT IF EXISTS "CHK_strategies_no_model_id"`);
    await queryRunner.query(`ALTER TABLE "strategies" DROP CONSTRAINT IF EXISTS "FK_strategies_organization"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_strategies_org_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_strategies_org"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "strategies"`);
  }
}
