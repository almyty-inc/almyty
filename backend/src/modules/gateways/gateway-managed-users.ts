import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
export async function prepareManagedUsers(input: any, previous: any = {}) {
  if (!Array.isArray(input?.users) || !input.users.length || input.users.length > 100) throw new BadRequestException('Add between one and 100 usernames');
  const seen = new Set<string>();
  const users = [];
  for (const item of input.users) {
    const username = typeof item?.username === 'string' ? item.username.trim() : '';
    if (!username || username.length > 128 || username.includes(':') || seen.has(username)) throw new BadRequestException('Usernames must be unique and cannot contain colons');
    seen.add(username);
    if ('passwordHash' in item) throw new BadRequestException('Password hashes cannot be supplied');
    const prior = previous?.users?.find((u: any) => u.id === item.id && u.username === username);
    const password = typeof item.password === 'string' ? item.password : '';
    if (password && (Buffer.byteLength(password, 'utf8') > 72 || password.length < 8)) throw new BadRequestException('Passwords must have at least eight characters and at most 72 bytes');
    const passwordHash = password ? await bcrypt.hash(password, 12) : prior?.passwordHash;
    if (!passwordHash) throw new BadRequestException('Enter a password for each new username');
    users.push({ id: prior?.id ?? randomUUID(), username, passwordHash, isActive: item.isActive !== false });
  }
  return { users };
}
export async function authenticateManagedUser(config: any, header: string): Promise<boolean> {
  if (!header?.startsWith('Basic ') || header.length > 2048) return false;
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = credentials.indexOf(':');
  if (colon <= 0) return false;
  // One username may appear more than once when the GatewayEndpointAccess
  // migration joined the lists of two duplicate rows; each password works.
  const username = credentials.slice(0, colon);
  const password = credentials.slice(colon + 1);
  for (const user of Array.isArray(config?.users) ? config.users : []) {
    if (user?.username !== username || user.isActive === false || !user.passwordHash) continue;
    if (await bcrypt.compare(password, user.passwordHash)) return true;
  }
  return false;
}
