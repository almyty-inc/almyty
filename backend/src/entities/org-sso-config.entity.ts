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

/**
 * Per-organization Single Sign-On (SSO) + SCIM configuration. This is an
 * enterprise (EE) feature — every route that reads or writes it is gated by
 * `@RequiresEntitlement('sso')`, so the entity is inert in the community build.
 *
 * Secrets (`oidcClientSecret`, the SCIM bearer token) are encrypted at the
 * service layer with the shared `field-crypto` AES-256-GCM helper — the same
 * scheme the Credential entity and LLM-provider configs use, so a single
 * `ENCRYPTION_KEY` covers all of them. Public IdP metadata (SAML entry point,
 * signing certificate, OIDC issuer URL / client id) is stored in the clear.
 *
 * The SCIM token is additionally stored as a deterministic SHA-256 lookup hash
 * so an inbound `Authorization: Bearer <token>` can be resolved to an org in a
 * single indexed query (the encrypted copy exists only so the admin UI can
 * re-display / copy the token).
 */
export type SsoProtocol = 'saml' | 'oidc';

@Entity('org_sso_configs')
export class OrgSsoConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** One config per organization. */
  @Index({ unique: true })
  @Column()
  organizationId: string;

  /** Which protocol the org authenticates with. */
  @Column({ type: 'varchar', default: 'saml' })
  protocol: SsoProtocol;

  /** SSO login is only offered when enabled. */
  @Column({ default: false })
  enabled: boolean;

  /**
   * Just-in-time provisioning. When true, a successful assertion for an email
   * with no existing member creates the user + membership on the fly. When
   * false, the login is rejected unless the user was already provisioned
   * (e.g. via SCIM or a manual invite).
   */
  @Column({ default: false })
  jitProvisioning: boolean;

  /** Org role assigned to JIT- and SCIM-provisioned users. */
  @Column({ type: 'varchar', default: 'member' })
  defaultRole: string;

  // ── SAML (all public IdP metadata) ──────────────────────────────────
  /** IdP SSO URL the browser is redirected to (SP-initiated). */
  @Column({ type: 'text', nullable: true })
  samlEntryPoint: string | null;

  /** SP entity id / issuer we present to the IdP. */
  @Column({ type: 'text', nullable: true })
  samlIssuer: string | null;

  /** IdP signing certificate (PEM body) used to verify assertions. */
  @Column({ type: 'text', nullable: true })
  samlCert: string | null;

  // ── OIDC ────────────────────────────────────────────────────────────
  /** OIDC issuer URL used for discovery (`/.well-known/openid-configuration`). */
  @Column({ type: 'text', nullable: true })
  oidcIssuerUrl: string | null;

  @Column({ type: 'text', nullable: true })
  oidcClientId: string | null;

  /** Encrypted (`encrypted:gcm:...`) via field-crypto at the service layer. */
  @Column({ type: 'text', nullable: true })
  oidcClientSecret: string | null;

  @Column({ type: 'text', nullable: true })
  oidcRedirectUri: string | null;

  // ── SCIM 2.0 provisioning ───────────────────────────────────────────
  @Column({ default: false })
  scimEnabled: boolean;

  /** Deterministic SHA-256 of the bearer token — indexed for O(1) lookup. */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  scimTokenHash: string | null;

  /** Encrypted copy of the token so the admin UI can re-display / copy it. */
  @Column({ type: 'text', nullable: true })
  scimTokenEncrypted: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
