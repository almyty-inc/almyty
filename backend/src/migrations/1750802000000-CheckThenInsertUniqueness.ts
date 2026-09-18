import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Real uniqueness behind three more check-then-insert paths. Each one
 * reads for an existing row and inserts when it finds none, with only
 * non-unique indexes underneath — so two writers that read before
 * either wrote both insert.
 *
 * tools: the generator does findByName then create-or-update, and its
 * batch runs the lookups through Promise.all, so even one pass has
 * concurrent readers; a re-run of POST /apis/:id/generate-tools can
 * also overlap a schema import's tool-gen phase. Two tools sharing
 * (organizationId, name) make gateway and skill resolution by name
 * pick an arbitrary one and an edit touch only one copy. Partial on
 * status: deletion is soft (status = 'deleted'), and a deleted row
 * must not reserve its name forever.
 *
 * models: `register` falls back to (organizationId, name) when the
 * card has no provider, but models_org_provider_vendor_uq is on
 * (organizationId, providerId, vendorModelId) and Postgres treats
 * NULLs as distinct — so endpoint-only cards were unconstrained.
 *
 * approval_requests: `create` is idempotent on (runId, toolCallId) by
 * a read, with the EE policy-resolution hook holding the window open
 * between that read and the insert. A redelivered next-step job gave
 * two gates and two notifications for one tool call.
 */
export class CheckThenInsertUniqueness1750802000000 implements MigrationInterface {
  name = 'CheckThenInsertUniqueness1750802000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fold duplicates already written, keeping the oldest row in each
    // group so anything referencing it by id still resolves. Losers
    // are retired rather than deleted where rows are pointed at from
    // elsewhere.
    await queryRunner.query(`
      UPDATE tools a
         SET status = 'deleted'
       WHERE a.status <> 'deleted'
         AND EXISTS (
           SELECT 1 FROM tools b
            WHERE b."organizationId" = a."organizationId"
              AND b.name = a.name
              AND b.status <> 'deleted'
              AND (b."createdAt" < a."createdAt"
                   OR (b."createdAt" = a."createdAt" AND b.id < a.id))
         )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tools_org_name_uq
      ON tools ("organizationId", name)
      WHERE status <> 'deleted'
    `);

    await queryRunner.query(`
      DELETE FROM models a
       USING models b
       WHERE a."providerId" IS NULL
         AND b."providerId" IS NULL
         AND a."organizationId" = b."organizationId"
         AND a.name = b.name
         AND (a."createdAt" > b."createdAt"
              OR (a."createdAt" = b."createdAt" AND a.id > b.id))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS models_org_name_endpoint_uq
      ON models ("organizationId", name)
      WHERE "providerId" IS NULL
    `);

    await queryRunner.query(`
      DELETE FROM approval_requests a
       USING approval_requests b
       WHERE a."toolCallId" IS NOT NULL
         AND b."toolCallId" IS NOT NULL
         AND a."runId" = b."runId"
         AND a."toolCallId" = b."toolCallId"
         AND (a."createdAt" > b."createdAt"
              OR (a."createdAt" = b."createdAt" AND a.id > b.id))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_run_toolcall_uq
      ON approval_requests ("runId", "toolCallId")
      WHERE "toolCallId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS approval_requests_run_toolcall_uq`);
    await queryRunner.query(`DROP INDEX IF EXISTS models_org_name_endpoint_uq`);
    await queryRunner.query(`DROP INDEX IF EXISTS tools_org_name_uq`);
  }
}
