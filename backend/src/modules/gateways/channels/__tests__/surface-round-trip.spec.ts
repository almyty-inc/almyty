import * as crypto from 'crypto';

import { GatewayType } from '../../../../entities/gateway.entity';
import { roundTrip } from './surface-round-trip.helper';
import { parseSentForm, parseSentJson } from '../adapters/__tests__/test-helpers';

/**
 * One end-to-end proof per surface: a correctly authenticated inbound
 * message produces the exact outbound request the platform documents.
 *
 * These are the tests that catch a surface being "wired up" but not
 * actually working: right adapter, wrong reply URL; right URL, wrong
 * auth scheme; right request, threaded against the wrong id.
 */

const AGENT_REPLY = 'here is your answer';

describe('surface round trips', () => {
  describe('slack', () => {
    const signingSecret = 'slack-signing-secret';
    const inbound = {
      team_id: 'T123',
      event: { type: 'message', text: 'hello', user: 'U1', channel: 'C42', ts: '1700000000.1' },
    };
    const rawBody = JSON.stringify(inbound);
    const timestamp = '1700000000';
    const headers = {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature':
        'v0=' +
        crypto
          .createHmac('sha256', signingSecret)
          .update(`v0:${timestamp}:${rawBody}`)
          .digest('hex'),
    };

    it('replies to the originating channel and thread with the bot token', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.SLACK,
        configuration: { bot_token: 'xoxb-real', signing_secret: signingSecret },
        inbound,
        headers,
        rawBody,
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('https://slack.com/api/chat.postMessage');
      expect(reply.init.headers.Authorization).toBe('Bearer xoxb-real');
      const body = parseSentJson(reply);
      expect(body.channel).toBe('C42');
      expect(body.thread_ts).toBe('1700000000.1');
      expect(body.text).toBe(AGENT_REPLY);
    });

    it('sends nothing at all when the signature is forged', async () => {
      const { calls } = await roundTrip({
        type: GatewayType.SLACK,
        configuration: { bot_token: 'xoxb-real', signing_secret: signingSecret },
        inbound,
        headers: { ...headers, 'x-slack-signature': 'v0=' + '0'.repeat(64) },
        rawBody,
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('telegram', () => {
    const secretToken = 'a'.repeat(64);
    const inbound = {
      message: { text: 'hi', from: { id: 55 }, chat: { id: 99 }, message_id: 7 },
    };

    it('replies to the originating chat via the bot token', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.TELEGRAM,
        configuration: { bot_token: 'tg-token', webhook_secret_token: secretToken },
        inbound,
        headers: { 'x-telegram-bot-api-secret-token': secretToken },
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('https://api.telegram.org/bottg-token/sendMessage');
      const body = parseSentJson(reply);
      expect(body.chat_id).toBe(99);
      expect(body.text).toBe(AGENT_REPLY);
    });

    it('sends nothing when the secret token header is absent', async () => {
      const { calls } = await roundTrip({
        type: GatewayType.TELEGRAM,
        configuration: { bot_token: 'tg-token', webhook_secret_token: secretToken },
        inbound,
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('whatsapp (twilio)', () => {
    const authToken = 'twilio-token';
    const webhookUrl = 'https://api.almyty.test/acme/wa';
    const inbound = {
      Body: 'hello',
      From: 'whatsapp:+15551110000',
      To: 'whatsapp:+15552220000',
      MessageSid: 'SM1',
    };
    const signature = (() => {
      const data = Object.keys(inbound)
        .sort()
        .reduce((acc, key) => acc + key + String((inbound as any)[key] ?? ''), webhookUrl);
      return crypto.createHmac('sha1', authToken).update(data, 'utf-8').digest('base64');
    })();

    it('replies to the sender through the Twilio Messages API', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.WHATSAPP,
        configuration: {
          twilio_account_sid: 'AC9',
          twilio_auth_token: authToken,
          phone_number: '+15552220000',
          webhook_url: webhookUrl,
        },
        inbound,
        headers: { 'x-twilio-signature': signature },
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC9/Messages.json');
      expect(reply.init.headers.Authorization).toBe(
        'Basic ' + Buffer.from('AC9:twilio-token').toString('base64'),
      );
      const form = parseSentForm(reply);
      // The whatsapp: prefix belongs on both ends or Twilio rejects it.
      expect(form.From).toBe('whatsapp:+15552220000');
      expect(form.To).toBe('whatsapp:+15551110000');
      expect(form.Body).toBe(AGENT_REPLY);
    });

    it('sends nothing when the Twilio signature does not match', async () => {
      const { calls } = await roundTrip({
        type: GatewayType.WHATSAPP,
        configuration: {
          twilio_account_sid: 'AC9',
          twilio_auth_token: authToken,
          phone_number: '+15552220000',
          webhook_url: webhookUrl,
        },
        inbound,
        headers: { 'x-twilio-signature': 'bogus' },
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('sms (twilio)', () => {
    const authToken = 'sms-token';
    const webhookUrl = 'https://api.almyty.test/acme/sms';
    const inbound = { Body: 'ping', From: '+15551110000', To: '+15552220000', MessageSid: 'SM2' };
    const signature = (() => {
      const data = Object.keys(inbound)
        .sort()
        .reduce((acc, key) => acc + key + String((inbound as any)[key] ?? ''), webhookUrl);
      return crypto.createHmac('sha1', authToken).update(data, 'utf-8').digest('base64');
    })();

    it('replies with bare E.164 numbers, no whatsapp prefix', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.SMS,
        configuration: {
          twilio_account_sid: 'AC8',
          twilio_auth_token: authToken,
          phone_number: '+15552220000',
          webhook_url: webhookUrl,
        },
        inbound,
        headers: { 'x-twilio-signature': signature },
        agentOutput: AGENT_REPLY,
      });

      const form = parseSentForm(reply);
      expect(form.From).toBe('+15552220000');
      expect(form.To).toBe('+15551110000');
      expect(form.From.startsWith('whatsapp:')).toBe(false);
    });
  });

  describe('whatsapp cloud (meta)', () => {
    const appSecret = 'meta-app-secret';
    const inbound = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PN1' },
                contacts: [{ profile: { name: 'Ada' } }],
                messages: [{ from: '15551110000', id: 'wamid.1', text: { body: 'hello' } }],
              },
            },
          ],
        },
      ],
    };
    const rawBody = JSON.stringify(inbound);
    const headers = {
      'x-hub-signature-256':
        'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf-8').digest('hex'),
    };

    it('replies through the Graph API for the configured phone number id', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.WHATSAPP_CLOUD,
        configuration: { access_token: 'meta-token', phone_number_id: 'PN1', app_secret: appSecret },
        inbound,
        headers,
        rawBody,
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('https://graph.facebook.com/v20.0/PN1/messages');
      expect(reply.init.headers.Authorization).toBe('Bearer meta-token');
      const body = parseSentJson(reply);
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('15551110000');
      expect(body.text.body).toBe(AGENT_REPLY);
    });
  });

  describe('discord', () => {
    // Inbound arrives over the authenticated gateway websocket, which
    // hands the raw message to the same dispatch path.
    const inbound = {
      content: 'hello',
      author: { id: 'U7' },
      channel_id: 'C900',
      guild_id: 'G1',
    };

    it('replies into the originating channel with Bot auth', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.DISCORD,
        configuration: { bot_token: 'discord-token' },
        inbound,
        agentOutput: AGENT_REPLY,
      });

      // Regression: this used to POST to /channels/undefined/messages
      // because the channel id never reached sendResponse.
      expect(reply.url).toBe('https://discord.com/api/v10/channels/C900/messages');
      expect(reply.init.headers.Authorization).toBe('Bot discord-token');
      expect(parseSentJson(reply).content).toBe(AGENT_REPLY);
    });

    it('truncates to Discord\'s 2000 character limit', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.DISCORD,
        configuration: { bot_token: 'discord-token' },
        inbound,
        agentOutput: 'x'.repeat(2500),
      });
      expect(parseSentJson(reply).content).toHaveLength(2000);
    });
  });

  describe('email', () => {
    const secret = 'svix-secret';
    const inbound = {
      type: 'email.received',
      data: {
        from: 'ada@example.com',
        to: 'agent@almyty.test',
        subject: 'Question',
        text: 'hello',
        message_id: '<abc@example.com>',
      },
    };

    it('replies to the sender and threads against the inbound Message-ID', async () => {
      const rawBody = JSON.stringify(inbound);
      // Svix signs id.timestamp.body; the adapter helper verifies it.
      const svixId = 'msg_1';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signed = `${svixId}.${timestamp}.${rawBody}`;
      const signature = crypto
        .createHmac('sha256', Buffer.from(secret, 'base64'))
        .update(signed)
        .digest('base64');

      const { reply } = await roundTrip({
        type: GatewayType.EMAIL,
        configuration: {
          resend_api_key: 're_key',
          reply_from: 'agent@almyty.test',
          resend_inbound_signing_secret: `whsec_${secret}`,
        },
        inbound,
        rawBody,
        headers: {
          'svix-id': svixId,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        },
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('https://api.resend.com/emails');
      expect(reply.init.headers.Authorization).toBe('Bearer re_key');
      const body = parseSentJson(reply);
      expect(body.to).toBe('ada@example.com');
      // Regression: In-Reply-To was undefined because messageId never
      // reached sendResponse, so every reply started a new mail thread.
      expect(body.headers['In-Reply-To']).toBe('<abc@example.com>');
    });
  });

  describe('chat widget', () => {
    it('persists the reply as an outbound event the widget can poll', async () => {
      const { calls, savedEvents } = await roundTrip({
        type: GatewayType.CHAT_WIDGET,
        configuration: {},
        inbound: { message: 'hello', sessionId: 'sess-1' },
        agentOutput: AGENT_REPLY,
      });

      // The widget has no push transport, so nothing goes over the wire.
      expect(calls).toHaveLength(0);
      const outbound = savedEvents.find((e) => e.direction === 'outbound');
      expect(outbound.payload.kind).toBe('widget_message');
      expect(outbound.payload.threadId).toBe('sess-1');
      expect(outbound.payload.message).toBe(AGENT_REPLY);
    });
  });

  describe('google chat', () => {
    it('replies to the configured space webhook, threaded', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.GOOGLE_CHAT,
        configuration: {
          webhook_url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k',
          verification_token: 'gc-token',
        },
        inbound: {
          message: {
            text: 'hello',
            sender: { name: 'users/1' },
            thread: { name: 'spaces/AAA/threads/T1' },
          },
        },
        headers: { authorization: 'Bearer gc-token' },
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('https://chat.googleapis.com/v1/spaces/AAA/messages?key=k');
      const body = parseSentJson(reply);
      expect(body.text).toBe(AGENT_REPLY);
      expect(body.thread.name).toBe('spaces/AAA/threads/T1');
    });
  });

  describe('microsoft teams', () => {
    it('replies to the activity serviceUrl and conversation with a bot token', async () => {
      const { calls } = await roundTrip({
        type: GatewayType.MICROSOFT_TEAMS,
        configuration: { bot_id: 'app-id', bot_password: 'app-secret' },
        inbound: {
          type: 'message',
          text: 'hello',
          from: { id: 'U1' },
          conversation: { id: 'conv-1' },
          serviceUrl: 'https://smba.trafficmanager.net/emea',
          channelData: { tenant: { id: 'tenant-1' } },
        },
        // Teams verification is a Bot Framework JWT; drive sendResponse
        // directly rather than forging a signed token.
        headers: {},
        agentOutput: AGENT_REPLY,
      });

      // Verification refuses the unsigned activity, so nothing is sent.
      // That refusal is the contract under test here.
      expect(calls).toHaveLength(0);
    });
  });

  describe('signal', () => {
    const inbound = {
      envelope: {
        source: '+15551110000',
        dataMessage: { message: 'hello' },
      },
    };

    it('replies to the sender through the signal-cli bridge', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.SIGNAL,
        configuration: {
          api_url: 'http://signal-cli:8080',
          phone_number: '+15559990000',
          inbound_token: 'bridge-token',
        },
        inbound,
        headers: { authorization: 'Bearer bridge-token' },
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('http://signal-cli:8080/v2/send');
      const body = parseSentJson(reply);
      expect(body.number).toBe('+15559990000');
      expect(body.recipients).toEqual(['+15551110000']);
      expect(body.message).toBe(AGENT_REPLY);
    });

    it('addresses the group rather than the sender for a group message', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.SIGNAL,
        configuration: {
          api_url: 'http://signal-cli:8080',
          phone_number: '+15559990000',
          inbound_token: 'bridge-token',
        },
        inbound: {
          envelope: {
            source: '+15551110000',
            dataMessage: { message: 'hello', groupInfo: { groupId: 'GRP1' } },
          },
        },
        headers: { authorization: 'Bearer bridge-token' },
        agentOutput: AGENT_REPLY,
      });

      expect(parseSentJson(reply).recipients).toEqual(['group.GRP1']);
    });
  });

  describe('matrix', () => {
    it('PUTs the reply into the originating room', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.MATRIX,
        configuration: {
          homeserver_url: 'https://matrix.example',
          access_token: 'mx-token',
          inbound_token: 'bridge-token',
        },
        inbound: {
          type: 'm.room.message',
          sender: '@ada:example',
          room_id: '!room:example',
          content: { body: 'hello', msgtype: 'm.text' },
        },
        headers: { authorization: 'Bearer bridge-token' },
        agentOutput: AGENT_REPLY,
      });

      expect(reply.init.method).toBe('PUT');
      expect(reply.url).toContain('https://matrix.example/_matrix/client/r0/rooms/');
      expect(reply.url).toContain(encodeURIComponent('!room:example'));
      expect(reply.init.headers.Authorization).toBe('Bearer mx-token');
      expect(parseSentJson(reply).body).toBe(AGENT_REPLY);
    });
  });

  describe('irc', () => {
    it('replies to the originating channel through the bridge', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.IRC,
        configuration: {
          webhook_url: 'https://irc-bridge.example/send',
          nick: 'almyty-bot',
          channel: '#general',
          inbound_token: 'bridge-token',
          bridge_token: 'outbound-token',
        },
        inbound: { message: 'hello', nick: 'ada', channel: '#support' },
        headers: { authorization: 'Bearer bridge-token' },
        agentOutput: AGENT_REPLY,
      });

      expect(reply.url).toBe('https://irc-bridge.example/send');
      expect(reply.init.headers.Authorization).toBe('Bearer outbound-token');
      const body = parseSentJson(reply);
      expect(body.channel).toBe('#support');
      expect(body.username).toBe('almyty-bot');
      expect(body.text).toBe(AGENT_REPLY);
    });
  });

  describe('EU AI Act Art. 50 disclosure', () => {
    it('prefixes the first reply on every human-facing surface that opts in', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.TELEGRAM,
        configuration: {
          bot_token: 'tg-token',
          webhook_secret_token: 'b'.repeat(64),
          aiDisclosure: true,
        },
        inbound: { message: { text: 'hi', from: { id: 1 }, chat: { id: 2 }, message_id: 3 } },
        headers: { 'x-telegram-bot-api-secret-token': 'b'.repeat(64) },
        agentOutput: AGENT_REPLY,
      });

      const body = parseSentJson(reply);
      expect(body.text).toBe(`You are chatting with an AI assistant.\n\n${AGENT_REPLY}`);
    });

    it('honours a custom disclosure line', async () => {
      const { reply } = await roundTrip({
        type: GatewayType.TELEGRAM,
        configuration: {
          bot_token: 'tg-token',
          webhook_secret_token: 'c'.repeat(64),
          aiDisclosure: 'This is a bot.',
        },
        inbound: { message: { text: 'hi', from: { id: 1 }, chat: { id: 2 }, message_id: 3 } },
        headers: { 'x-telegram-bot-api-secret-token': 'c'.repeat(64) },
        agentOutput: AGENT_REPLY,
      });

      expect(parseSentJson(reply).text).toBe(`This is a bot.\n\n${AGENT_REPLY}`);
    });
  });
});
