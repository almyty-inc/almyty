import { NotFoundException } from '@nestjs/common';

import { CliGeneratorService } from '../cli-generator.service';
import { CodegenService } from '../codegen.service';
import { SkillGeneratorService } from '../skill-generator.service';
import { SkillRendererHelper } from '../skill-renderer.helper';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * The SKILL.md, CLI and SDK generators print a tool's or a gateway's full
 * definition, so their lookups carry the caller's organization. Their
 * specs stub `findOne` with a canned row, which answers any `where`; here
 * the other tenant's rows are in a real table and must stay unreachable.
 */
describe('tool and gateway generators are organization-scoped', () => {
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';

  const repos = () => ({
    tools: fakeRepository<any>([
      { id: 'tool-theirs', organizationId: OTHER_ORG, name: 'theirTool', parameters: {} },
    ]),
    gateways: fakeRepository<any>([
      { id: 'gw-theirs', organizationId: OTHER_ORG, name: 'Their Gateway', endpoint: '/theirs' },
      { id: 'gw-mine', organizationId: ORG, name: 'My Gateway', endpoint: '/mine' },
    ]),
    gatewayTools: fakeRepository<any>(),
  });

  const skills = (r: ReturnType<typeof repos>) =>
    new SkillGeneratorService(r.tools as any, r.gateways as any, r.gatewayTools as any, new SkillRendererHelper());
  const cli = (r: ReturnType<typeof repos>) =>
    new CliGeneratorService(r.tools as any, r.gateways as any, r.gatewayTools as any);
  const sdk = (r: ReturnType<typeof repos>) =>
    new CodegenService(r.tools as any, r.gateways as any, r.gatewayTools as any);

  it("skills: no SKILL.md for another organization's tool", async () => {
    await expect(skills(repos()).generateToolSkill('tool-theirs', ORG)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("skills: no bundle for another organization's gateway, but one for its own", async () => {
    const service = skills(repos());
    await expect(service.generateGatewaySkills('gw-theirs', ORG)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.generateGatewaySkills('gw-mine', ORG)).resolves.toMatchObject({ toolCount: 0 });
  });

  it("skills: no individual skills for another organization's gateway", async () => {
    await expect(skills(repos()).generateIndividualSkills('gw-theirs', ORG)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("cli: no script for another organization's tool", async () => {
    await expect(cli(repos()).generateToolCli('tool-theirs', 'bash', ORG)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("cli: no bundle for another organization's gateway, but one for its own", async () => {
    const service = cli(repos());
    await expect(service.generateGatewayCliBunde('gw-theirs', 'bash', ORG)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.generateGatewayCliBunde('gw-mine', 'bash', ORG)).resolves.toMatchObject({
      toolCount: 0,
    });
  });

  it("sdk: no SDK for another organization's tool", async () => {
    await expect(sdk(repos()).generateToolSdk('tool-theirs', ORG)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("sdk: no SDK for another organization's gateway, but one for its own", async () => {
    const service = sdk(repos());
    await expect(service.generateGatewaySdk('gw-theirs', ORG)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.generateGatewaySdk('gw-mine', ORG)).resolves.toMatchObject({ toolCount: 0 });
  });
});
