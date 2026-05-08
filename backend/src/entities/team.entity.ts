import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { UserTeam } from './user-team.entity';

@Entity('teams')
export class Team {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  organizationId: string;

  @Column({ default: true })
  isActive: boolean;

  /**
   * Marks the org's "Everyone" team. Every org has exactly one default
   * team (enforced by partial unique index in 1745330000000 migration).
   * Every member of the org is automatically a member of this team.
   * It cannot be deleted via the standard team-delete flow.
   */
  @Column({ default: false })
  isDefault: boolean;

  @Column({ type: 'json', nullable: true })
  settings: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, org => org.teams, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => UserTeam, userTeam => userTeam.team)
  members: UserTeam[];
}