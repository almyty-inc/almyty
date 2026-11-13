/**
 * J7: reaching an agent from code. The agent's API access is opened to
 * callers with a key ("Outside, protected" > Keys), a key is made on the
 * agent's page, and the official `openai` and `@anthropic-ai/sdk`
 * packages call the OpenAI- and Anthropic-compatible endpoints with it,
 * streaming and not. The answer must be Open-Meteo's number at that
 * moment. Revoking the key on the page shuts both endpoints.
 *
 * Also `almyty agents run`, from the published CLI signed in as the QA
 * user. The agent key is minted in the product and never printed.
 */
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { test, expect } from './support/fixtures'
import { API_URL } from './support/env'
import { data } from './support/qa-api'
import { cliSession } from './support/cli'
import { buildAgent, connectOpenMeteo, expectTemperature, openMeteoMax, weatherQuestion } from './support/weather-agent'
import type { Page } from '@playwright/test'

/**
 * On the agent's page: API access > Outside, protected > Keys > New key.
 * Returns the key, read the way a person takes it (the Copy button).
 */
async function makeAgentKey(page: Page, keyName: string): Promise<string> {
  const access = page.getByTestId('agent-api-access-section')
  await access.scrollIntoViewIfNeeded()
  await access.getByRole('radio', { name: /^Outside, protected/ }).click()
  await access.getByRole('button', { name: 'Save API access' }).click()
  await expect(access.getByRole('button', { name: 'Save API access' })).toBeHidden({ timeout: 30_000 })
  const keys = access.getByRole('checkbox', { name: 'Keys' })
  // The box turns on once the server has saved the method.
  await expect(keys).toBeEnabled({ timeout: 30_000 })
  await keys.click()
  await expect(keys, 'Keys should be on once saved').toBeChecked({ timeout: 30_000 })
  await access.getByRole('button', { name: 'New key' }).click()
  const form = access.getByRole('form', { name: 'New key' })
  await form.getByRole('textbox', { name: 'Name' }).fill(keyName)
  await form.getByRole('button', { name: 'Make key' }).click()
  const copy = access.getByRole('button', { name: 'Copy api key' })
  await expect(copy, 'the new key should be shown once').toBeVisible({ timeout: 30_000 })
  await copy.click()
  const key = (await page.evaluate(() => navigator.clipboard.readText())).trim()
  expect(key.length, 'the copied key should not be empty').toBeGreaterThan(16)
  await access.getByRole('button', { name: "I've saved it" }).click()
  return key
}

