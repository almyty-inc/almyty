import { loadEeModules } from './ee-loader';

/**
 * The ee-loader is the OSS↔EE bridge. Under jest (which resolves `.ts`),
 * the `ee/` barrel is present, so the loader returns the EE module classes
 * — this exercises the EE-build code path. The OSS behaviour (barrel absent
 * → `[]`) is verified end-to-end against the compiled OSS `dist/`, since it
 * depends on the runtime module resolver not finding a built `ee/index.js`.
 */
describe('loadEeModules', () => {
  it('resolves the EE_MODULES barrel when ee/ is present', () => {
    const modules = loadEeModules();
    expect(Array.isArray(modules)).toBe(true);
    expect(modules.length).toBeGreaterThan(0);
    // Every entry is a NestJS module class (a constructor function).
    for (const m of modules) {
      expect(typeof m).toBe('function');
    }
  });

  it('returns the full EE feature set', () => {
    const names = loadEeModules().map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'SsoModule',
        'RbacModule',
        'AuditExportModule',
        'ApprovalPoliciesModule',
        'BillingModule',
        'EeStubsModule',
        'ComplianceModule',
        'ChargebackModule',
      ]),
    );
  });
});
