import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateHttpApiDto, CreateSdkApiDto } from './api.dto';

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

describe('CreateHttpApiDto', () => {
  function base(): Record<string, unknown> {
    return { name: 'Stripe', baseUrl: 'https://api.stripe.com' };
  }

  it('accepts a minimal valid payload', async () => {
    expect(await violations(CreateHttpApiDto, base())).toEqual([]);
  });

  it('rejects missing required fields', async () => {
    const errs = await violations(CreateHttpApiDto, {});
    expect(errs.some((e) => e.startsWith('name:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('baseUrl:'))).toBe(true);
  });

  it('rejects non-http baseUrl', async () => {
    const errs = await violations(CreateHttpApiDto, { ...base(), baseUrl: 'ftp://x.com' });
    expect(errs.some((e) => e.startsWith('baseUrl:'))).toBe(true);
  });

  it('rejects an oversize name', async () => {
    const errs = await violations(CreateHttpApiDto, { ...base(), name: 'x'.repeat(101) });
    expect(errs).toContain('name:maxLength');
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const errs = await violations(CreateHttpApiDto, { ...base(), rogue: 'attack' });
    expect(errs.some((e) => e.startsWith('rogue:'))).toBe(true);
  });
});

describe('CreateSdkApiDto', () => {
  function base(): Record<string, unknown> {
    return { name: 'Stripe SDK', dependencies: { stripe: '^14.0.0' } };
  }

  it('accepts a minimal valid payload', async () => {
    expect(await violations(CreateSdkApiDto, base())).toEqual([]);
  });

  it('rejects missing dependencies', async () => {
    const errs = await violations(CreateSdkApiDto, { name: 'Stripe SDK' });
    expect(errs.some((e) => e.startsWith('dependencies:'))).toBe(true);
  });

  it('rejects missing name', async () => {
    const errs = await violations(CreateSdkApiDto, { dependencies: { stripe: '^14.0.0' } });
    expect(errs.some((e) => e.startsWith('name:'))).toBe(true);
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const errs = await violations(CreateSdkApiDto, { ...base(), rogue: 'attack' });
    expect(errs.some((e) => e.startsWith('rogue:'))).toBe(true);
  });
});
