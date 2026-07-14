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

  it('accepts an optional configuration.usageApiKey on create (issue #241)', async () => {
    const dto = plainToInstance(CreateLlmProviderBodyDto, {
      name: 'OpenAI Prod',
      type: LlmProviderType.OPENAI,
      configuration: { apiKey: 'sk-inference', usageApiKey: 'sk-admin-usage' },
    })
    const errors = await validate(dto, { whitelist: true })
    expect(errors).toHaveLength(0)
    expect(dto.configuration.usageApiKey).toBe('sk-admin-usage')
  })

  it('accepts an optional configuration.usageApiKey on update (issue #241)', async () => {
    const dto = plainToInstance(UpdateLlmProviderBodyDto, {
      configuration: { usageApiKey: 'sk-ant-admin-usage' },
    })
    const errors = await validate(dto, { whitelist: true })
    expect(errors).toHaveLength(0)
    expect(dto.configuration?.usageApiKey).toBe('sk-ant-admin-usage')
  })

  it('rejects description longer than 1000 chars on update', async () => {
    const dto = plainToInstance(UpdateLlmProviderBodyDto, {
      description: 'x'.repeat(1001),
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'description')?.constraints).toHaveProperty('maxLength')
  })
})
