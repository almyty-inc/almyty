import { getMetadataStorage, validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'

import { CreateToolBodyDto, UpdateToolBodyDto } from '../tools-controller.dto'
import { ToolType } from '../../../../entities/tool.entity'
import { MAX_GENERATED_DESCRIPTION_LENGTH } from '../../tool-quota'

describe('CreateToolBodyDto / UpdateToolBodyDto length caps', () => {
  it('rejects a CreateToolBodyDto name longer than 100 chars', async () => {
    const dto = plainToInstance(CreateToolBodyDto, {
      name: 'A'.repeat(101),
      description: 'ok',
      type: ToolType.API,
      parameters: {},
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'name')?.constraints).toHaveProperty('maxLength')
  })

  it('accepts a CreateToolBodyDto name of 100 chars', async () => {
    const dto = plainToInstance(CreateToolBodyDto, {
      name: 'A'.repeat(100),
      description: 'ok',
      type: ToolType.API,
      parameters: {},
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'name')).toBeUndefined()
  })

  it('rejects an UpdateToolBodyDto description longer than 1000 chars', async () => {
    const dto = plainToInstance(UpdateToolBodyDto, {
      description: 'x'.repeat(1001),
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'description')?.constraints).toHaveProperty('maxLength')
  })

  // A tool description is shipped to every LLM that lists the tool. Manual
  // create and update are capped at the controller DTO; derived
  // descriptions (schema, MCP, Tool Hub) are truncated at
  // MAX_GENERATED_DESCRIPTION_LENGTH. The manual cap must never be the
  // looser of the two.
  it('rejects a CreateToolBodyDto description longer than 1000 chars (a 1MB one too)', async () => {
    for (const description of ['x'.repeat(1001), 'x'.repeat(1024 * 1024)]) {
      const dto = plainToInstance(CreateToolBodyDto, { name: 'n', description, type: ToolType.API, parameters: {} })
      const errors = await validate(dto)
      expect(errors.find(e => e.property === 'description')?.constraints).toHaveProperty('maxLength')
    }
  })

  it('accepts a description at the cap on create and update', async () => {
    const description = 'x'.repeat(1000)
    const created = plainToInstance(CreateToolBodyDto, { name: 'n', description, type: ToolType.API, parameters: {} })
    const updated = plainToInstance(UpdateToolBodyDto, { description })
    expect((await validate(created)).find(e => e.property === 'description')).toBeUndefined()
    expect((await validate(updated)).find(e => e.property === 'description')).toBeUndefined()
  })

  it('caps manual descriptions no looser than generated ones', () => {
    const caps = [CreateToolBodyDto, UpdateToolBodyDto].map((target) => {
      const meta = getMetadataStorage()
        .getTargetValidationMetadatas(target, '', true, false)
        .find((m) => m.propertyName === 'description' && m.name === 'maxLength')
      return meta?.constraints?.[0]
    })
    for (const cap of caps) {
      expect(typeof cap).toBe('number')
      expect(cap).toBeLessThanOrEqual(MAX_GENERATED_DESCRIPTION_LENGTH)
    }
  })
})