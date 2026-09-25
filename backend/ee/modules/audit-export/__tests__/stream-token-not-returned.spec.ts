import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { listenOnLoopback } from '../../../../src/test/http';

import { AuditExportController } from '../audit-export.controller';
import { JwtAuthGuard } from '../../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../src/modules/auth/guards/roles.guard';
import { EntitlementGuard } from '../../../../src/modules/licensing/guards/entitlement.guard';

/**
 * The SIEM secret never leaves the server.
 *
 * `token` holds a Splunk HEC token, a Datadog API key or a webhook
 * bearer. The list route returned the stored rows unmapped, so that
 * secret went to every admin's browser and into their network log --
 * for a field the UI does not even display, which is why nobody noticed.
 * The write path already treats it as write-only; this is the read path
 * catching up.
 */
describe('GET /audit-export/streams', () => {
  let app: INestApplication;
  const rows = [
    { id: 's1', organizationId: 'org-1', target: 'splunk_hec', endpoint: 'https://splunk.example/x', token: 'hec-SUPER-SECRET', actionFilter: null },
    { id: 's2', organizationId: 'org-1', target: 'webhook', endpoint: 'https://hooks.example/y', token: null, actionFilter: null },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditExportController],
    })
      .useMocker((token) => {
        const name = typeof token === 'function' ? token.name : String(token);
        if (name.includes('AuditStreamService')) return { list: async () => rows };
        return {};
      })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { currentOrganizationId: 'org-1' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(EntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => await app?.close());

  it('never puts the token on the wire', async () => {
    const res = await request(app.getHttpServer()).get('/audit-export/streams').expect(200);

    expect(JSON.stringify(res.body)).not.toContain('hec-SUPER-SECRET');
    for (const row of res.body.data) expect(row).not.toHaveProperty('token');
  });

  it('still says whether a target HAS a token, which is what the UI needs', async () => {
    const { body } = await request(app.getHttpServer()).get('/audit-export/streams').expect(200);

    expect(body.data.find((r: any) => r.id === 's1').hasToken).toBe(true);
    expect(body.data.find((r: any) => r.id === 's2').hasToken).toBe(false);
  });

  it('keeps the fields the list is for', async () => {
    const { body } = await request(app.getHttpServer()).get('/audit-export/streams').expect(200);
    expect(body.data[0]).toMatchObject({ id: 's1', target: 'splunk_hec', endpoint: 'https://splunk.example/x' });
  });
});
