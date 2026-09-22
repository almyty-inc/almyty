import { readFileSync } from 'fs';
import { join } from 'path';

import { ComplianceEnforcementHookImpl } from '../compliance-enforcement.hook';
import { PII_CATEGORY_SETTINGS, piiCategoriesToSettings } from '../pii-categories';

/**
 * `compliance_policies.piiCategories` had a settings page, a DTO, a jsonb
 * column and a line in the compliance report -- and no effect on what the
 * pii-filter masked. The enforcement hook handed the plugin `{}`, so the
 * plugin ran on its registered defaults (all five detectors on) whatever
 * the four checkboxes said, while the report told the operator the
 * narrowed set was the enforced one.
 *
 * Source-reading arms on purpose. A unit test of piiCategoriesToSettings
 * passes perfectly while nothing calls it -- which is the shape of every
 * bug in this family. These arms assert the CALLS exist.
 *
 * What it guards:
 *   1. the enforcement hook translates categories instead of sending `{}`;
 *   2. the report goes through the same translation, so it cannot describe
 *      a narrowing the pipeline does not apply;
 *   3. every category id the settings page offers has a mapping;
 *   4. every setting the mapping names is one the plugin actually reads;
 *   5. the plugin manager's merge gate accepts what we return.
 */
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

const hookSrc = read('backend', 'ee', 'modules', 'compliance', 'compliance-enforcement.hook.ts');
const reportSrc = read('backend', 'ee', 'modules', 'compliance', 'compliance.service.ts');
const pluginSrc = read('backend', 'src', 'modules', 'plugins', 'built-in', 'pii-filter.plugin.ts');
const managerSrc = read('backend', 'src', 'modules', 'plugins', 'plugin-manager.service.ts');
const settingsPage = read('frontend', 'src', 'components', 'settings', 'compliance-settings.tsx');

describe('the category selection reaches the filter', () => {
  it('the enforcement hook translates rather than sending an empty object', () => {
    expect(hookSrc).toContain('piiCategoriesToSettings(policy.piiCategories)');
    // The bug: the pii arm of the ternary was a bare `{}`.
    expect(hookSrc).not.toMatch(/:\s*\{\};\n\s*\}\n\s*return \{ enforcedPlugins/);
  });

  it('the report presents the same translation it enforces', () => {
    expect(reportSrc).toContain('piiCategoriesToSettings(policy.piiCategories)');
  });

  it('the plugin manager merges a non-empty override', () => {
    // Our return must clear this gate or the translation is inert again.
    expect(managerSrc).toContain('Object.keys(enforcedSettings).length > 0');
    expect(Object.keys(piiCategoriesToSettings(['email'])).length).toBeGreaterThan(0);
  });
});

describe('the mapping matches both ends', () => {
  it('covers every category the settings page offers', () => {
    const block = settingsPage.slice(
      settingsPage.indexOf('const PII_CATEGORIES'),
      settingsPage.indexOf(']', settingsPage.indexOf('const PII_CATEGORIES')),
    );
    const offered = [...block.matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1]);

    expect(offered.length).toBeGreaterThan(0);
    for (const category of offered) {
      expect(Object.keys(PII_CATEGORY_SETTINGS)).toContain(category);
    }
  });

  it('names only settings the plugin actually reads', () => {
    for (const setting of Object.values(PII_CATEGORY_SETTINGS)) {
      expect(pluginSrc).toContain(`setting: '${setting}'`);
    }
  });
});

describe('what the hook hands the plugin', () => {
  const effective = (over: any = {}) => ({
    organizationId: 'org-1',
    configured: true,
    enforcedPlugins: ['pii-filter'],
    securityThreshold: 'high',
    blockOnViolation: true,
    piiCategories: [],
    ...over,
  });

  const enforcementFor = async (piiCategories: string[]) => {
    const compliance = { getEffectivePolicy: jest.fn(async () => effective({ piiCategories })) };
    const licenses = { hasForOrg: jest.fn(async () => true) };
    const hook = new ComplianceEnforcementHookImpl(compliance as any, licenses as any);
    const result = await hook.getEnforcement(`org-${piiCategories.join('-') || 'none'}`);
    return result!.enforcedPlugins['pii-filter'];
  };

  it('switches off the categories the operator did not select', async () => {
    expect(await enforcementFor(['email', 'ssn'])).toEqual({
      detectEmails: true,
      detectSSN: true,
      detectPhoneNumbers: false,
      detectCreditCards: false,
      detectIPAddresses: false,
    });
  });

  it('leaves the plugin defaults alone when no category is selected -- empty means all', async () => {
    expect(await enforcementFor([])).toEqual({});
  });

  it('ignores a category a newer build wrote and this one does not know', () => {
    expect(piiCategoriesToSettings(['email', 'passport_number'])).toEqual({
      detectEmails: true,
      detectSSN: false,
      detectPhoneNumbers: false,
      detectCreditCards: false,
      detectIPAddresses: false,
    });
  });
});
