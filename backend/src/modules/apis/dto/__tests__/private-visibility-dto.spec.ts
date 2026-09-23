import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { CreateApiDto, UpdateApiDto, CreateHttpApiDto, CreateSdkApiDto } from '../api.dto';
import { CreateAgentDto } from '../../../agents/dto/create-agent.dto';
import { UpdateAgentDto } from '../../../agents/dto/update-agent.dto';
import { CreateToolBodyDto, UpdateToolBodyDto } from '../../../tools/dto/tools-controller.dto';
import { ApiType } from '../../../../entities/api.entity';
import { ToolType } from '../../../../entities/tool.entity';

// The "Private (just me)" choice in the dashboard's VisibilityField sends
// visibility='private'. With forbidNonWhitelisted validation a DTO that
// only knew org/team would 400 the whole create/edit.
describe('agent / tool / API DTOs accept visibility="private"', () => {
  const cases: Array<[string, any, any]> = [
    ['CreateApiDto', CreateApiDto, { name: 'a', type: ApiType.OPENAPI, baseUrl: 'https://x.com' }],
    ['UpdateApiDto', UpdateApiDto, {}],
    ['CreateHttpApiDto', CreateHttpApiDto, { name: 'a', baseUrl: 'https://x.com' }],
    ['CreateSdkApiDto', CreateSdkApiDto, { name: 'a', dependencies: { lodash: '^4' } }],
    ['CreateAgentDto', CreateAgentDto, { name: 'a' }],
    ['UpdateAgentDto', UpdateAgentDto, {}],
    ['CreateToolBodyDto', CreateToolBodyDto, { name: 'a', description: 'a', type: ToolType.API, parameters: {} }],
    ['UpdateToolBodyDto', UpdateToolBodyDto, {}],
  ];

  it.each(cases)('%s accepts private', async (_n, Dto, base) => {
    const errors = await validate(plainToInstance(Dto, { ...base, visibility: 'private', teamId: null }));
    expect(errors.find((e) => e.property === 'visibility')).toBeUndefined();
  });

  it.each(cases)('%s still rejects anything else', async (_n, Dto, base) => {
    const errors = await validate(plainToInstance(Dto, { ...base, visibility: 'public' }));
    expect(errors.find((e) => e.property === 'visibility')).toBeDefined();
  });
});
