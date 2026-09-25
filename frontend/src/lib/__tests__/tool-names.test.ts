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
