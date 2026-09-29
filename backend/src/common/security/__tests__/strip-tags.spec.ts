import { plainToInstance } from 'class-transformer';

import { stripTags } from '../strip-tags';
import { CreateUserDto } from '../../../modules/auth/dto/create-user.dto';
import { CreateAgentDto } from '../../../modules/agents/dto/create-agent.dto';
import { CreateApiDto } from '../../../modules/apis/dto/api.dto';
import { CreateOrganizationDto } from '../../../modules/organizations/dto/create-organization.dto';

/**
 * stripTags replaces `s.replace(/<[^>]*>/g, '')`, which is quadratic on an
 * unclosed `<` and ran in DTO transforms: registration included, so before
 * any sign-in. 100 KB of `<` (the JSON body limit) took six seconds.
 */
describe('stripTags', () => {
  const ALPHABET = ['<', '>', 'a', ' ', '/', '\n', 'b'];

  const random = (seed: number, length: number): string => {
    let x = seed;
    let out = '';
    for (let i = 0; i < length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out += ALPHABET[x % ALPHABET.length];
    }
    return out;
  };

  it('matches /<[^>]*>/g on every string it is given', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const s = random(seed, seed % 40);
      expect(stripTags(s)).toBe(s.replace(/<[^>]*>/g, ''));
    }
  });

  it('matches /<[^>]+>/g with allowEmpty: false', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const s = random(seed * 7, seed % 40);
      expect(stripTags(s, { allowEmpty: false })).toBe(s.replace(/<[^>]+>/g, ''));
    }
  });

  it('keeps plain names and removes markup', () => {
    expect(stripTags('Ada <b>Lovelace</b>')).toBe('Ada Lovelace');
    expect(stripTags('a < b')).toBe('a < b');
    expect(stripTags('<script>alert(1)</script>x')).toBe('alert(1)x');
  });

  it('is linear on a megabyte of unclosed tags', () => {
    const started = Date.now();
    expect(stripTags('<'.repeat(1_000_000))).toHaveLength(1_000_000);
    expect(stripTags('<a'.repeat(500_000), { allowEmpty: false })).toHaveLength(1_000_000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['CreateUserDto.firstName (registration, unauthenticated)', CreateUserDto, 'firstName'],
    ['CreateAgentDto.name', CreateAgentDto, 'name'],
    ['CreateApiDto.name', CreateApiDto, 'name'],
    ['CreateOrganizationDto.name', CreateOrganizationDto, 'name'],
  ])('%s strips a 100 KB unclosed-tag body without holding the event loop', (_label, dto: any, field: string) => {
    const started = Date.now();
    // No `>` anywhere: the shape the regex spent the longest failing on.
    const out = plainToInstance(dto, { [field]: '<'.repeat(100_000) + 'x' }) as any;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out[field]).toBe('<'.repeat(100_000) + 'x');
    expect((plainToInstance(dto, { [field]: '  Ada <b>L</b>  ' }) as any)[field]).toBe('Ada L');
  });
});
