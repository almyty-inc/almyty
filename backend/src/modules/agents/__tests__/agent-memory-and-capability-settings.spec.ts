import {
  NATIVE_MEMORY_ACCOUNT,
  memoryConfigProblems,
  memoryScopeFor,
  memorySettings,
  retentionSeconds,
} from '../agent-memory-settings';
import {
  capabilityProblems,
  mayCallAgent,
  normaliseCapabilities,
  temporaryAgentLimits,
} from '../agent-capabilities';

/**
 * The Memory and Capabilities sections of an autonomous agent, as the
 * server reads them. Each setting on the page is one of these values; the
 * page and the API are refused with the same sentences.
 */
describe('memory settings', () => {
  const agent = (memoryConfig: any) => ({ id: 'agent-1', memoryConfig }) as any;
  const run = (over: Record<string, any> = {}) =>
    ({ id: 'run-1', organizationId: 'org-1', userId: 'u-1', endUserId: null, metadata: {}, ...over }) as any;

  it('defaults to what the agent did before these settings: almyty, shared, saved only when asked, kept until deleted', () => {
    expect(memorySettings({ enabled: true })).toEqual({
      enabled: true,
      account: NATIVE_MEMORY_ACCOUNT,
      whose: 'shared',
      save: 'asked',
      neverSave: [],
      retentionDays: null,
      credentialId: null,
    });
  });

  it('reads the old auto-save switch as saving facts', () => {
    expect(memorySettings({ enabled: true, autoSave: true }).save).toBe('facts');
    // An explicit choice wins over the old switch.
    expect(memorySettings({ enabled: true, autoSave: true, save: 'asked' }).save).toBe('asked');
  });

  it('splits the never-save rules into lines and drops blanks', () => {
    expect(memorySettings({ enabled: true, neverSave: 'payment details\n\n  health information  \n' }).neverSave).toEqual([
      'payment details',
      'health information',
    ]);
  });

  describe('whose memory a run reads and writes', () => {
    it("shared: the organization's memory every agent sees", () => {
      expect(memoryScopeFor(agent({ enabled: true, whose: 'shared' }), run())).toEqual({ scope_type: 'workspace', scope_id: 'org-1' });
    });

    it("per agent: this agent's own memory, which no other agent reads", () => {
      expect(memoryScopeFor(agent({ enabled: true, whose: 'agent' }), run())).toEqual({ scope_type: 'agent', scope_id: 'org-1:agent:agent-1' });
    });

    it('per person: the member who started the run', () => {
      expect(memoryScopeFor(agent({ enabled: true, whose: 'person' }), run())).toEqual({ scope_type: 'user', scope_id: 'org-1:user:u-1' });
    });

    it("per person: a visitor gets a memory of their own, apart from every member's", () => {
      expect(memoryScopeFor(agent({ enabled: true, whose: 'person' }), run({ userId: null, endUserId: 'eu-7' }))).toEqual({
        scope_type: 'user',
        scope_id: 'org-1:user:visitor:eu-7',
      });
    });

    it('per person with nobody to remember for (a heartbeat, an A2A caller): no memory at all', () => {
      expect(memoryScopeFor(agent({ enabled: true, whose: 'person' }), run({ userId: null }))).toBeNull();
    });

    it('memory off: no scope', () => {
      expect(memoryScopeFor(agent({ enabled: false, whose: 'shared' }), run())).toBeNull();
      expect(memoryScopeFor(agent(null), run())).toBeNull();
    });
  });

  it('turns days into the ttl every saved memory carries', () => {
    expect(retentionSeconds(memorySettings({ enabled: true, retentionDays: 30 }))).toBe(30 * 86400);
    expect(retentionSeconds(memorySettings({ enabled: true }))).toBeNull();
  });

  describe('refused at save', () => {
    const accounts = [
      { id: NATIVE_MEMORY_ACCOUNT, name: "almyty's own memory", canExpire: true },
      { id: 'mem0', name: 'Mem0', canExpire: true },
      { id: 'vertex-memory-bank', name: 'Vertex AI Memory Bank', canExpire: false },
    ];

    it('accepts a sound configuration', () => {
      expect(
        memoryConfigProblems({ enabled: true, account: 'mem0', whose: 'agent', save: 'facts', neverSave: 'card numbers', retentionDays: 30 }, accounts),
      ).toEqual([]);
      expect(memoryConfigProblems(null, accounts)).toEqual([]);
    });

    it('names each bad value', () => {
      expect(memoryConfigProblems({ whose: 'everyone', save: 'always', retentionDays: 0 }, accounts)).toEqual([
        'Whose memory must be one of: person, agent, shared',
        'What gets saved must be one of: facts, conversations, asked',
        'Keep memories for 1 to 3650 days, or until deleted',
      ]);
    });

    it('refuses an account the organization has not set up', () => {
      expect(memoryConfigProblems({ enabled: true, account: 'zep' }, accounts)).toEqual([
        'The memory account "zep" is not set up for this organization. Set it up on the Memory page first',
      ]);
    });

    it('refuses a time limit on an account almyty cannot delete single memories from', () => {
      expect(memoryConfigProblems({ enabled: true, account: 'vertex-memory-bank', retentionDays: 30 }, accounts)).toEqual([
        'Vertex AI Memory Bank has no way to delete one memory, so its memories are kept until deleted there',
      ]);
    });

    it('refuses never-save rules too long to screen with', () => {
      expect(memoryConfigProblems({ neverSave: 'x'.repeat(2001) }, accounts)).toEqual(['Keep the never-save rules under 2000 characters']);
    });
  });
});

