import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'

import { CreateApiDto, UpdateApiDto } from '../api.dto'

describe('CreateApiDto / UpdateApiDto length caps', () => {
  it('rejects a name longer than 100 chars', async () => {
    const dto = plainToInstance(CreateApiDto, {
      name: 'A'.repeat(101),
      type: 'openapi',
      baseUrl: 'https://example.com',
    })

    const errors = await validate(dto)
    const nameErrors = errors.find(e => e.property === 'name')
    expect(nameErrors).toBeDefined()
    expect(nameErrors!.constraints).toHaveProperty('maxLength')
  })

  it('accepts a name of exactly 100 chars', async () => {
    const dto = plainToInstance(CreateApiDto, {
      name: 'A'.repeat(100),
      type: 'openapi',
      baseUrl: 'https://example.com',
    })

    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'name')).toBeUndefined()
  })

  it('rejects a description longer than 1000 chars on UpdateApiDto', async () => {
    const dto = plainToInstance(UpdateApiDto, {
      description: 'x'.repeat(1001),
    })

    const errors = await validate(dto)
    const descErrors = errors.find(e => e.property === 'description')
    expect(descErrors).toBeDefined()
    expect(descErrors!.constraints).toHaveProperty('maxLength')
  })
})
