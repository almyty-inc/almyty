import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import {
  BUILD_PLATFORMS,
  canBuildHere,
  describeOutcome,
  isBuildable,
  platformsFor,
  signingRequirementFor,
} from '../build-targets';

describe('what can be built, and where', () => {
  it('knows which targets produce an artifact at all', () => {
    expect(isBuildable(DistributionTarget.TUI)).toBe(true);
    expect(isBuildable(DistributionTarget.DESKTOP)).toBe(true);
    expect(isBuildable(DistributionTarget.BINARY)).toBe(true);
    // A web app is served, not downloaded, and Slack is someone else's
    // client. Neither has anything to compile.
    expect(isBuildable(DistributionTarget.WEB)).toBe(false);
    expect(isBuildable(DistributionTarget.SLACK)).toBe(false);
  });

  it('offers macOS for every buildable target', () => {
    for (const target of [
      DistributionTarget.TUI,
      DistributionTarget.BINARY,
      DistributionTarget.DESKTOP,
    ]) {
      const ids = platformsFor(target).map((p) => p.id);
      expect(ids).toContain('macos-arm64');
    }
  });

  it('needs no Apple hardware for anything', () => {
    // Executables cross-compile through bun; the desktop app ships as a
    // zipped .app rather than a .dmg; rcodesign signs and notarises both
    // from Linux. The usual "macOS needs a Mac" shorthand does not apply.
    for (const target of [
      DistributionTarget.TUI,
      DistributionTarget.BINARY,
      DistributionTarget.DESKTOP,
    ]) {
      for (const platform of platformsFor(target)) {
        expect(canBuildHere(platform.id, target, { macos: false })).toEqual({
          ok: true,
          reason: null,
        });
      }
    }
  });

  it('rejects a platform it does not know rather than guessing', () => {
    const result = canBuildHere('solaris-sparc', DistributionTarget.TUI);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown platform/);
  });

  it('defaults macOS to a zip, which is the format Apple documents', () => {
    expect(BUILD_PLATFORMS['macos-arm64'].extension).toBe('zip');
    expect(BUILD_PLATFORMS['macos-x64'].extension).toBe('zip');
  });

  it('still offers a disk image, which xorrisofs can produce on Linux', () => {
    // A .dmg is a preference for the drag-to-Applications window, not a
    // reason to need Apple hardware.
    expect(describeOutcome('macos-arm64', true, 'dmg').artifact).toMatch(/\.dmg$/);
    expect(describeOutcome('macos-arm64', true, 'zip').artifact).toMatch(/\.zip$/);
  });
});

describe('signing requirements', () => {
  it('asks for nothing on Linux', () => {
    expect(signingRequirementFor('linux-x64')).toBeNull();
  });

  it('asks for a certificate on Windows', () => {
    const requirement = signingRequirementFor('windows-x64');
    expect(requirement?.kind).toBe('authenticode');
    expect(requirement?.needs.join(' ')).toMatch(/\.pfx/);
  });

  it('asks for both halves of the Apple flow', () => {
    // A certificate alone is not enough: without notarisation macOS
    // still refuses to open the app.
    const requirement = signingRequirementFor('macos-arm64');
    expect(requirement?.kind).toBe('apple');
    expect(requirement?.needs.join(' ')).toMatch(/Developer ID/);
    expect(requirement?.needs.join(' ')).toMatch(/App Store Connect/);
  });
});

describe('describeOutcome', () => {
  it('warns that an unsigned macOS build will not open', () => {
    const outcome = describeOutcome('macos-arm64', false);
    expect(outcome.caveat).toMatch(/refuses to open/);
  });

  it('warns about SmartScreen on an unsigned Windows build', () => {
    expect(describeOutcome('windows-x64', false).caveat).toMatch(/SmartScreen/);
  });

  it('says nothing alarming about an unsigned Linux build, because there is nothing', () => {
    expect(describeOutcome('linux-x64', false).caveat).toBeNull();
  });

  it('drops the caveat once the build will be signed', () => {
    expect(describeOutcome('macos-arm64', true).caveat).toBeNull();
    expect(describeOutcome('windows-x64', true).caveat).toBeNull();
  });

  it('names the artifact the operator will actually receive', () => {
    expect(describeOutcome('macos-arm64', true).artifact).toMatch(/\.zip$/);
    expect(describeOutcome('linux-x64', true).artifact).toMatch(/\.AppImage$/);
  });
});
