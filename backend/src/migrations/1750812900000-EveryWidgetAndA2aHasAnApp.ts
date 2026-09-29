import { MigrationInterface, QueryRunner } from 'typeorm';

import { widgetBranding, wrapUnownedPlaces } from './support/app-places/wrap-unowned-places';

/** The gateway types this migration wraps, frozen as they were when it was written. */
const WIDGET_AND_A2A_TYPES: readonly string[] = Object.freeze(['chat_widget', 'a2a']);
/**
 * The website widget and A2A are places on an app too.
 *
 * A chat widget on someone's website and an agent other agents call over
 * A2A are both an agent put in front of someone, so each is now a place
 * on an app ("On your website", "Other agents (A2A)") and made only by
 * publishing that place. A widget or A2A gateway no place points at is
 * wrapped in one here, the way EveryChatSurfaceHasAnApp1750812800000
 * wrapped web chats and channels (wrapUnownedPlaces), with two
 * differences:
 *
 * - It joins the agent's app when the organization has one (the agent is
 *   its default) that does not have that place yet, so an agent's web
 *   chat, Slack and widget end up on one app rather than two.
 * - An app made for a widget takes the widget's look (colour, title,
 *   greeting, theme) as its branding: an app-owned widget reads its look
 *   from the app.
 *
 * Each gateway keeps its address, its keys and its sign-in methods: the
 * place points at it rather than replacing it. `down()` leaves the apps
 * in place.
 */
export class EveryWidgetAndA2aHasAnApp1750812900000 implements MigrationInterface {
  name = 'EveryWidgetAndA2aHasAnApp1750812900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await wrapUnownedPlaces(queryRunner, WIDGET_AND_A2A_TYPES, {
      joinAgentApps: true,
      brandingFor: widgetBranding,
    });
  }

  public async down(): Promise<void> {
    // The apps stay: they are ordinary apps now, and removing them would
    // leave their places owned by nothing again.
  }
}
