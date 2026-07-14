import 'reflect-metadata';

import { PromotedSkillsService } from '../promoted-skills.service';

/**
 * Regression: in the compiled EE assembly (dist-ee require order), the module
 * cycle llm-providers -> tool-executor -> runner -> mcp -> promoted-skills
 * left LlmProvidersService undefined at the moment PromotedSkillsService was
 * decorated. design:paramtypes[3] became undefined, Nest threw "can't resolve
 * dependencies (?)" at boot, and dev/staging rolled out straight into
 * CrashLoopBackOff — while tsc and the whole jest suite stayed green.
 *
 * The fix is an explicit @Inject(forwardRef(() => LlmProvidersService)),
 * which records a self-declared dependency that survives the cycle. This
 * spec locks that: if someone removes the forwardRef, the self-declared
 * dep for index 3 disappears and this fails in-suite.
 *
 * (The general class of this bug is caught post-build by
 * `scripts/ee-di-smoke.js`, which jest cannot reproduce because it sandboxes
 * the module registry — this spec pins the one known instance.)
 */
describe('PromotedSkillsService DI cycle guard', () => {
  it('declares LlmProvidersService via forwardRef self-declared dependency at index 3', () => {
    const selfDeclared: Array<{ index: number; param: any }> =
      Reflect.getMetadata('self:paramtypes', PromotedSkillsService) || [];
    const dep = selfDeclared.find((d) => d.index === 3);
    expect(dep).toBeDefined();
    // forwardRef wrapper exposes the target lazily
    expect(typeof dep!.param.forwardRef).toBe('function');
  });
});
