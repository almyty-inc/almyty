import { MigrationInterface, QueryRunner } from 'typeorm';

import { toolClass } from '../modules/tools/tool-side-effect';
import { computeToolHash, computeToolHashWithoutClass } from '../common/security/tool-integrity';

/**
 * Every tool's side-effect class (docs/design/code-mode.md, part A):
 * `sideEffect` (read, write, destructive), `openWorld`, and
 * `sideEffectSource` (override, annotation, http_method, graphql, default).
 *
 * The columns are added with the safe defaults, then every tool is
 * classified with the same function the entity hook uses on every write
 * (modules/tools/tool-side-effect.ts), so a backfilled row and a freshly
 * saved one agree:
 *  - a generated GraphQL tool's operation type is copied from `operations`
 *    into `metadata.sourceOperation.type`, which is where the classifier
 *    reads it from (new imports write it there themselves);
 *  - an older `metadata.sideEffect` override becomes source `override`.
 *
 * The class is part of the integrity hash now. A tool whose stored hash
 * still matches its definition without the class is re-stamped; one that
 * does not (it was already refused at execution) is left refused.
 */
export class ToolSideEffectClass1750813799000 implements MigrationInterface {
  name = 'ToolSideEffectClass1750813799000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "sideEffect" varchar(16) NOT NULL DEFAULT 'write'`);
    await queryRunner.query(`ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "openWorld" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "sideEffectSource" varchar(16) NOT NULL DEFAULT 'default'`);
    await queryRunner.query(
      `ALTER TABLE "tools" ADD CONSTRAINT "CHK_tools_side_effect" CHECK ("sideEffect" IN ('read', 'write', 'destructive'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "tools" ADD CONSTRAINT "CHK_tools_side_effect_source" CHECK ("sideEffectSource" IN ('override', 'annotation', 'http_method', 'graphql', 'default'))`,
    );

    const BATCH = 500;
    for (let offset = 0; ; offset += BATCH) {
      const rows: any[] = await queryRunner.query(
        `SELECT t."id", t."name", t."description", t."parameters", t."code", t."executionMethod", t."metadata",
                t."configuration", t."httpConfig", t."graphqlConfig", t."llmConfig", t."definitionHash",
                o."type" AS "operationType"
           FROM "tools" t
           LEFT JOIN "operations" o ON o."id" = t."operationId"
          ORDER BY t."id"
          LIMIT $1 OFFSET $2`,
        [BATCH, offset],
      );
      if (!rows.length) break;
      for (const row of rows) {
        let metadata = row.metadata ?? null;
        if (metadata?.sourceOperation && !metadata.sourceOperation.type && row.operationType) {
          metadata = { ...metadata, sourceOperation: { ...metadata.sourceOperation, type: row.operationType } };
        }
        const tool = { ...row, metadata };
        const cls = toolClass(tool);
        const hash = row.definitionHash && computeToolHashWithoutClass(tool) === row.definitionHash
          ? computeToolHash(tool).hash
          : row.definitionHash;
        await queryRunner.query(
          `UPDATE "tools" SET "sideEffect" = $2, "openWorld" = $3, "sideEffectSource" = $4, "metadata" = $5::json, "definitionHash" = $6 WHERE "id" = $1`,
          [row.id, cls.sideEffect, cls.openWorld, cls.sideEffectSource, metadata === null ? null : JSON.stringify(metadata), hash],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Hashes re-stamped with the class stay as they are: without the class
    // they no longer verify, the same as before this migration for any tool
    // edited since. Re-stamp from the definitions if that matters.
    await queryRunner.query(`ALTER TABLE "tools" DROP CONSTRAINT IF EXISTS "CHK_tools_side_effect_source"`);
    await queryRunner.query(`ALTER TABLE "tools" DROP CONSTRAINT IF EXISTS "CHK_tools_side_effect"`);
    await queryRunner.query(`ALTER TABLE "tools" DROP COLUMN IF EXISTS "sideEffectSource"`);
    await queryRunner.query(`ALTER TABLE "tools" DROP COLUMN IF EXISTS "openWorld"`);
    await queryRunner.query(`ALTER TABLE "tools" DROP COLUMN IF EXISTS "sideEffect"`);
  }
}
