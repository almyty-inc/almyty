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
 * Per-organization BYO-KMS (customer-managed CMK) configuration.
 *
 * This is an enterprise (EE) feature gated by `@RequiresEntitlement('byo_kms')`.
 * It implements envelope encryption: a random 256-bit Data Encryption Key (DEK)
 * is generated per org, wrapped (encrypted) by the customer's own AWS KMS
 * Customer Master Key (CMK) via KMS `Encrypt`, and only the WRAPPED DEK is
 * stored here (`wrappedDek`). The plaintext DEK never touches the database.
 *
 * On read, the wrapped DEK is unwrapped via KMS `Decrypt` and used as the
 * AES-256-GCM key for field decryption. Orgs WITHOUT a row here (or with
 * `enabled = false`) fall back to the platform-managed `field-crypto` key
 * unchanged — this table is inert for them and for the entire community build.
 *
 * Nothing secret is stored in the clear: `cmkArn` and `awsRegion` are public
 * KMS resource identifiers, and `wrappedDek` is ciphertext that is useless
 * without the customer's CMK (which almyty cannot decrypt on its own).
 */
@Entity('org_kms_configs')
export class OrgKmsConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** One KMS config per organization. */
  @Index({ unique: true })
  @Column()
  organizationId: string;

  /**
   * Whether envelope encryption is actively used for this org. When false the
   * platform-managed key path is used even if a CMK ARN is present — this lets
   * an admin stage a config before cutting over, and lets us disable the KMS
   * path without dropping the row (and its wrapped DEK).
   */
  @Column({ default: false })
  enabled: boolean;

  /** Fully-qualified AWS KMS key ARN of the customer's CMK. Public identifier. */
  @Column({ type: 'text', nullable: true })
  cmkArn: string | null;

  /**
   * AWS region the CMK lives in. Derived from the ARN when omitted; stored
   * explicitly so the KMS client can be constructed without parsing the ARN.
   */
  @Column({ type: 'varchar', nullable: true })
  awsRegion: string | null;

  /**
   * The org's Data Encryption Key, WRAPPED by the customer's CMK (base64 of the
   * KMS `CiphertextBlob`). Opaque and useless without the CMK. Never stored in
   * plaintext, never logged. Null until a CMK is provisioned.
   */
  @Column({ type: 'text', nullable: true })
  wrappedDek: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
