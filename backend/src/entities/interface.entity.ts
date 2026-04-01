import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Agent } from './agent.entity';
import { Organization } from './organization.entity';

export enum InterfaceType {
  CHAT_WIDGET = 'chat_widget',
  SLACK = 'slack',
  WHATSAPP = 'whatsapp',
  DISCORD = 'discord',
  EMAIL = 'email',
  TELEGRAM = 'telegram',
  WEBHOOK = 'webhook',
  GOOGLE_CHAT = 'google_chat',
  MICROSOFT_TEAMS = 'microsoft_teams',
  SIGNAL = 'signal',
  MATRIX = 'matrix',
  IRC = 'irc',
}

export enum InterfaceStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

@Entity('interfaces')
@Index(['agentId'])
@Index(['organizationId'])
export class AgentInterface {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  agentId: string;

  @Column()
  organizationId: string;

  @Column({ type: 'varchar' })
  type: InterfaceType;

  @Column()
  name: string;

  @Column({ type: 'varchar', default: InterfaceStatus.INACTIVE })
  status: InterfaceStatus;

  @Column({ type: 'json', default: {} })
  configuration: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: 0 })
  totalMessages: number;

  @Column({ nullable: true })
  lastMessageAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agentId' })
  agent: Agent;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  isActive(): boolean {
    return this.status === InterfaceStatus.ACTIVE;
  }
}
