import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A quorum that cannot lose an approver.
 *
 * The approvals collected for a policy-governed request lived in a JSONB
 * accumulator on the request row, and every reviewer read the list,
 * appended itself and wrote the whole list back. On a 3-of-N gate
 * holding [A], reviewer B wrote [A,B]; reviewer C, who had loaded
 * before B committed, wrote [A,C] over it and B's approval was gone.
 * Either the quorum never completed and a properly approved request
 * expired denied, or the erased approver dropped out of the
 * "already approved" guard and one human could be counted twice —
 * a 3-of-3 satisfied by two people. The status flip next to it was
 * already compare-and-swap guarded; the accumulator was not.
 *
 * One row per approval, unique on (requestId, approverId): an approval
 * is an INSERT that cannot overwrite anyone, and a repeat approval from
 * the same person is refused by the index rather than by a list lookup
 * that a lost update can defeat.
 */
export class ApprovalPolicyApprovals1750800000000 implements MigrationInterface {
  name = 'ApprovalPolicyApprovals1750800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS approval_policy_approvals (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "requestId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "approverId" uuid NOT NULL,
        "roles" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_approval_policy_approvals" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_approval_policy_approvals_request_approver"
      ON approval_policy_approvals ("requestId", "approverId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_approval_policy_approvals_request_created"
      ON approval_policy_approvals ("requestId", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_approval_policy_approvals_request_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_approval_policy_approvals_request_approver"`);
    await queryRunner.query(`DROP TABLE IF EXISTS approval_policy_approvals`);
  }
}
