import { SlackAdapter } from '../slack.adapter';
import { TelegramAdapter } from '../telegram.adapter';
import { DiscordAdapter } from '../discord.adapter';
import { WhatsAppCloudAdapter } from '../whatsapp-cloud.adapter';
import { WhatsAppAdapter } from '../whatsapp.adapter';
import { SmsAdapter } from '../sms.adapter';
import { MicrosoftTeamsAdapter } from '../microsoft-teams.adapter';
import { GoogleChatAdapter } from '../google-chat.adapter';
import { MatrixAdapter } from '../matrix.adapter';
import { SignalAdapter } from '../signal.adapter';
import { IrcAdapter } from '../irc.adapter';
import { EmailAdapter } from '../email.adapter';
import { WebhookAdapter } from '../webhook.adapter';
import { IMessageSendblueAdapter } from '../imessage-sendblue.adapter';
import type { AdapterResponse } from '../base.adapter';
import { extractReplyMedia } from '../../reply-media';

/**
 * Files in and out of every channel, at the adapter: what each platform's
 * delivery hands over, how each one's files are fetched (with which
 * credential, to which host only), who wrote a group message, and how a
 * reply's images and files go out. The platforms are faked at global
 * fetch, which safeFetch and the adapters call; every request is recorded
 * with its headers, and anything not modelled answers 404.
 */
