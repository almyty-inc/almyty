import { readFileSync } from 'fs';
import { join } from 'path';
import * as bcryptjs from 'bcryptjs';
import * as bcrypt from 'bcrypt';

/**
 * The global jest setup runs before every spec. A bcrypt double there that
 * answers "match" for any password makes every login, API-key and SCIM token
 * check in the suite unable to fail, so a wrong-password path could regress
 * with every test still green. These pin that the setup leaves both bcrypt
 * libraries real; a spec that wants speed hashes with a low cost factor, and
 * one that wants a double declares it locally.
 */
describe('global jest setup and bcrypt', () => {
  it('bcryptjs.compare rejects a wrong password under the global setup', async () => {
    const hash = await bcryptjs.hash('right', 4);
    expect(hash).not.toBe('right');
    await expect(bcryptjs.compare('wrong', hash)).resolves.toBe(false);
    await expect(bcryptjs.compare('right', hash)).resolves.toBe(true);
  });

  it('bcrypt.compare rejects a wrong password under the global setup', async () => {
    const hash = await bcrypt.hash('right', 4);
    await expect(bcrypt.compare('wrong', hash)).resolves.toBe(false);
    await expect(bcrypt.compare('right', hash)).resolves.toBe(true);
  });

  it('the setup file does not mock either bcrypt library', () => {
    const source = readFileSync(join(__dirname, '..', 'setup.ts'), 'utf8');
    expect(source).not.toMatch(/jest\.(mock|doMock)\(\s*['"`]bcrypt(js)?['"`]/);
  });
});
