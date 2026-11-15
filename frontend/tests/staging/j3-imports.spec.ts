/**
 * J3: every other kind of API description, each against a real public
 * service with no key, each followed by running one of the tools it made.
 */
import { test, expect } from './support/fixtures'
import { activateTool, connectApi, executeTool, idFromUrl, openApiTools, openTestTool, responseData } from './support/flows'
import type { Page } from '@playwright/test'

const COUNTRIES_GRAPHQL = 'https://countries.trevorblades.com/'
const COUNTRY_INFO_WSDL = 'http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso?WSDL'
// Postman's public gRPC echo service. It speaks plaintext HTTP/2 on port
// 443 and has no published .proto, so the service it reflects is written out
// here. (grpcb.in, used before, stopped answering on every port.)
const ECHO_ADDRESS = 'http://grpc.postman-echo.com:443'
const ECHO_PROTO = `syntax = "proto3";

service HelloService {
  rpc SayHello (HelloRequest) returns (HelloResponse);
}

message HelloRequest {
  string greeting = 1;
}

message HelloResponse {
  string reply = 1;
}
`

/** From the API page, open the generated tool whose identifier ends in `suffix`. */
async function openToolOf(page: Page, apiName: string, suffix: string): Promise<string> {
  await openApiTools(page, apiName)
  // The list pages ten at a time; search narrows it to the one tool.
  await page.getByRole('textbox', { name: 'Search tools...' }).fill(suffix)
  // A row's accessible name starts "Select <tool identifier> <display name> …".
  const match = page.getByRole('row', { name: new RegExp(`^Select \\S+_${suffix} `) })
  await expect(match.first(), `a tool …_${suffix} should have been generated`).toBeVisible()
  await match.first().locator('td').nth(1).click()
  await expect(page).toHaveURL(/\/tools\/[0-9a-f-]{36}/)
  return idFromUrl(page)
}

/** The whole result shown for a successful run, as text. */
async function resultText(page: Page): Promise<string> {
  const panel = page.getByRole('tabpanel', { name: 'Test tool' })
  return JSON.stringify(await responseData(panel))
}

test.describe('J3 import an API of every kind and run a tool', () => {
  test('J3 GraphQL import (Countries) and run a query tool', async ({ page, gate }) => {
    const name = gate.name('countries-graphql')
    await connectApi(page, gate, {
      kind: /^GraphQL/,
      name,
      fill: async (p) => {
        await p.getByRole('textbox', { name: 'Endpoint' }).fill(COUNTRIES_GRAPHQL)
      },
    })
    const toolId = await openToolOf(page, name, 'query_country')
    const panel = await openTestTool(page, toolId)

    // What the service itself says about DE right now.
    const direct = await (await fetch(COUNTRIES_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ country(code: "DE") { name capital } }' }),
    })).json()
    expect(direct.data.country.name).toBe('Germany')

    expect(await executeTool(panel, { code: 'DE' }), 'the country query should succeed').toBe('Success')
    const shown = await resultText(page)
    expect(shown).toContain(direct.data.country.name)
  })

  test('J3 SOAP import (CountryInfo WSDL) and run an operation', async ({ page, gate }) => {
    const name = gate.name('countryinfo-soap')
    await connectApi(page, gate, {
      kind: /^SOAP/,
      name,
      fill: async (p) => {
        await p.getByRole('textbox', { name: 'Link to the WSDL' }).fill(COUNTRY_INFO_WSDL)
      },
    })
    const toolId = await openToolOf(page, name, 'capital_city')
    const panel = await openTestTool(page, toolId)
    expect(await executeTool(panel, { sCountryISOCode: 'DE' }), 'CapitalCity should succeed').toBe('Success')
    expect(await resultText(page)).toContain('Berlin')
  })

  test('J3 gRPC import (echo service proto) and run a unary call', async ({ page, gate }) => {
    const name = gate.name('grpc-echo')
    await connectApi(page, gate, {
      kind: /^gRPC/,
      name,
      fill: async (p) => {
        await p.getByRole('tab', { name: 'Paste' }).click()
        await p.getByRole('main').getByRole('textbox').first().fill(ECHO_PROTO)
        await p.getByRole('button', { name: 'Advanced' }).click()
        await p.getByRole('textbox', { name: 'Address' }).fill(ECHO_ADDRESS)
      },
    })
    const toolId = await openToolOf(page, name, 'say_hello')
    const panel = await openTestTool(page, toolId)
    const marker = `${gate.runId}-echo`
    // HelloRequest's fields are what a caller fills in.
    await expect(
      panel.getByRole('textbox', { name: 'Enter greeting', exact: true }),
      'the request message fields (HelloRequest.greeting) should be tool inputs',
    ).toBeVisible()
    expect(await executeTool(panel, { greeting: marker }), 'SayHello should succeed').toBe('Success')
    // The echo service answers "hello <greeting>".
    expect(await resultText(page)).toContain(`hello ${marker}`)
  })

  test('J3 SDK import (npm slugify) and run its function', async ({ page, gate }) => {
    const name = gate.name('slugify-sdk')
    await page.goto('/apis/new')
    await page.getByRole('button', { name: /^SDK/ }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
    await page.getByRole('textbox', { name: 'Package name' }).fill('slugify')
    await page.getByRole('button', { name: 'Add package' }).click()
    await page.getByRole('button', { name: 'Connect API' }).click()
    await expect(page).toHaveURL(/\/apis\/[0-9a-f-]{36}$/, { timeout: 180_000 })
    gate.track('api', idFromUrl(page))
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    // The package was analysed from the npm registry.
    await expect(page.getByText(/\d+ methods? to build tools from/)).toBeVisible({ timeout: 120_000 })

    // An SDK API offers its functions; the tool is made from one of them.
    await page.getByRole('link', { name: 'Create a tool' }).click()
    await expect(page.getByRole('combobox', { name: 'Execution method' })).toHaveText('SDK / npm package')
    await page.getByRole('textbox', { name: 'Tool name' }).fill(gate.ident('slugify'))
    await page.getByRole('combobox', { name: 'Package' }).click()
    await page.getByRole('option', { name: /^slugify v/ }).click()
    await page.getByRole('combobox', { name: 'Class / export' }).click()
    await page.getByRole('option', { name: 'default function' }).click()
    await page.getByRole('combobox', { name: 'Method', exact: true }).click()
    await page.getByRole('option').first().click()
    await expect(page.getByRole('textbox', { name: 'Parameter name' }).first()).toHaveValue('string')
    await page.getByRole('button', { name: 'Create tool' }).click()
    await expect(page).toHaveURL(/\/tools\/[0-9a-f-]{36}/, { timeout: 60_000 })
    const toolId = idFromUrl(page)
    gate.track('tool', toolId)
    await activateTool(page)

    const panel = await openTestTool(page, toolId)
    expect(await executeTool(panel, { string: 'Gate Run Hello World' }), 'slugify should succeed').toBe('Success')
    expect(await resultText(page)).toContain('Gate-Run-Hello-World')
  })
})
