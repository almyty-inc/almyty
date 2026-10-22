import * as crypto from 'crypto';

import { TelegramAdapter } from '../telegram.adapter';
import { SlackAdapter } from '../slack.adapter';
import { MicrosoftTeamsAdapter } from '../microsoft-teams.adapter';
import { DiscordAdapter } from '../discord.adapter';
import { SmsAdapter } from '../sms.adapter';
import { approvalActions, readApprovalAction } from '../../../../agents/always-on/channel-approval';
import { installFetchMock, parseSentJson } from './test-helpers';

/**
 * Approve and Reject buttons on the four platforms that have them: the
 * payload each sends, the press each reads back (from a delivery the
 * platform vouched for), and how each answers it. A platform without
 * buttons sends the text alone, which says how to answer in words.
 */
const ID = '3f9a1c2b-1111-4111-8111-111111111111';
const ENV = { CHANNEL_ACTION_SECRET: 'adapter-test-secret' };
const actions = approvalActions(ID, ENV);
const [APPROVE, REJECT] = actions.map((a) => a.id);

describe('Telegram: inline keyboard and callback_query', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  const adapter = new TelegramAdapter();
  beforeEach(() => {
    fetchMock = installFetchMock();
    fetchMock.setNextResponse({ json: { ok: true, result: {} } });
  });
  afterEach(() => fetchMock.restore());

  it('sends the buttons as an inline keyboard whose callback_data is the action', async () => {
    const formatted = adapter.formatOutbound({ text: 'Waiting for your OK', actions });
    expect(formatted.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Approve', callback_data: APPROVE }, { text: 'Reject', callback_data: REJECT }]],
    });
    await adapter.sendResponse({ bot_token: 'T' }, formatted, { chatId: 42 });
    expect(parseSentJson(fetchMock.calls[0])).toEqual({ chat_id: 42, text: 'Waiting for your OK', reply_markup: formatted.reply_markup });
    expect(readApprovalAction(formatted.reply_markup.inline_keyboard[0][0].callback_data, ENV)).toEqual({ approvalId: ID, decision: 'approve' });
  });

  it('sends no keyboard without actions', () => {
    expect(adapter.formatOutbound({ text: 'hi' })).toEqual({ text: 'hi' });
  });

  it('reads a callback_query as a press by the Telegram user who pressed it', () => {
    const update = {
      update_id: 900,
      callback_query: {
        id: 'cbq-1',
        from: { id: 555, first_name: 'Ana', last_name: 'B' },
        data: APPROVE,
        message: { message_id: 77, chat: { id: 555, type: 'private' } },
      },
    };
    expect(adapter.actionOf(update)).toEqual({
      data: APPROVE,
      userId: '555',
      userName: 'Ana B',
      group: false,
      context: { callbackQueryId: 'cbq-1', chatId: 555, messageId: 77 },
    });
    expect(adapter.actionOf({ update_id: 1, message: { text: 'yes', from: { id: 1 }, chat: { id: 1 } } })).toBeNull();
  });

  it('a callback is verified like any update: by the secret token Telegram echoes', async () => {
    const config = { webhook_secret_token: 'shh' };
    expect(await adapter.verifyWebhook({ callback_query: {} }, { 'x-telegram-bot-api-secret-token': 'shh' }, config)).toBe(true);
    expect(await adapter.verifyWebhook({ callback_query: {} }, { 'x-telegram-bot-api-secret-token': 'nope' }, config)).toBe(false);
    expect(await adapter.verifyWebhook({ callback_query: {} }, {}, config)).toBe(false);
  });

  it('answers a settled press: stops the spinner, takes the buttons off, says the outcome in the chat', async () => {
    const press = adapter.actionOf({ callback_query: { id: 'cbq-1', from: { id: 555 }, data: APPROVE, message: { message_id: 77, chat: { id: 555 } } } })!;
    await adapter.answerAction({ bot_token: 'T' }, press, 'Approved. It carries on.', true);
    expect(fetchMock.calls.map((c) => c.url.split('/').pop())).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup', 'sendMessage']);
    expect(parseSentJson(fetchMock.calls[0])).toEqual({ callback_query_id: 'cbq-1', text: 'Approved. It carries on.' });
    expect(parseSentJson(fetchMock.calls[1])).toEqual({ chat_id: 555, message_id: 77, reply_markup: { inline_keyboard: [] } });
    expect(parseSentJson(fetchMock.calls[2])).toEqual({ chat_id: 555, text: 'Approved. It carries on.' });
  });

  it('answers a refusal to the presser alone, as an alert', async () => {
    const press = adapter.actionOf({ callback_query: { id: 'cbq-2', from: { id: 9 }, data: APPROVE, message: { message_id: 77, chat: { id: -100 } } } })!;
    await adapter.answerAction({ bot_token: 'T' }, press, 'Sorry, only the person this agent works for can approve.', false);
    expect(fetchMock.calls).toHaveLength(1);
    expect(parseSentJson(fetchMock.calls[0])).toMatchObject({ callback_query_id: 'cbq-2', show_alert: true });
  });

  it('keeps the message a reply quotes, so "yes" under a request finds it', () => {
    const normalized = adapter.normalizeInbound({
      message: { text: 'yes', from: { id: 1 }, chat: { id: 1, type: 'private' }, message_id: 5, reply_to_message: { text: 'Reply yes ... (ref 3F9A1C)' } },
    });
    expect(normalized.metadata?.replyToText).toBe('Reply yes ... (ref 3F9A1C)');
  });
});

