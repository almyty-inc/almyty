/**
 * J4: Delete run. One finished run of an agent, deleted from its page
 * after the "Delete run?" confirm, is gone from the agent's runs and from
 * the API; a code-mode run takes its run_code scripts and the tool calls
 * they made with it; and the lead of the agent's team is offered Delete run
 * (the agent's `viewerCanManage`), while a member outside the team does not
 * even see the agent.
 *
 * Every agent here is the test's own throwaway, never one of the QA org's
 * demo agents. Models come from the QA org's connected providers.
 */
import { test, expect, signUpFresh, dropFreshUser, screenshotThis, type FreshUser } from './support/fixtures'
import { API_URL, QA_ORG_NAME } from './support/env'
import { data } from './support/qa-api'
import {
  berlinTomorrow,
  buildAgent,
  connectOpenMeteo,
  expectTemperature,
  openMeteoMax,
  tryIt,
  weatherQuestion,
} from './support/weather-agent'
import type { APIRequestContext, Page } from '@playwright/test'
import type { Gate } from './support/fixtures'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ECHO_INSTRUCTIONS = 'Answer in one short sentence. Do not call any tool.'

/** Open the agent's latest run from its Overview; returns the run's id. */
async function openLatestRun(page: Page, agentId: string): Promise<string> {
  await page.goto(`/agents/${agentId}`)
  await page.getByRole('row', { name: /^Open the run of/ }).first().click()
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/runs/${UUID}$`))
  const runId = page.url().match(new RegExp(`/runs/(${UUID})`))![1]
  const runs = page.getByRole('tabpanel', { name: 'Runs' })
  await expect(runs.getByRole('heading', { name: 'Steps' })).toBeVisible({ timeout: 60_000 })
  await expect(runs.getByText(/^completed$/i).first(), 'the run should have finished').toBeVisible({ timeout: 60_000 })
  return runId
}

/** Delete run on the opened run, through its "Delete run?" confirm. */
async function deleteOpenedRun(page: Page, agentId: string, runId: string): Promise<void> {
  const runs = page.getByRole('tabpanel', { name: 'Runs' })
  const button = runs.getByRole('button', { name: 'Delete run' })
  await expect(button).toBeEnabled()
  await button.click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete run?' })
  await expect(confirm).toBeVisible()
  const answered = page.waitForResponse(
    (r) => r.url().endsWith(`/agents/${agentId}/runs/${runId}`) && r.request().method() === 'DELETE',
    { timeout: 60_000 },
  )
  await confirm.getByRole('button', { name: 'Delete run' }).click()
  expect((await answered).status(), 'the server should delete the run').toBe(200)
  await expect(confirm).toBeHidden()
}

/** The run, read back as the QA user: its HTTP status. */
async function runStatus(qa: APIRequestContext, agentId: string, runId: string): Promise<number> {
  return (await qa.get(`/agents/${agentId}/runs/${runId}`)).status()
}

test.describe('J4 delete a run', () => {
  test('J4 Delete run removes a finished run from the agent and the API', async ({ page, gate, qa }) => {
    const agent = await buildAgent(page, gate, { what: 'delete-run', instructions: ECHO_INSTRUCTIONS })
    const answer = await tryIt(page, 'Say hello.')
    expect(answer.length, 'the agent should answer').toBeGreaterThan(0)

    const runId = await openLatestRun(page, agent.id)
    expect(await runStatus(qa, agent.id, runId), 'the run exists before it is deleted').toBe(200)

    await deleteOpenedRun(page, agent.id, runId)

    // Back on the list, which no longer has it: the agent's only run is gone.
    const runs = page.getByRole('tabpanel', { name: 'Runs' })
    await expect(runs.getByText('No runs yet')).toBeVisible()
    await expect(runs.getByText('0 runs')).toBeVisible()
    // And the API agrees.
    expect(await runStatus(qa, agent.id, runId), 'the deleted run should be 404').toBe(404)
    const listed = await data<any[]>(await qa.get(`/agents/${agent.id}/runs`))
    expect(listed.map((r) => r.id)).not.toContain(runId)
    // Opening its link again finds nothing to delete.
    await page.goto(`/agents/${agent.id}/runs/${runId}`)
    await expect(page.getByRole('tabpanel', { name: 'Runs' }).getByText('No runs yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete run' })).toHaveCount(0)
  })

  test('J4 a code-mode run takes its run_code scripts and their tool calls with it', async ({ page, gate, qa, org }) => {
    const apiName = await connectOpenMeteo(page, gate, 'code-mode')
    const agent = await buildAgent(page, gate, {
      what: 'code-mode',
      apiName,
      toolList: 'Search, and write scripts',
      instructions:
        'You report weather. First call search_tools to find the Open-Meteo forecast tool, then get_tool on it: ' +
        'its answer gives the script name to call it by, `code.namespace` and `code.function`. ' +
        'Then get the numbers with ONE run_code script that calls `await <namespace>.<function>({...})` ' +
        '(latitude, longitude, daily=["temperature_2m_max"], timezone=Europe/Berlin, start_date and end_date set to the day asked) ' +
        'and returns the daily maximum. Never use call_tool for the forecast. ' +
        'Report exactly the value the script returned, in °C, with one decimal. Never invent numbers.',
    })
    const day = berlinTomorrow()
    const [answer, expected] = await Promise.all([tryIt(page, weatherQuestion(day)), openMeteoMax(day)])
    expectTemperature(answer, expected, day)

    const runId = await openLatestRun(page, agent.id)
    // The run's steps show the script it ran, with the call it made.
    const steps = (await page.getByRole('tabpanel', { name: 'Runs' }).innerText()).replace(/\s+/g, ' ')
    expect(steps, 'the run should list a script that made a call').toMatch(/\d+ script [1-9]\d* calls?: [1-9]\d* ran/)

    // Its scripts, as stored: at least one, which called the forecast tool.
    const scripts = await data<any[]>(await qa.get(`/agents/${agent.id}/runs/${runId}/code-executions`))
    expect(scripts.length, 'the run should have left a run_code script').toBeGreaterThan(0)
    const ran = scripts.find((s) => s.status === 'completed' && s.callCount > 0)
    expect(ran, `a script should have completed with a tool call; got ${JSON.stringify(scripts.map((s) => ({ status: s.status, calls: s.callCount })))}`).toBeTruthy()
    const detail = await data<any>(await qa.get(`/agents/${agent.id}/runs/${runId}/code-executions/${ran.id}`))
    const forecastCalls = detail.calls.filter((c: any) => /_get_v1_forecast$/.test(c.toolName || ''))
    expect(forecastCalls.length, 'the script should have called the forecast tool').toBeGreaterThan(0)
    const toolId: string = forecastCalls[0].toolId
    // The forecast tool is this test's own, so every call it has on record is this run's.
    const callsOnRecord = async () =>
      (await data<any>(await qa.get(`/organizations/${org.id}/tools/${toolId}/stats?timeframe=hour`))).totalExecutions as number
    expect(await callsOnRecord(), "the script's calls should be on the tool's record").toBeGreaterThanOrEqual(forecastCalls.length)

    await deleteOpenedRun(page, agent.id, runId)

    await expect(page.getByRole('tabpanel', { name: 'Runs' }).getByText('No runs yet')).toBeVisible()
    expect(await runStatus(qa, agent.id, runId)).toBe(404)
    // The scripts are read through their run, so once the run is gone so is
    // every way to them: both the list and the one script answer 404.
    expect((await qa.get(`/agents/${agent.id}/runs/${runId}/code-executions`)).status()).toBe(404)
    expect((await qa.get(`/agents/${agent.id}/runs/${runId}/code-executions/${ran.id}`)).status()).toBe(404)
    // The tool calls the script made went with the run.
    expect(await callsOnRecord(), "the script's tool calls should be deleted with the run").toBe(0)
  })
})

/** Invite a fresh account into the QA org as a plain member; it accepts from its own browser and switches to it. */
async function joinQaOrg(gate: Gate, qa: APIRequestContext, orgId: string, person: FreshUser): Promise<string> {
  await data(await qa.post(`/organizations/${orgId}/members`, { data: { email: person.email, role: 'member' } }))
  const members = await data<any[]>(await qa.get(`/organizations/${orgId}/members`))
  const membership = members.find((m) => m.email === person.email)
  expect(membership, `${person.email} should be listed once invited`).toBeTruthy()
  gate.track('member', membership.userId)

  const { page } = person
  await page.goto(`/invite/accept?membership=${membership.id}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByText(/joined|accepted|welcome/i).first()).toBeVisible({ timeout: 30_000 })
  await page.goto('/dashboard')
  const switcher = page.getByRole('button', { name: /^Switch organization, current: / })
  await switcher.click()
  await page.getByRole('menuitem', { name: new RegExp(`${QA_ORG_NAME}$`) }).click()
  await expect(page.getByRole('button', { name: `Switch organization, current: ${QA_ORG_NAME}` })).toBeVisible({ timeout: 15_000 })
  return membership.userId
}

