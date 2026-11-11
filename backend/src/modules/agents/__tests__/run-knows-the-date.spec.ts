/**
 * An agent asked for "today's meetings" or to "follow up after three days
 * without a reply" has to know what day it is. The model does not: its
 * system prompt has to say so, on every call, as of that call, in the
 * organization's time zone.
 */
import { AgentRuntimeBuilders, describeNow } from '../agent-runtime-builders';
import { currentTimeBlock, localTime, withCurrentTime } from '../../../common/utils/current-time';
import { LlmChatHelper } from '../../llm-providers/llm-chat.helper';

describe('a run is told the current date and time', () => {
  const builders = new AgentRuntimeBuilders({ find: jest.fn(async () => []) } as any, { listActiveRules: jest.fn(async () => []) } as any);
  const agent: any = { id: 'a1', instructions: 'Write the morning brief.', agentConfig: {}, memoryConfig: {} };
  const run: any = { id: 'r1', organizationId: 'org-1' };

  afterEach(() => jest.useRealTimers());

  it('describes the moment with its weekday, in UTC', () => {
    expect(describeNow(new Date('2026-10-08T07:05:00Z'))).toBe('It is Thursday, 2026-10-08, 07:05 UTC (2026-10-08T07:05:00.000Z).');
  });

  it('describes the moment on the clock of a time zone', () => {
    // 23:30 UTC on Thursday is already Friday morning in Tokyo.
    expect(describeNow(new Date('2026-10-08T23:30:00Z'), 'Asia/Tokyo')).toBe(
      'It is Friday, 2026-10-09, 08:30 in Asia/Tokyo (2026-10-08T23:30:00.000Z).',
    );
    expect(localTime(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin').iso).toBe('2026-01-15T13:00:00+01:00');
    expect(localTime(new Date('2026-07-15T12:00:00Z'), 'America/New_York').iso).toBe('2026-07-15T08:00:00-04:00');
  });

  it('says a date up to today is not in the future', () => {
    expect(currentTimeBlock(new Date('2026-10-08T23:30:00Z'), 'Asia/Tokyo')).toContain(
      "The organization's time zone is Asia/Tokyo. A date on or before 2026-10-09 is not in the future.",
    );
  });

  it('an unknown time zone reads as UTC', () => {
    expect(describeNow(new Date('2026-10-08T07:05:00Z'), 'Mars/Olympus')).toContain('07:05 UTC');
  });

  it('goes into the system prompt after the instructions, once', async () => {
    const messages = await builders.buildMessages(agent, run, [], '');
    const dated = withCurrentTime(messages, new Date('2026-10-12T06:30:00Z'), 'Europe/Berlin');

    expect(dated[0].role).toBe('system');
    expect(dated[0].content).toContain('[CURRENT TIME]\nIt is Monday, 2026-10-12, 08:30 in Europe/Berlin');
    expect(dated[0].content.indexOf('[INSTRUCTIONS]')).toBeLessThan(dated[0].content.indexOf('[CURRENT TIME]'));
    // Applied again (chatStream falls through to chat), it is not added twice.
    const again = withCurrentTime(dated, new Date('2026-10-12T06:31:00Z'), 'Europe/Berlin');
    expect(again[0].content.split('[CURRENT TIME]').length).toBe(2);
  });

  it('a prompt with no system message gets one of its own', () => {
    const dated = withCurrentTime([{ role: 'user', content: 'Which day is it?' }], new Date('2026-10-12T06:30:00Z'));
    expect(dated).toHaveLength(2);
    expect(dated[0]).toEqual({ role: 'system', content: expect.stringContaining('It is Monday, 2026-10-12, 06:30 UTC') });
    expect(dated[1]).toEqual({ role: 'user', content: 'Which day is it?' });
  });

  describe('the model call (LlmChatHelper) adds it to a request that asks', () => {
    const helper = (zone?: string): any => {
      const h: any = Object.create(LlmChatHelper.prototype);
      h.timeZones = zone ? { zoneOf: jest.fn(async () => zone) } : undefined;
      return h;
    };
    const request = { messages: [{ role: 'system', content: 'You are a verifier.' }, { role: 'user', content: 'Check this.' }] };

    it('in the organization time zone', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-12T23:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const h = helper('Asia/Tokyo');
      const dated = await h.datedRequest({ ...request, currentTime: true }, 'org-1');
      expect(h.timeZones.zoneOf).toHaveBeenCalledWith('org-1');
      expect(dated.messages[0].content).toMatch(/^You are a verifier\.\n\n\[CURRENT TIME\]\nIt is Tuesday, 2026-10-13, 08:30 in Asia\/Tokyo/);
      expect(dated.messages[1]).toEqual(request.messages[1]);
    });

    it('in UTC when the time zone service is not wired', async () => {
      const dated = await helper().datedRequest({ ...request, currentTime: true }, 'org-1');
      expect(dated.messages[0].content).toContain('UTC');
    });

    it('and leaves a request that does not ask alone', async () => {
      const plain = { ...request };
      expect(await helper('Asia/Tokyo').datedRequest(plain, 'org-1')).toBe(plain);
    });
  });
});