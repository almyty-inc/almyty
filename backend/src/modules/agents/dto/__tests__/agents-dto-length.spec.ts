import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'

import { CreateAgentDto } from '../create-agent.dto'
import { UpdateAgentDto } from '../update-agent.dto'

describe('CreateAgentDto / UpdateAgentDto length caps', () => {
  it('rejects name longer than 100 chars on create', async () => {
    const dto = plainToInstance(CreateAgentDto, { name: 'A'.repeat(101) })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'name')?.constraints).toHaveProperty('maxLength')
  })

  it('accepts name of 100 chars on create', async () => {
    const dto = plainToInstance(CreateAgentDto, { name: 'A'.repeat(100) })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'name')).toBeUndefined()
  })

  it('rejects description longer than 1000 chars on update', async () => {
    const dto = plainToInstance(UpdateAgentDto, { description: 'x'.repeat(1001) })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'description')?.constraints).toHaveProperty('maxLength')
  })
})
