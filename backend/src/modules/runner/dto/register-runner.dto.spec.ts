import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterRunnerDto } from './register-runner.dto';
import { RunnerIsolationTier } from '../../../entities/runner.entity';

function basePayload(): Record<string, unknown> {
  return {
    name: 'laptop',
    labels: { team: 'platform' },
    runtimeInfo: {
      os: 'darwin',
      arch: 'arm64',
      hostname: 'frane-macbook',
      cpuCount: 8,
      memoryMb: 16384,
      runnerVersion: '1.0.0',
      binaries: { node: 'v20.18.0', git: '2.47.0' },
    },
    config: {
      defaultIsolation: RunnerIsolationTier.HOST,
      maxConcurrent: 4,
      allowedCwdRoots: ['/Users/frane/workspace'],
      denyPatterns: [],
      networkBlocked: false,
      installBlocked: false,
    },
  };
}

async function violations(payload: any): Promise<string[]> {
  const dto = plainToInstance(RegisterRunnerDto, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const flat: string[] = [];
  const walk = (errs: any[], prefix = ''): void => {
    for (const e of errs) {
      if (e.constraints) {
        for (const k of Object.keys(e.constraints)) {
          flat.push(`${prefix}${e.property}:${k}`);
        }
      }
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    }
  };
  walk(errors);
  return flat;
}

describe('RegisterRunnerDto', () => {
  it('accepts a well-formed payload', async () => {
    expect(await violations(basePayload())).toEqual([]);
  });

  it('rejects missing name', async () => {
    const payload = basePayload();
    delete (payload as any).name;
    const errs = await violations(payload);
    expect(errs.some((e) => e.startsWith('name:'))).toBe(true);
  });

  it('rejects an oversize name', async () => {
    const payload = basePayload();
    payload.name = 'x'.repeat(121);
    const errs = await violations(payload);
    expect(errs).toContain('name:maxLength');
  });

  it('rejects bad defaultIsolation', async () => {
    const payload = basePayload();
    (payload.config as any).defaultIsolation = 'wasm';
    const errs = await violations(payload);
    expect(errs).toContain('config.defaultIsolation:isEnum');
  });

  it('rejects maxConcurrent out of range', async () => {
    const payload = basePayload();
    (payload.config as any).maxConcurrent = 0;
    const errs = await violations(payload);
    expect(errs.some((e) => e.startsWith('config.maxConcurrent'))).toBe(true);
  });

  it('rejects non-UUID teamId', async () => {
    const payload = basePayload();
    payload.visibility = 'team';
    payload.teamId = 'not-a-uuid';
    const errs = await violations(payload);
    expect(errs).toContain('teamId:isUuid');
  });

  it('accepts visibility=team with a valid UUID teamId', async () => {
    const payload = basePayload();
    payload.visibility = 'team';
    payload.teamId = '550e8400-e29b-41d4-a716-446655440000';
    expect(await violations(payload)).toEqual([]);
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const payload = { ...basePayload(), rogueField: 'attack' };
    const errs = await violations(payload);
    expect(errs.some((e) => e.startsWith('rogueField:'))).toBe(true);
  });
});
