import { AuditStreamService } from '../audit-stream.service';

/**
 * A SIEM target is a URL an org admin types, and the server POSTs the
 * org's audit events to it. That makes it the same class of input as an
 * LLM provider base URL, an MCP source, an agent webhook and a
 * connection endpoint -- every one of which goes through the SSRF
 * validator before the server will call it.
 *
 * This one did not. Nothing under `ee/` imported `validateUrl` or
 * `decideEgress` at all, so `http://169.254.169.254/...` was accepted,
 * stored, and POSTed to on every audit event, and `deliver` writes the
 * outcome back onto the config row as `lastError: 'HTTP <status>'` --
 * which `GET /audit-export/streams` returns. A blind SSRF with a status
 * oracle, reachable by any org admin on the `audit_export` plan.
 *
 * A SIEM really on the customer's private network is the legitimate
 * case, and it is already answered the same way everywhere else: the
 * organization's `settings.egressAllowlist`.
 */
describe('AuditStreamService.create — endpoint egress', () => {
  function build(allowlist: string[] = []) {
    const configs: any = {
      create: (row: any) => row,
      save: jest.fn(async (row: any) => ({ id: 's1', ...row })),
    };
    const organizations: any = {
      findOne: jest.fn(async () => ({ id: 'org-1', settings: { egressAllowlist: allowlist } })),
    };
    return { service: new AuditStreamService(configs, organizations), configs, organizations };
  }

  const attempt = (service: AuditStreamService, endpoint: string) =>
    service.create({ organizationId: 'org-1', target: 'webhook', endpoint });

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['loopback', 'http://127.0.0.1:6379/'],
    ['localhost by name', 'http://localhost:5432/'],
    ['private range', 'http://10.0.0.5/collector'],
    ['kubernetes api', 'https://kubernetes.default.svc/api/v1/secrets'],
    ['non-http scheme', 'file:///etc/passwd'],
    ['embedded credentials', 'https://user:pw@siem.example.com/hec'],
  ])('refuses %s', async (_label, endpoint) => {
    const { service, configs } = build();

    await expect(attempt(service, endpoint)).rejects.toMatchObject({
      response: { code: 'EGRESS_NOT_ALLOWED' },
    });
    expect(configs.save).not.toHaveBeenCalled();
  });

  it('accepts a public SIEM endpoint', async () => {
    const { service, configs } = build();

    await expect(attempt(service, 'https://http-inputs.splunkcloud.example/services/collector'))
      .resolves.toMatchObject({ id: 's1' });
    expect(configs.save).toHaveBeenCalled();
  });

  it('accepts a private SIEM the organization put on its egress allowlist', async () => {
    const { service, configs } = build(['splunk.internal.example']);

    await expect(attempt(service, 'http://splunk.internal.example:8088/services/collector'))
      .resolves.toMatchObject({ id: 's1' });
    expect(configs.save).toHaveBeenCalled();
  });

  it('refuses a private host that is not the allowlisted one', async () => {
    const { service } = build(['splunk.internal.example']);

    await expect(attempt(service, 'http://10.0.0.5/collector')).rejects.toMatchObject({
      response: { code: 'EGRESS_NOT_ALLOWED' },
    });
  });
});
