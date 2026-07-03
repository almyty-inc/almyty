import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { GatewaySearchQueryDto } from '../dto/controller-body.dto';

/**
 * Regression: the agent-detail Interfaces tab queries
 * GET /gateways?kind=agent&agentId=<uuid>. These two params were missing
 * from the search DTO, so the global forbidNonWhitelisted pipe 400'd the
 * request and "Deployed Channels" rendered permanently empty.
 */
describe('GatewaySearchQueryDto', () => {
  it('accepts kind + agentId (the Interfaces tab query)', async () => {
    const dto = plainToInstance(GatewaySearchQueryDto, {
      kind: 'agent',
      agentId: '017466e6-92e0-4334-929c-47384399505c',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-uuid agentId and unknown kinds', async () => {
    const bad = plainToInstance(GatewaySearchQueryDto, { kind: 'bogus', agentId: 'nope' });
    const errors = await validate(bad, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});
