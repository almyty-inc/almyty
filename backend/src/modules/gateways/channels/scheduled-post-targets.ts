import { BadRequestException } from '@nestjs/common';

import { GatewayType } from '../../../entities/gateway.entity';
import type { ChannelDelivery, PostChannelOption } from '../../agents/scheduled-result-poster';

/**
 * What a scheduled post needs to know about each platform: what a
 * destination is called there, whether it can be typed or only picked
 * from places the channel already talks in, how to check one, how to
 * turn it into the thread context the adapter's sendResponse reads, and
 * how long one message may be.
 *
 * Only platforms whose adapter can start a message on its own are here.
 * The web chat and the website widget answer a visitor who is present,
 * so they have nobody to post to.
 */
export interface PostTarget {
  noun: string;
  choose: PostChannelOption['choose'];
  placeholder?: string;
  hint?: string;
  /** The longest message the platform takes; a longer result is split. Null: one message, whatever the length. */
  maxChars: number | null;
  /** The most messages one result is split into; the rest is cut with a note. */
  maxParts: number;
  /** A typed destination in its stored shape. Throws BadRequestException with a sentence a person can act on. */
  normalize(to: string): string;
  /** The thread context sendResponse reads for this destination. */
  threadContext(delivery: ChannelDelivery): Record<string, any>;
  /**
   * Each post is a conversation of its own (an email starts a new thread),
   * so each carries the AI disclosure. Elsewhere a destination is one
   * ongoing conversation, told once.
   */
  eachPostIsNewConversation?: boolean;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>.]+(?:\.[^\s@,;<>.]+)+$/;
/** The most addresses one scheduled email goes to. */
export const MAX_EMAIL_RECIPIENTS = 10;

function phone(to: string): string {
  const compact = to.replace(/[\s().-]/g, '');
  if (!E164.test(compact)) {
    throw new BadRequestException('Enter the phone number with its country code, like +14155550100.');
  }
  return compact;
}

function required(to: string, noun: string): string {
  const value = to.trim();
  if (!value) throw new BadRequestException(`Choose a ${noun.toLowerCase()}.`);
  return value;
}

