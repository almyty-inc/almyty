import { createHash } from 'crypto';

import type { NormalizedMessage } from './adapters/base.adapter';

/** The longest name a message is prefixed with. */
const MAX_NAME_CHARS = 40;

/**
 * How the agent tells people apart in a conversation that has several.
 *
 * In a group chat, a channel or a room every message reaches the agent as
 * "Name: text", so it can see who asked what and answer the right person.
 * The name is the platform's display name when the delivery carries one;
 * otherwise, and whenever the name is itself an email address or a phone
 * number, a stable short id derived from the platform's id for the
 * sender. Contact details never go into the conversation in full: the
 * transcript is stored, shown and handed to the model.
 *
 * One-to-one conversations are left as they are.
 */
export function withSpeaker(normalized: NormalizedMessage, text: string): string {
  if (!normalized.group) return text;
  const id = normalized.sender?.id ?? normalized.userId;
  if (!id || id === 'unknown') return text;
  return `${speakerLabel(normalized.sender?.name, id)}: ${text}`;
}

/** The name a message is prefixed with: a usable display name, else a short id. */
export function speakerLabel(name: string | undefined | null, id: string): string {
  const cleaned = typeof name === 'string' ? oneLine(name) : '';
  if (cleaned && !looksLikeContact(cleaned)) return cleaned;
  return shortId(id);
}

/**
 * A stable short id for a sender: the same person reads the same in every
 * message of the conversation, and the id reveals nothing about them.
 */
export function shortId(id: string): string {
  return `user-${createHash('sha256').update(String(id)).digest('hex').slice(0, 6)}`;
}

/** An email address, or something with enough digits to be a phone number. */
export function looksLikeContact(value: string): boolean {
  const at = value.indexOf('@');
  if (at > 0 && value.indexOf('.', at + 2) > at + 1) return true;
  return (value.match(/\d/g)?.length ?? 0) >= 7;
}

function oneLine(value: string): string {
  // Control characters and line breaks out: a name is one line, and a
  // newline in it would let a display name write a line of its own.
  const flat = value.replace(CONTROL_OR_SEPARATOR, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS - 3).trim()}...` : flat;
}

/** C0 controls, DEL, and the two Unicode line and paragraph separators. */
const CONTROL_OR_SEPARATOR = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');
