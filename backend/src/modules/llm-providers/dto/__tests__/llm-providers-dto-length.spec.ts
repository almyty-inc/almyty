import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'

import { CreateLlmProviderBodyDto, UpdateLlmProviderBodyDto } from '../llm-providers-controller.dto'
import { LlmProviderType } from '../../../../entities/llm-provider.entity'

describe('CreateLlmProviderBodyDto / UpdateLlmProviderBodyDto length caps', () => {
  it('rejects name longer than 100 chars on create', async () => {
    const dto = plainToInstance(CreateLlmProviderBodyDto, {
      name: 'A'.repeat(101),
      type: LlmProviderType.OPENAI,
      configuration: { apiKey: 'sk' },
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'name')?.constraints).toHaveProperty('maxLength')
  })

  it('rejects description longer than 1000 chars on update', async () => {
    const dto = plainToInstance(UpdateLlmProviderBodyDto, {
      description: 'x'.repeat(1001),
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'description')?.constraints).toHaveProperty('maxLength')
  })
})
