import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CustomDomainService,
  CustomDomainStore,
  TxtResolver,
} from '../custom-domain.service';
import { CustomDomainConfig, VERIFICATION_VALUE_PREFIX } from '../custom-domain';

/**
 * Custom domains for hosted chat: claim, publish TXT, verify, serve.
 *
 * The store double below holds gateway rows and enforces the same two
 * rules the Postgres store does -- a compare-and-set on the claim that was
 * checked, and at most one ACTIVE row per hostname across every
 * organization (UQ_gateways_custom_domain_active). The SQL itself is
 * exercised against a real database in
 * test/integration/custom-domain-store.integration.spec.ts.
 */

interface Row {
  id: string;
  organizationId: string;
  type: string;
  configuration: Record<string, any>;
}

class MemoryStore implements CustomDomainStore {
  constructor(readonly rows: Map<string, Row>) {}

  async write(gatewayId: string, organizationId: string, block: CustomDomainConfig | null) {
    const row = this.rows.get(gatewayId);
    if (!row || row.organizationId !== organizationId) return;
    if (block) row.configuration = { ...row.configuration, customDomain: { ...block } };
    else {
      const { customDomain: _gone, ...rest } = row.configuration;
      row.configuration = rest;
    }
  }

  async replaceClaim(
    gatewayId: string,
    organizationId: string,
    current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>,
    next: CustomDomainConfig,
  ) {
    const row = this.rows.get(gatewayId);
    const stored = row?.configuration.customDomain;
    if (!row || row.organizationId !== organizationId || stored?.hostname !== current.hostname || stored?.verificationToken !== current.verificationToken) {
      return 'stale' as const;
    }
    if (next.status === 'active' && (await this.activeElsewhere(next.hostname, gatewayId))) return 'conflict' as const;
    row.configuration = { ...row.configuration, customDomain: { ...next } };
    return 'ok' as const;
  }

  async activeElsewhere(hostname: string, exceptGatewayId: string) {
    return [...this.rows.values()].some(
      (r) =>
        r.id !== exceptGatewayId &&
        r.type === 'hosted_chat' &&
        r.configuration.customDomain?.status === 'active' &&
        r.configuration.customDomain?.hostname === hostname,
    );
  }
}

function harness(opts: { txt?: Record<string, string[]>; resolver?: TxtResolver } = {}) {
  const rows = new Map<string, Row>([
    ['gw-a', { id: 'gw-a', organizationId: 'org-a', type: 'hosted_chat', configuration: { hostedChat: { slug: 'acme' } } }],
    ['gw-b', { id: 'gw-b', organizationId: 'org-b', type: 'hosted_chat', configuration: { hostedChat: { slug: 'bravo' } } }],
    ['gw-w', { id: 'gw-w', organizationId: 'org-a', type: 'chat_widget', configuration: {} }],
  ]);
  const store = new MemoryStore(rows);
  const txt = opts.txt ?? {};
  const resolver: TxtResolver =
    opts.resolver ??
    (async (name) => {
      const values = txt[name];
      if (!values) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return values.map((v) => [v]);
    });
  // GatewaysService.findManageable's contract: org-scoped, manage right required.
  const gatewaysService = {
    findManageable: async (id: string, organizationId: string, userId: string) => {
      const row = rows.get(id);
      if (!row || row.organizationId !== organizationId) throw new NotFoundException('Gateway not found');
      if (userId === 'viewer') throw new ForbiddenException('not allowed');
      return JSON.parse(JSON.stringify(row));
    },
  };
  const service = new CustomDomainService(gatewaysService as any, store, resolver);
  const publish = (name: string, token: string) => {
    txt[name] = [...(txt[name] ?? []), `${VERIFICATION_VALUE_PREFIX}${token}`];
  };
  return { service, rows, store, txt, publish };
}

const block = (rows: Map<string, Row>, id: string): CustomDomainConfig => rows.get(id)!.configuration.customDomain;

