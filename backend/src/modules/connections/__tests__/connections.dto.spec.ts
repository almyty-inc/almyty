import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CompleteConnectDto, ConnectBodyDto, CreateConnectorDto, ListConnectorsQueryDto, RotateBodyDto } from '../dto/connections.dto';

async function violations(cls: any, payload: any): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, payload), { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}).map((k) => `${e.property}:${k}`));
}

describe('connections DTOs', () => {
  it('ConnectBodyDto accepts the documented shape and rejects unknown methods, owners, modes and extra keys', async () => {
    expect(await violations(ConnectBodyDto, {})).toEqual([]);
    expect(await violations(ConnectBodyDto, { method: 'api_key', owner: 'user', mode: 'headless', input: { apiKey: 'x' }, name: 'Mine' })).toEqual([]);
    expect(await violations(ConnectBodyDto, { method: 'magic' })).toContain('method:isIn');
    expect(await violations(ConnectBodyDto, { owner: 'workspace' })).toContain('owner:isIn');
    expect(await violations(ConnectBodyDto, { mode: 'popup' })).toContain('mode:isIn');
    expect(await violations(ConnectBodyDto, { input: 'not-an-object' })).toContain('input:isObject');
    expect(await violations(ConnectBodyDto, { name: '' })).toContain('name:minLength');
    expect(await violations(ConnectBodyDto, { apiKey: 'sk-top-level' })).toContain('apiKey:whitelistValidation');
  });

  it('CompleteConnectDto needs a real state and a code', async () => {
    expect(await violations(CompleteConnectDto, { state: 'a'.repeat(43), code: 'c' })).toEqual([]);
    expect(await violations(CompleteConnectDto, { state: 'short', code: 'c' })).toContain('state:minLength');
    expect(await violations(CompleteConnectDto, { state: 'a'.repeat(43) })).toContain('code:isString');
  });

  it('RotateBodyDto and ListConnectorsQueryDto', async () => {
    expect(await violations(RotateBodyDto, {})).toEqual([]);
    expect(await violations(RotateBodyDto, { input: { apiKey: 'new' } })).toEqual([]);
    expect(await violations(RotateBodyDto, { input: 5 })).toContain('input:isObject');
    expect(await violations(ListConnectorsQueryDto, { kind: 'inference' })).toEqual([]);
    expect(await violations(ListConnectorsQueryDto, { kind: 'toaster' })).toContain('kind:isIn');
  });

  it('CreateConnectorDto checks the outer shape (key format, kind, at least one method, validation object)', async () => {
    const good = { key: 'my-vllm', kind: 'inference', displayName: 'My vLLM', connect: [{ type: 'api_key', schema: { type: 'object', properties: {} } }], validation: { kind: 'http', url: 'https://x.example.com/v1/models' } };
    expect(await violations(CreateConnectorDto, good)).toEqual([]);
    expect(await violations(CreateConnectorDto, { ...good, key: 'My Key' })).toContain('key:matches');
    expect(await violations(CreateConnectorDto, { ...good, kind: 'nope' })).toContain('kind:isIn');
    expect(await violations(CreateConnectorDto, { ...good, connect: [] })).toContain('connect:arrayMinSize');
    expect(await violations(CreateConnectorDto, { ...good, validation: 'http' })).toContain('validation:isObject');
    expect(await violations(CreateConnectorDto, { ...good, organizationId: 'org-2' })).toContain('organizationId:whitelistValidation');
  });
});
