import { Test, TestingModule } from '@nestjs/testing';
import { OpenAPIParserService } from '../openapi-parser.service';

/**
 * Hostile-schema resource-exhaustion fixtures.
 *
 * Every fixture here is tiny — a few hundred bytes — and would hang or
 * OOM the process without a guard, so the test itself always terminates
 * fast in both directions.
 */
describe('OpenAPIParserService - hostile schemas', () => {
  let service: OpenAPIParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OpenAPIParserService],
    }).compile();
    service = module.get<OpenAPIParserService>(OpenAPIParserService);
  });

  /**
   * YAML anchors/aliases share references, so js-yaml loads this in
   * microseconds and it occupies a few hundred bytes of heap. But the
   * document it *denotes* has fanout^(levels+1) nodes. Any consumer that
   * walks it as a tree runs for geological time.
   */
  function aliasBomb(levels: number, fanout: number): string {
    let y = `a: &a [${Array(fanout).fill('"x"').join(',')}]\n`;
    let prev = 'a';
    for (let i = 0; i < levels; i++) {
      const k = `l${i}`;
      y += `${k}: &${k} [${Array(fanout).fill('*' + prev).join(',')}]\n`;
      prev = k;
    }
    y += 'openapi: "3.0.0"\n';
    y += 'info: {title: bomb, version: "1"}\n';
    y += `paths: {"/x": {get: {operationId: x, parameters: *${prev}}}}\n`;
    return y;
  }

  it('refuses a YAML anchor/alias bomb instead of walking it', async () => {
    const bomb = aliasBomb(11, 9);
    expect(bomb.length).toBeLessThan(2048);

    const started = Date.now();
    await expect(service.parseSchema(bomb, 'bomb.yaml')).rejects.toThrow(
      /Invalid OpenAPI schema/,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses a cyclic YAML alias document', async () => {
    const cyclic = [
      'openapi: "3.0.0"',
      'info: {title: cyc, version: "1"}',
      'paths: {}',
      'loop: &loop',
      '  child: *loop',
      '',
    ].join('\n');

    await expect(service.parseSchema(cyclic, 'cyclic.yaml')).rejects.toThrow(
      /Invalid OpenAPI schema/,
    );
  });

  it('still rejects an external $ref nested below the old depth cap', async () => {
    // 1200 levels of nesting, then an external $ref. The old guard
    // `return`ed past depth 1000 — failing open — so this ref was
    // never inspected at all.
    let node: any = { $ref: 'http://169.254.169.254/latest/meta-data/' };
    for (let i = 0; i < 1200; i++) node = { nested: node };
    const doc = {
      openapi: '3.0.0',
      info: { title: 'deep', version: '1.0.0' },
      paths: {},
      components: { schemas: { Deep: node } },
    };

    await expect(service.parseSchema(JSON.stringify(doc))).rejects.toThrow(
      /Invalid OpenAPI schema/,
    );
  });

  it('still parses an ordinary YAML spec that uses anchors legitimately', async () => {
    const ok = [
      'openapi: "3.0.0"',
      'info: {title: ok, version: "1.0.0"}',
      'common: &common',
      '  name: limit',
      '  in: query',
      'paths:',
      '  /users:',
      '    get:',
      '      operationId: listUsers',
      '      parameters:',
      '        - *common',
      '      responses:',
      '        "200": {description: ok}',
      '',
    ].join('\n');

    const parsed = await service.parseSchema(ok, 'ok.yaml');
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0].operationId).toBe('listUsers');
    expect(parsed.operations[0].parameters.query.limit).toBeDefined();
  });
});
