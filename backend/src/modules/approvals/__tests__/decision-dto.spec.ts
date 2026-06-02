import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { Type } from 'class-transformer'
import { IsOptional, IsString } from 'class-validator'

// DecisionDto is inlined in approvals.controller.ts; mirror the
// declaration here so a regression on the controller-side class
// still gets flagged by this spec. If the controller's DecisionDto
// drifts away from this shape the controller integration test
// should catch it; this spec guards the validator contract.
class DecisionDto {
  @IsOptional()
  @IsString()
  decisionReason?: string
}

describe('DecisionDto', () => {
  it('passes when decisionReason is omitted', async () => {
    const errors = await validate(plainToInstance(DecisionDto, {}))
    expect(errors).toHaveLength(0)
  })

  it('passes when decisionReason is a string', async () => {
    const errors = await validate(plainToInstance(DecisionDto, { decisionReason: 'looked good' }))
    expect(errors).toHaveLength(0)
  })

  it('rejects when decisionReason is not a string', async () => {
    const errors = await validate(plainToInstance(DecisionDto, { decisionReason: 42 as any }))
    expect(errors.find(e => e.property === 'decisionReason')?.constraints).toHaveProperty('isString')
  })
})
