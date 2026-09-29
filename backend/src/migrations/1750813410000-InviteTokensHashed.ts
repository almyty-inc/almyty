import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invite tokens are stored as their SHA-256 (hashInviteToken in
 * organizations-invites.helper.ts): in `user_organizations.inviteToken`
 * and in each `organizations.settings.pendingInvites[].inviteToken`.
 * Any pending invite already in the table is hashed in place, so no
 * usable token stays at rest and every mailed link keeps working.
 */
export class InviteTokensHashed1750813410000 implements MigrationInterface {
  name = 'InviteTokensHashed1750813410000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "user_organizations"
         SET "inviteToken" = encode(sha256(convert_to("inviteToken", 'UTF8')), 'hex')
       WHERE "inviteToken" IS NOT NULL
    `);
    await queryRunner.query(`
      UPDATE "organizations"
         SET "settings" = jsonb_set(
           "settings",
           '{pendingInvites}',
           (SELECT COALESCE(jsonb_agg(
                     CASE WHEN invite ? 'inviteToken'
                          THEN jsonb_set(invite, '{inviteToken}',
                                 to_jsonb(encode(sha256(convert_to(invite->>'inviteToken', 'UTF8')), 'hex')))
                          ELSE invite END), '[]'::jsonb)
              FROM jsonb_array_elements("settings"->'pendingInvites') AS invite)
         )
       WHERE jsonb_typeof("settings"->'pendingInvites') = 'array'
         AND jsonb_array_length("settings"->'pendingInvites') > 0
    `);
  }

  public async down(): Promise<void> {
    // A hash cannot be turned back into the token it was made from.
  }
}
