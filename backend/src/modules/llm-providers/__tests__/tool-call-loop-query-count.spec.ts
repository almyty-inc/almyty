import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';

/**
 * One model turn's tool calls used to cost a findOne each — the batched form
 * was already ten lines above in the same file (`prepareTools`), the loop
 * just did not use it — and the executions ran strictly serially.
 */
describe('executeToolCalls resolves tools in one query', () => {
  const ORG = 'org-1';
  const session: any = { userId: 'user-1' };

  const makeHelper = (tools: any[], execute?: jest.Mock) => {
    const toolRepository = { find: jest.fn().mockResolvedValue(tools), findOne: jest.fn() };
    const toolExecutorService = {
      executeTool:
        execute ??
        jest.fn().mockResolvedValue({ success: true, data: 'ok', executionTime: 1, cached: false }),
    };
    const helper = Object.create(LlmChatRunnerHelper.prototype) as LlmChatRunnerHelper;
    (helper as any).toolRepository = toolRepository;
    (helper as any).toolExecutorService = toolExecutorService;
    return { helper, toolRepository, toolExecutorService };
  };

  it('issues one org-scoped query for five tool calls, not five', async () => {
    const tools = ['a', 'b', 'c', 'd', 'e'].map((name, i) => ({
      id: `t-${i}`, name, organizationId: ORG,
    }));
    const { helper, toolRepository, toolExecutorService } = makeHelper(tools);
    const toolCalls = tools.map((t, i) => ({ id: `c-${i}`, name: t.name, parameters: {} })) as any[];

    await helper.executeToolCalls(toolCalls, session, ORG);

    expect(toolRepository.find).toHaveBeenCalledTimes(1);
    expect(toolRepository.findOne).not.toHaveBeenCalled();
    expect(toolRepository.find).toHaveBeenCalledWith({
      where: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, organizationId: ORG })),
    });
    expect(toolExecutorService.executeTool).toHaveBeenCalledTimes(5);
    expect(toolCalls.every((c) => c.result === 'ok')).toBe(true);
  });

  it('asks for each distinct name once when the model repeats a tool', async () => {
    const { helper, toolRepository } = makeHelper([{ id: 't-1', name: 'a', organizationId: ORG }]);
    const toolCalls = [
      { id: 'c-1', name: 'a', parameters: {} },
      { id: 'c-2', name: 'a', parameters: {} },
    ] as any[];

    await helper.executeToolCalls(toolCalls, session, ORG);

    expect(toolRepository.find.mock.calls[0][0].where).toEqual([{ name: 'a', organizationId: ORG }]);
  });

  it('never matches a tool owned by another organization', async () => {
    // A row that slipped through the query must still be rejected in memory.
    const { helper, toolExecutorService } = makeHelper([
      { id: 't-other', name: 'send_email', organizationId: 'org-2' },
    ]);
    const toolCalls = [{ id: 'c-1', name: 'send_email', parameters: {} }] as any[];

    await helper.executeToolCalls(toolCalls, session, ORG);

    expect(toolExecutorService.executeTool).not.toHaveBeenCalled();
    expect(toolCalls[0].error).toBe("Tool 'send_email' not found");
  });

  it('reports a missing tool per call and still runs the others', async () => {
    const { helper, toolExecutorService } = makeHelper([
      { id: 't-1', name: 'a', organizationId: ORG },
    ]);
    const toolCalls = [
      { id: 'c-1', name: 'a', parameters: {} },
      { id: 'c-2', name: 'ghost', parameters: {} },
    ] as any[];

    await helper.executeToolCalls(toolCalls, session, ORG);

    expect(toolCalls[0].result).toBe('ok');
    expect(toolCalls[1].error).toBe("Tool 'ghost' not found");
    expect(toolExecutorService.executeTool).toHaveBeenCalledTimes(1);
  });

  it('runs a turn\'s tool calls concurrently rather than one round trip at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const execute = jest.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { success: true, data: 'ok', executionTime: 1, cached: false };
    });
    const tools = ['a', 'b', 'c'].map((name, i) => ({ id: `t-${i}`, name, organizationId: ORG }));
    const { helper } = makeHelper(tools, execute);
    const toolCalls = tools.map((t, i) => ({ id: `c-${i}`, name: t.name, parameters: {} })) as any[];

    await helper.executeToolCalls(toolCalls, session, ORG);

    expect(peak).toBeGreaterThan(1);
  });

  it('does nothing at all for an empty turn', async () => {
    const { helper, toolRepository } = makeHelper([]);
    await helper.executeToolCalls([], session, ORG);
    expect(toolRepository.find).not.toHaveBeenCalled();
  });
});
