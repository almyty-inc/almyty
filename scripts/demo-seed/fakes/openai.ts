// An OpenAI-compatible model vendor for the fakes: /v1/models,
// /v1/chat/completions (plain and streamed) and /v1/embeddings under a
// prefix. What the model says is a service's own script (`decide`); this
// only speaks the wire format, so every fake vendor answers the same way.
import { get, json, post, STREAMED, type Route } from './server.ts'

export interface ToolCall { id?: string; name: string; args?: unknown }
export interface Decision {
  content?: string | null
  toolCalls?: ToolCall[]
  /** Token counts the vendor reports; the run views show them. */
  promptTokens?: number
  completionTokens?: number
}
export interface ChatRequest { model?: string; messages?: any[]; tools?: any[]; stream?: boolean; [k: string]: unknown }

export interface VendorOptions {
  /** Path prefix, such as /openai (the vendor answers at /openai/v1/...). */
  prefix: string
  models: { id: string; created: number; owned_by?: string }[]
  decide: (body: ChatRequest) => Decision | Promise<Decision>
  /** Token counts when the decision has none. */
  usage?: (body: ChatRequest, d: Decision) => { prompt: number; completion: number }
  /** How a streamed answer is cut into chunks (default: up to 40 characters at a space). */
  chunks?: (content: string) => string[]
  /** The completion id and creation time the answers carry. */
  completionId?: string
  created?: () => number
  callId?: (i: number) => string
  embeddings?: boolean
}

let seq = 0
const defaultCallId = () => `call_${(++seq).toString(36).padStart(6, '0')}`

export function vendor(o: VendorOptions): Route[] {
  const id = o.completionId ?? 'chatcmpl-demo'
  const created = o.created ?? (() => 1790000000)
  const chunks = o.chunks ?? ((c: string) => c.match(/.{1,40}(\s|$)/g) ?? [c])
  const routes: Route[] = [
    get(`${o.prefix}/v1/models`, () => json({ object: 'list', data: o.models.map((m) => ({ ...m, object: 'model', owned_by: m.owned_by ?? m.id.split('/')[0] })) })),
    post(`${o.prefix}/v1/chat/completions`, async (req, _m, res) => {
      const body = req.body as ChatRequest
      const d = await o.decide(body)
      const u = d.promptTokens !== undefined ? { prompt: d.promptTokens, completion: d.completionTokens ?? 0 } : o.usage?.(body, d) ?? { prompt: 200, completion: 20 }
      const usage = { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.prompt + u.completion }
      const model = body.model || o.models[0]?.id
      const toolCalls = d.toolCalls?.length ? d.toolCalls.map((c, i) => ({ id: c.id ?? o.callId?.(i) ?? defaultCallId(), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) : undefined
      const message = { role: 'assistant', content: d.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
      const finish = toolCalls ? 'tool_calls' : 'stop'
      const at = created()
      if (!body.stream) return json({ id, object: 'chat.completion', created: at, model, choices: [{ index: 0, message, finish_reason: finish }], usage })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: at, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (toolCalls) chunk({ role: 'assistant', tool_calls: toolCalls.map((c, index) => ({ index, ...c })) }, null)
      else for (const piece of chunks(d.content ?? '')) chunk({ content: piece }, null)
      chunk({}, finish)
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: at, model, choices: [], usage })}\n\n`)
      res.end('data: [DONE]\n\n')
      return STREAMED
    }),
  ]
  if (o.embeddings !== false) {
    routes.push(post(`${o.prefix}/v1/embeddings`, (req) => {
      const inputs = Array.isArray(req.body.input) ? req.body.input : [req.body.input]
      const dims = Number(req.body.dimensions) || 1536
      return json({ object: 'list', model: req.body.model, data: inputs.map((s: unknown, index: number) => ({ object: 'embedding', index, embedding: Array.from({ length: dims }, (_, i) => Math.sin((String(s).length + 1) * (i + 1)) / 10) })), usage: { prompt_tokens: 8, total_tokens: 8 } })
    }))
  }
  return routes
}

/** Text of a message's content, whatever shape it came in. */
export function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => c?.text ?? (typeof c?.content === 'string' ? c.content : '')).join(' ')
  return ''
}
