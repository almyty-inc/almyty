import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'

import { CreateGatewayBodyDto, UpdateGatewayBodyDto } from '../controller-body.dto'
import { GatewayType } from '../../../../entities/gateway.entity'

describe('CreateGatewayBodyDto / UpdateGatewayBodyDto length caps', () => {
  it('rejects name longer than 100 chars on create', async () => {
    const dto = plainToInstance(CreateGatewayBodyDto, {
      name: 'A'.repeat(101),
      type: GatewayType.MCP,
      endpoint: '/g',
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'name')?.constraints).toHaveProperty('maxLength')
  })

  it('rejects description longer than 1000 chars on update', async () => {
    const dto = plainToInstance(UpdateGatewayBodyDto, {
      description: 'x'.repeat(1001),
    })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'description')?.constraints).toHaveProperty('maxLength')
  })
})