describe('CustomDomainService', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    delete process.env.HOSTED_CHAT_CUSTOM_DOMAIN_TARGET;
    process.env.HOSTED_CHAT_BASE_DOMAIN = 'almyty.app';
  });
  afterAll(() => {
    process.env = OLD;
  });

  it('claims a hostname unverified and shows the TXT and CNAME records to publish', async () => {
    const { service, rows } = harness();
    const view = await service.set('gw-a', 'org-a', 'u1', ' Chat.Acme.com ');
    expect(view.status).toBe('pending_verification');
    expect(view.records.txt).toEqual({
      type: 'TXT',
      name: '_almyty-verify.chat.acme.com',
      value: `${VERIFICATION_VALUE_PREFIX}${block(rows, 'gw-a').verificationToken}`,
    });
    expect(view.records.cname).toEqual({ type: 'CNAME', name: 'chat.acme.com', value: 'acme.almyty.app' });
    expect(block(rows, 'gw-a').status).toBe('pending_verification');
  });

  it('serves the hostname only once its TXT record proves control', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');

    const notYet = await service.verify('gw-a', 'org-a', 'u1');
    expect(notYet.status).toBe('failed');
    expect(notYet.lastError).toMatch(/No TXT record/);
    expect(block(rows, 'gw-a').status).not.toBe('active');

    publish('_almyty-verify.chat.acme.com', 'not-the-token');
    expect((await service.verify('gw-a', 'org-a', 'u1')).lastError).toMatch(/did not match/);
    expect(block(rows, 'gw-a').status).not.toBe('active');

    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    const live = await service.verify('gw-a', 'org-a', 'u1');
    expect(live.status).toBe('active');
    expect(live.verifiedAt).toEqual(expect.any(String));
    expect(block(rows, 'gw-a').status).toBe('active');
  });

  it('a changed domain starts over: new token, unverified, the old name no longer served', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    const firstToken = block(rows, 'gw-a').verificationToken;
    publish('_almyty-verify.chat.acme.com', firstToken);
    await service.verify('gw-a', 'org-a', 'u1');

    const moved = await service.set('gw-a', 'org-a', 'u1', 'help.acme.com');
    expect(moved.status).toBe('pending_verification');
    expect(block(rows, 'gw-a').hostname).toBe('help.acme.com');
    expect(block(rows, 'gw-a').verificationToken).not.toBe(firstToken);
    expect(block(rows, 'gw-a').verifiedAt).toBeNull();
    // The old proof does not carry over to the new name.
    expect((await service.verify('gw-a', 'org-a', 'u1')).status).toBe('failed');
  });

  it('setting the hostname a surface already holds changes nothing', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');
    const before = { ...block(rows, 'gw-a') };
    await service.set('gw-a', 'org-a', 'u1', 'CHAT.acme.com');
    expect(block(rows, 'gw-a')).toEqual(before);
  });

  it('one live owner per hostname, across organizations', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.shared.com');
    await service.set('gw-b', 'org-b', 'u2', 'chat.shared.com');
    // Both tokens published (say the domain changed hands mid-flight).
    publish('_almyty-verify.chat.shared.com', block(rows, 'gw-a').verificationToken);
    publish('_almyty-verify.chat.shared.com', block(rows, 'gw-b').verificationToken);

    await expect(service.verify('gw-a', 'org-a', 'u1')).resolves.toMatchObject({ status: 'active' });
    await expect(service.verify('gw-b', 'org-b', 'u2')).rejects.toBeInstanceOf(ConflictException);
    expect(block(rows, 'gw-b').status).toBe('failed');
    expect(block(rows, 'gw-b').lastError).toMatch(/already serving/);

    // And a new claim on a name someone serves is refused up front.
    await service.set('gw-b', 'org-b', 'u2', 'other.example.com');
    await expect(service.set('gw-b', 'org-b', 'u2', 'chat.shared.com')).rejects.toBeInstanceOf(ConflictException);
  });

  it('a domain whose record disappeared stops being served; a DNS hiccup does not unpublish it', async () => {
    const { service, rows, publish, txt } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');

    delete txt['_almyty-verify.chat.acme.com'];
    expect((await service.verify('gw-a', 'org-a', 'u1')).status).toBe('failed');

    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');
    const flaky = harness({
      resolver: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
    });
    flaky.rows.get('gw-a')!.configuration.customDomain = { ...block(rows, 'gw-a') };
    const view = await flaky.service.verify('gw-a', 'org-a', 'u1');
    expect(view.status).toBe('active');
    expect(view.lastError).toMatch(/Could not read DNS/);
  });

  it('never activates on the proof of a claim that changed while it was checked', async () => {
    let service!: CustomDomainService;
    const h = harness({
      resolver: async () => {
        // The tenant repoints the surface while our lookup is in flight.
        await service.set('gw-a', 'org-a', 'u1', 'other.acme.com');
        return [[`${VERIFICATION_VALUE_PREFIX}${stale}`]];
      },
    });
    service = h.service;
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    const stale = block(h.rows, 'gw-a').verificationToken;
    await expect(service.verify('gw-a', 'org-a', 'u1')).rejects.toMatchObject({
      response: { code: 'DOMAIN_CHANGED' },
    });
    expect(block(h.rows, 'gw-a')).toMatchObject({ hostname: 'other.acme.com', status: 'pending_verification' });
  });

  it.each([
    ['https://chat.acme.com', 'DOMAIN_INVALID'],
    ['*.acme.com', 'DOMAIN_INVALID'],
    ['localhost', 'DOMAIN_INVALID'],
    ['acme.almyty.app', 'DOMAIN_RESERVED'],
    ['evil.almyty.com', 'DOMAIN_RESERVED'],
  ])('refuses %s', async (hostname, code) => {
    const { service } = harness();
    await expect(service.set('gw-a', 'org-a', 'u1', hostname)).rejects.toMatchObject({ response: { code } });
  });

  it('is for hosted chat surfaces the caller may manage in their own organization', async () => {
    const { service } = harness();
    await expect(service.set('gw-w', 'org-a', 'u1', 'chat.acme.com')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('gw-b', 'org-a', 'u1', 'chat.acme.com')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.verify('gw-a', 'org-a', 'viewer')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('removing the domain stops serving it', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');
    await service.remove('gw-a', 'org-a', 'u1');
    expect(rows.get('gw-a')!.configuration.customDomain).toBeUndefined();
    await expect(service.get('gw-a', 'org-a', 'u1')).resolves.toBeNull();
  });
});

