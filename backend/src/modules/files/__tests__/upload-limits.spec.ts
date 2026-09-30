import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FilesController } from '../files.controller';
import { FilesService } from '../files.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { MAX_UPLOAD_FIELDS } from '../upload-limits';
import { listenOnLoopback } from '../../../test/http';

/**
 * POST /files/upload through the real multer interceptor.
 *
 * multer bounded the file and nothing else: the form fields beside it
 * were unlimited in number, each up to 1 MB, all held in memory before
 * the handler ran. The route takes one file and nothing in the body.
 */
describe('POST /files/upload multipart limits', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  let app: INestApplication;
  let upload: jest.Mock;

  beforeAll(async () => {
    upload = jest.fn(async () => ({ id: 'file-1' }));
    const moduleRef = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [{ provide: FilesService, useValue: { upload } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: 'user-1', currentOrganizationId: ORG };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => upload.mockClear());

  const post = (fields: number, files = 1) => {
    let req = request(app.getHttpServer()).post('/files/upload');
    for (let i = 0; i < fields; i++) req = req.field(`f${i}`, 'x'.repeat(1024));
    for (let i = 0; i < files; i++) {
      req = req.attach('file', Buffer.from('hello'), { filename: `notes-${i}.txt`, contentType: 'text/plain' });
    }
    return req;
  };

  it('accepts a file with a few fields', async () => {
    const res = await post(3);
    expect(res.status).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('refuses a request carrying more form fields than any upload needs', async () => {
    const res = await post(MAX_UPLOAD_FIELDS * 5);
    expect(res.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses a second file', async () => {
    const res = await post(0, 2);
    expect(res.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });
});
