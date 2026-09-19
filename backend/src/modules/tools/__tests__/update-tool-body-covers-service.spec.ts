import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { UpdateToolBodyDto } from '../dto/tools-controller.dto';

/**
 * Source-reading guard: every field `ToolsService.updateTool()` reads off
 * the update DTO must be declared on the body class the controller
 * validates.
 *
 * main.ts installs `forbidNonWhitelisted: true`, so a field the service
 * handles but the body class does not declare is not merely dropped --
 * the whole PUT is refused with "property X should not exist", and the
 * handling is unreachable by any caller. That had already happened once
 * to `apiId` on the create body (see the note in tools-controller.dto.ts)
 * and was still true of `authConfig` on the update body: the service has
 * assigned it since the protocol-config fix, and no request could carry
 * it.
 */
describe('UpdateToolBodyDto covers every field updateTool() handles', () => {
  const serviceSource = readFileSync(join(__dirname, '..', 'tools.service.ts'), 'utf8');

  // The body of updateTool(), so createTool()'s reads don't leak in.
  const updateBody = serviceSource.slice(
    serviceSource.indexOf('async updateTool('),
    serviceSource.indexOf('async getTool('),
  );
  const handled = [
    ...new Set(
      [...updateBody.matchAll(/updateToolDto\.(\w+)/g)]
        .map((m) => m[1])
        // `updateAnyEarly` is the same object widened to any; the loop
        // below covers those names through their own matches.
        .filter((name) => name !== 'constructor'),
    ),
  ].sort();

  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });
  const meta = { type: 'body' as const, metatype: UpdateToolBodyDto, data: '' };

  it('reads the field list off the service rather than restating it', () => {
    expect(handled).toEqual(expect.arrayContaining(['authConfig', 'httpConfig', 'visibility']));
  });

  it.each(handled)('a PUT may carry %s', async (field) => {
    // Every property on the body class is @IsOptional(), so an explicit
    // null exercises the whitelist and nothing else.
    await expect(pipe.transform({ [field]: null }, meta)).resolves.toBeDefined();
  });

  it('still refuses a field the service does not handle', async () => {
    await expect(pipe.transform({ organizationId: null }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
