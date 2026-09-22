import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { Strategy } from '../../../../entities/strategy.entity';
import { StrategiesController } from '../strategies.controller';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

/**
 * What `GET /strategies` actually puts on the wire.
 *
 * The seed carries `experimental` and the entity has a column for it, but
 * neither is what a picker reads. The field only means anything once it
 * survives the controller's own projection, which rebuilds each row from
 * a fixed set of keys and had silently dropped it. A test on the seed
 * object cannot see that, because the seed is correct either way.
 */
describe('GET /strategies', () => {
  let app: INestApplication;
  const rows: Strategy[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StrategiesController],
      providers: [{ provide: getRepositoryToken(Strategy), useValue: { find: async () => rows } }],
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
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const list = async () => (await request(app.getHttpServer()).get('/strategies').expect(200)).body.data as any[];

  it('marks explore_extract_patch experimental, so the picker can badge it', async () => {
    const eep = (await list()).find((s) => s.key === 'explore_extract_patch');
    expect(eep).toBeDefined();
    expect(eep.experimental).toBe(true);
  });

  it('leaves every other built-in unmarked rather than defaulting to undefined', async () => {
    for (const s of (await list()).filter((s) => s.key !== 'explore_extract_patch')) {
      expect(s.experimental).toBe(false);
    }
  });

  it('does not imply a saving in the description of an experimental shape', async () => {
    const eep = (await list()).find((s) => s.key === 'explore_extract_patch');
    expect(eep.description).toMatch(/experimental/i);
    expect(eep.description).not.toMatch(/cheaper|saves money|reduces cost/i);
  });

  it('carries the flag from an organization row too, not only from the seeds', async () => {
    rows.push({
      key: 'house_style',
      displayName: 'House style',
      description: 'Ours.',
      roleSlots: ['principal'],
      shape: { entry: 'answer', steps: [{ id: 'answer', kind: 'call', roleSlot: 'principal' }] },
      organizationId: 'org-1',
      experimental: true,
    } as Strategy);

    const mine = (await list()).find((s) => s.key === 'house_style');
    expect(mine.experimental).toBe(true);
    rows.length = 0;
  });
});
