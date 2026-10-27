import { describe, expect, it } from 'vitest'

import { humanizeIdentifier, readableToolName } from '../tool-names'

const petstore = { id: 'api-p', name: 'Swagger Petstore - OpenAPI 3.0' }

describe('readableToolName', () => {
  it("prefers the operation's summary", () => {
    expect(readableToolName({ name: 'swagger_petstore_openapi_3_0_get_pet_by_id', operation: { name: 'Find pet by ID.', api: petstore } })).toBe('Find pet by ID')
  })

  it('drops the API prefix and puts the operation in words', () => {
    expect(readableToolName({ name: 'swagger_petstore_openapi_3_0_place_order', api: petstore })).toBe('Place order')
    expect(readableToolName({ name: 'swagger_petstore_openapi_3_0_place_order', operation: { name: 'placeOrder', api: petstore } })).toBe('Place order')
  })

  it('does not take a method and path, or an operationId, for a summary', () => {
    expect(readableToolName({ name: 'get_pets_by_id', operation: { name: 'GET /pets/{id}' } })).toBe('Get pets by id')
  })

  it('reads camelCase and leaves a name people wrote alone', () => {
    expect(readableToolName({ name: 'weatherNow' })).toBe('Weather now')
    expect(readableToolName({ name: 'Weather report' })).toBe('Weather report')
    expect(readableToolName({ name: 'weather' })).toBe('weather')
  })
})

describe('humanizeIdentifier', () => {
  it('turns snake, kebab and camel case into a sentence', () => {
    expect(humanizeIdentifier('place_order')).toBe('Place order')
    expect(humanizeIdentifier('list-all-pets')).toBe('List all pets')
    expect(humanizeIdentifier('getPetById')).toBe('Get pet by id')
  })
})

describe('tools from specs without summaries', () => {
  it('reads the description, and treats a dotted method id as a machine name', () => {
    // The tool picker, the ask-first list and approvals showed
    // "hubspot_deals_post_crm_v3_objects_0_3_search_do_search" and "gmail.users.messages.send".
    expect(readableToolName({ name: 'gmail_gmail_users_messages_list', description: "Lists the messages in the user's mailbox." })).toBe(
      "Lists the messages in the user's mailbox",
    )
    expect(readableToolName({ name: 'google_tasks_tasks_tasks_list', api: { name: 'Google Tasks' }, operation: { name: 'tasks.tasks.list' } })).toBe('Tasks tasks list')
  })

  it("leaves a description's markdown out of the name", () => {
    expect(readableToolName({ name: 'gmail_gmail_users_messages_send', description: 'Sends the specified message to the recipients in the `To`, `Cc`, and `Bcc` headers. For example usage, see Sending email.' })).toBe(
      'Sends the specified message to the recipients in the To, Cc, and Bcc headers',
    )
  })
})

describe('the name generation chose', () => {
  // HubSpot's tools showed "GET /crm/v3/owners operation" and
  // "Get crm v3 objects companies company id 937ca5".
  it('is used when the tool has one', () => {
    expect(readableToolName({
      name: 'hubspot_companies_get_crm_v3_objects_companies_company_id_937ca5',
      description: 'GET /crm/v3/objects/companies/{companyId} operation',
      metadata: { displayName: 'Get company by id' },
    })).toBe('Get company by id')
  })

  it('without one, a generated "METHOD /path operation" description is not a name and the hash is dropped', () => {
    expect(readableToolName({ name: 'hubspot_owners_get_crm_v3_owners', api: { name: 'HubSpot Owners' }, description: 'GET /crm/v3/owners operation' })).toBe('Get crm v3 owners')
    expect(readableToolName({
      name: 'hubspot_companies_get_crm_v3_objects_companies_company_id_937ca5',
      api: { name: 'HubSpot Companies' },
      description: 'GET /crm/v3/objects/companies/{companyId} operation',
    })).toBe('Get crm v3 objects companies company id')
  })
})
