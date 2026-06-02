import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'

import { CreateApiDto, UpdateApiDto } from '../api.dto'
import { CreateAgentDto } from '../../../agents/dto/create-agent.dto'
import { UpdateAgentDto } from '../../../agents/dto/update-agent.dto'
import { CreateGatewayBodyDto, UpdateGatewayBodyDto } from '../../../gateways/dto/controller-body.dto'
import { CreateLlmProviderBodyDto, UpdateLlmProviderBodyDto } from '../../../llm-providers/dto/llm-providers-controller.dto'
import { CreateToolBodyDto, UpdateToolBodyDto } from '../../../tools/dto/tools-controller.dto'
import { ApiType } from '../../../../entities/api.entity'
import { GatewayType } from '../../../../entities/gateway.entity'
import { LlmProviderType } from '../../../../entities/llm-provider.entity'
import { ToolType } from '../../../../entities/tool.entity'

// Regression for #106 and #107: the team-scoping fields sent by the
// dashboard's VisibilityField component (visibility + teamId) used
// to be missing from these DTOs. Because the ValidationPipe runs
// with forbidNonWhitelisted=true, the request 400'd with
// "property visibility should not exist". This spec freezes the
// whitelist behavior so a future DTO refactor can't silently drop
// the fields and ship another mass 400 regression.

const minimalApi = { name: 'a', type: ApiType.OPENAPI, baseUrl: 'https://x.com' }
const minimalAgent = { name: 'a' }
const minimalGateway = { name: 'a', type: GatewayType.MCP, endpoint: '/x' }
const minimalLlm = { name: 'a', type: LlmProviderType.OPENAI, configuration: { apiKey: 'sk' } }
const minimalTool = { name: 'a', description: 'a', type: ToolType.API, parameters: {} }

describe('team-scoping whitelist (visibility + teamId)', () => {
  const cases: Array<[string, any, any]> = [
    ['CreateApiDto', CreateApiDto, minimalApi],
    ['UpdateApiDto', UpdateApiDto, {}],
    ['CreateAgentDto', CreateAgentDto, minimalAgent],
    ['UpdateAgentDto', UpdateAgentDto, {}],
    ['CreateGatewayBodyDto', CreateGatewayBodyDto, minimalGateway],
    ['UpdateGatewayBodyDto', UpdateGatewayBodyDto, {}],
    ['CreateLlmProviderBodyDto', CreateLlmProviderBodyDto, minimalLlm],
    ['UpdateLlmProviderBodyDto', UpdateLlmProviderBodyDto, {}],
    ['CreateToolBodyDto', CreateToolBodyDto, minimalTool],
    ['UpdateToolBodyDto', UpdateToolBodyDto, {}],
  ]

  it.each(cases)('%s accepts visibility="org" and teamId=null', async (_n, Dto, base) => {
    const dto = plainToInstance(Dto, { ...base, visibility: 'org', teamId: null })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'visibility')).toBeUndefined()
    expect(errors.find(e => e.property === 'teamId')).toBeUndefined()
  })

  it.each(cases)('%s accepts visibility="team" with a teamId string', async (_n, Dto, base) => {
    const dto = plainToInstance(Dto, { ...base, visibility: 'team', teamId: 'team-uuid' })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'visibility')).toBeUndefined()
    expect(errors.find(e => e.property === 'teamId')).toBeUndefined()
  })

  it.each(cases)('%s rejects visibility values outside org/team', async (_n, Dto, base) => {
    const dto = plainToInstance(Dto, { ...base, visibility: 'public' })
    const errors = await validate(dto)
    expect(errors.find(e => e.property === 'visibility')?.constraints).toHaveProperty('isEnum')
  })
})
