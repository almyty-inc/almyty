import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

/**
 * The outside world of the core-journey spec, on one local port: an
 * OpenAPI description, the API it describes, and an OpenAI-compatible
 * model server. Nothing here reaches the internet and nothing needs a key.
 *
 * The model is scripted rather than clever. Offered a tool and not yet
 * given its result, it asks for the forecast tool; given the result, it
 * answers with FINAL_ANSWER plus what the tool said. So an answer that
 * contains the forecast proves the tool really ran.
 */

export const MODEL_ID = 'e2e-journey'
export const FORECAST = 'sunny-with-e2e-clouds'
export const FINAL_ANSWER = 'E2E_JOURNEY_ANSWER'

export interface FakeUpstreams {
  /** http://<host>:<port>, no trailing slash. */
  origin: string
  /** Where the OpenAI-compatible model server lives (…/v1). */
  llmUrl: string
  /** Where the OpenAPI description is served. */
  openApiUrl: string
  /** The OpenAPI description itself, for an upload instead of a link. */
  openApi: () => string
  /** Calls the fake API received, newest last. */
  apiCalls: string[]
  /** Chat completions the fake model answered, newest last. */
  chatCalls: Array<{ tools: string[]; toolOffered: boolean; toolAnswered: boolean }>
  close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function openApiDocument(origin: string) {
  return {
    openapi: '3.0.3',
    info: { title: 'E2E Forecast', version: '1.0.0', description: 'A local weather API for the core-journey spec.' },
    servers: [{ url: `${origin}/api` }],
    paths: {
      '/forecast': {
        get: {
          operationId: 'getForecast',
          summary: 'Get the forecast for a city',
          parameters: [{ name: 'city', in: 'query', required: true, schema: { type: 'string' }, description: 'City name' }],
          responses: {
            '200': {
              description: 'The forecast',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { city: { type: 'string' }, forecast: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
  }
}

/** A chat completion, as JSON or as the SSE stream a `stream: true` caller wants. */
function completion(res: ServerResponse, stream: boolean, message: { content: string | null; tool_calls?: unknown[] }) {
  const created = Math.floor(Date.now() / 1000)
  const finish = message.tool_calls ? 'tool_calls' : 'stop'
  if (!stream) {
    return json(res, 200, {
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      created,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    })
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const chunk = (delta: unknown, finish_reason: string | null) =>
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  if (message.tool_calls) {
    chunk({ role: 'assistant', tool_calls: (message.tool_calls as any[]).map((c, index) => ({ index, ...c })) }, null)
  } else {
    chunk({ role: 'assistant', content: message.content }, null)
  }
  chunk({}, finish)
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created, model: MODEL_ID, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}

export async function startFakeUpstreams(): Promise<FakeUpstreams> {
  const apiCalls: string[] = []
  const chatCalls: FakeUpstreams['chatCalls'] = []
  let origin = ''

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://fake')
    try {
      if (req.method === 'GET' && url.pathname === '/openapi.json') return json(res, 200, openApiDocument(origin))

      if (req.method === 'GET' && url.pathname === '/api/forecast') {
        apiCalls.push(`${req.method} ${url.pathname}${url.search}`)
        return json(res, 200, { city: url.searchParams.get('city') || '', forecast: FORECAST })
      }

      if (req.method === 'GET' && /^\/v1\/models\/?$/.test(url.pathname)) {
        return json(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'e2e' }] })
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const messages: any[] = Array.isArray(body.messages) ? body.messages : []
        const tools: any[] = Array.isArray(body.tools) ? body.tools : []
        const toolResult = messages.find((m) => m?.role === 'tool')
        const forecastTool = tools.find((t) => /forecast/i.test(t?.function?.name || ''))
        chatCalls.push({ tools: tools.map((t) => t?.function?.name ?? t?.name), toolOffered: !!forecastTool, toolAnswered: !!toolResult })

        if (forecastTool && !toolResult) {
          return completion(res, !!body.stream, {
            content: null,
            tool_calls: [
              {
                id: 'call_e2e_1',
                type: 'function',
                function: { name: forecastTool.function.name, arguments: JSON.stringify({ city: 'Lisbon' }) },
              },
            ],
          })
        }
        // The final answer may be written by a call with no tools offered,
        // where the tool's result arrives as conversation text: look everywhere.
        const heard = JSON.stringify(messages).includes(FORECAST) ? `the forecast is ${FORECAST}` : 'no forecast'
        return completion(res, !!body.stream, { content: `${FINAL_ANSWER}: ${heard}` })
      }

      json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } })
    } catch (err) {
      json(res, 500, { error: { message: String(err) } })
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  origin = `http://localhost:${(server.address() as AddressInfo).port}`
  return {
    origin,
    llmUrl: `${origin}/v1`,
    openApiUrl: `${origin}/openapi.json`,
    openApi: () => JSON.stringify(openApiDocument(origin), null, 2),
    apiCalls,
    chatCalls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