describe('Slack: actions block and block_actions', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  const adapter = new SlackAdapter();
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => fetchMock.restore());

  const interactive = (overrides: Record<string, any> = {}) => ({
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U-OWNER', username: 'ana' },
    channel: { id: 'D123' },
    container: { type: 'message', message_ts: '1700.1', channel_id: 'D123' },
    message: { ts: '1700.1', text: 'Support agent wants to do something' },
    response_url: 'https://hooks.slack.com/actions/T1/1/abc',
    actions: [{ type: 'button', action_id: 'almyty_action_0', value: APPROVE }],
    ...overrides,
  });

  it('sends the buttons as an actions block, each value the action, Approve primary and Reject danger', () => {
    const formatted = adapter.formatOutbound({ text: 'Waiting for your OK', actions });
    expect(formatted.text).toBe('Waiting for your OK');
    expect(formatted.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Waiting for your OK' } },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'almyty_action_0', text: { type: 'plain_text', text: 'Approve' }, value: APPROVE, style: 'primary' },
          { type: 'button', action_id: 'almyty_action_1', text: { type: 'plain_text', text: 'Reject' }, value: REJECT, style: 'danger' },
        ],
      },
    ]);
  });

  it('reads a block_actions payload, form encoded as Slack posts it, as a press', () => {
    const body = { payload: JSON.stringify(interactive()) };
    expect(adapter.actionOf(body)).toEqual({
      data: APPROVE,
      userId: 'U-OWNER',
      userName: 'ana',
      group: false,
      context: {
        responseUrl: 'https://hooks.slack.com/actions/T1/1/abc',
        channel: 'D123',
        messageTs: '1700.1',
        messageText: 'Support agent wants to do something',
      },
    });
    expect(adapter.extractTenantId(body)).toBe('T1');
    expect(adapter.actionOf({ event_id: 'Ev1', event: { type: 'message', text: 'yes', user: 'U1' } })).toBeNull();
  });

  it('a press is verified like any delivery: by the signature over the raw form body, fresh', async () => {
    const secret = 'slack-signing-secret';
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(interactive()))}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = (ts: string, raw: string) => 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
    const body = { payload: JSON.stringify(interactive()) };
    expect(await adapter.verifyWebhook(body, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': sign(timestamp, rawBody) }, { signing_secret: secret }, rawBody)).toBe(true);
    // Another value pressed than the one signed.
    const forged = `payload=${encodeURIComponent(JSON.stringify(interactive({ actions: [{ value: REJECT }] })))}`;
    expect(await adapter.verifyWebhook(body, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': sign(timestamp, rawBody) }, { signing_secret: secret }, forged)).toBe(false);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(await adapter.verifyWebhook(body, { 'x-slack-request-timestamp': stale, 'x-slack-signature': sign(stale, rawBody) }, { signing_secret: secret }, rawBody)).toBe(false);
  });

  it('answers a settled press by replacing the message with its text and the outcome', async () => {
    const press = adapter.actionOf({ payload: JSON.stringify(interactive()) })!;
    await adapter.answerAction({}, press, 'Approved. It carries on.', true);
    expect(fetchMock.calls[0].url).toBe('https://hooks.slack.com/actions/T1/1/abc');
    expect(parseSentJson(fetchMock.calls[0])).toEqual({ replace_original: true, text: 'Support agent wants to do something\n\nApproved. It carries on.' });
  });

  it('answers a refusal to the presser alone (ephemeral)', async () => {
    const press = adapter.actionOf({ payload: JSON.stringify(interactive({ user: { id: 'U-OTHER' } })) })!;
    await adapter.answerAction({}, press, 'Sorry, only the person this agent works for can approve.', false);
    expect(parseSentJson(fetchMock.calls[0])).toEqual({ replace_original: false, response_type: 'ephemeral', text: 'Sorry, only the person this agent works for can approve.' });
  });

  it('answers nowhere but Slack\'s own response host', async () => {
    const press = adapter.actionOf({ payload: JSON.stringify(interactive({ response_url: 'https://evil.example/hook' })) })!;
    await expect(adapter.answerAction({}, press, 'x', true)).rejects.toThrow(/no Slack response URL/);
    expect(fetchMock.calls).toHaveLength(0);
  });
});

