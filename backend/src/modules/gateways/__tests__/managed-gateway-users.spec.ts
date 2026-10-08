import { prepareManagedUsers, authenticateManagedUser } from '../gateway-managed-users';
describe('managed endpoint usernames', () => {
 it('hashes passwords and handles colons without consulting almyty accounts', async () => {
  const config = await prepareManagedUsers({ users: [{ username: 'alice', password: 'long:password:123' }] });
  expect(config.users[0].password).toBeUndefined();
  expect(config.users[0].passwordHash).not.toContain('long:password');
  expect(await authenticateManagedUser(config, 'Basic ' + Buffer.from('alice:long:password:123').toString('base64'))).toBe(true);
  expect(await authenticateManagedUser(config, 'Basic ' + Buffer.from('alice:wrong').toString('base64'))).toBe(false);
 });
 it('keeps unchanged hashes only for the same server-issued id and username', async () => {
  const previous = await prepareManagedUsers({ users: [{ username: 'alice', password: 'long-password-123' }] });
  const saved = await prepareManagedUsers({ users: [{ id: previous.users[0].id, username: 'alice' }] }, previous);
  expect(saved.users[0].passwordHash).toBe(previous.users[0].passwordHash);
  await expect(prepareManagedUsers({ users: [{ id: previous.users[0].id, username: 'bob' }] }, previous)).rejects.toThrow();
 });
 it('refuses duplicate names and supplied hashes', async () => {
  await expect(prepareManagedUsers({ users: [{ username: 'alice', passwordHash: 'forged' }] })).rejects.toThrow();
  await expect(prepareManagedUsers({ users: [{ username: 'a', password: 'long-password-123' }, { username: 'a', password: 'long-password-123' }] })).rejects.toThrow();
 });
});
