import { BadRequestException } from '@nestjs/common';

import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmProvidersService } from '../llm-providers.service';

/**
 * The egress policy, exercised where a URL actually enters the system.
 *
 * This exists because the policy shipped with a full unit suite and NO
 * CALLERS: decideEgress and assertEgressAllowed were imported by nothing
 * but their own spec, so an organization's allowlist decided nothing and
 * a private provider URL was refused only by the install-wide env flags
 * it was written to replace. Testing decideEgress again would not have
 * caught that. Driving the service does.
 */
describe('a provider URL is gated on save', () => {
  const organization = (egressAllowlist?: string[]) => ({
    id: 'org-1',
    settings: egressAllowlist ? { egressAllowlist } : {},
  });

  /** The private method under test, reached the way the service reaches it. */
  const gate = (org: any) => {
    const service = Object.create(LlmProvidersService.prototype) as any;
    service.organizationRepository = { findOne: jest.fn().mockResolvedValue(org) };
    return (type: LlmProviderType, configuration: any) =>
      service.assertProviderEgressAllowed(type, configuration, 'org-1');
  };

  it('refuses a provider pointed at loopback', async () => {
    const check = gate(organization());
    await expect(
      check(LlmProviderType.CUSTOM, { apiUrl: 'http://127.0.0.1:6379/v1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses one pointed at the cloud metadata service', async () => {
    const check = gate(organization());
    await expect(
      check(LlmProviderType.CUSTOM, { apiUrl: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow();
  });

  it('says which host was refused and what to do about it', async () => {
    const check = gate(organization());
    await check(LlmProviderType.CUSTOM, { apiUrl: 'http://10.0.0.5/v1' }).catch((err: any) => {
      const body = err.getResponse();
      expect(body.code).toBe('EGRESS_NOT_ALLOWED');
      expect(body.message).toContain('10.0.0.5');
      expect(body.message).toMatch(/allowlist/i);
    });
    expect.assertions(3);
  });

  it('allows a private address this organization has allowlisted, and only that one', async () => {
    const check = gate(organization(['10.0.0.5']));
    await expect(check(LlmProviderType.CUSTOM, { apiUrl: 'http://10.0.0.5:8000/v1' })).resolves.toBeUndefined();
    await expect(check(LlmProviderType.CUSTOM, { apiUrl: 'http://10.0.0.6:8000/v1' })).rejects.toThrow();
  });

  it('allows localhost only when it is allowlisted', async () => {
    await expect(
      gate(organization())(LlmProviderType.CUSTOM, { apiUrl: 'http://localhost:8000/v1' }),
    ).rejects.toThrow();
    await expect(
      gate(organization(['localhost']))(LlmProviderType.CUSTOM, { apiUrl: 'http://localhost:8000/v1' }),
    ).resolves.toBeUndefined();
  });

  it('does NOT judge a hostname here, which is the half this gate cannot do', async () => {
    // gpu-1.internal is private in fact and public as a string. Nothing
    // at save time can know that, so it passes here and is refused at
    // connect by the DNS-pinning agent when the name resolves into a
    // banned range. Written down because the split is easy to mistake
    // for a hole: see ssrf-safe-agent.ts for the other half.
    const check = gate(organization());
    await expect(
      check(LlmProviderType.CUSTOM, { apiUrl: 'http://gpu-1.internal:8000/v1' }),
    ).resolves.toBeUndefined();
  });

  it('lets a public provider through without an allowlist at all', async () => {
    const check = gate(organization());
    await expect(check(LlmProviderType.OPENAI, {})).resolves.toBeUndefined();
    await expect(
      check(LlmProviderType.CUSTOM, { apiUrl: 'https://api.example.com/v1' }),
    ).resolves.toBeUndefined();
  });

  it('still honours the install-wide Ollama escape hatch', async () => {
    const previous = process.env.OLLAMA_ALLOW_PRIVATE_URLS;
    process.env.OLLAMA_ALLOW_PRIVATE_URLS = 'true';
    try {
      const check = gate(organization());
      await expect(
        check(LlmProviderType.OLLAMA, { apiUrl: 'http://localhost:11434' }),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_ALLOW_PRIVATE_URLS;
      else process.env.OLLAMA_ALLOW_PRIVATE_URLS = previous;
    }
  });

  it('stamps the allowlisted host so the connect-time check can make the same exception', async () => {
    const configuration: any = { apiUrl: 'http://gpu-1.internal:8000/v1' };
    await gate(organization(['*.internal']))(LlmProviderType.CUSTOM, configuration);
    // Without this the name is refused when it resolves, and allowlisting
    // it would have achieved nothing.
    expect(configuration.egressApprovedHost).toBe('gpu-1.internal');
  });

  it('stamps nothing for a host nobody allowlisted', async () => {
    const configuration: any = { apiUrl: 'https://api.example.com/v1' };
    await gate(organization(['gpu-1.internal']))(LlmProviderType.CUSTOM, configuration);
    expect(configuration.egressApprovedHost).toBeUndefined();
  });

  it('refuses to take the stamp from the request body', async () => {
    // The whole point of the stamp is that it lets a name past DNS
    // pinning. Accepting it as input would hand every caller the decision
    // this gate exists to make.
    const configuration: any = {
      apiUrl: 'https://api.example.com/v1',
      egressApprovedHost: '169.254.169.254',
    };
    await gate(organization())(LlmProviderType.CUSTOM, configuration);
    expect(configuration.egressApprovedHost).toBeUndefined();
  });

  it('drops a stale stamp when the host is no longer allowlisted', async () => {
    const configuration: any = { apiUrl: 'http://gpu-1.internal:8000/v1', egressApprovedHost: 'gpu-1.internal' };
    await gate(organization([]))(LlmProviderType.CUSTOM, configuration);
    expect(configuration.egressApprovedHost).toBeUndefined();
  });
});
