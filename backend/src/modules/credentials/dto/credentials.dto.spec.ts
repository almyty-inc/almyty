import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CreateCredentialDto,
  UpdateCredentialDto,
  CreateAccessKeyDto,
} from './credentials.dto';

async function violations(cls: any, payload: any): Promise<string[]> {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const flat: string[] = [];
  const walk = (errs: any[], prefix = ''): void => {
    for (const e of errs) {
      if (e.constraints) {
        for (const k of Object.keys(e.constraints)) flat.push(`${prefix}${e.property}:${k}`);
      }
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    }
  };
  walk(errors);
  return flat;
}

describe('CreateCredentialDto', () => {
  function base(): Record<string, unknown> {
    return {
      name: 'Stripe API',
      type: 'api_key',
      config: { apiKey: 'sk_live_xxx' },
    };
  }

  it('accepts a minimal valid payload', async () => {
    expect(await violations(CreateCredentialDto, base())).toEqual([]);
  });

  it('accepts visibility=team with a valid UUID teamId', async () => {
    expect(
      await violations(CreateCredentialDto, {
        ...base(),
        visibility: 'team',
        teamId: '550e8400-e29b-41d4-a716-446655440000',
      }),
    ).toEqual([]);
  });

  it('rejects missing required fields', async () => {
    const errs = await violations(CreateCredentialDto, {});
    expect(errs.some((e) => e.startsWith('name:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('type:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('config:'))).toBe(true);
  });

  it('rejects bad visibility values', async () => {
    const errs = await violations(CreateCredentialDto, { ...base(), visibility: 'public' });
    expect(errs).toContain('visibility:isEnum');
  });

  it('rejects non-UUID teamId', async () => {
    const errs = await violations(CreateCredentialDto, { ...base(), teamId: 'not-a-uuid' });
    expect(errs).toContain('teamId:isUuid');
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const errs = await violations(CreateCredentialDto, { ...base(), rogue: 'attack' });
    expect(errs.some((e) => e.startsWith('rogue:'))).toBe(true);
  });
});

describe('UpdateCredentialDto', () => {
  it('accepts an empty patch', async () => {
    expect(await violations(UpdateCredentialDto, {})).toEqual([]);
  });

  it('accepts isActive boolean', async () => {
    expect(await violations(UpdateCredentialDto, { isActive: false })).toEqual([]);
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const errs = await violations(UpdateCredentialDto, { rogue: 'attack' });
    expect(errs.some((e) => e.startsWith('rogue:'))).toBe(true);
  });
});

describe('CreateAccessKeyDto', () => {
  it('accepts a minimal valid payload', async () => {
    expect(await violations(CreateAccessKeyDto, { name: 'CI key' })).toEqual([]);
  });

  it('accepts rate limits within bounds', async () => {
    expect(
      await violations(CreateAccessKeyDto, {
        name: 'CI key',
        rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
      }),
    ).toEqual([]);
  });

  it('rejects missing name', async () => {
    const errs = await violations(CreateAccessKeyDto, {});
    expect(errs.some((e) => e.startsWith('name:'))).toBe(true);
  });

  it('rejects non-positive rate limit values', async () => {
    const errs = await violations(CreateAccessKeyDto, {
      name: 'CI key',
      rateLimits: { requestsPerMinute: 0 },
    });
    expect(errs).toContain('rateLimits.requestsPerMinute:min');
  });

  it('rejects non-UUID gatewayId', async () => {
    const errs = await violations(CreateAccessKeyDto, { name: 'CI key', gatewayId: 'not-a-uuid' });
    expect(errs).toContain('gatewayId:isUuid');
  });
});