/** The HTTP status an SDK call failed with (or 0 if it did not fail). */
async function statusOf(call: () => Promise<unknown>): Promise<number> {
  try {
    await call()
    return 0
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}

test.describe('J7 compatible APIs', () => {
  test('J7 agent key: openai and @anthropic-ai/sdk, streaming and not, answer from Open-Meteo; revoked key is refused', async ({ page, gate, qa }) => {
    const apiName = await connectOpenMeteo(page, gate, 'compat')
    const agent = await buildAgent(page, gate, { what: 'compat-agent', apiName })
    // Opening API access makes a gateway for the agent; remove it with the agent.
    gate.defer('agent API access gateway', async () => {
      const gatewayId = (await data<any>(await qa.get(`/agents/${agent.id}/api-access`)))?.gatewayId
      if (gatewayId) {
        const res = await qa.delete(`/gateways/${gatewayId}`)
        if (!res.ok() && res.status() !== 404) throw new Error(`delete gateway ${gatewayId}: ${res.status()}`)
      }
    })

    const keyName = gate.name('compat-key')
    const key = await makeAgentKey(page, keyName)
    // The key reaches this agent by its id (`agent:<id>`).
    const model = `agent:${agent.id}`
    const question = weatherQuestion()
    const openai = new OpenAI({ baseURL: `${API_URL}/v1`, apiKey: key, maxRetries: 0, timeout: 240_000 })
    const anthropic = new Anthropic({ baseURL: API_URL, apiKey: key, maxRetries: 0, timeout: 240_000 })

    await test.step('OpenAI-compatible, not streamed', async () => {
      const [res, expected] = await Promise.all([
        openai.chat.completions.create({ model, messages: [{ role: 'user', content: question }] }),
        openMeteoMax(),
      ])
      expectTemperature(res.choices[0]?.message?.content ?? '', expected)
    })

    await test.step('OpenAI-compatible, streamed', async () => {
      const [stream, expected] = await Promise.all([
        openai.chat.completions.create({ model, messages: [{ role: 'user', content: question }], stream: true }),
        openMeteoMax(),
      ])
      let text = ''
      let chunks = 0
      for await (const chunk of stream) {
        chunks++
        text += chunk.choices[0]?.delta?.content ?? ''
      }
      expect(chunks, 'a streamed answer arrives as chunks').toBeGreaterThan(1)
      expectTemperature(text, expected)
    })

    await test.step('Anthropic-compatible, not streamed', async () => {
      const [res, expected] = await Promise.all([
        anthropic.messages.create({ model, max_tokens: 1024, messages: [{ role: 'user', content: question }] }),
        openMeteoMax(),
      ])
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      expectTemperature(text, expected)
    })

    await test.step('Anthropic-compatible, streamed', async () => {
      const [stream, expected] = await Promise.all([
        Promise.resolve(anthropic.messages.stream({ model, max_tokens: 1024, messages: [{ role: 'user', content: question }] })),
        openMeteoMax(),
      ])
      let deltas = 0
      stream.on('text', () => deltas++)
      const text = await stream.finalText()
      expect(deltas, 'a streamed answer arrives as text deltas').toBeGreaterThan(0)
      expectTemperature(text, expected)
    })

    await test.step('revoke the key on the page; both endpoints refuse it', async () => {
      const access = page.getByTestId('agent-api-access-section')
      await access.getByRole('button', { name: `Revoke ${keyName}` }).click()
      // A revoked key leaves the list.
      await expect(access.getByRole('list', { name: 'Keys' })).not.toContainText(keyName)
      expect(await statusOf(() => openai.chat.completions.create({ model, messages: [{ role: 'user', content: 'hello' }] })), 'a revoked key on /v1/chat/completions').toBe(401)
      expect(await statusOf(() => anthropic.messages.create({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] })), 'a revoked key on /v1/messages').toBe(401)
    })
  })

  test('J7 agent key works with the model the Integration snippet names', async ({ page, gate, qa }) => {
    const apiName = await connectOpenMeteo(page, gate, 'snippet')
    const agent = await buildAgent(page, gate, { what: 'snippet-agent', apiName })
    gate.defer('agent API access gateway', async () => {
      const gatewayId = (await data<any>(await qa.get(`/agents/${agent.id}/api-access`)))?.gatewayId
      if (gatewayId) {
        const res = await qa.delete(`/gateways/${gatewayId}`)
        if (!res.ok() && res.status() !== 404) throw new Error(`delete gateway ${gatewayId}: ${res.status()}`)
      }
    })
    const key = await makeAgentKey(page, gate.name('snippet-key'))
    try {
      // The agent page's Integration card: Node.js, OpenAI-compatible endpoint.
      await page.getByRole('button', { name: 'Node.js', exact: true }).click()
      const snippet = await page.getByText(/model: 'agent:[^']+'/).first().innerText()
      const model = snippet.match(/model: '(agent:[^']+)'/)![1]
      const openai = new OpenAI({ baseURL: `${API_URL}/v1`, apiKey: key, maxRetries: 0, timeout: 240_000 })
      const [res, expected] = await Promise.all([
        openai.chat.completions.create({ model, messages: [{ role: 'user', content: weatherQuestion() }] }).catch((err) => err as Error),
        openMeteoMax(),
      ])
      expect(res instanceof Error ? `${(res as any).status} ${res.message}` : 'answered', `the snippet's model "${model}" with the agent's own key`).toBe('answered')
      expectTemperature((res as OpenAI.Chat.Completions.ChatCompletion).choices[0]?.message?.content ?? '', expected)
    } finally {
      const access = page.getByTestId('agent-api-access-section')
      const revoke = access.getByRole('button', { name: /^Revoke gate-/ })
      if (await revoke.count()) await revoke.first().click()
    }
  })

  test('J7 almyty agents run answers from Open-Meteo', async ({ page, gate, qa, browser }) => {
    const apiName = await connectOpenMeteo(page, gate, 'cli-run')
    const agent = await buildAgent(page, gate, { what: 'cli-run-agent', apiName })
    const cli = await cliSession(browser, gate, qa, 'agents-run')
    const [res, expected] = await Promise.all([
      cli.run(['agents', 'run', agent.name, '--input', JSON.stringify(weatherQuestion()), '--watch', '--json'], { timeout: 300_000 }),
      openMeteoMax(),
    ])
    expect(res.code, `almyty agents run should exit 0: ${res.stderr.slice(-400)}`).toBe(0)
    const run = JSON.parse(res.stdout)
    expect(run.status, 'the run should complete').toBe('completed')
    expectTemperature(typeof run.output === 'string' ? run.output : JSON.stringify(run.output), expected)
  })
})
