import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * One reviewer's approval of one policy-governed approval request.
 *
 * A quorum has to be counted, and counting it in a JSONB accumulator on
 * the request row means every reviewer reads the list, appends itself
 * and writes the whole list back. On a 3-of-N gate that already held
 * [A], reviewer B wrote [A,B] and reviewer C — who had loaded before B
 * committed — wrote [A,C] over it. B's approval was gone. The quorum
 * then either never completed and a properly approved request expired
 * denied, or the "already approved" guard stopped holding because the
 * erased approver was no longer in the list, so one person could be
 * counted twice and satisfy a 3-of-3 with two humans.
 *
 * One row per approval with a unique (requestId, approverId) makes both
 * outcomes impossible rather than guarded: an approval is an INSERT
 * that cannot overwrite anyone, and a second approval from the same
 * person is refused by the database rather than by a list lookup.
 *
 * `roles` is the set of role names the approver held AT THE MOMENT OF
 * APPROVING, snapshotted rather than re-resolved, so a later role change
 * cannot retroactively satisfy or unsatisfy a step.
 */
@Entity('approval_policy_approvals')
@Index('UQ_approval_policy_approvals_request_approver', ['requestId', 'approverId'], {
  unique: true,
})
@Index(['requestId', 'createdAt'])
export class ApprovalPolicyApprovalRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The approval_requests row this approval counts towards. */
  @Column({ type: 'uuid' })
  requestId: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  approverId: string;

  /** Role names held at approval time; matched against a step's approverRole. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  roles: string[];

  @CreateDateColumn()
  createdAt: Date;
}
