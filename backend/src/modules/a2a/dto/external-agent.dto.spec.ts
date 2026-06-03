import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  PreviewExternalAgentDto,
  CreateExternalAgentDto,
  UpdateExternalAgentDto,
} from './external-agent.dto';

async function violations(cls: any, payload: any): Promise<string[]> {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const flat: string[] = [];
  const walk = (errs: any[], prefix = ''): void => {
    for (const e of errs) {
      if (e.constraints) {
        for (const k of Object.keys(e.constraints)) flat.push(`${prefix}${e.property}:${k}`);
      }
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    }
  };
  walk(errors);
  return flat;
}

describe('PreviewExternalAgentDto', () => {
  it('accepts a well-formed https URL', async () => {
    expect(await violations(PreviewExternalAgentDto, { url: 'https://example.com/.well-known/agent.json' })).toEqual([]);
  });

  it('rejects missing url', async () => {
    const errs = await violations(PreviewExternalAgentDto, {});
    expect(errs.some((e) => e.startsWith('url:'))).toBe(true);
  });

  it('rejects non-URL strings', async () => {
    const errs = await violations(PreviewExternalAgentDto, { url: 'not-a-url' });
    expect(errs).toContain('url:isUrl');
  });
});

describe('CreateExternalAgentDto', () => {
  function base(): Record<string, unknown> {
    return {
      name: 'Remote A2A',
      agentCardUrl: 'https://example.com/agent.json',
    };
  }

  it('accepts a minimal valid payload', async () => {
    expect(await violations(CreateExternalAgentDto, base())).toEqual([]);
  });

  it('rejects missing required fields', async () => {
    const errs = await violations(CreateExternalAgentDto, {});
    expect(errs.some((e) => e.startsWith('name:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('agentCardUrl:'))).toBe(true);
  });

  it('rejects non-UUID credentialId', async () => {
    const errs = await violations(CreateExternalAgentDto, { ...base(), credentialId: 'not-a-uuid' });
    expect(errs).toContain('credentialId:isUuid');
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const errs = await violations(CreateExternalAgentDto, { ...base(), rogue: 'attack' });
    expect(errs.some((e) => e.startsWith('rogue:'))).toBe(true);
  });
});

describe('UpdateExternalAgentDto', () => {
  it('accepts an empty patch', async () => {
    expect(await violations(UpdateExternalAgentDto, {})).toEqual([]);
  });

  it('rejects an oversize name', async () => {
    const errs = await violations(UpdateExternalAgentDto, { name: 'x'.repeat(201) });
    expect(errs).toContain('name:maxLength');
  });

  it('rejects unknown top-level fields when forbidNonWhitelisted is set', async () => {
    const errs = await violations(UpdateExternalAgentDto, { rogue: 'attack' });
    expect(errs.some((e) => e.startsWith('rogue:'))).toBe(true);
  });
});
