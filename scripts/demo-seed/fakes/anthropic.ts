// An Anthropic-compatible model vendor for the fakes: /v1/models and
// /v1/messages (plain and streamed) under a prefix. The request is turned
// into the chat shape fakes/openai.ts uses (a system message first, then
// the turns), so a service's scripted model reads one shape for every
// vendor. Document parts become a { type: 'file' } marker the script can
// see; tool results become text. It answers in text only.
import { get, json, post, STREAMED, type Route } from './server.ts'
import type { ChatRequest, Decision } from './openai.ts'

export interface AnthropicOptions {
  /** Path prefix, such as /anthropic (the vendor answers at /anthropic/v1/...). */
  prefix: string
  models: string[]
  /** Answers the request in the chat shape. */
  decide: (body: ChatRequest) => Decision | Promise<Decision>
  /** Token counts, from the request in the chat shape and the decision. */
  usage?: (body: ChatRequest, d: Decision) => { input: number; output: number }
  /** How a streamed answer is cut into text deltas (default: 60 characters each). */
  chunks?: (content: string) => string[]
  /** The message id the answers carry. */
  messageId?: string
  /** The model named when the request names none. */
  defaultModel?: string
}

/** One content part of an Anthropic message, as the chat shape has it. */
export function chatPart(p: any): any {
  if (p?.type === 'text') return { type: 'text', text: p.text }
  if (p?.type === 'document') return { type: 'file', file: { filename: p.title || p.name || 'document.pdf', mime: p.source?.media_type, bytes: (p.source?.data || '').length } }
  if (p?.type === 'tool_result') return { type: 'text', text: typeof p.content === 'string' ? p.content : JSON.stringify(p.content) }
  return { type: p?.type }
}

/** An Anthropic Messages request in the chat shape: the system prompt as the first message. */
export function toChat(body: any): ChatRequest {
  const messages = [
    ...(body.system ? [{ role: 'system', content: Array.isArray(body.system) ? body.system.map((s: any) => s.text).join('\n') : body.system }] : []),
    ...(body.messages || []).map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(chatPart) })),
  ]
  return { ...body, messages, tools: [] }
}

export function anthropicVendor(o: AnthropicOptions): Route[] {
  const id = o.messageId ?? 'msg_demo'
  const chunks = o.chunks ?? ((c: string) => c.match(/[\s\S]{1,60}/g) ?? [''])
  return [
    get(`${o.prefix}/v1/models`, () => json({
      data: o.models.map((m) => ({ type: 'model', id: m, display_name: m, created_at: '2025-09-29T00:00:00Z' })),
      has_more: false, first_id: o.models[0], last_id: o.models.at(-1),
    })),
    post(`${o.prefix}/v1/messages`, async (req, _m, res) => {
      const chat = toChat(req.body)
      const d = await o.decide(chat)
      const model = req.body.model || o.defaultModel || o.models[0]
      const content = d.content || ''
      const u = o.usage?.(chat, d) ?? { input: 200, output: 20 }
      if (!req.body.stream) {
        return json({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: u.input, output_tokens: u.output } })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: u.input, output_tokens: 1 } } })
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const piece of chunks(content)) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } })
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output } })
      ev('message_stop', {})
      res.end()
      return STREAMED
    }),
  ]
}
