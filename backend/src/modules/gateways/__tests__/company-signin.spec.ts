import { companyIdentityAllowed, companyIssuer } from '../company-signin.service';
describe('company sign-in identity boundary', () => {
 it('requires verified exact email domains', () => {
  const config = { allowedEmailDomains: ['example.com'], allowedGroups: [], preset: 'google' };
  expect(companyIdentityAllowed(config, { email: 'a@example.com', email_verified: true, hd: 'example.com' })).toBe(true);
  expect(companyIdentityAllowed(config, { email: 'a@sub.example.com', email_verified: true })).toBe(false);
  expect(companyIdentityAllowed(config, { email: 'a@example.com' })).toBe(false);
  expect(companyIdentityAllowed(config, { email: 'a@example.com', email_verified: true })).toBe(false);
 });
 it('enforces group restrictions even with an allowed domain', () => {
  const config = { allowedEmailDomains: ['example.com'], allowedGroups: ['staff'], groupsClaim: 'groups' };
  expect(companyIdentityAllowed(config, { email: 'a@example.com', email_verified: true, groups: ['staff'] })).toBe(true);
  expect(companyIdentityAllowed(config, { email: 'a@example.com', email_verified: true, groups: ['other'] })).toBe(false);
 });
 it('refuses shared Microsoft tenant authorities', () => {
  expect(() => companyIssuer({ preset: 'microsoft', tenant: 'common' })).toThrow();
  expect(companyIssuer({ preset: 'google' })).toBe('https://accounts.google.com');
 });
});
