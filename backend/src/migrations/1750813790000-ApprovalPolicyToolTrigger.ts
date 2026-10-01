import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An approval policy can ask for approval on its own, at the tool call:
 * "ask before issue_refund when amount is over 500". `trigger` holds that
 * rule (the tool, the numeric argument, the comparison and the amount);
 * null is a policy that only governs requests an agent raises itself.
 *
 * The expression index serves the lookup every tool call makes: the
 * enabled rules for one tool.
 */
export class ApprovalPolicyToolTrigger1750813790000 implements MigrationInterface {
  name = 'ApprovalPolicyToolTrigger1750813790000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "approval_policies" ADD COLUMN IF NOT EXISTS "trigger" jsonb NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_approval_policies_trigger_tool" ON "approval_policies" ("organizationId", ("trigger"->>'toolId')) WHERE "trigger" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_approval_policies_trigger_tool"`);
    await queryRunner.query(`ALTER TABLE "approval_policies" DROP COLUMN IF EXISTS "trigger"`);
  }
}
