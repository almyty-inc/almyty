import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * EE (advanced_rbac): binds a {@link CustomRole} to a user within an
 * organization. A user may hold several custom roles at once; the
 * effective grant set is the union of every assigned role's permissions
 * (plus whatever the built-in org role already implies).
 */
@Entity('custom_role_assignments')
@Index(['organizationId', 'userId'])
@Index(['customRoleId', 'userId'], { unique: true })
export class CustomRoleAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  customRoleId: string;

  @Column({ type: 'uuid', nullable: true })
  assignedBy: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
