import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateGatewayBodyDto, UpdateGatewayBodyDto } from '../dto/controller-body.dto';

/**
 * A person pauses or resumes a gateway, nothing else: 'error' is the health
 * check's verdict and 'maintenance' had no behaviour of its own. And the
 * Share tools page sends the picked tools as ids.
 */
describe('gateway body DTOs', () => {
  const errorsOf = async (cls: any, body: Record<string, unknown>) =>
    (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

  it.each(['active', 'inactive'])('accepts status %s on update', async (status) => {
    expect(await errorsOf(UpdateGatewayBodyDto, { status })).toEqual([]);
  });

  it.each(['maintenance', 'error', 'paused', ''])('refuses status %j on update', async (status) => {
    expect(await errorsOf(UpdateGatewayBodyDto, { status })).toEqual(['status']);
  });

  const create = { name: 'Weather', type: 'tools', endpoint: '/weather', configuration: {} };

  it('accepts a shared-tools gateway with picked tool ids', async () => {
    expect(await errorsOf(CreateGatewayBodyDto, { ...create, toolIds: ['0d000000-0000-4000-8000-000000000001'] })).toEqual([]);
  });

  it('refuses tool ids that are not ids', async () => {
    expect(await errorsOf(CreateGatewayBodyDto, { ...create, toolIds: ['get_weather'] })).toEqual(['toolIds']);
    expect(await errorsOf(CreateGatewayBodyDto, { ...create, toolIds: 'x' })).toEqual(['toolIds']);
  });
});