describe('custom domains are wired', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('GatewaysModule registers the controller, the service and the Postgres store', () => {
    const mod = src('gateways.module.ts');
    expect(mod).toMatch(/controllers:\s*\[[\s\S]*?\bCustomDomainController\b/);
    expect(mod).toMatch(/providers:\s*\[[\s\S]*?\bCustomDomainService\b/);
    expect(mod).toMatch(/provide:\s*CUSTOM_DOMAIN_STORE,\s*useClass:\s*PgCustomDomainStore/);
  });

  it('the controller routes get, set, verify and remove under /gateways/:gatewayId/custom-domain', () => {
    const ctl = src('channels/custom-domain.controller.ts');
    expect(ctl).toMatch(/@Controller\('gateways'\)/);
    for (const route of [
      "@Get(':gatewayId/custom-domain')",
      "@Put(':gatewayId/custom-domain')",
      "@Post(':gatewayId/custom-domain/verify')",
      "@Delete(':gatewayId/custom-domain')",
    ]) {
      expect(ctl).toContain(route);
    }
    expect(ctl).toMatch(/@UseGuards\(JwtAuthGuard, RolesGuard, PrivateGatewayGuard\)/);
  });

  it('the hosted chat page on a custom domain is resolved only through active rows', () => {
    const svc = src('channels/hosted-chat.service.ts');
    expect(svc).toMatch(/'customDomain' ->> 'status' = :status", \{\s*status: 'active'/);
  });

  it('the dashboard calls these routes', () => {
    const api = readFileSync(join(__dirname, '../../../../../../frontend/src/lib/api.ts'), 'utf8');
    expect(api).toMatch(/\/custom-domain\/verify/);
  });
});