describe('capabilities', () => {
  const agent = (agentConfig: any, id = 'agent-1') => ({ id, agentConfig }) as any;

  it('calls exactly the agents it was given', () => {
    const a = agent({ canCallAgents: true, callableAgentIds: ['b'] });
    expect(mayCallAgent(a, 'b')).toBe(true);
    expect(mayCallAgent(a, 'c')).toBe(false);
  });

  it('an empty list calls nothing, whatever the old switch says', () => {
    expect(mayCallAgent(agent({ canCallAgents: true, callableAgentIds: [] }), 'b')).toBe(false);
  });

  it('never calls itself', () => {
    expect(mayCallAgent(agent({ canCallAgents: true, callableAgentIds: ['agent-1'] }), 'agent-1')).toBe(false);
  });

  it('an API client that only sets the switch still means every agent', () => {
    expect(mayCallAgent(agent({ canCallAgents: true }), 'z')).toBe(true);
    expect(mayCallAgent(agent({}), 'z')).toBe(false);
  });

  it('keeps the switch equal to the list on save', () => {
    const cfg: any = { canCallAgents: true, callableAgentIds: [] };
    normaliseCapabilities(cfg);
    expect(cfg.canCallAgents).toBe(false);
    const on: any = { callableAgentIds: ['b', 'b'], apiIds: ['api-1', 'api-1'] };
    normaliseCapabilities(on);
    expect(on).toEqual({ canCallAgents: true, callableAgentIds: ['b'], apiIds: ['api-1'] });
  });

  it('reads the temporary agent limits: per run and alive at once', () => {
    expect(temporaryAgentLimits(agent({ canCreateAgents: true, maxTemporaryAgents: 2, maxTemporaryAgentsAlive: 4 }))).toEqual({ perRun: 2, alive: 4 });
    expect(temporaryAgentLimits(agent({ canCreateAgents: false, maxTemporaryAgents: 2 }))).toEqual({ perRun: 0, alive: 0 });
    expect(temporaryAgentLimits(agent({ canCreateAgents: true }))).toEqual({ perRun: null, alive: null });
  });

  it('names each bad value', () => {
    expect(capabilityProblems({ callableAgentIds: 'b', apiIds: [3], maxTemporaryAgents: 0, maxTemporaryAgentsAlive: 21 })).toEqual([
      'The agents it may call must be a list of agent ids',
      'The APIs it may use must be a list of API ids',
      'Temporary agents per run must be a whole number from 1 to 20',
      'Temporary agents alive at once must be a whole number from 1 to 20',
    ]);
    expect(capabilityProblems({ callableAgentIds: ['b'], apiIds: ['api-1'], maxTemporaryAgents: 3, maxTemporaryAgentsAlive: 5 })).toEqual([]);
  });
});
