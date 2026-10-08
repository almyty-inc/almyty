import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The rules that keep hosted runners honest, read from the source, and
 * the wiring that proves each unit is reached from a real entry point
 * (the "unwired units" rule: code that compiles and passes its own tests
 * while nothing calls it).
 */
const MODULE = join(__dirname, '..');
const SRC = join(MODULE, '..', '..');
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

describe('hosted runners: rules and wiring', () => {
  describe('adapters never import each other', () => {
    const dir = join(MODULE, 'adapters');
    const files = readdirSync(dir).filter((f) => f.endsWith('.adapter.ts'));

    it('finds both adapters', () => {
      expect(files.sort()).toEqual(['kubernetes.adapter.ts', 'stub.adapter.ts']);
    });

    it.each(files)('%s imports only the interface and its own helpers', (file) => {
      const imports = [...read(dir, file).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      const offenders = imports.filter((p) => /\.adapter$/.test(p) || (/^\.\.?\//.test(p) && !/hosted-runner-adapter\.interface$/.test(p) && !p.startsWith(`./${file.replace('.adapter.ts', '')}/`)));
      expect(offenders).toEqual([]);
    });
  });

  describe('only the reconcile processor talks to adapters or writes what it observed', () => {
    const files = readdirSync(MODULE).filter((f) => f.endsWith('.ts') && f !== 'hosted-runners.processor.ts');

    it.each(files)('%s calls no adapter method', (file) => {
      const source = read(MODULE, file);
      expect(source).not.toMatch(/\badapter\.(provision|read|scale|rotateEnrollment|clearSecrets|teardown)\(/);
      expect(source).not.toMatch(/\badapters\.get\(/);
    });

    it.each(files)('%s writes only desired state and the idle clock on hosted_runners', (file) => {
      const source = read(MODULE, file);
      for (const m of source.matchAll(/this\.hostedRunners\.update\(([^;]*?)\);/gs)) {
        const patch = m[1].slice(m[1].indexOf('},') + 2);
        expect(patch).not.toMatch(/\b(state|actual|externalRef|lastError|lastReconcileAt)\b/);
      }
    });
  });

  describe('persistent workspaces', () => {
    it('are never released by a run ending: run-end release selects by runId, which they never carry', () => {
      const runEnd = read(SRC, 'modules', 'workspace', 'run-end-release.ts');
      expect(runEnd).toMatch(/repo\.update\(\s*\{ runId: job, status: WorkspaceStatus\.ACTIVE \}/);
      const service = read(MODULE, 'hosted-runners.service.ts');
      expect(service).toMatch(/kind: 'persistent',[\s\S]*?runId: null|runId: null,[\s\S]*?kind: 'persistent'/);
      const sweep = read(SRC, 'modules', 'workspace', 'workspace.service.ts');
      expect(sweep).toMatch(/filter\(\(w\) => !!w\.runId\)/);
    });

    it('are never stranded: the fan-out touches job workspaces only, and hosted runners are not offered for it', () => {
      const workspace = read(SRC, 'modules', 'workspace', 'workspace.service.ts');
      const strand = workspace.slice(workspace.indexOf('async markStrandedForRunners('), workspace.indexOf('private async transitionFromActive('));
      expect(strand).toMatch(/\.andWhere\('kind = :job', \{ job: 'job' \}\)/);
      const runner = read(SRC, 'modules', 'runner', 'runner.service.ts');
      expect(runner).toMatch(/if \(next === RunnerState\.OFFLINE && runner\.kind !== 'hosted'\) markStrandedFor\.push/);
      expect(runner).toMatch(/\.andWhere\(`r\.kind = 'self'`\)/);
    });
  });

  describe('every unit has a caller', () => {
    const moduleSource = read(MODULE, 'hosted-runners.module.ts');

    it('the module registers the processor, both adapters, enrollment, usage and the controllers', () => {
      for (const name of ['HostedRunnersProcessor', 'EnrollmentService', 'HostedUsageService', 'EnvironmentsService', 'HostedRunnersService']) {
        expect(moduleSource).toMatch(new RegExp(`providers: \\[[\\s\\S]*\\b${name}\\b`));
      }
      expect(moduleSource).toMatch(/controllers: \[EnvironmentsController, HostedRunnerEnrollmentController\]/);
      expect(moduleSource).toMatch(/register\(new KubernetesHostedAdapter\(/);
      expect(moduleSource).toMatch(/register\(new StubHostedAdapter\(\)\)/);
      expect(moduleSource).toMatch(/provide: HOSTED_DISPATCH, useExisting: HostedRunnersService/);
      expect(read(SRC, 'app.module.ts')).toMatch(/^\s+HostedRunnersModule,$/m);
    });

    it('the processor opens and closes usage intervals and mints enrollment tokens', () => {
      const processor = read(MODULE, 'hosted-runners.processor.ts');
      expect(processor).toMatch(/this\.usage\.open\(/);
      expect(processor).toMatch(/this\.usage\.close\(/);
      expect(processor).toMatch(/this\.enrollment\.mint\(/);
      expect(processor).toMatch(/this\.service\.suspendIdle\(/);
      expect(processor).toMatch(/this\.service\.sweepSuspended\(/);
    });

    it('the tool executor dispatches to environments through HOSTED_DISPATCH, and agents pass their environment', () => {
      const executor = read(SRC, 'modules', 'tools', 'tool-executor.service.ts');
      expect(executor).toMatch(/@Inject\(HOSTED_DISPATCH\) private readonly hostedDispatch/);
      expect(executor).toMatch(/this\.hostedDispatch\.resolveTarget\(/);
      const steps = read(SRC, 'modules', 'agents', 'agent-step-processor.ts');
      expect(steps).toMatch(/environmentId: agentEnvironmentId\(agent\)/);
      expect(steps).toMatch(/runnerErrorCode === WORKSPACE_WAKING/);
      expect(read(SRC, 'modules', 'agents', 'agent-execution.engine.ts')).toMatch(/environmentId: agentEnvironmentId\(agent\)/);
    });

    it('the hosted stream and enrollment are routed', () => {
      const stream = read(SRC, 'modules', 'runner', 'transport', 'worker-stream.controller.ts');
      expect(stream).toMatch(/@Post\('runners\/hosted\/stream'\)\s*@UseGuards\(RunnerCredentialGuard\)/);
      const enroll = read(MODULE, 'hosted-runner-enrollment.controller.ts');
      expect(enroll).toMatch(/@Post\('enroll'\)/);
      expect(enroll).toMatch(/@Post\('hosted\/credential'\)\s*@HttpCode\(200\)\s*@UseGuards\(RunnerCredentialGuard\)/);
    });

    it('environments publish and withdraw their tools', () => {
      const envs = read(MODULE, 'environments.service.ts');
      expect(envs).toMatch(/this\.capabilities\.publishEnvironment\(saved\)/);
      expect(envs).toMatch(/this\.capabilities\.unpublishEnvironment\(env\.id\)/);
    });
  });
});