export const POST_TARGETS: Partial<Record<GatewayType, PostTarget>> = {
  [GatewayType.SLACK]: {
    noun: 'Slack channel',
    choose: 'pick_or_enter',
    placeholder: 'C0123ABCDEF',
    hint: 'The bot has to be in the channel. Invite it with /invite, or enter the channel ID from the channel details in Slack.',
    // Slack takes up to 40,000 characters but folds anything past ~4,000
    // behind "show more"; splitting keeps each part readable.
    maxChars: 3900,
    maxParts: 5,
    normalize: (to) => {
      const value = required(to, 'Slack channel');
      if (!/^[CGD][A-Z0-9]{6,}$/.test(value)) {
        throw new BadRequestException('Enter the Slack channel ID, like C0123ABCDEF. It is at the bottom of the channel details in Slack.');
      }
      return value;
    },
    threadContext: (d) => ({ channel: d.to }),
  },
  [GatewayType.MICROSOFT_TEAMS]: {
    noun: 'Teams channel or chat',
    choose: 'pick',
    hint: 'Teams lets the bot post only where someone has talked to it. Mention the bot once in the channel or chat you want, and it shows up here.',
    maxChars: 20000,
    maxParts: 3,
    normalize: (to) => required(to, 'Teams channel or chat'),
    threadContext: (d) => ({
      threadId: d.to,
      metadata: { conversationId: d.to, serviceUrl: d.context?.serviceUrl },
    }),
  },
  [GatewayType.EMAIL]: {
    noun: 'Email address',
    choose: 'enter',
    placeholder: 'team@example.com, lead@example.com',
    hint: `Up to ${MAX_EMAIL_RECIPIENTS} addresses, separated by commas.`,
    maxChars: null,
    maxParts: 1,
    normalize: (to) => {
      const list = to
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) throw new BadRequestException('Enter at least one email address.');
      if (list.length > MAX_EMAIL_RECIPIENTS) {
        throw new BadRequestException(`Send to at most ${MAX_EMAIL_RECIPIENTS} addresses.`);
      }
      const bad = list.find((a) => !EMAIL.test(a));
      if (bad) throw new BadRequestException(`"${bad}" is not an email address.`);
      return [...new Set(list.map((a) => a.toLowerCase()))].join(', ');
    },
    threadContext: (d) => ({ recipients: String(d.to).split(', ') }),
    eachPostIsNewConversation: true,
  },
  [GatewayType.TELEGRAM]: {
    noun: 'Telegram chat',
    choose: 'pick_or_enter',
    placeholder: '-1001234567890 or @yourchannel',
    hint: 'Telegram bots can write only to chats that have talked to them, and to channels where they are an admin.',
    maxChars: 4096,
    maxParts: 5,
    normalize: (to) => {
      const value = required(to, 'Telegram chat');
      if (!/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(value)) {
        throw new BadRequestException('Enter a Telegram chat ID (a number) or a public channel name starting with @.');
      }
      return value;
    },
    threadContext: (d) => ({ chatId: d.to }),
  },
  [GatewayType.DISCORD]: {
    noun: 'Discord channel',
    choose: 'pick_or_enter',
    placeholder: '123456789012345678',
    hint: 'Turn on Developer Mode in Discord, then right-click the channel and copy its ID.',
    maxChars: 2000,
    maxParts: 5,
    normalize: (to) => {
      const value = required(to, 'Discord channel');
      if (!/^\d{15,22}$/.test(value)) throw new BadRequestException('Enter the Discord channel ID, a long number.');
      return value;
    },
    threadContext: (d) => ({ channelId: d.to }),
  },
  [GatewayType.GOOGLE_CHAT]: {
    noun: 'Space',
    choose: 'fixed',
    hint: 'Posts to the space this channel is connected to.',
    maxChars: 4000,
    maxParts: 5,
    normalize: () => '',
    threadContext: () => ({}),
  },
  [GatewayType.WHATSAPP]: {
    noun: 'Phone number',
    choose: 'pick_or_enter',
    placeholder: '+14155550100',
    hint: 'WhatsApp delivers a business message only to someone who wrote to this number in the last 24 hours, unless you use an approved template.',
    maxChars: 1600,
    maxParts: 3,
    normalize: (to) => phone(to.replace(/^whatsapp:/i, '')),
    threadContext: (d) => ({ from: `whatsapp:${d.to}` }),
  },
  [GatewayType.WHATSAPP_CLOUD]: {
    noun: 'Phone number',
    choose: 'pick_or_enter',
    placeholder: '+14155550100',
    hint: 'WhatsApp delivers a business message only to someone who wrote to this number in the last 24 hours, unless you use an approved template.',
    maxChars: 4096,
    maxParts: 3,
    normalize: (to) => phone(/^\d+$/.test(to.trim()) ? `+${to.trim()}` : to),
    // The Cloud API takes the number without the plus.
    threadContext: (d) => ({ from: String(d.to).replace(/^\+/, '') }),
  },
  [GatewayType.SMS]: {
    noun: 'Phone number',
    choose: 'pick_or_enter',
    placeholder: '+14155550100',
    maxChars: 1600,
    maxParts: 2,
    normalize: (to) => phone(to),
    threadContext: (d) => ({ from: d.to }),
  },
  [GatewayType.IMESSAGE_SENDBLUE]: {
    noun: 'Phone number or Apple ID email',
    choose: 'pick_or_enter',
    placeholder: '+14155550100',
    maxChars: 18000,
    maxParts: 2,
    normalize: (to) => (EMAIL.test(to.trim()) ? to.trim().toLowerCase() : phone(to)),
    threadContext: (d) => ({ from: d.to }),
  },
  [GatewayType.IMESSAGE_LOOPMESSAGE]: {
    noun: 'Phone number or Apple ID email',
    choose: 'pick_or_enter',
    placeholder: '+14155550100',
    maxChars: 9000,
    maxParts: 2,
    normalize: (to) => (EMAIL.test(to.trim()) ? to.trim().toLowerCase() : phone(to)),
    threadContext: (d) => ({ from: d.to }),
  },
  [GatewayType.SIGNAL]: {
    noun: 'Phone number or group',
    choose: 'pick_or_enter',
    placeholder: '+14155550100',
    maxChars: 2000,
    maxParts: 5,
    normalize: (to) => (to.trim().startsWith('group.') ? to.trim() : phone(to)),
    threadContext: (d) =>
      String(d.to).startsWith('group.')
        ? { metadata: { groupId: d.to } }
        : { userId: d.to },
  },
  [GatewayType.MATRIX]: {
    noun: 'Room',
    choose: 'pick_or_enter',
    placeholder: '!roomid:example.org',
    maxChars: 30000,
    maxParts: 3,
    normalize: (to) => {
      const value = required(to, 'Room');
      if (!/^![^:]+:.+$/.test(value)) throw new BadRequestException('Enter a Matrix room ID, like !abc123:example.org.');
      return value;
    },
    threadContext: (d) => ({ threadId: d.to }),
  },
  [GatewayType.IRC]: {
    noun: 'IRC channel',
    choose: 'pick_or_enter',
    placeholder: '#team',
    maxChars: 400,
    maxParts: 10,
    normalize: (to) => {
      const value = required(to, 'IRC channel');
      if (!/^[#&][^\s,]+$/.test(value)) throw new BadRequestException('Enter an IRC channel, like #team.');
      return value;
    },
    threadContext: (d) => ({ threadId: d.to }),
  },
  [GatewayType.WEBHOOK]: {
    noun: 'Callback URL',
    choose: 'fixed',
    hint: 'Posts to the callback URL this channel is set up with.',
    maxChars: null,
    maxParts: 1,
    normalize: () => '',
    threadContext: () => ({}),
    // A callback is no conversation: every delivery carries the line.
    eachPostIsNewConversation: true,
  },
};

export function postTargetFor(type: string): PostTarget | null {
  return POST_TARGETS[type as GatewayType] ?? null;
}

/** Said at the end of a result that did not fit. */
export const TRUNCATION_NOTE = '… (cut short: the full result is in the run history)';

/**
 * Split a result into messages a platform takes, at the most natural
 * break inside each window: a blank line, then a line end, then a
 * sentence end, then a space, and only as a last resort mid-word. A
 * result that needs more than `maxParts` messages is cut, and the last
 * one says so.
 */
export function splitMessage(
  text: string,
  maxChars: number | null,
  maxParts: number,
): { parts: string[]; truncated: boolean } {
  const body = text.trim();
  if (!maxChars || body.length <= maxChars) return { parts: [body], truncated: false };
  const parts: string[] = [];
  let rest = body;
  while (rest.length > 0 && parts.length < maxParts) {
    if (rest.length <= maxChars) {
      parts.push(rest);
      rest = '';
      break;
    }
    const lastPart = parts.length === maxParts - 1;
    const room = lastPart ? maxChars - TRUNCATION_NOTE.length - 1 : maxChars;
    const window = rest.slice(0, room);
    const floor = Math.floor(room * 0.5);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', ' ']) {
      const at = window.lastIndexOf(sep);
      if (at >= floor) {
        cut = at + (sep === '. ' ? 1 : 0);
        break;
      }
    }
    if (cut <= 0) cut = room;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  const truncated = rest.length > 0;
  if (truncated) parts[parts.length - 1] = `${parts[parts.length - 1]} ${TRUNCATION_NOTE}`;
  return { parts, truncated };
}
