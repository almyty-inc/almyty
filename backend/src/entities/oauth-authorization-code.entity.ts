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

@Entity('oauth_authorization_codes')
@Index(['codeHash'], { unique: true })
@Index(['clientId'])
@Index(['expiresAt'])
export class OAuthAuthorizationCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  codeHash: string; // SHA-256 hash of the authorization code

  @Column()
  clientId: string;

  @Column({ nullable: true })
  userId: string;

  @Column()
  gatewayId: string;

  @Column()
  organizationId: string;

  @Column()
  redirectUri: string;

  @Column({ nullable: true })
  scope: string;

  @Column()
  codeChallenge: string; // PKCE

  @Column({ default: 'S256' })
  codeChallengeMethod: string;

  @Column({ nullable: true })
  resource: string; // RFC 8707

  @Column({ nullable: true })
  state: string;

  @Column()
  expiresAt: Date;

  @Column({ default: false })
  isUsed: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => OAuthClient, client => client.authorizationCodes, {
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

  // Methods
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  isValid(): boolean {
    return !this.isUsed && !this.isExpired();
  }

  markUsed(): void {
    this.isUsed = true;
  }
}
