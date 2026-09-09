import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateOrganizationDto } from './update-organization.dto';
import { CreateOrganizationDto } from './create-organization.dto';

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

describe('CreateOrganizationDto admin-field gating', () => {
  it('rejects plan on create (only settable on update by admins)', async () => {
    const errs = await violations(CreateOrganizationDto, { name: 'Acme', plan: 'enterprise' });
    expect(errs.some((e) => e.startsWith('plan:'))).toBe(true);
  });

  it('rejects billingInfo on create', async () => {
    const errs = await violations(CreateOrganizationDto, { name: 'Acme', billingInfo: { card: '4242' } });
    expect(errs.some((e) => e.startsWith('billingInfo:'))).toBe(true);
  });
});

describe('UpdateOrganizationDto', () => {
  it('accepts an empty patch', async () => {
    expect(await violations(UpdateOrganizationDto, {})).toEqual([]);
  });

  it('accepts a plan upgrade', async () => {
    expect(await violations(UpdateOrganizationDto, { plan: 'pro' })).toEqual([]);
  });

  it('rejects an unknown plan tier', async () => {
    const errs = await violations(UpdateOrganizationDto, { plan: 'platinum' });
    expect(errs).toContain('plan:isEnum');
  });

  it('accepts isActive boolean', async () => {
    expect(await violations(UpdateOrganizationDto, { isActive: false })).toEqual([]);
  });

  it('accepts billingInfo as object', async () => {
    expect(await violations(UpdateOrganizationDto, { billingInfo: { customerId: 'cus_xxx' } })).toEqual([]);
  });

  it('accepts planExpiresAt as ISO date', async () => {
    expect(await violations(UpdateOrganizationDto, { planExpiresAt: '2026-12-31T23:59:59.000Z' })).toEqual([]);
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const errs = await violations(UpdateOrganizationDto, { rogue: 'attack' });
    expect(errs.some((e) => e.startsWith('rogue:'))).toBe(true);
  });

  describe('settings.defaultRouting', () => {
    const policy = {
      objective: 'cheapest', privacyTier: 'private_cloud', regions: ['eu-central'], capabilities: { tools: true },
      fallbackChain: ['card-1', 'vendor/model'], pinnedModel: 'card-1', budgetHeadroomCents: 500,
    };

    it('accepts a full policy', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: policy } })).toEqual([]);
    });

    it('accepts null to clear it, and leaves other settings keys alone', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: null, maxApis: 5, pendingInvites: [] } })).toEqual([]);
      expect(await violations(UpdateOrganizationDto, { settings: { maxApis: 5 } })).toEqual([]);
    });

    it('rejects an unknown objective, a bad tier and a non-object', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: { objective: 'random' } } })).toEqual(['settings:organizationSettings']);
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: { privacyTier: 'secret' } } })).toEqual(['settings:organizationSettings']);
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: 'cheapest' } })).toEqual(['settings:organizationSettings']);
    });

    it('rejects non-boolean capabilities, non-string chains, fractional budgets and unknown keys', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: { capabilities: { tools: 'yes' } } } })).toEqual(['settings:organizationSettings']);
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: { fallbackChain: [1] } } })).toEqual(['settings:organizationSettings']);
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: { budgetHeadroomCents: 12.5 } } })).toEqual(['settings:organizationSettings']);
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: { model: 'x' } } })).toEqual(['settings:organizationSettings']);
    });

    it('names the offending field in the message', async () => {
      const dto = plainToInstance(UpdateOrganizationDto, { settings: { defaultRouting: { objective: 'random' } } });
      const [error] = await validate(dto);
      expect(error.constraints?.organizationSettings).toContain('defaultRouting.objective');
    });
  });
});