describe('Microsoft Teams: Adaptive Card and Action.Submit', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  const adapter = new MicrosoftTeamsAdapter();
  beforeEach(() => {
    fetchMock = installFetchMock();
    fetchMock.setNextResponse({ json: { access_token: 'tok' } });
  });
  afterEach(() => fetchMock.restore());

  it('sends the text and the buttons as an Adaptive Card with an Action.Submit each', () => {
    const formatted = adapter.formatOutbound({ text: 'Waiting for your OK', actions });
    expect(formatted).toEqual({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4',
            body: [{ type: 'TextBlock', text: 'Waiting for your OK', wrap: true }],
            actions: [
              { type: 'Action.Submit', title: 'Approve', data: { almytyAction: APPROVE }, style: 'positive' },
              { type: 'Action.Submit', title: 'Reject', data: { almytyAction: REJECT }, style: 'destructive' },
            ],
          },
        },
      ],
    });
    expect(adapter.formatOutbound({ text: 'hi' })).toEqual({ type: 'message', text: 'hi' });
  });

  it('reads a submit (a message activity whose value is the card data) as a press by its sender', () => {
    const activity = {
      type: 'message',
      id: 'act-2',
      replyToId: 'act-1',
      from: { id: '29:owner', name: 'Ana', aadObjectId: 'aad-1' },
      conversation: { id: 'a:conv', conversationType: 'personal' },
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      value: { almytyAction: APPROVE },
    };
    expect(adapter.actionOf(activity)).toEqual({
      data: APPROVE,
      userId: '29:owner',
      userName: 'Ana',
      group: false,
      context: { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'a:conv', replyToId: 'act-1' },
    });
    expect(adapter.actionOf({ ...activity, value: undefined, text: 'yes' })).toBeNull();
  });

  it('a submit is verified like any activity: a Bot Framework token for this bot, or nothing', async () => {
    expect(await adapter.verifyWebhook({ type: 'message', value: { almytyAction: APPROVE } }, {}, { bot_id: 'bot' })).toBe(false);
    expect(await adapter.verifyWebhook({ type: 'message', value: { almytyAction: APPROVE } }, { authorization: 'Bearer x.y.z' }, {})).toBe(false);
  });

  it('answers in the conversation, and replaces a settled card so it cannot be pressed again', async () => {
    const press = adapter.actionOf({
      type: 'message',
      replyToId: 'act-1',
      from: { id: '29:owner' },
      conversation: { id: 'a:conv' },
      serviceUrl: 'https://smba.trafficmanager.net/emea',
      value: { almytyAction: APPROVE },
    })!;
    await adapter.answerAction({ bot_id: 'bot', bot_password: 'pw' }, press, 'Approved. It carries on.', true);
    const sends = fetchMock.calls.filter((c) => c.url.startsWith('https://smba.trafficmanager.net'));
    expect(sends.map((c) => c.init.method)).toEqual(['POST', 'PUT']);
    expect(sends[0].url).toBe('https://smba.trafficmanager.net/emea/v3/conversations/a:conv/activities');
    expect(parseSentJson(sends[0])).toEqual({ type: 'message', text: 'Approved. It carries on.' });
    expect(sends[1].url).toBe('https://smba.trafficmanager.net/emea/v3/conversations/a:conv/activities/act-1');
  });
});

