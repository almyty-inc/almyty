import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { OAuthClient } from './oauth-client.entity';
import { User } from './user.entity';
import { Gateway } from './gateway.entity';
import { Organization } from './organization.entity';

@Entity('oauth_access_tokens')
@Index(['tokenHash'], { unique: true })
@Index(['clientId'])
@Index(['userId'])
@Index(['expiresAt'])
export class OAuthAccessToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  tokenHash: string; // SHA-256 hash of the token

  @Column({ type: 'varchar' })
  tokenType: 'access' | 'refresh';

  @Column()
  clientId: string;

  @Column({ nullable: true })
  userId: string;

  @Column()
  gatewayId: string;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  scope: string;

  @Column({ nullable: true })
  resource: string; // RFC 8707

  @Column()
  expiresAt: Date;

  @Column({ default: false })
  isRevoked: boolean;

  @Column({ nullable: true })
  parentTokenId: string; // Self-reference for refresh token chains

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => OAuthClient, client => client.accessTokens, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'clientId', referencedColumnName: 'clientId' })
  client: OAuthClient;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Gateway, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  @ManyToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => OAuthAccessToken, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'parentTokenId' })
  parentToken: OAuthAccessToken;

  // Methods
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  isValid(): boolean {
    return !this.isRevoked && !this.isExpired();
  }

  isAccessToken(): boolean {
    return this.tokenType === 'access';
  }

  isRefreshToken(): boolean {
    return this.tokenType === 'refresh';
  }

  revoke(): void {
    this.isRevoked = true;
  }
}