const LIMITS = { maxBytes: 10 * 1024 * 1024, timeoutMs: 20_000 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

type Route = (url: string, init: any) => Response | undefined;
let calls: Array<{ url: string; init: any }>;
let route: Route;
const original = globalThis.fetch;
beforeEach(() => {
  calls = [];
  route = () => undefined;
  (globalThis as any).fetch = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return route(String(url), init) ?? new Response('not modelled', { status: 404 });
  });
});
afterEach(() => {
  (globalThis as any).fetch = original;
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const png = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
const authOf = (call: { init: any }) => new Headers(call.init?.headers).get('authorization');
const bodyOf = (call: { init: any }) => JSON.parse(call.init.body);

/** A reply with a picture and a PDF in its text, as the pipeline hands it over. */
const replyWithMedia = (): AdapterResponse => {
  const text = 'Here is the label.\n\n![label](https://files.example/label.png)\n\nAnd [the invoice](https://files.example/invoice.pdf).';
  const media = extractReplyMedia(text);
  return { text, textWithoutMedia: media.textWithoutMedia, attachments: media.attachments };
};

describe('Slack', () => {
  const adapter = new SlackAdapter();
  const config = { bot_token: 'xoxb-1' };
  const event = (extra: Record<string, unknown> = {}) => ({
    event: { type: 'message', user: 'U1', text: 'look', channel: 'C1', channel_type: 'channel', ts: '1.2', ...extra },
  });

  it('hands over shared files by their private link, and knows a channel from a DM', () => {
    const n = adapter.normalizeInbound(
      event({ files: [{ name: 'box.png', mimetype: 'image/png', size: 72, url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/box.png' }] }),
    );
    expect(n.attachments).toEqual([{ url: 'https://files.slack.com/files-pri/T1-F1/download/box.png', type: 'image/png', name: 'box.png', size: 72 }]);
    expect(n.group).toBe(true);
    expect(n.sender).toEqual({ id: 'U1', name: undefined });
    expect(adapter.normalizeInbound(event({ channel_type: 'im', channel: 'D1' })).group).toBe(false);
    // An app_mention carries no channel_type; the id's first letter does.
    expect(adapter.normalizeInbound({ event: { type: 'app_mention', user: 'U1', text: 'hi', channel: 'D9' } }).group).toBe(false);
    expect(adapter.normalizeInbound({ event: { type: 'app_mention', user: 'U1', text: 'hi', channel: 'C9' } }).group).toBe(true);
  });

  it('reads a file with the bot token, and only from Slack\'s file host', async () => {
    route = (url) => (url.startsWith('https://files.slack.com/') ? png() : undefined);
    const got = await adapter.fetchAttachment({ url: 'https://files.slack.com/files-pri/T1-F1/download/box.png', type: 'image/png', name: 'box.png' }, config, LIMITS);
    expect(got?.bytes.equals(PNG)).toBe(true);
    expect(authOf(calls[0])).toBe('Bearer xoxb-1');

    calls.length = 0;
    await expect(adapter.fetchAttachment({ url: 'https://evil.example/box.png', type: 'image/png', name: 'box.png' }, config, LIMITS)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('looks up a sender\'s name once, with the bot token, and remembers it', async () => {
    route = (url) => (url.startsWith('https://slack.com/api/users.info') ? json({ ok: true, user: { profile: { display_name: 'Anna' } } }) : undefined);
    const n = adapter.normalizeInbound(event());
    await expect(adapter.senderName(n, config)).resolves.toBe('Anna');
    await expect(adapter.senderName(n, config)).resolves.toBe('Anna');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/users.info?user=U1');
    expect(authOf(calls[0])).toBe('Bearer xoxb-1');
    // A name the event carried is used as it is.
    const withProfile = adapter.normalizeInbound(event({ user_profile: { display_name: 'Ben' } }));
    await expect(adapter.senderName(withProfile, config)).resolves.toBe('Ben');
    expect(calls).toHaveLength(1);
  });

  it('sends a reply\'s image as an image block and keeps the PDF as a link', async () => {
    const formatted = adapter.formatOutbound(replyWithMedia());
    expect(formatted.blocks.at(-1)).toEqual({ type: 'image', image_url: 'https://files.example/label.png', alt_text: 'label' });
    expect(formatted.text).toBe('Here is the label.\n\nAnd the invoice.\nthe invoice: https://files.example/invoice.pdf');
    expect(formatted.blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: formatted.text } });

    route = () => json({ ok: true, ts: '9.9' });
    await adapter.sendResponse(config, formatted, { channel: 'C1', threadId: '1.2' });
    expect(bodyOf(calls[0]).blocks).toEqual(formatted.blocks);
  });

  it('a reply with no media keeps its text as written', () => {
    expect(adapter.formatOutbound({ text: 'no pictures', textWithoutMedia: 'no pictures', attachments: undefined })).toEqual({ text: 'no pictures' });
  });
});

describe('Telegram', () => {
  const adapter = new TelegramAdapter();
  const config = { bot_token: '123:ABC' };

  it('hands over the largest size of a photo and a document, with the caption as text; knows a group', () => {
    const n = adapter.normalizeInbound({
      message: {
        message_id: 5,
        from: { id: 42, first_name: 'Anna', last_name: 'K' },
        chat: { id: -100, type: 'supergroup' },
        caption: 'is this broken?',
        photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'large', file_size: 900 }],
        document: { file_id: 'doc-1', file_name: 'invoice.pdf', mime_type: 'application/pdf', file_size: 2000 },
      },
    });
    expect(n.text).toBe('is this broken?');
    expect(n.attachments).toEqual([
      { ref: 'large', type: 'image/jpeg', name: 'photo.jpg', size: 900 },
      { ref: 'doc-1', type: 'application/pdf', name: 'invoice.pdf', size: 2000 },
    ]);
    expect(n.group).toBe(true);
    expect(n.sender).toEqual({ id: '42', name: 'Anna K' });
  });

  it('turns a file_id into bytes with getFile and the bot\'s file URL', async () => {
    route = (url) => {
      if (url === 'https://api.telegram.org/bot123:ABC/getFile?file_id=large') return json({ ok: true, result: { file_path: 'photos/file_1.jpg' } });
      if (url === 'https://api.telegram.org/file/bot123:ABC/photos/file_1.jpg') return png();
      return undefined;
    };
    const got = await adapter.fetchAttachment({ ref: 'large', type: 'image/jpeg', name: 'photo.jpg' }, config, LIMITS);
    expect(got?.bytes.equals(PNG)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.telegram.org/bot123:ABC/getFile?file_id=large',
      'https://api.telegram.org/file/bot123:ABC/photos/file_1.jpg',
    ]);
  });

  it('refuses a file path that climbs out, and a file over the cap before asking', async () => {
    route = () => json({ ok: true, result: { file_path: '../../etc/passwd' } });
    await expect(adapter.fetchAttachment({ ref: 'x', type: 'image/jpeg', name: 'p' }, config, LIMITS)).rejects.toThrow('getFile did not name the file');
    calls.length = 0;
    await expect(adapter.fetchAttachment({ ref: 'x', type: 'image/jpeg', name: 'p', size: LIMITS.maxBytes + 1 }, config, LIMITS)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('sends the text, then the photo and the PDF by URL', async () => {
    const formatted = adapter.formatOutbound(replyWithMedia());
    expect(formatted.media).toEqual([
      { method: 'sendPhoto', url: 'https://files.example/label.png' },
      { method: 'sendDocument', url: 'https://files.example/invoice.pdf' },
    ]);
    expect(formatted.text).toBe('Here is the label.\n\nAnd the invoice.');
    route = () => json({ ok: true, result: {} });
    await adapter.sendResponse(config, formatted, { chatId: -100 });
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['sendMessage', 'sendPhoto', 'sendDocument']);
    expect(bodyOf(calls[1])).toEqual({ chat_id: -100, photo: 'https://files.example/label.png' });
    expect(bodyOf(calls[2])).toEqual({ chat_id: -100, document: 'https://files.example/invoice.pdf' });
  });
});

describe('Discord', () => {
  const adapter = new DiscordAdapter();

  it('hands over CDN attachments, knows a server channel from a DM, and names the writer', () => {
    const n = adapter.normalizeInbound({
      id: 'm1',
      content: 'see',
      channel_id: 'c1',
      guild_id: 'g1',
      author: { id: 'u1', username: 'anna_k', global_name: 'Anna' },
      member: { nick: 'Anna (ops)' },
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/box.png?ex=1', filename: 'box.png', content_type: 'image/png', size: 72 }],
    });
    expect(n.attachments).toEqual([{ url: 'https://cdn.discordapp.com/attachments/1/2/box.png?ex=1', type: 'image/png', name: 'box.png', size: 72 }]);
    expect(n.group).toBe(true);
    expect(n.sender).toEqual({ id: 'u1', name: 'Anna (ops)' });
    expect(adapter.normalizeInbound({ id: 'm2', content: 'hi', channel_id: 'dm', author: { id: 'u1', username: 'anna_k' } }).group).toBe(false);
  });

  it('fetches only from Discord\'s CDN, with no token', async () => {
    route = () => png();
    const got = await adapter.fetchAttachment({ url: 'https://cdn.discordapp.com/attachments/1/2/box.png', type: 'image/png', name: 'box.png' }, { bot_token: 'secret' }, LIMITS);
    expect(got?.bytes.equals(PNG)).toBe(true);
    expect(authOf(calls[0])).toBeNull();
    await expect(adapter.fetchAttachment({ url: 'https://evil.example/x.png', type: 'image/png', name: 'x' }, {}, LIMITS)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('shows a reply\'s image as an embed', () => {
    const formatted = adapter.formatOutbound(replyWithMedia());
    expect(formatted.embeds).toEqual([{ image: { url: 'https://files.example/label.png' } }]);
    expect(formatted.content).toContain('the invoice: https://files.example/invoice.pdf');
  });
});

describe('WhatsApp (Cloud API)', () => {
  const adapter = new WhatsAppCloudAdapter();
  const config = { access_token: 'meta-token', phone_number_id: 'PN1' };
  const inbound = (message: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { messages: [{ from: '4915', id: 'wamid.1', ...message }] } }] }] });

  it('hands over an image or a document by media id, with its caption as the text', () => {
    const n = adapter.normalizeInbound(inbound({ type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'broken?' } }));
    expect(n.text).toBe('broken?');
    expect(n.attachments).toEqual([{ ref: 'MEDIA1', type: 'image/jpeg', name: 'image.jpg' }]);
    const doc = adapter.normalizeInbound(inbound({ type: 'document', document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'inv.pdf' } }));
    expect(doc.attachments).toEqual([{ ref: 'MEDIA2', type: 'application/pdf', name: 'inv.pdf' }]);
  });

  it('asks the media node for its URL and reads it, with the token, only on Meta\'s media host', async () => {
    route = (url) => {
      if (url === 'https://graph.facebook.com/v20.0/MEDIA1') return json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', file_size: 72 });
      if (url.startsWith('https://lookaside.fbsbx.com/')) return png();
      return undefined;
    };
    const got = await adapter.fetchAttachment({ ref: 'MEDIA1', type: 'image/jpeg', name: 'i' }, config, LIMITS);
    expect(got?.bytes.equals(PNG)).toBe(true);
    expect(calls.map(authOf)).toEqual(['Bearer meta-token', 'Bearer meta-token']);

    calls.length = 0;
    route = () => json({ url: 'https://evil.example/steal' });
    await expect(adapter.fetchAttachment({ ref: 'MEDIA1', type: 'image/jpeg', name: 'i' }, config, LIMITS)).rejects.toThrow('the media node named no file on the media host');
    expect(calls).toHaveLength(1);
  });

  it('sends the text, then the picture and the PDF as media messages by link', async () => {
    const formatted = adapter.formatOutbound(replyWithMedia());
    route = () => json({ messages: [{ id: 'wamid.out' }] });
    await adapter.sendResponse(config, formatted, { from: '4915' });
    expect(calls.map(bodyOf)).toEqual([
      { messaging_product: 'whatsapp', to: '4915', text: { body: 'Here is the label.\n\nAnd the invoice.' } },
      { messaging_product: 'whatsapp', to: '4915', type: 'image', image: { link: 'https://files.example/label.png' } },
      { messaging_product: 'whatsapp', to: '4915', type: 'document', document: { link: 'https://files.example/invoice.pdf', filename: 'the invoice' } },
    ]);
  });
});

describe('Twilio: WhatsApp and SMS/MMS', () => {
  const config = { twilio_account_sid: 'AC1', twilio_auth_token: 'tok', phone_number: '+1555' };
  const basic = `Basic ${Buffer.from('AC1:tok').toString('base64')}`;
  const media = { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1', MediaContentType0: 'image/jpeg' };

  it('hands over MMS and WhatsApp media, read with the account\'s credentials on Twilio\'s host only', async () => {
    for (const adapter of [new SmsAdapter(), new WhatsAppAdapter()]) {
      calls.length = 0;
      const n = adapter.normalizeInbound({ Body: '', From: '+1666', MessageSid: 'SM1', ...media });
      expect(n.attachments).toEqual([{ url: media.MediaUrl0, type: 'image/jpeg', name: 'media-1.jpeg' }]);
      route = () => png();
      await adapter.fetchAttachment(n.attachments![0], config, LIMITS);
      expect(authOf(calls[0])).toBe(basic);
      await expect(adapter.fetchAttachment({ url: 'https://evil.example/m', type: 'image/jpeg', name: 'm' }, config, LIMITS)).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    }
  });

  it('WhatsApp sends a reply\'s picture and PDF as media, one per message', async () => {
    const adapter = new WhatsAppAdapter();
    const formatted = adapter.formatOutbound(replyWithMedia());
    route = () => json({ sid: 'SM2', status: 'queued' });
    await adapter.sendResponse(config, formatted, { from: 'whatsapp:+1666' });
    const forms = calls.map((c) => Object.fromEntries(new URLSearchParams(c.init.body)));
    expect(forms[0]).toMatchObject({ Body: 'Here is the label.\n\nAnd the invoice.', MediaUrl: 'https://files.example/label.png' });
    expect(forms[1]).toMatchObject({ Body: '', MediaUrl: 'https://files.example/invoice.pdf' });
  });

  it('SMS keeps a reply\'s links as text', () => {
    const response = replyWithMedia();
    expect(new SmsAdapter().formatOutbound(response)).toEqual({ body: response.text });
  });
});

describe('Microsoft Teams', () => {
  const adapter = new MicrosoftTeamsAdapter();
  const config = { bot_id: 'bot', bot_password: 'pw' };

  it('hands over a pasted image and a shared file, knows a group chat, and names the writer', () => {
    const n = adapter.normalizeInbound({
      id: 'a1',
      text: 'look',
      from: { id: '29:1', name: 'Anna Kowalski' },
      conversation: { id: 'conv', conversationType: 'groupChat' },
      attachments: [
        { contentType: 'text/html', content: '<p>look</p>' },
        { contentType: 'image/png', contentUrl: 'https://smba.trafficmanager.net/emea/v3/attachments/1/views/original', name: 'pasted.png' },
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'invoice.pdf',
          content: { downloadUrl: 'https://contoso.sharepoint.com/personal/x/invoice.pdf?tempauth=1' },
        },
      ],
    });
    expect(n.attachments).toEqual([
      { url: 'https://smba.trafficmanager.net/emea/v3/attachments/1/views/original', ref: 'inline', type: 'image/png', name: 'pasted.png' },
      { url: 'https://contoso.sharepoint.com/personal/x/invoice.pdf?tempauth=1', ref: 'download', type: 'application/octet-stream', name: 'invoice.pdf' },
    ]);
    expect(n.group).toBe(true);
    expect(n.sender).toEqual({ id: '29:1', name: 'Anna Kowalski' });
  });

  it('reads a pasted image with the bot token, and a shared file\'s pre-authorized link with nothing', async () => {
    route = (url) => {
      if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'bf-token' });
      return png();
    };
    await adapter.fetchAttachment({ url: 'https://smba.trafficmanager.net/emea/v3/attachments/1/views/original', ref: 'inline', type: 'image/png', name: 'p' }, config, LIMITS);
    expect(authOf(calls.find((c) => c.url.startsWith('https://smba'))!)).toBe('Bearer bf-token');

    calls.length = 0;
    await adapter.fetchAttachment({ url: 'https://contoso.sharepoint.com/personal/x/invoice.pdf?tempauth=1', ref: 'download', type: 'application/octet-stream', name: 'i' }, config, LIMITS);
    expect(calls).toHaveLength(1);
    expect(authOf(calls[0])).toBeNull();

    calls.length = 0;
    await expect(adapter.fetchAttachment({ url: 'https://evil.example/x', ref: 'inline', type: 'image/png', name: 'x' }, config, LIMITS)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('shows a reply\'s image as an attachment and keeps the PDF as a link', () => {
    const formatted = adapter.formatOutbound(replyWithMedia());
    expect(formatted.attachments).toEqual([{ contentType: 'image/png', contentUrl: 'https://files.example/label.png', name: 'label' }]);
    expect(formatted.text).toContain('the invoice: https://files.example/invoice.pdf');
  });
});

describe('Google Chat', () => {
  const adapter = new GoogleChatAdapter();

  it('names files sent to it without fetching them, and knows a space from a DM', async () => {
    const n = adapter.normalizeInbound({
      message: {
        name: 'spaces/A/messages/B',
        text: 'see',
        sender: { name: 'users/1', displayName: 'Anna' },
        attachment: [{ contentName: 'box.png', contentType: 'image/png', attachmentDataRef: { resourceName: 'r' } }],
      },
      space: { name: 'spaces/A', spaceType: 'SPACE' },
    });
    expect(n.attachments).toEqual([{ type: 'image/png', name: 'box.png' }]);
    expect(n.group).toBe(true);
    expect(n.sender).toEqual({ id: 'users/1', name: 'Anna' });
    await expect(adapter.fetchAttachment(n.attachments![0], {}, LIMITS)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    expect(adapter.normalizeInbound({ message: { text: 'hi', sender: { name: 'users/1' } }, space: { spaceType: 'DIRECT_MESSAGE' } }).group).toBe(false);
  });

  it('shows a reply\'s image in a card', async () => {
    const formatted = adapter.formatOutbound(replyWithMedia());
    expect(formatted.cardsV2[0].card.sections[0].widgets).toEqual([{ image: { imageUrl: 'https://files.example/label.png', altText: 'label' } }]);
    route = () => json({ name: 'spaces/A/messages/C' });
    await adapter.sendResponse({ webhook_url: 'https://chat.googleapis.com/v1/spaces/A/messages?key=k' }, formatted, {});
    expect(bodyOf(calls[0]).cardsV2).toEqual(formatted.cardsV2);
  });
});

describe('Matrix', () => {
  const adapter = new MatrixAdapter();
  const config = { homeserver_url: 'https://matrix.example', access_token: 'syt_1' };

  it('hands over an image by its mxc URI, with a caption only when there is one', () => {
    const n = adapter.normalizeInbound({
      event_id: '$1',
      room_id: '!r:matrix.example',
      sender: '@anna:matrix.example',
      content: { msgtype: 'm.image', body: 'box.png', url: 'mxc://matrix.example/AbC123', info: { mimetype: 'image/png', size: 72 } },
    });
    expect(n.text).toBe('');
    expect(n.attachments).toEqual([{ ref: 'mxc://matrix.example/AbC123', type: 'image/png', name: 'box.png', size: 72 }]);
    expect(n.sender).toEqual({ id: '@anna:matrix.example', name: 'anna' });
    expect(n.group).toBe(true);
    const captioned = adapter.normalizeInbound({ content: { msgtype: 'm.file', body: 'the invoice', filename: 'inv.pdf', url: 'mxc://m/x' } });
    expect(captioned.text).toBe('the invoice');
  });

  it('reads it from the homeserver\'s authenticated media endpoint, and refuses a malformed URI', async () => {
    route = () => png();
    await adapter.fetchAttachment({ ref: 'mxc://matrix.example/AbC123', type: 'image/png', name: 'b' }, config, LIMITS);
    expect(calls[0].url).toBe('https://matrix.example/_matrix/client/v1/media/download/matrix.example/AbC123');
    expect(authOf(calls[0])).toBe('Bearer syt_1');
    await expect(adapter.fetchAttachment({ ref: 'mxc://matrix.example/../../admin', type: 'image/png', name: 'b' }, config, LIMITS)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('Signal', () => {
  const adapter = new SignalAdapter();
  const config = { api_url: 'https://signal-bridge.example', phone_number: '+1555' };

  it('knows a group and names the writer by their Signal name', () => {
    const n = adapter.normalizeInbound({
      envelope: { sourceUuid: 'uuid-1', source: '+1666', sourceName: 'Anna', dataMessage: { message: 'hi', timestamp: 1, groupInfo: { groupId: 'G1' } } },
    });
    expect(n.group).toBe(true);
    expect(n.sender).toEqual({ id: 'uuid-1', name: 'Anna' });
  });

  it('attaches a reply\'s picture and PDF inline, read through the egress guard, and sends a link it could not read', async () => {
    const formatted = adapter.formatOutbound(replyWithMedia());
    route = (url) => {
      if (url === 'https://files.example/label.png') return png();
      if (url === 'https://signal-bridge.example/v2/send') return json({ timestamp: 1 });
      return undefined;
    };
    await adapter.sendResponse(config, formatted, { userId: '+1666' });
    const send = bodyOf(calls.find((c) => c.url.endsWith('/v2/send'))!);
    expect(send.base64_attachments).toEqual([`data:image/png;filename=label;base64,${PNG.toString('base64')}`]);
    // The PDF host answered 404: the reply says where it is instead.
    expect(send.message).toBe('Here is the label.\n\nAnd the invoice.\nthe invoice: https://files.example/invoice.pdf');
  });
});

describe('IRC', () => {
  it('a channel has several people, a private message one; files are not part of IRC', () => {
    const adapter = new IrcAdapter();
    expect(adapter.normalizeInbound({ nick: 'anna', channel: '#ops', text: 'hi' })).toMatchObject({ group: true, sender: { id: 'anna', name: 'anna' } });
    expect(adapter.normalizeInbound({ nick: 'anna', channel: 'bot', text: 'hi' }).group).toBe(false);
    const response = replyWithMedia();
    expect(adapter.formatOutbound(response)).toEqual({ text: response.text });
  });
});

describe('Email', () => {
  it('attaches a reply\'s files to the mail by link, for Resend to fetch', async () => {
    const adapter = new EmailAdapter();
    const formatted = adapter.formatOutbound(replyWithMedia());
    expect(formatted.attachments).toEqual([
      { filename: 'label', path: 'https://files.example/label.png' },
      { filename: 'the invoice', path: 'https://files.example/invoice.pdf' },
    ]);
    route = () => json({ id: 're_1' });
    await adapter.sendResponse({ resend_api_key: 're_key' }, formatted, { from: 'anna@example.com', subject: 'Label' });
    expect(bodyOf(calls[0]).attachments).toEqual(formatted.attachments);
    expect(bodyOf(calls[0]).text).toBe('Here is the label.\n\nAnd the invoice.');
    expect(bodyOf(calls[0]).html).toBe('<div style="white-space:pre-wrap">Here is the label.<br><br>And the invoice.</div>');
  });

  it('names the files a JSON-posting provider only lists', () => {
    const n = new EmailAdapter().normalizeInbound({ from: 'a@example.com', subject: 's', text: 'see', attachments: [{ filename: 'a.pdf', content_type: 'application/pdf' }] });
    expect(n.attachments).toEqual([{ type: 'application/pdf', name: 'a.pdf' }]);
  });
});

describe('Webhook', () => {
  it('takes https attachment links from the caller, and nothing else', () => {
    const n = new WebhookAdapter().normalizeInbound({
      text: 'see',
      attachments: [{ url: 'https://files.example/a.png', type: 'image/png' }, { url: 'http://10.0.0.1/x' }, { url: 'file:///etc/passwd' }],
    });
    expect(n.attachments).toEqual([{ url: 'https://files.example/a.png', type: 'image/png', name: 'a.png' }]);
  });
});

describe('iMessage (Sendblue)', () => {
  it('in a group, the writer is known by number only; a reply\'s media goes as media and leaves the text', () => {
    const adapter = new IMessageSendblueAdapter();
    const n = adapter.normalizeInbound({ from_number: '+14155550101', content: 'hi', group_id: 'G1', message_handle: 'h' });
    expect(n.group).toBe(true);
    expect(n.sender).toEqual({ id: '+14155550101' });
    const formatted = adapter.formatOutbound(replyWithMedia());
    expect(formatted.media).toEqual(['https://files.example/label.png', 'https://files.example/invoice.pdf']);
    expect(formatted.content).toBe('Here is the label.\n\nAnd the invoice.');
  });
});