test.describe('J4 team lead manages a team agent', () => {
  // One throwaway account plays both parts, first outside the team, then as
  // its lead: staging throttles sign-ins per IP, and the gate already signs
  // several fresh accounts in.
  test('J4 a member outside the agent\'s team does not see it; made the team\'s lead, they are offered Delete run', async ({ browser, page, gate, qa, org }, testInfo) => {
    const person = await signUpFresh(browser)
    gate.defer(`fresh user ${person.email}`, () => dropFreshUser(person, testInfo))
    const personId = await joinQaOrg(gate, qa, org.id, person)

    // A team, and the QA user's agent, run once, then given to the team.
    const team = await data<any>(await qa.post(`/organizations/${org.id}/teams`, { data: { name: gate.name('team') } }))
    gate.track('team', team.id)
    const agent = await buildAgent(page, gate, { what: 'team-agent', instructions: ECHO_INSTRUCTIONS })
    await tryIt(page, 'Say hello.')
    const runId = await openLatestRun(page, agent.id)
    await data(await qa.patch(`/agents/${agent.id}`, { data: { visibility: 'team', teamId: team.id } }))

    const theirs = person.page
    screenshotThis(theirs)
    const agentRead = () => theirs.waitForResponse((r) => r.url().endsWith(`/agents/${agent.id}`) && r.request().method() === 'GET')

    // A plain member outside the team: the agent is not theirs to see, let alone manage.
    const outside = agentRead()
    await theirs.goto(`/agents/${agent.id}/runs/${runId}`)
    expect((await outside).status(), 'a member outside the team should not read the agent').toBe(404)
    await expect(theirs.getByRole('button', { name: 'Delete run' })).toHaveCount(0)
    expect((await theirs.request.delete(`${API_URL}/agents/${agent.id}/runs/${runId}`)).ok(), 'nor delete its run').toBe(false)
    expect(await runStatus(qa, agent.id, runId)).toBe(200)

    // Made the team's lead: the agent's page says they may manage it, and its run offers Delete run.
    await data(await qa.post(`/organizations/${org.id}/teams/${team.id}/members`, { data: { userId: personId, role: 'lead' } }))
    const asLead = agentRead()
    await theirs.goto(`/agents/${agent.id}/runs/${runId}`)
    const agentForLead = (await (await asLead).json()).data
    expect(agentForLead.viewerCanManage, 'the team lead may manage the agent').toBe(true)
    const runs = theirs.getByRole('tabpanel', { name: 'Runs' })
    await expect(runs.getByRole('heading', { name: 'Steps' })).toBeVisible({ timeout: 60_000 })
    await expect(runs.getByRole('button', { name: 'Delete run' }), 'the team lead should be offered Delete run').toBeVisible()

    // And the lead's Delete run is honoured by the server.
    await deleteOpenedRun(theirs, agent.id, runId)
    expect(await runStatus(qa, agent.id, runId)).toBe(404)
  })
})