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

  // plan, billingInfo and planExpiresAt are written by the Stripe webhook
  // (and referrals), never by the org's own admins. billingInfo holds the
  // signed licenseToken and the Stripe customer id: accepting it here let an
  // org admin paste another org's token to self-grant its entitlements, or
  // point the org at someone else's Stripe customer and open their portal.
  it.each([
    ['plan', { plan: 'enterprise' }],
    ['billingInfo', { billingInfo: { licenseToken: 'copied.token', stripeCustomerId: 'cus_victim' } }],
    ['planExpiresAt', { planExpiresAt: '2099-12-31T23:59:59.000Z' }],
  ])('rejects the billing-owned field %s', async (field, payload) => {
    const errs = await violations(UpdateOrganizationDto, payload);
    expect(errs.some((e) => e.startsWith(`${field}:`))).toBe(true);
  });

  it('accepts isActive boolean', async () => {
    expect(await violations(UpdateOrganizationDto, { isActive: false })).toEqual([]);
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

    it('accepts null to clear it', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: { defaultRouting: null } })).toEqual([]);
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

  describe('settings.egressAllowlist', () => {
    // The value decides whether a private host may be reached, so a bad
    // shape is worth refusing at the edge rather than discovering when
    // the gate reads it.
    it('accepts a list of hosts, including a wildcard', async () => {
      expect(
        await violations(UpdateOrganizationDto, { settings: { egressAllowlist: ['localhost', '10.0.0.5', '*.internal.acme.test'] } }),
      ).toEqual([]);
    });

    it('accepts it being absent or empty', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: {} })).toEqual([]);
      expect(await violations(UpdateOrganizationDto, { settings: { egressAllowlist: [] } })).toEqual([]);
    });

    it('refuses a bare string, which would make .some() iterate characters', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: { egressAllowlist: 'localhost' } })).not.toEqual([]);
    });

    it('refuses a URL, and says so, because it would silently never match a host', async () => {
      const dto = plainToInstance(UpdateOrganizationDto, {
        settings: { egressAllowlist: ['http://10.0.0.5:8000/v1'] },
      });
      const [error] = await validate(dto);
      expect(error.constraints?.organizationSettings).toContain('hosts, not URLs');
    });

    it('refuses an empty entry', async () => {
      expect(await violations(UpdateOrganizationDto, { settings: { egressAllowlist: ['  '] } })).not.toEqual([]);
    });
  });

  // The limits are the plan's. An org admin holds PATCH on the org, so
  // these used to be a self-service upgrade: settings.maxTools = 100000.
  describe('settings keys an admin may not write', () => {
    it.each([
      ['maxTools', { maxTools: 100000 }],
      ['maxApis', { maxApis: 100000 }],
      ['maxGateways', { maxGateways: 100000 }],
      ['pendingInvites', { pendingInvites: [{ email: 'x@y.z', inviteToken: 'chosen' }] }],
      ['an unknown key', { someFutureLimit: 1 }],
    ])('refuses %s on update and on create', async (_name, settings) => {
      expect(await violations(UpdateOrganizationDto, { settings })).toEqual(['settings:organizationSettings']);
      expect(await violations(CreateOrganizationDto, { name: 'Acme', settings })).toEqual(['settings:organizationSettings']);
    });

    it('says the limits come from the plan', async () => {
      const dto = plainToInstance(UpdateOrganizationDto, { settings: { defaultRouting: null, maxTools: 5 } });
      const [error] = await validate(dto);
      expect(error.constraints?.organizationSettings).toContain('settings.maxTools cannot be changed here');
    });

    it('still takes every writable key', async () => {
      expect(
        await violations(UpdateOrganizationDto, {
          settings: { defaultRouting: null, egressAllowlist: ['localhost'], allowUserScopedConnections: false },
        }),
      ).toEqual([]);
      expect(await violations(UpdateOrganizationDto, { settings: { allowUserScopedConnections: 'yes' } })).toEqual([
        'settings:organizationSettings',
      ]);
    });
  });
});
