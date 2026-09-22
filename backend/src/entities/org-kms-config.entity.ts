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
 * A wrapped DEK the org has rotated away from, kept so values sealed under it
 * remain readable. `keyId` is the identifier carried in those values'
 * ciphertext: the leading bytes of `sha256(wrappedDek)`, hex-encoded. It is a
 * fingerprint of a blob that is already at rest here, not key material.
 */
export interface RetiredDek {
  keyId: string;
  /** base64 KMS `CiphertextBlob` of the retired DEK. */
  wrappedDek: string;
  /** The CMK this DEK is wrapped by — not necessarily the org's current one. */
  cmkArn: string;
  awsRegion: string | null;
  /** ISO timestamp of the rotation that retired this DEK. */
  retiredAt: string;
}

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
  @Column({ type: 'uuid' })
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
   * The org's ACTIVE Data Encryption Key, WRAPPED by the customer's CMK
   * (base64 of the KMS `CiphertextBlob`). Opaque and useless without the CMK.
   * Never stored in plaintext, never logged. Null until a CMK is provisioned.
   *
   * This blob also names the key: the ciphertext of every value sealed with
   * it carries the leading bytes of `sha256(wrappedDek)` as its key id, so
   * the identifier is derived from the blob rather than tracked beside it and
   * the two can never disagree.
   */
  @Column({ type: 'text', nullable: true })
  wrappedDek: string | null;

  /**
   * Every wrapped DEK this org has rotated away from, newest last. A rotation
   * mints a new DEK and moves the outgoing one here in the same row update, so
   * a value sealed under a superseded key is still matched to the key that
   * sealed it (by the key id in its ciphertext) and stays readable.
   *
   * Each entry is the wrapped blob plus the CMK reference needed to unwrap it,
   * which is not always the CMK named above — a rotation may move the org to a
   * different CMK, and the retired DEK is still wrapped by the old one. Like
   * `wrappedDek`, these are ciphertext almyty cannot decrypt on its own.
   *
   * Entries are never removed. Nothing can establish that no secret is still
   * sealed under a given key, so dropping one is unbounded, silent data loss;
   * keeping one costs a few hundred bytes.
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  retiredDeks: RetiredDek[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
