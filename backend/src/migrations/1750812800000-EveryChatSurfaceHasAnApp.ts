import { MigrationInterface, QueryRunner } from 'typeorm';

import { wrapUnownedPlaces } from './support/app-places/wrap-unowned-places';

/**
 * The gateway types this migration wraps, as they were when it was
 * written. Frozen rather than read off APP_SURFACE_GATEWAY_TYPES: a type
 * that becomes a place later has a migration of its own
 * (EveryWidgetAndA2aHasAnApp1750812900000).
 */
const CHAT_SURFACE_TYPES: readonly string[] = Object.freeze([
  'hosted_chat',
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'whatsapp_cloud',
  'sms',
  'email',
  'webhook',
  'google_chat',
  'microsoft_teams',
  'signal',
  'matrix',
  'irc',
]);
/**
 * Every web chat and messaging channel belongs to an app.
 *
 * An app is the one place an agent is put in front of people, and the
 * gateways it stands up are recorded on its places (`gatewayId`). A web
 * chat or a Slack, Discord, Teams, ... gateway that no place points at is
 * wrapped in one here:
 *
 * - One app per agent (per organization), named after the agent, with the
 *   agent as its default. Gateways of the same agent on different
 *   platforms become places of the same app; a second gateway of the
 *   same agent on the same platform gets an app of its own, since an app
 *   ships to a platform once.
 * - The app row is the one `AgentAppsService.create` saves
 *   (`newAppFields`: default limits, empty branding, public link unless a
 *   web chat carried its own sign-in rule). Its slug comes from the name
 *   (`appSlugFromName`), made free against the organization's apps; a
 *   web chat's app keeps the chat's address when it is free, because the
 *   web place is addressed by its app's slug.
 * - The place points at the gateway, is live when the gateway is active,
 *   and carries the gateway's connection reference and non-secret
 *   platform settings (`placeConfigurationFrom`), so republishing from the
 *   app finds everything the gateway answers with.
 * - The gateway's configuration records the app (`appId`), as a publish
 *   writes it.
 *
 * A private agent is not put on an app (an app refuses one); its gateway
 * still gets an app, named after it, with no agent to publish until one
 * is shared. `down()` leaves the apps in place.
 */
export class EveryChatSurfaceHasAnApp1750812800000 implements MigrationInterface {
  name = 'EveryChatSurfaceHasAnApp1750812800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await wrapUnownedPlaces(queryRunner, CHAT_SURFACE_TYPES);
  }

  public async down(): Promise<void> {
    // The apps stay: they are ordinary apps now, and removing them would
    // leave their surfaces owned by nothing again.
  }
}
