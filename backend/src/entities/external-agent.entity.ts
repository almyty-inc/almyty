import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Organization } from './organization.entity';
import { Credential } from './credential.entity';

@Entity('external_agents')
@Index(['organizationId'])
export class ExternalAgent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text' })
  agentCardUrl: string;

  @Column({ type: 'json', nullable: true })
  cachedCard: Record<string, any>;

  @Column({ nullable: true })
  cardLastFetchedAt: Date;

  @Column({ type: 'text', nullable: true })
  baseRpcUrl: string;

  @Column({ nullable: true })
  credentialId: string;

  @Column({ type: 'text', nullable: true })
  selectedSecurityScheme: string;

  @Column({ type: 'json', nullable: true })
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };

  @Column({ type: 'text', default: 'active' })
  status: 'active' | 'error' | 'card_stale';

  @Column({ nullable: true })
  lastHealthCheckAt: Date;

  @Column({ default: 0 })
  totalRequests: number;

  @Column({ default: 0 })
  successfulRequests: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => Credential, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'credentialId' })
  credential: Credential;
}
