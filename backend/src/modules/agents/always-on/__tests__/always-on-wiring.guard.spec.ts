import { readFileSync } from 'fs';
import { join } from 'path';

import { WAKE_SOURCES } from '../../../../entities/agent-wake.entity';

/**
 * Source-reading guards for Always on (docs/always-on.md): every unit is
 * reached by a real entry point, and the heartbeat's fixed ten steps stay
 * gone. Each of these was a real failure mode before: a heartbeat job that
 * no boot restored, a builder save that never reached the queue, a run
 * capped at ten steps whatever the agent said.
 */
const SRC = join(__dirname, '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('Always on is wired', () => {
  const processor = code('modules/agents/agent-runtime.processor.ts');
  const service = code('modules/agents/always-on/always-on.service.ts');

  it('no wake runs on a fixed number of steps', () => {
    expect(processor).not.toMatch(/maxSteps:\s*10\b/);
    expect(service).not.toMatch(/maxSteps\s*:/);
    // The run takes the agent's own limits.
    expect(service).toMatch(/startRun\([\s\S]*?agentLimits: true/);
  });

  it('the timer and the wake job are handled by the runtime processor', () => {
    expect(processor).toMatch(/@Process\(ALWAYS_ON_TICK_JOB\)[\s\S]*?this\.alwaysOn\.tick\(/);
    expect(processor).toMatch(/@Process\(ALWAYS_ON_WAKE_JOB\)[\s\S]*?this\.alwaysOn\.process\(/);
    // A heartbeat job left in Redis from before still fires as a tick.
    expect(processor).toMatch(/@Process\(LEGACY_HEARTBEAT_JOB\)/);
  });

  it('timers are restored at boot', () => {
    expect(service).toMatch(/async onModuleInit\(\)[\s\S]*?await this\.restoreTimers\(\)/);
  });

  it('a finished run reports through Always on', () => {
    expect(processor).toMatch(/private async finished\(runId: string\)[\s\S]*?this\.alwaysOn\?\.onRunFinished\(runId\)/);
    expect((processor.match(/await this\.finished\(runId\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('wakes that arrive during a run join it at its next step', () => {
    expect(code('modules/agents/agent-step-processor.ts')).toMatch(/this\.alwaysOn\.drainInto\(run\)/);
  });

  it('every wake source has a caller', () => {
    for (const source of WAKE_SOURCES) {
      expect({ source, called: new RegExp(`\\.wake\\([^)]*'${source}'`).test(service) }).toEqual({ source, called: true });
    }
    // ...and each of those is reached from outside the service.
    expect(code('modules/gateways/channels/channel-gateway.service.ts')).toMatch(/this\.alwaysOn[\s\S]{0,40}\.routeInbound\(/);
    expect(code('modules/agents/always-on/always-on.controller.ts')).toMatch(/this\.alwaysOn\.wakeNow\(/);
    expect(service).toMatch(/onConnectionEvent\(\(event\)/);
    expect(read('../ee/modules/connections-governance/connections-governance.service.ts')).toMatch(
      /private async notifyOwners[\s\S]{0,300}publishForNotification\(type, connection\)/,
    );
  });

  it('the builder save no longer schedules anything by itself', () => {
    expect(code('modules/agents/agents.controller.ts')).not.toMatch(/reconcileHeartbeat|enableHeartbeat/);
  });

  it('the daily summary and the capacity check are handled by the runtime processor', () => {
    expect(processor).toMatch(/@Process\(ALWAYS_ON_DIGEST_JOB\)[\s\S]*?this\.alwaysOn\.digest\(/);
    expect(processor).toMatch(/@Process\(ALWAYS_ON_CAPACITY_JOB\)[\s\S]*?this\.alwaysOn\.resumeAllWithinCapacity\(/);
    // ...and both are scheduled: the summary with the agent's other jobs, the check at boot.
    expect(service).toMatch(/private async scheduleJobs[\s\S]*?ALWAYS_ON_DIGEST_JOB/);
    expect(service).toMatch(/async restoreTimers\(\)[\s\S]*?await this\.scheduleCapacityCheck\(\)/);
  });

  it('CAPACITY_EXHAUSTED is raised where a wake turns into a run, before the run starts', () => {
    const process = service.slice(service.indexOf('async process('), service.indexOf('private async claim('));
    expect(process.indexOf('capacityPause(')).toBeGreaterThan(-1);
    expect(process.indexOf('capacityPause(')).toBeLessThan(process.indexOf('this.runtime.startRun('));
  });
});
