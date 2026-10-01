import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Gateway } from './gateway.entity';
import { Organization } from './organization.entity';
import { OAuthAuthorizationCode } from './oauth-authorization-code.entity';
import { OAuthAccessToken } from './oauth-access-token.entity';

@Entity('oauth_clients')
@Index(['clientId'], { unique: true })
@Index(['organizationId'])
@Index(['gatewayId'])
export class OAuthClient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  clientId: string;

  @Column({ nullable: true })
  clientSecretHash: string; // bcrypt hash, null for public clients

  @Column()
  clientName: string;

  @Column({ nullable: true })
  clientUri: string;

  @Column({ type: 'json' })
  redirectUris: string[];

  @Column({ type: 'json', default: '["authorization_code","refresh_token"]' })
  grantTypes: string[];

  @Column({ type: 'json', default: '["code"]' })
  responseTypes: string[];

  @Column({ nullable: true })
  scope: string;

  @Column({ default: 'none' })
  tokenEndpointAuthMethod: string;

  @Column({ nullable: true })
  gatewayId: string;

  /**
   * Null only on a Client ID Metadata Document client, which no
   * organization owns (CHK_oauth_clients_owner).
   */
  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ default: true })
  isActive: boolean;

  /** OIDC / RFC 7591 application_type: decides which redirect URIs are allowed. */
  @Column({ type: 'varchar', length: 16, default: 'web' })
  applicationType: 'web' | 'native';

  /**
   * A Client ID Metadata Document client: `clientId` is the https URL of
   * its metadata, which the server fetched (and refreshes) instead of the
   * client registering. Valid on every gateway, like the URL itself.
   */
  @Column({ default: false })
  isMetadataDocument: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  metadataFetchedAt: Date | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Gateway, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  @ManyToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => OAuthAuthorizationCode, code => code.client)
  authorizationCodes: OAuthAuthorizationCode[];

  @OneToMany(() => OAuthAccessToken, token => token.client)
  accessTokens: OAuthAccessToken[];

  // Methods
  isPublicClient(): boolean {
    return !this.clientSecretHash;
  }

  supportsGrantType(grantType: string): boolean {
    return this.grantTypes?.includes(grantType) || false;
  }

  supportsResponseType(responseType: string): boolean {
    return this.responseTypes?.includes(responseType) || false;
  }

  isValidRedirectUri(redirectUri: string): boolean {
    return this.redirectUris?.includes(redirectUri) || false;
  }

  hasScope(scope: string): boolean {
    if (!this.scope) return false;
    const allowedScopes = this.scope.split(' ');
    return allowedScopes.includes(scope);
  }
}
