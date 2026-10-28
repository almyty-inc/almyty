import { createHmac, timingSafeEqual } from 'crypto';

import type { ChannelAction } from '../scheduled-result-poster';

/**
 * Approve in chat (docs/always-on.md, "Approving from your channel").
 *
 * When a run of an agent with an owner's channel holds a tool call for a
 * person, the request is posted there: what it wants to do, readable (an
 * email it would send as To, Subject and text, not base64), with Approve
 * and Reject buttons where the platform has them, and "reply yes or no"
 * everywhere. Only the owner's own address on that channel may decide;
 * the decision goes through ApprovalsService like one on the Approvals
 * page, so whichever comes first wins and the other is told it is decided.
 *
 * This file is the pure part: the words, the reply grammar, and the data
 * a button carries.
 */

export type ChannelDecision = 'approve' | 'reject';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The short reference a request goes by in chat ("ref 3F9A1C"): the first six of its id. */
export function approvalRef(id: string): string {
  return String(id ?? '').replace(/-/g, '').slice(0, 6).toUpperCase();
}

// ---------------------------------------------------------------------------
// What it wants to do, readable
// ---------------------------------------------------------------------------

export interface EmailPreview {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

const MAX_RAW = 512 * 1024;

function rawOf(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, any>;
  const raw = typeof p.raw === 'string' ? p.raw : typeof p.message?.raw === 'string' ? p.message.raw : null;
  return raw && raw.length <= MAX_RAW ? raw : null;
}

/**
 * An email a held tool call would send (Gmail's send and drafts carry the
 * whole message as one base64url `raw`), read back as To, Cc, Subject and
 * text. The same reading the Approvals page does (frontend
 * lib/email-preview.ts); null for anything else.
 */
export function emailPreviewOf(payload: unknown): EmailPreview | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, any>;
  const raw = rawOf(p.parameters) ?? rawOf(p.arguments) ?? rawOf(p);
  if (!raw || !/^[A-Za-z0-9_\-+/=\s]+$/.test(raw)) return null;
  const text = Buffer.from(raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (!text) return null;
  const split = text.search(/\r?\n\r?\n/);
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split).replace(/^\r?\n\r?\n/, '') : '';
  const header = (name: string) => {
    const m = head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  const to = header('To');
  const subject = header('Subject');
  if (!to && !subject) return null;
  const cc = header('Cc');
  // A chat message has plain line breaks; an email's are CRLF.
  return { to, subject, body: body.replace(/\r\n?/g, '\n').trim(), ...(cc ? { cc } : {}) };
}

function clip(text: string, max: number): string {
  const clean = String(text ?? '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function valueWords(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return clip(value.replace(/\s+/g, ' '), 200);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return clip(JSON.stringify(value), 200);
  } catch {
    return '(not shown)';
  }
}

/** The most arguments a chat preview lists; the rest are on the Approvals page. */
const MAX_ARGUMENTS = 12;
/** The most of an email's text a chat preview shows. */
const MAX_EMAIL_BODY = 1500;

/**
 * What the held call would do, as lines a person reads in chat: the email
 * it would send, the changes a script would make, or the tool and its
 * arguments. Empty when the request carries nothing to show.
 */
export function approvalPreview(payload: Record<string, any> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return '';
  const email = emailPreviewOf(payload);
  if (email) {
    return [
      'The email it will send:',
      `To: ${email.to || '(nobody)'}`,
      ...(email.cc ? [`Cc: ${email.cc}`] : []),
      `Subject: ${email.subject || '(no subject)'}`,
      '',
      clip(email.body, MAX_EMAIL_BODY),
    ].join('\n');
  }
  if (payload.kind === 'change_set' && Array.isArray(payload.changeSet)) {
    const changes = payload.changeSet as any[];
    const shown = changes.slice(0, MAX_ARGUMENTS).map((c) => `- ${clip(String(c?.summary ?? c?.tool ?? c?.toolName ?? 'a change'), 200)}`);
    const rest = changes.length - shown.length;
    return [`${changes.length} ${changes.length === 1 ? 'change' : 'changes'}:`, ...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join('\n');
  }
  const out: string[] = [];
  if (typeof payload.tool === 'string' && payload.tool) out.push(`Tool: ${clip(payload.tool, 120)}`);
  const params = payload.parameters && typeof payload.parameters === 'object' ? (payload.parameters as Record<string, unknown>) : null;
  if (params) {
    const keys = Object.keys(params);
    for (const key of keys.slice(0, MAX_ARGUMENTS)) out.push(`${clip(key, 60)}: ${valueWords(params[key])}`);
    if (keys.length > MAX_ARGUMENTS) out.push(`and ${keys.length - MAX_ARGUMENTS} more`);
  }
  return out.join('\n');
}

/**
 * The message a held call is posted as: who asks and why, what it would
 * do, and how to answer here or in Approvals.
 */
export function approvalMessage(
  agentName: string,
  row: { id: string; reason?: string | null; payload?: Record<string, any> | null },
  approvalsUrl: string,
): string {
  // The reason is a sentence of its own; its full stop goes, or it reads "list)..".
  let reason = String(row.reason ?? '').trim() || 'see Approvals';
  while (reason.endsWith('.')) reason = reason.slice(0, -1);
  const preview = approvalPreview(row.payload);
  return [
    `${agentName} wants to do something and is waiting for your OK: ${reason}.`,
    ...(preview ? ['', preview] : []),
    '',
    `Reply yes to approve or no to reject (ref ${approvalRef(row.id)}), or decide in Approvals: ${approvalsUrl}`,
  ].join('\n');
}

/**
 * The one line a channel other people read gets for a held call: who is
 * waiting for whose OK, on what kind of thing, and the link. Never the
 * preview: an email's text or a payment's details are the owner's to see.
 */
export function approvalNotice(
  agentName: string,
  ownerName: string | null,
  row: { payload?: Record<string, any> | null },
  approvalsUrl: string,
): string {
  const payload = row.payload ?? null;
  const what = emailPreviewOf(payload)
    ? 'an email'
    : payload?.kind === 'change_set'
      ? 'a set of changes'
      : typeof payload?.tool === 'string' && payload.tool
        ? `“${clip(payload.tool, 80)}”`
        : 'something it wants to do';
  const whose = ownerName ? `${clip(ownerName, 60)}'s` : "its owner's";
  return `${agentName} is waiting for ${whose} OK on ${what}. Approvals: ${approvalsUrl}`;
}
/** A question the agent put to its owner (ask_user), as posted on their channel. */
export function questionMessage(agentName: string, question: string): string {
  return `${agentName} has a question for you:\n\n${clip(question, 3000)}\n\nReply here and it carries on.`;
}

// ---------------------------------------------------------------------------
// Replies: "yes", "no", "approve", "reject"
// ---------------------------------------------------------------------------

const DECISION_LINE = /^(yes|no|approve|reject)\b(?:[\s,:]+(?:ref\s*)?#?([0-9a-f]{6}))?[.!]?$/i;
const REF_IN_TEXT = /\bref\s*#?([0-9a-f]{6})\b/i;

/**
 * A reply that decides a request: its first line is yes, no, approve or
 * reject (any case), alone or with the request's ref ("yes 3F9A1C"). A
 * line that says more ("no, send it tomorrow") is a message, not a
 * decision. Later lines are ignored, so an email reply's quote does not count.
 */
export function parseDecision(text: string | null | undefined): { decision: ChannelDecision; ref?: string } | null {
  const first = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return null;
  const m = DECISION_LINE.exec(first);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return { decision: word === 'yes' || word === 'approve' ? 'approve' : 'reject', ...(m[2] ? { ref: m[2].toUpperCase() } : {}) };
}

/** The ref a reply quotes: in the message it replies to, or in an email's quoted text. */
export function quotedRef(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const m = REF_IN_TEXT.exec(String(text ?? ''));
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/**
 * The key a button's data is signed with: CHANNEL_ACTION_SECRET, else the
 * install's JWT secret. The platform's own signature (or socket) already
 * says the press is real; this says the button is one we posted, for this
 * request and this decision, so a crafted callback cannot name another.
 */
function actionKey(env: Record<string, string | undefined>): string {
  return env.CHANNEL_ACTION_SECRET || env.JWT_SECRET || 'almyty-channel-actions';
}

function tag(decision: 'a' | 'r', id: string, env: Record<string, string | undefined>): string {
  return createHmac('sha256', actionKey(env)).update(`apv:${decision}:${id.toLowerCase()}`).digest('hex').slice(0, 16);
}

/** A button's data: `apv:<a|r>:<approval id>:<tag>`, 59 characters (Telegram allows 64). */
export function approvalActionData(id: string, decision: ChannelDecision, env: Record<string, string | undefined> = process.env): string {
  const d = decision === 'approve' ? 'a' : 'r';
  return `apv:${d}:${id.toLowerCase()}:${tag(d, id, env)}`;
}

/** The Approve and Reject buttons for a request. */
export function approvalActions(id: string, env: Record<string, string | undefined> = process.env): ChannelAction[] {
  return [
    { id: approvalActionData(id, 'approve', env), label: 'Approve', style: 'primary' },
    { id: approvalActionData(id, 'reject', env), label: 'Reject', style: 'danger' },
  ];
}

/** A pressed button's data read back; null when it is not ours or its tag does not match. */
export function readApprovalAction(
  data: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): { approvalId: string; decision: ChannelDecision } | null {
  const m = /^apv:([ar]):([0-9a-f-]{36}):([0-9a-f]{16})$/i.exec(String(data ?? ''));
  if (!m || !UUID_RE.test(m[2])) return null;
  const d = m[1].toLowerCase() as 'a' | 'r';
  const expected = Buffer.from(tag(d, m[2], env));
  const given = Buffer.from(m[3].toLowerCase());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { approvalId: m[2].toLowerCase(), decision: d === 'a' ? 'approve' : 'reject' };
}