describe('Discord: button components and INTERACTION_CREATE', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  const adapter = new DiscordAdapter();
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => fetchMock.restore());

  const interaction = (overrides: Record<string, any> = {}) => ({
    id: '1200',
    type: 3,
    token: 'itok',
    application_id: 'app',
    channel_id: 'dm-1',
    user: { id: 'owner-1', username: 'ana' },
    data: { custom_id: APPROVE, component_type: 2 },
    message: { id: 'm-1', content: 'Support agent wants to do something' },
    ...overrides,
  });

  it('sends the buttons as one action row, green Approve and red Reject, custom_id the action', () => {
    expect(adapter.formatOutbound({ text: 'Waiting for your OK', actions })).toEqual({
      content: 'Waiting for your OK',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: APPROVE },
            { type: 2, style: 4, label: 'Reject', custom_id: REJECT },
          ],
        },
      ],
    });
    expect(adapter.formatOutbound({ text: 'hi' })).toEqual({ content: 'hi' });
  });

  it('reads a component interaction as a press: the user in a DM, the member in a server', () => {
    expect(adapter.actionOf(interaction())).toEqual({
      data: APPROVE,
      userId: 'owner-1',
      userName: 'ana',
      group: false,
      context: { interactionId: '1200', interactionToken: 'itok', channelId: 'dm-1', messageContent: 'Support agent wants to do something' },
    });
    const inServer = adapter.actionOf(interaction({ user: undefined, guild_id: 'g', member: { nick: 'Ana', user: { id: 'owner-1' } } }))!;
    expect(inServer).toMatchObject({ userId: 'owner-1', userName: 'Ana', group: true });
    // A message is not a press.
    expect(adapter.actionOf({ id: 'm', type: 0, content: 'yes', author: { id: 'x' }, channel_id: 'c' })).toBeNull();
  });

  it('answers a settled press by updating the message without its buttons', async () => {
    await adapter.answerAction({}, adapter.actionOf(interaction())!, 'Approved. It carries on.', true);
    expect(fetchMock.calls[0].url).toBe('https://discord.com/api/v10/interactions/1200/itok/callback');
    expect(parseSentJson(fetchMock.calls[0])).toEqual({
      type: 7,
      data: { content: 'Support agent wants to do something\n\nApproved. It carries on.', components: [] },
    });
  });

  it('answers a refusal to the presser alone (ephemeral)', async () => {
    await adapter.answerAction({}, adapter.actionOf(interaction({ user: { id: 'someone' } }))!, 'Sorry.', false);
    expect(parseSentJson(fetchMock.calls[0])).toEqual({ type: 4, data: { content: 'Sorry.', flags: 64 } });
  });
});

describe('a platform without buttons', () => {
  it('sends the text alone, which says how to answer in words', () => {
    const formatted = new SmsAdapter().formatOutbound({ text: 'Reply yes to approve or no to reject (ref 3F9A1C)', actions });
    expect(JSON.stringify(formatted)).not.toContain('apv:');
    expect(new SmsAdapter().actionOf({ Body: 'yes' })).toBeNull();
  });
});
