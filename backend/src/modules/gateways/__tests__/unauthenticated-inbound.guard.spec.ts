import { readFileSync } from 'fs';
import { join } from 'path';

import { GatewayType } from '../../../entities/gateway.entity';
import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';

import { BaseAdapter } from '../channels/adapters/base.adapter';
import { ChatWidgetAdapter } from '../channels/adapters/chat-widget.adapter';
import { SlackAdapter } from '../channels/adapters/slack.adapter';
import { DiscordAdapter } from '../channels/adapters/discord.adapter';
import { TelegramAdapter } from '../channels/adapters/telegram.adapter';
import { WhatsAppAdapter } from '../channels/adapters/whatsapp.adapter';
import { WhatsAppCloudAdapter } from '../channels/adapters/whatsapp-cloud.adapter';
import { SmsAdapter } from '../channels/adapters/sms.adapter';
import { EmailAdapter } from '../channels/adapters/email.adapter';
import { WebhookAdapter } from '../channels/adapters/webhook.adapter';
import { GoogleChatAdapter } from '../channels/adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../channels/adapters/microsoft-teams.adapter';
import { SignalAdapter } from '../channels/adapters/signal.adapter';
import { MatrixAdapter } from '../channels/adapters/matrix.adapter';
import { IrcAdapter } from '../channels/adapters/irc.adapter';

/**
 * The invariant that governs every unauthenticated inbound surface.
 *
 * `CHANNEL_TYPES` membership SKIPS almyty API-key authentication on
 * `/:orgSlug/:resourceSlug` (UnifiedEndpointController carries no
 * guard, and the only APP_GUARD in the tree is the throttler). The sole
 * remaining control on those requests is `adapter.verifyWebhook`. An
 * adapter that sets `inboundIsUnauthenticatedByDesign` inherits
 * BaseAdapter's default, which returns that flag — so for such an
 * adapter `verifyWebhook` returns TRUE for anyone.
 *
 *   unauthenticated-by-design  ∩  CHANNEL_TYPES  =  ∅
 *
 * Discord violated this. Its adapter is unauthenticated-by-design
 * because its real inbound is the authenticated gateway websocket, and
 * its comment asserted "there is no untrusted HTTP entry point" — but
 * `GatewayType.DISCORD` was in `CHANNEL_TYPES`, so there was one, and
 * an unsigned POST started an agent run in the victim's organization
 * with the attacker choosing the prompt and, through `channel_id`,
 * where the reply was delivered.
 *
 * This is deliberately a structural test rather than a behavioural one.
 * A behavioural test passes against an unwired check: it can only
 * observe that some request was refused, not that the adapter set and
 * the route set still agree. These assertions read the two sets
 * themselves, plus the source of every adapter, so the next adapter
 * added to either side has to satisfy the invariant to land.
 */
describe('unauthenticated inbound surfaces', () => {
  /** Every adapter the channel layer can dispatch to, by gateway type. */
  const adapters: ReadonlyArray<[GatewayType, BaseAdapter]> = [
    [GatewayType.CHAT_WIDGET, new ChatWidgetAdapter({} as any)],
    [GatewayType.SLACK, new SlackAdapter()],
    [GatewayType.DISCORD, new DiscordAdapter()],
    [GatewayType.TELEGRAM, new TelegramAdapter()],
    [GatewayType.WHATSAPP, new WhatsAppAdapter()],
    [GatewayType.WHATSAPP_CLOUD, new WhatsAppCloudAdapter()],
    [GatewayType.SMS, new SmsAdapter()],
    [GatewayType.EMAIL, new EmailAdapter()],
    [GatewayType.WEBHOOK, new WebhookAdapter()],
    [GatewayType.GOOGLE_CHAT, new GoogleChatAdapter()],
    [GatewayType.MICROSOFT_TEAMS, new MicrosoftTeamsAdapter()],
    [GatewayType.SIGNAL, new SignalAdapter()],
    [GatewayType.MATRIX, new MatrixAdapter()],
    [GatewayType.IRC, new IrcAdapter()],
  ];

  /** The protected flag, read off the instance. */
  const unauthenticatedByDesign = (adapter: BaseAdapter): boolean =>
    (adapter as any).inboundIsUnauthenticatedByDesign === true;

  it('never routes an unauthenticated-by-design adapter through the unsigned channel path', () => {
    const offenders = adapters
      .filter(([type, adapter]) => unauthenticatedByDesign(adapter) && UnifiedGatewayDelegation.CHANNEL_TYPES.has(type))
      .map(([type]) => type);

    expect(offenders).toEqual([]);
  });

  it('keeps the set of unauthenticated-by-design adapters to the two that earned it', () => {
    // A third one appearing is the thing to notice. Both of these reach
    // the pipeline only through a path that authenticates elsewhere:
    // discord through its gateway websocket, the widget through its own
    // rate-limited controller.
    const byDesign = adapters.filter(([, a]) => unauthenticatedByDesign(a)).map(([type]) => type).sort();

    expect(byDesign).toEqual([GatewayType.CHAT_WIDGET, GatewayType.DISCORD].sort());
  });

  it('gives every adapter on the unsigned channel path a verifyWebhook of its own', () => {
    // Inheriting BaseAdapter.verifyWebhook on a CHANNEL_TYPES adapter
    // means inheriting `return this.inboundIsUnauthenticatedByDesign`.
    // That is false by default, so it fails closed rather than open —
    // but an adapter reachable over HTTP with no verifier of its own is
    // a surface that can never accept a legitimate delivery, which is
    // its own kind of broken. Require the override explicitly.
    const inherited = adapters
      .filter(([type]) => UnifiedGatewayDelegation.CHANNEL_TYPES.has(type))
      .filter(
        ([, adapter]) =>
          Object.getPrototypeOf(adapter).verifyWebhook === BaseAdapter.prototype.verifyWebhook,
      )
      .map(([type]) => type);

    expect(inherited).toEqual([]);
  });

  it('refuses every CHANNEL_TYPES adapter an inbound request carrying no credential at all', async () => {
    // The property the whole boundary rests on, asserted against the
    // adapters rather than described in a comment: an empty body, empty
    // headers and an empty config must not verify.
    for (const [type, adapter] of adapters) {
      if (!UnifiedGatewayDelegation.CHANNEL_TYPES.has(type)) continue;
      await expect(adapter.verifyWebhook({}, {}, {}, '')).resolves.toBe(false);
    }
  });

  it('states the invariant where the set is defined, so the next editor sees it', () => {
    // Source-reading, on purpose. The set is data; what keeps it
    // correct is that whoever adds a line to it knows what membership
    // costs. If the explanation is deleted, this fails.
    const source = readFileSync(
      join(__dirname, '..', 'unified-gateway-delegation.helper.ts'),
      'utf8',
    );
    expect(source).toContain('inboundIsUnauthenticatedByDesign');
    expect(source).toMatch(/SKIPS?\s+almyty API-key authentication/i);
  });
});
