import { AutonomousStrategyRunner, withRoleInstructions } from '../autonomous-strategy.runner';

/**
 * Work mode Panel: each model panelist answers with its own extra
 * instructions (its angle). They were dropped, so a panel set up as "read
 * it as the supplier's lawyer" and "check it against Dutch law" got the
 * same reading three times.
 */
describe('panelists answer with their extra instructions', () => {
  const conversation = [
    { role: 'system', content: '[INSTRUCTIONS]\nReview supplier contracts.' },
    { role: 'user', content: 'Review the attached draft.' },
  ] as any[];

  it('puts the role instructions after the system prompt', () => {
    const out = withRoleInstructions(conversation, { name: 'Supplier side', instructions: "Read it as the supplier's lawyer." }) as any[];
    expect(out.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(out[1].content).toBe("[YOUR ROLE: Supplier side]\nRead it as the supplier's lawyer.");
    expect(withRoleInstructions(conversation, { name: 'Main' })).toBe(conversation);
    expect(withRoleInstructions(conversation, { name: 'Main', instructions: '  ' })).toBe(conversation);
  });

  it('sends each panelist its own angle', async () => {
    const sent: any[] = [];
    const chatStream = jest.fn(async (_providerId: string, request: any) => {
      sent.push(request);
      const judging = String(request.messages.at(-1)?.content).startsWith('Several responses');
      return { message: { content: judging ? '{"agreeing": 1, "answer": "One memo."}' : `answer ${sent.length}` }, cost: 0.001, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    });
    const runner = new AutonomousStrategyRunner({ llmProvidersService: { chatStream } } as any, {} as any);
    const run: any = { id: 'run-1', organizationId: 'org-1', input: 'Review the attached draft.', steps: [], totalCost: 0, totalTokens: 0, metadata: {} };
    const role = (key: string, name: string, instructions?: string) => ({ key, name, purpose: key === 'judge' ? 'judge' : 'panelist', kind: 'model', providerId: 'p', model: 'm', ...(instructions ? { instructions } : {}) }) as any;

    const result = await runner.panel({
      run,
      main: role('main', 'Main'),
      panelists: [role('panelist_1', 'Supplier side', "Read it as the supplier's lawyer."), role('panelist_2', 'Dutch law', 'Check it against Dutch and EU law.')],
      judge: role('judge', 'Judge'),
      loopRequest: { messages: conversation } as any,
      first: 'main answer',
      limits: {} as any,
    });

    const systemOf = (request: any) => request.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
    const panelCalls = sent.filter((r) => !String(r.messages.at(-1)?.content).startsWith('Several responses'));
    expect(panelCalls).toHaveLength(2);
    expect(panelCalls.map(systemOf)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[YOUR ROLE: Supplier side]\nRead it as the supplier's lawyer."),
        expect.stringContaining('[YOUR ROLE: Dutch law]\nCheck it against Dutch and EU law.'),
      ]),
    );
    expect(result.content).toBe('One memo.');
  });
});
