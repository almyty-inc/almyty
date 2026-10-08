import { Message, MessageRole, MessageType } from '../../entities/message.entity';

/**
 * What a person is shown of a conversation, wherever they or an operator
 * on their behalf asks for it: the web chat's own download, the widget's,
 * and the operator's answer to a data request all build it here.
 */

/** One turn, as a person is shown it. */
export interface TranscriptTurn {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

/** Turns replayed or exported for one conversation. */
export const TRANSCRIPT_TURN_LIMIT = 500;

/**
 * Tool calls and system scaffolding stay out of a transcript. An
 * assistant turn that called tools is scaffolding too: its text is the
 * agent narrating its working (what it is about to look up, what the
 * last tool said), saved alongside the call, not an answer.
 */
export function isPublicTurn(m: Message): boolean {
  return (
    (m.role === MessageRole.USER || m.role === MessageRole.ASSISTANT) &&
    m.type !== MessageType.TOOL_CALL &&
    !(Array.isArray(m.toolCalls) && m.toolCalls.length > 0) &&
    m.metadata?.internal !== true
  );
}

/** The shape a transcript turn is exposed as. */
export function toTranscript(m: Message): TranscriptTurn {
  return {
    id: m.id,
    role: m.role,
    content: typeof m.getTextContent === 'function' ? m.getTextContent() : m.content,
    createdAt: m.createdAt,
  };
}

/**
 * Message rows (ordered by conversation, then time) grouped into each
 * conversation's public transcript, at most TRANSCRIPT_TURN_LIMIT turns each.
 */
export function groupTranscripts(rows: Message[]): Map<string, TranscriptTurn[]> {
  const grouped = new Map<string, TranscriptTurn[]>();
  for (const m of rows) {
    if (!isPublicTurn(m)) continue;
    const bucket = grouped.get(m.conversationId);
    if (bucket) {
      if (bucket.length < TRANSCRIPT_TURN_LIMIT) bucket.push(toTranscript(m));
    } else {
      grouped.set(m.conversationId, [toTranscript(m)]);
    }
  }
  return grouped;
}
