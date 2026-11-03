import { AuthController, profileName } from '../auth.controller';

/**
 * The web client reads `name` from the profile for the sidebar avatar's
 * initials and the user menu. The User entity keeps first and last name
 * apart, and its fullName getter does not survive the object spread the
 * route answers with, so there was no `name` and every avatar read "U".
 */
describe('the profile carries the person name', () => {
  const user: any = {
    id: 'u-1',
    email: 'dana@acme.example',
    firstName: 'Dana',
    lastName: 'Lind',
    passwordHash: 'secret',
    isVerified: true,
    organizationMemberships: [],
  };

  it('GET /auth/profile answers with name, and never the password hash', async () => {
    const controller: any = Object.create(AuthController.prototype);
    const res = await controller.getProfile(user);
    expect(res.data.name).toBe('Dana Lind');
    expect(res.data.passwordHash).toBeUndefined();
  });

  it('is null rather than blank when neither part is set', () => {
    expect(profileName({ firstName: '', lastName: '' } as any)).toBeNull();
    expect(profileName({ firstName: 'Dana', lastName: '' } as any)).toBe('Dana');
  });
});
