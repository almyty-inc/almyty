import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'

import { CreateToolBodyDto, UpdateToolBodyDto } from '../tools-controller.dto'
import { ToolType } from '../../../../entities/tool.entity'

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
})
