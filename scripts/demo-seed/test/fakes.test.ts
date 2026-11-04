import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { serve, get, post, json, type Service } from '../fakes/server.ts'
import { vendor } from '../fakes/openai.ts'

async function start(service: Service) {
  const [server, v6] = serve([service], { port: 0 })
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => { server.close(); v6.close() } }
}

test('routes answer with JSON, health is built in, the rest is a 404', async (t) => {
  const s = await start({ name: 'x', routes: [get(/^\/items\/(\w+)$/, (_r, m) => json({ id: m[1] })), post('/items', (r) => json({ got: r.body }, 201))] })
  t.after(s.close)
  assert.deepEqual(await (await fetch(`${s.url}/health`)).json(), { ok: true })
  assert.deepEqual(await (await fetch(`${s.url}/items/a1`)).json(), { id: 'a1' })
  const made = await fetch(`${s.url}/items`, { method: 'POST', body: JSON.stringify({ n: 1 }) })
  assert.equal(made.status, 201)
  assert.deepEqual(await made.json(), { got: { n: 1 } })
  assert.equal((await fetch(`${s.url}/nope`)).status, 404)
})

test('the OpenAI vendor answers plainly and streamed, with tool calls', async (t) => {
  const routes = vendor({ prefix: '/openai', models: [{ id: 'gpt-4o', created: 1 }], decide: (b) => (b.tools?.length ? { toolCalls: [{ name: 'get_order', args: { id: 'NW-1' } }], promptTokens: 10, completionTokens: 2 } : { content: 'Order NW-1 is late, held at customs.' }) })
  const s = await start({ name: 'm', routes })
  t.after(s.close)
  const models = await (await fetch(`${s.url}/openai/v1/models`)).json()
  assert.equal(models.data[0].id, 'gpt-4o')
  const plain = await (await fetch(`${s.url}/openai/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [], tools: [{}] }) })).json()
  assert.equal(plain.choices[0].message.tool_calls[0].function.name, 'get_order')
  assert.deepEqual(plain.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
  const streamed = await (await fetch(`${s.url}/openai/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [], stream: true }) })).text()
  const pieces = streamed.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)))
  assert.equal(pieces.map((p) => p.choices[0]?.delta?.content ?? '').join(''), 'Order NW-1 is late, held at customs.')
  assert.ok(streamed.trimEnd().endsWith('data: [DONE]'))
})
