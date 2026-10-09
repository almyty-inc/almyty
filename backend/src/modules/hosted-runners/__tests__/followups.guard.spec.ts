import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * The follow-ups of 2026-10-08, read from the source: each unit is reached
 * from the path that needs it (the "unwired units" rule), and the pod-scoped
 * model token is accepted nowhere but the model endpoints.
 */
const MODULE = join(__dirname, '..');
const SRC = join(MODULE, '..', '..');
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') sources(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('hosted runners follow-ups: wiring', () => {
  describe('the owner leaves, or the team goes', () => {
    const helper = read(SRC, 'modules', 'organizations', 'resource-handover.helper.ts');
    const orgs = read(SRC, 'modules', 'organizations', 'organizations.service.ts');
    const users = read(SRC, 'modules', 'users', 'users.service.ts');

    it('the handover helper hands environments over on every departure and privatises them on a team delete', () => {
      const leave = helper.slice(helper.indexOf('async handOverPrivateResources('), helper.indexOf('private async removeUserGrants('));
      expect(leave).toMatch(/this\.environments\.onMemberLeaving\(manager,/);
      // Hosted runners are not deregistered with the leaver's own machines.
      expect(leave).toMatch(/where: \{ organizationId, ownerUserId: fromUserId, kind: 'self' \}/);
      const team = helper.slice(helper.indexOf('async demoteTeamResources('));
      expect(team).toMatch(/this\.environments\.onTeamDeleted\(manager,/);
      expect(helper).toMatch(/@Optional\(\) private readonly environments\?: EnvironmentHandoverService/);
    });

    it('member removal, team deletion and account deletion run what the handover left for after commit', () => {
      const remove = orgs.slice(orgs.indexOf('async removeMember('), orgs.indexOf('private requireHandover('));
      expect(remove).toMatch(/handOverPrivateResources\(manager, \{[\s\S]*?afterCommit,[\s\S]*?\}\)/);
      expect(remove).toMatch(/publishCommitted\(audit\);\s*\/\/[^\n]*\n\s*await runAfterCommit\(afterCommit\);/);
      const del = orgs.slice(orgs.indexOf('async deleteTeam('), orgs.indexOf('async getTeamMembers('));
      expect(del).toMatch(/demoteTeamResources\(manager, \{[\s\S]*?afterCommit,[\s\S]*?\}\)/);
      expect(del).toMatch(/publishCommitted\(audit\);\s*await runAfterCommit\(afterCommit\);/);
      expect(users).toMatch(/handOverPrivateResources\(manager, \{[\s\S]*?afterCommit,[\s\S]*?\}\)/);
      expect(users).toMatch(/await runAfterCommit\(afterCommit\);/);
    });

    it('a team delete by any other path still makes its environments private (the trigger)', () => {
      const migration = read(SRC, 'migrations', '1791000300000-HostedRunnersFollowups.ts');
      expect(migration).toMatch(/UPDATE environments SET visibility = 'private', "teamId" = NULL WHERE "teamId" = OLD\.id/);
      expect(migration).toMatch(/BEFORE DELETE ON teams/);
    });
  });

  describe('one folder, one job at a time', () => {
    it('the tool executor names the run, maps busy to a retry, and gives a lone call\'s lease back', () => {
      const executor = read(SRC, 'modules', 'tools', 'tool-executor.service.ts');
      expect(executor).toMatch(/resolveTarget\(environmentId, \{[\s\S]*?runId,[\s\S]*?\}\)/);
      expect(executor).toMatch(/target\.kind === 'waking' \|\| target\.kind === 'busy'/);
      expect(executor).toMatch(/this\.hostedDispatch\?\.releaseLease\(heldLease\.workspaceId, heldLease\.holder\)/);
    });

    it('an agent run sleeps and retries on a busy workspace, as on a waking one', () => {
      expect(read(SRC, 'modules', 'agents', 'agent-step-processor.ts')).toMatch(/runnerErrorCode === WORKSPACE_BUSY/);
    });

    it('resolveTarget takes the lease, and the module provides the lease service', () => {
      const service = read(MODULE, 'hosted-runners.service.ts');
      expect(service).toMatch(/this\.leases\.acquire\(workspace\.id, holder, caller\.signal\)/);
      expect(read(MODULE, 'hosted-runners.module.ts')).toMatch(/providers: \[[\s\S]*\bWorkspaceLeaseService\b/);
    });

    it('a hosted pod cannot ask to run more than one thing at a time', () => {
      const enrollment = read(MODULE, 'enrollment.service.ts');
      expect(enrollment).toMatch(/\.\.\.\(input\.config \?\? \{\}\),[\s\S]*?maxConcurrent: 1,/);
    });
  });

  describe('usage records are kept for the retention window', () => {
    it('the retention tick runs the usage sweep and the module can reach the table', () => {
      const sweep = read(SRC, 'modules', 'retention', 'retention-sweep.service.ts');
      expect(sweep).toMatch(/Promise\.all\(\[[^\]]*this\.sweepRunnerUsage\(\)[^\]]*\]\)/);
      expect(sweep).toMatch(/endedAt: And\(Not\(IsNull\(\)\), LessThan\(cutoff\)\)/);
      expect(read(SRC, 'modules', 'retention', 'retention.module.ts')).toMatch(/RunnerUsageInterval,/);
    });
  });

  describe('what the Hosted tab reads', () => {
    it('is routed, with the fixed paths ahead of :id, and served by the insights service', () => {
      const controller = read(MODULE, 'environments.controller.ts');
      const at = (s: string) => controller.indexOf(s);
      expect(at("@Get('settings')")).toBeGreaterThan(-1);
      expect(at("@Get('usage')")).toBeGreaterThan(-1);
      expect(at("@Get('settings')")).toBeLessThan(at("@Get(':id')"));
      expect(at("@Get('usage')")).toBeLessThan(at("@Get(':id')"));
      expect(controller).toMatch(/@Get\(':id\/runs'\)[\s\S]*?this\.insights\.runs\(/);
      expect(controller).toMatch(/settings: await this\.insights\.options\(organizationId\)/);
      expect(controller).toMatch(/mine: mine\[e\.id\] \?\? null/);
      expect(read(MODULE, 'hosted-runners.module.ts')).toMatch(/providers: \[[\s\S]*\bEnvironmentInsightsService\b/);
    });
  });

  describe('the pod-scoped model token', () => {
    it('is accepted by the model endpoints and nowhere else, and gets the pass-through there, never an agent', () => {
      const users = sources(SRC)
        .filter((f) => !f.startsWith(MODULE + sep))
        .filter((f) => /HOSTED_MODEL_TOKENS|HostedModelTokenService/.test(readFileSync(f, 'utf8')))
        .map((f) => relative(SRC, f).split(sep).join('/'))
        .sort();
      expect(users).toEqual([
        'modules/agents/agent-anthropic-compat.controller.ts',
        'modules/agents/agent-openai-compat.controller.ts',
        'modules/agents/model-pass-through.controller.ts',
      ]);
      for (const file of users.filter((f) => f.includes('-compat.'))) {
        const source = read(SRC, file);
        // Asked first; a pod token goes to the pass-through and returns.
        expect(source).toMatch(/const podKey = await this\.podTokens\?\.authenticate\(presentedToken\(/);
        expect(source).toMatch(/if \(podKey\) \{\s*if \(!this\.passThrough\)[^\n]*\n\s*return await this\.passThrough\.forward\(podKey, '(anthropic_messages|openai_chat)'/);
      }
      const own = read(SRC, 'modules', 'agents', 'model-pass-through.controller.ts');
      expect(own).toMatch(/@Post\('responses'\)[\s\S]*?this\.passThrough\.forward\(key, 'openai_responses'/);
      // Inside the module only the renewal route takes it.
      const enrollment = read(MODULE, 'hosted-runner-enrollment.controller.ts');
      expect(enrollment).toMatch(/@Post\('hosted\/model-token'\)[\s\S]*?this\.modelTokens\.renew\(presentedToken\(authorization\)\)/);
    });

    it('the pass-through uses org-wide providers and the owner\'s granted private ones only, and counts as spend', () => {
      const pass = read(SRC, 'modules', 'agents', 'model-pass-through.service.ts');
      expect(pass).toMatch(/\{ organizationId, visibility: 'org', status: LlmProviderStatus\.ACTIVE \}/);
      expect(pass).toMatch(/\{ organizationId, visibility: 'private' as const, ownerUserId, hostedPodAccess: true, status: LlmProviderStatus\.ACTIVE \}/);
      // Only the provider's owner gives the grant.
      expect(read(SRC, 'modules', 'llm-providers', 'llm-providers.service.ts')).toMatch(/provider\.visibility !== 'private' \|\| provider\.ownerUserId !== userId/);
      expect(pass).toMatch(/this\.budgets\?\.enforceForOrganization\(organizationId\)/);
      expect(pass).not.toMatch(/AgentExecutionEngine|CompatAgentInvoker|startRun\(/);
      expect(read(SRC, 'modules', 'budgets', 'spend.service.ts')).toMatch(/repo: this\.hostedCallRepo, alias: 'run', perAgent: false/);
    });

    it('is minted at every pod start and revoked whenever the pod stops', () => {
      const processor = read(MODULE, 'hosted-runners.processor.ts');
      expect(processor).toMatch(/this\.modelTokens\.mint\(hr, workspace\.ownerUserId, now\)/);
      for (const reason of ['pod_stopped', 'torn_down', 'failed']) expect(processor).toMatch(new RegExp(`this\\.modelTokens\\?\\.revoke\\(hr\\.id, '${reason}'`));
      const moduleSource = read(MODULE, 'hosted-runners.module.ts');
      expect(moduleSource).toMatch(/provide: HOSTED_MODEL_TOKENS, useExisting: HostedModelTokenService/);
    });

    it('stores only a hash', () => {
      const entity = read(SRC, 'entities', 'hosted-model-token.entity.ts');
      const columns = [...entity.matchAll(/^\s+(\w+)(?:\?|!)?:\s/gm)].map((m) => m[1]);
      expect(columns).toContain('tokenHash');
      expect(columns).not.toContain('token');
      expect(read(MODULE, 'hosted-model-token.service.ts')).toMatch(/tokenHash: sha256\(token\)/);
    });
  });
});
