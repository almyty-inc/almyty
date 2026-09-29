import { BadRequestException } from '@nestjs/common';

import { normaliseRunnerLabels } from './agents.service';

/**
 * agentConfig.runnerLabels arrives as typed text from the agent form or
 * as an object from the API, and is stored as an object the run engine
 * hands to every runner-backed tool call.
 */
describe('an agent\'s machine labels on save', () => {
  it('turns typed text into the stored object', () => {
    const config: any = { canCallAgents: false, runnerLabels: 'gpu=yes, os=mac' };
    normaliseRunnerLabels(config);
    expect(config.runnerLabels).toEqual({ gpu: 'yes', os: 'mac' });
  });

  it('clears the requirement when the field is emptied', () => {
    const config: any = { runnerLabels: ' ' };
    normaliseRunnerLabels(config);
    expect(config).not.toHaveProperty('runnerLabels');
  });

  it('leaves a config without the field alone', () => {
    const config: any = { canCallAgents: true };
    normaliseRunnerLabels(config);
    expect(config).toEqual({ canCallAgents: true });
    expect(() => normaliseRunnerLabels(undefined)).not.toThrow();
  });

  it('refuses text that is not key=value', () => {
    expect(() => normaliseRunnerLabels({ runnerLabels: 'gpu' })).toThrow(BadRequestException);
  });
});
