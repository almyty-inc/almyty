/**
 * J13: an autonomous agent on a Claude model, with tools and memory.
 *
 * A model comparison on staging (2026-11-13) found Claude agents broken in
 * three ways this gate holds closed:
 * - calls went out with a 1024-token output limit, and runs that spent it
 *   before answering were marked completed with an empty answer;
 * - earlier tool calls went back to Claude as plain text, so it repeated
 *   them (store_memory five times in a row, one run hit its cost cap);
 * - only the first of several tool calls in one reply was kept.
 *
 * The agent recalls memory, calls the Open-Meteo forecast and stores the
 * result, then answers. The answer must be Open-Meteo's own number, no tool
 * may be called twice with the same arguments, and the run's output must
 * stay under what the model's card allows for one reply.
 *
 * The model comes from the QA org's connected Anthropic provider;
 * GATE_CLAUDE_MODEL picks another connected Claude model.
 */
import { test, expect } from './support/fixtures'
import { data } from './support/qa-api'
import {
  berlinTomorrow,
  buildAgent,
  connectOpenMeteo,
  expectTemperature,
  openMeteoMax,
  tryIt,
  weatherQuestion,
  WEATHER_INSTRUCTIONS,
} from './support/weather-agent'

const CLAUDE_MODEL = process.env.GATE_CLAUDE_MODEL || 'claude-opus-5-5'

const INSTRUCTIONS =
  WEATHER_INSTRUCTIONS +
  ' Work in this order: first call recall_memory once to look up what you remember about Berlin, ' +
  'then call the forecast tool, then call store_memory once to save the maximum temperature you found, then answer.'

test.describe('J13 autonomous agent on Claude', () => {
  test.setTimeout(420_000)

  test('J13 Claude agent calls its tools once each, stores a memory, and answers with Open-Meteo\'s number', async ({ page, gate, qa }) => {
    const apiName = await connectOpenMeteo(page, gate, 'claude')
    const { id } = await buildAgent(page, gate, {
      what: 'claude-weather',
      apiName,
      instructions: INSTRUCTIONS,
      memory: true,
      workMode: { label: 'Single', models: [CLAUDE_MODEL] },
    })

    const day = berlinTomorrow()
    const [text, expected] = await Promise.all([tryIt(page, weatherQuestion(day), 300_000), openMeteoMax(day)])
    expect(text.trim().length, 'the answer should not be empty').toBeGreaterThan(0)
    expectTemperature(text, expected, day)

    // The run behind the answer, read back.
    const runs = await data<any[]>(await qa.get(`/agents/${id}/runs?limit=5`))
    expect(runs.length, 'Try it should have made a run').toBeGreaterThan(0)
    const run = await data<any>(await qa.get(`/agents/${id}/runs/${runs[0].id}`))
    expect(run.status, `the run should complete (error: ${run.error ?? 'none'})`).toBe('completed')
    expect(String(run.output ?? '').trim().length, 'the run should have an answer').toBeGreaterThan(0)

    const steps: any[] = run.steps ?? []
    const calls = steps.filter((s) => s.type === 'tool_call').map((s) => ({ tool: String(s.input?.tool ?? ''), args: JSON.stringify(s.input?.parameters ?? {}) }))
    const tools = new Set(calls.map((c) => c.tool))
    const forecastTool = `${apiName.replace(/-/g, '_')}_get_v1_forecast`
    expect([...tools], 'the run should call the forecast tool').toContain(forecastTool)
    expect([...tools], 'the run should store a memory').toContain('store_memory')
    expect(tools.size, `the run should call at least two different tools (called: ${[...tools].join(', ')})`).toBeGreaterThanOrEqual(2)

    // No call made twice with the same arguments.
    const seen = new Map<string, number>()
    for (const c of calls) seen.set(`${c.tool} ${c.args}`, (seen.get(`${c.tool} ${c.args}`) ?? 0) + 1)
    const repeated = [...seen.entries()].filter(([, n]) => n > 1)
    expect(repeated, 'no tool call should be repeated with identical arguments').toEqual([])

    // No reply ran into the output limit, and the whole run wrote less than the card allows for one reply.
    const llmSteps = steps.filter((s) => s.type === 'llm_call')
    expect(llmSteps.filter((s) => s.output?.status === 'no_answer'), 'no reply should come back without an answer').toEqual([])
    const outputTokens = llmSteps.reduce((sum, s) => sum + Number(s.tokens?.output ?? 0), 0)
    // The card of the model that answered, on the provider that served it.
    const answeredOn = llmSteps.find((s) => s.output?.providerId)?.output?.providerId
    const cards = await data<any[]>(await qa.get('/models?selectable=true'))
    const card = cards.find((c) => c.vendorModelId === CLAUDE_MODEL && (!answeredOn || c.providerId === answeredOn) && c.maxOutputTokens)
    expect(card, `${CLAUDE_MODEL} should have a model card with its most output tokens`).toBeTruthy()
    expect(outputTokens, `the run wrote ${outputTokens} output tokens`).toBeGreaterThan(0)
    expect(outputTokens, `the run should write less than ${card.maxOutputTokens} output tokens`).toBeLessThan(card.maxOutputTokens)
    // What the run did, on the gate report.
    test.info().annotations.push({
      type: 'run',
      description: `${CLAUDE_MODEL}: ${calls.length} tool calls (${calls.map((c) => c.tool).join(', ')}), ${outputTokens} output tokens of ${card.maxOutputTokens}, ${run.totalTokens} tokens, $${Number(run.totalCost).toFixed(4)}`,
    })
  })
})
