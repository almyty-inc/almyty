import { EventEmitter } from 'events';

import { A2AServerService } from '../a2a-server.service';
import { A2AAgentCardService } from '../a2a-agent-card.service';
import { a2aPartsToAgentInput, partsToText } from '../a2a-part.mapper';
import { agentRunToTask } from '../a2a-task.mapper';
import { A2A_ERROR_CODES, A2A_PROTOCOL_VERSION } from '../types/a2a-spec.types';

/**
 * Wire-shape conformance for the A2A JSON-RPC binding.
 *
 * Shapes here are taken from the normative A2A v1.0 definitions:
 *   - specification/a2a.proto  (a2aproject/A2A, tag v1.0.1)
 *   - docs/specification.md section 9, "JSON-RPC Protocol Binding"
 * A2A v1.0 carries the ProtoJSON encoding of the proto on every binding, so
 * the JSON-RPC wire uses TASK_STATE_* / ROLE_* enum values, oneof-member
 * discrimination for Parts and StreamResponse, and PascalCase method names.
 */
describe('A2A wire conformance (v1.0 JSON-RPC binding)', () => {
  const mockGateway: any = {
    id: 'gw-1',
    agentId: 'agent-1',
    organizationId: 'org-1',
    authConfigs: [],
    endpoint: '/test-a2a',
  };

  const mockReq: any = {
    protocol: 'https',
    get: () => 'api.example.com',
    on: jest.fn(),
  };

  const RUN_ID = '00000000-0000-0000-0000-0000000000aa';

  const makeRun = (overrides: any = {}) => ({
    id: RUN_ID,
    agentId: 'agent-1',
    organizationId: 'org-1',
    conversationId: 'ctx-1',
    status: 'running',
    output: null,
    error: null,
    metadata: {},
    totalCost: 0,
    executionTime: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDone: () => false,
    ...overrides,
  });

  const makeRes = () => {
    const writes: string[] = [];
    const headers: Record<string, string> = {};
    return {
      writes,
      headers,
      json: jest.fn(),
      setHeader: jest.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      end: jest.fn(),
      destroyed: false,
    };
  };

  const makeService = (runtime: any, runRepo: any) =>
    new A2AServerService(
      runtime as any,
      new A2AAgentCardService(),
      runRepo as any,
      { findOne: jest.fn() } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
    );

  /** Every SSE `data:` frame emitted onto a response, parsed. */
  const sseFrames = (res: { writes: string[] }) =>
    res.writes
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice('data: '.length).trim()));

  // -----------------------------------------------------------------------
  // 1. Inbound Part decoding — the failure that answers unasked questions
  // -----------------------------------------------------------------------

  describe('inbound Part decoding accepts every A2A dialect', () => {
    it('reads text from a v1.0 Part (oneof member presence)', () => {
      expect(a2aPartsToAgentInput([{ text: 'what is 2+2' } as any]).text).toBe(
        'what is 2+2',
      );
    });

    it('reads text from a v0.2.x / v0.3.x Part (kind discriminator)', () => {
      expect(
        a2aPartsToAgentInput([{ kind: 'text', text: 'what is 2+2' } as any]).text,
      ).toBe('what is 2+2');
    });

    it('reads text from a v0.1.x Part (type discriminator)', () => {
      expect(
        a2aPartsToAgentInput([{ type: 'text', text: 'what is 2+2' } as any]).text,
      ).toBe('what is 2+2');
    });

    it('joins multiple text parts', () => {
      expect(
        a2aPartsToAgentInput([
          { kind: 'text', text: 'a' },
          { text: 'b' },
        ] as any).text,
      ).toBe('a\nb');
    });

    it('merges data parts into variables in every dialect', () => {
      expect(
        a2aPartsToAgentInput([
          { kind: 'data', data: { a: 1 } },
          { data: { b: 2 } },
        ] as any).variables,
      ).toEqual({ a: 1, b: 2 });
    });

    it('ignores file parts rather than emitting empty text for them', () => {
      const out = a2aPartsToAgentInput([
        { url: 'https://example.com/a.pdf', mediaType: 'application/pdf' },
        { kind: 'file', file: { uri: 'https://example.com/b.pdf' } },
        { text: 'hi' },
      ] as any);
      expect(out.text).toBe('hi');
    });

    it('partsToText survives a null/garbage parts list', () => {
      expect(partsToText(null)).toBe('');
      expect(partsToText([null, 3, 'x'] as any)).toBe('');
    });
  });

  it('SendMessage forwards the client text to the agent run', async () => {
    const startRun = jest.fn().mockResolvedValue(makeRun());
    const runtime = { startRun, getRun: jest.fn(), cancelRun: jest.fn() };
    const svc = makeService(runtime, { findOne: jest.fn() });
    const res = makeRes();

    await svc.handleJsonRpc(
      mockGateway,
      mockReq,
      {
        jsonrpc: '2.0',
        method: 'SendMessage',
        id: 1,
        params: {
          message: {
            messageId: 'm-1',
            role: 'ROLE_USER',
            parts: [{ text: 'what is the capital of France' }],
          },
        },
      },
      res as any,
    );

    // The load-bearing assertion: the run must be started with the text the
    // client actually sent, not with an empty prompt.
    expect(startRun).toHaveBeenCalledWith(
      'agent-1',
      'org-1',
      null,
      'what is the capital of France',
    );
  });

  it('message/send forwards the text of a v0.x kind-discriminated Part', async () => {
    const startRun = jest.fn().mockResolvedValue(makeRun());
    const runtime = { startRun, getRun: jest.fn(), cancelRun: jest.fn() };
    const svc = makeService(runtime, { findOne: jest.fn() });
    const res = makeRes();

    await svc.handleJsonRpc(
      mockGateway,
      mockReq,
      {
        jsonrpc: '2.0',
        method: 'message/send',
        id: 1,
        params: { message: { parts: [{ kind: 'text', text: 'ping' }] } },
      },
      res as any,
    );

    expect(startRun).toHaveBeenCalledWith('agent-1', 'org-1', null, 'ping');
  });

  // -----------------------------------------------------------------------
  // 2. Outbound Task shape
  // -----------------------------------------------------------------------

  describe('emitted Task shape', () => {
    const completedRun: any = {
      ...makeRun({ status: 'completed', output: 'Paris', isDone: () => true }),
    };

    const messages: any[] = [
      { id: 'm-1', role: 'user', content: 'capital of France?', createdAt: new Date() },
      { id: 'm-2', role: 'assistant', content: 'Paris', createdAt: new Date() },
    ];

    it('emits Parts as v1.0 oneof members, with no kind/type discriminator', () => {
      const task = agentRunToTask(completedRun, messages);
      const part: any = task.status.message!.parts[0];
      expect(part).toEqual({ text: 'Paris' });
      expect(part.kind).toBeUndefined();
      expect(part.type).toBeUndefined();
    });

    it('emits task history as Messages, not status snapshots', () => {
      const task = agentRunToTask(completedRun, messages);
      expect(task.history).toHaveLength(2);
      const [first, second] = task.history as any[];
      expect(first.role).toBe('ROLE_USER');
      expect(second.role).toBe('ROLE_AGENT');
      // Message.messageId is REQUIRED by the proto.
      expect(first.messageId).toBe('m-1');
      expect(first.parts).toEqual([{ text: 'capital of France?' }]);
      // A history entry is a Message; it has no `state` of its own.
      expect((first as any).state).toBeUndefined();
    });

    it('emits Artifacts with the required artifactId and no stray lastChunk', () => {
      const task = agentRunToTask(completedRun, messages);
      const artifact: any = task.artifacts![0];
      expect(typeof artifact.artifactId).toBe('string');
      expect(artifact.artifactId.length).toBeGreaterThan(0);
      expect(artifact.parts).toEqual([{ text: 'Paris' }]);
      // `lastChunk` lives on TaskArtifactUpdateEvent, not on Artifact.
      expect(artifact.lastChunk).toBeUndefined();
    });

    it('always carries a contextId, which stream events require', () => {
      const task = agentRunToTask(
        makeRun({ conversationId: null, metadata: {} }) as any,
        [],
      );
      expect(typeof task.contextId).toBe('string');
      expect(task.contextId!.length).toBeGreaterThan(0);
    });

    it('uses ProtoJSON TaskState values', () => {
      expect(agentRunToTask(completedRun, []).status.state).toBe(
        'TASK_STATE_COMPLETED',
      );
    });
  });

  // -----------------------------------------------------------------------
  // 3. Streaming: JSON-RPC envelopes, StreamResponse payloads, keep-alive
  // -----------------------------------------------------------------------

  describe('message/stream SSE frames', () => {
    const setupStream = async (rpcId: string | number = 7) => {
      const emitter = new EventEmitter();
      const run = makeRun();
      const runtime = {
        startRun: jest.fn().mockResolvedValue(run),
        getRun: jest.fn(),
        cancelRun: jest.fn(),
        sendInput: jest.fn(),
        getRunEmitter: jest.fn().mockReturnValue(emitter),
      };
      const runRepo = { findOne: jest.fn().mockResolvedValue(run) };
      const svc = makeService(runtime, runRepo);
      const res = makeRes();
      const req: any = { ...mockReq, on: jest.fn() };

      await svc.handleJsonRpc(
        mockGateway,
        req,
        {
          jsonrpc: '2.0',
          method: 'message/stream',
          id: rpcId,
          params: { message: { parts: [{ text: 'stream me' }] } },
        },
        res as any,
      );

      return { emitter, res, runtime, svc };
    };

    it('sets the proxy-survival headers the MCP transport uses', async () => {
      const { res } = await setupStream();
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toContain('no-transform');
      expect(res.headers['X-Accel-Buffering']).toBe('no');
    });

    it('wraps every frame in a JSON-RPC response envelope reusing the request id', async () => {
      const { emitter, res } = await setupStream('req-42');
      emitter.emit('event', { type: 'run.step', data: {}, timestamp: '' });
      await new Promise((r) => setImmediate(r));

      const frames = sseFrames(res);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.jsonrpc).toBe('2.0');
        expect(frame.id).toBe('req-42');
        expect(frame.result).toBeDefined();
      }
    });

    it('carries a StreamResponse statusUpdate, not a bare kind/type event', async () => {
      const { emitter, res } = await setupStream();
      emitter.emit('event', { type: 'run.step', data: {}, timestamp: '' });
      await new Promise((r) => setImmediate(r));

      const [frame] = sseFrames(res);
      expect(frame.result.statusUpdate).toBeDefined();
      expect(frame.result.statusUpdate.taskId).toBe(RUN_ID);
      expect(typeof frame.result.statusUpdate.contextId).toBe('string');
      expect(frame.result.statusUpdate.status.state).toBe('TASK_STATE_WORKING');
      // v1.0 removed the `kind` discriminator and the `final` flag; the old
      // hand-rolled payload had `type: 'status'` at the top level.
      expect(frame.result.type).toBeUndefined();
      expect(frame.result.kind).toBeUndefined();
      expect(frame.result.statusUpdate.kind).toBeUndefined();
    });

    it('emits artifact updates under the artifactUpdate member', async () => {
      const emitter = new EventEmitter();
      const doneRun = makeRun({
        status: 'completed',
        output: 'the answer',
        isDone: () => true,
      });
      const runtime = {
        startRun: jest.fn().mockResolvedValue(doneRun),
        getRun: jest.fn(),
        cancelRun: jest.fn(),
        sendInput: jest.fn(),
        getRunEmitter: jest.fn().mockReturnValue(emitter),
      };
      const svc = makeService(runtime, {
        findOne: jest.fn().mockResolvedValue(doneRun),
      });
      const res = makeRes();

      await svc.handleJsonRpc(
        mockGateway,
        { ...mockReq, on: jest.fn() } as any,
        {
          jsonrpc: '2.0',
          method: 'message/stream',
          id: 1,
          params: { message: { parts: [{ text: 'go' }] } },
        },
        res as any,
      );

      emitter.emit('event', { type: 'run.completed', data: {}, timestamp: '' });
      await new Promise((r) => setImmediate(r));

      const artifactFrames = sseFrames(res).filter(
        (f) => f.result.artifactUpdate,
      );
      expect(artifactFrames).toHaveLength(1);
      expect(artifactFrames[0].result.artifactUpdate.artifact.artifactId).toBeDefined();
      expect(artifactFrames[0].result.artifactUpdate.taskId).toBe(RUN_ID);
    });

    it('sends SSE keep-alive comments so a long run is not reaped at the proxy', async () => {
      jest.useFakeTimers();
      try {
        const { res } = await setupStream();
        expect(res.writes.some((w) => w.startsWith(': keep-alive'))).toBe(false);
        jest.advanceTimersByTime(15_000);
        expect(res.writes.some((w) => w.startsWith(': keep-alive'))).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. SubscribeToTask / tasks/resubscribe
  // -----------------------------------------------------------------------

  describe('SubscribeToTask / tasks/resubscribe', () => {
    const makeSubscribeService = (run: any) => {
      const emitter = new EventEmitter();
      const runtime = {
        startRun: jest.fn(),
        getRun: jest.fn(),
        cancelRun: jest.fn(),
        getRunEmitter: jest.fn().mockReturnValue(emitter),
      };
      return {
        emitter,
        svc: makeService(runtime, { findOne: jest.fn().mockResolvedValue(run) }),
      };
    };

    it.each(['SubscribeToTask', 'tasks/resubscribe'])(
      '%s is implemented, not METHOD_NOT_FOUND',
      async (method) => {
        const { svc } = makeSubscribeService(makeRun());
        const res = makeRes();
        await svc.handleJsonRpc(
          mockGateway,
          { ...mockReq, on: jest.fn() } as any,
          { jsonrpc: '2.0', method, id: 1, params: { id: RUN_ID } },
          res as any,
        );
        expect(res.json).not.toHaveBeenCalled();
        expect(res.headers['Content-Type']).toBe('text/event-stream');
      },
    );

    it('replays the current task as the first frame so a reattaching client catches up', async () => {
      const { svc } = makeSubscribeService(makeRun());
      const res = makeRes();
      await svc.handleJsonRpc(
        mockGateway,
        { ...mockReq, on: jest.fn() } as any,
        { jsonrpc: '2.0', method: 'SubscribeToTask', id: 9, params: { id: RUN_ID } },
        res as any,
      );

      const [first] = sseFrames(res);
      expect(first.id).toBe(9);
      expect(first.result.task.id).toBe(RUN_ID);
    });

    it('rejects a subscription to a terminal task with UNSUPPORTED_OPERATION', async () => {
      const { svc } = makeSubscribeService(
        makeRun({ status: 'completed', output: 'done', isDone: () => true }),
      );
      const res = makeRes();
      await svc.handleJsonRpc(
        mockGateway,
        { ...mockReq, on: jest.fn() } as any,
        { jsonrpc: '2.0', method: 'SubscribeToTask', id: 1, params: { id: RUN_ID } },
        res as any,
      );
      expect(res.json).toHaveBeenCalled();
      expect((res.json as jest.Mock).mock.calls[0][0].error.code).toBe(
        A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
      );
    });

    it('returns TASK_NOT_FOUND for an unknown task id', async () => {
      const runtime = {
        startRun: jest.fn(),
        getRun: jest.fn(),
        cancelRun: jest.fn(),
        getRunEmitter: jest.fn(),
      };
      const svc = makeService(runtime, {
        findOne: jest.fn().mockResolvedValue(null),
      });
      const res = makeRes();
      await svc.handleJsonRpc(
        mockGateway,
        { ...mockReq, on: jest.fn() } as any,
        { jsonrpc: '2.0', method: 'SubscribeToTask', id: 1, params: { id: RUN_ID } },
        res as any,
      );
      expect((res.json as jest.Mock).mock.calls[0][0].error.code).toBe(
        A2A_ERROR_CODES.TASK_NOT_FOUND,
      );
    });

    it('returns INVALID_PARAMS when the task id is missing', async () => {
      const { svc } = makeSubscribeService(makeRun());
      const res = makeRes();
      await svc.handleJsonRpc(
        mockGateway,
        { ...mockReq, on: jest.fn() } as any,
        { jsonrpc: '2.0', method: 'SubscribeToTask', id: 1, params: {} },
        res as any,
      );
      expect((res.json as jest.Mock).mock.calls[0][0].error.code).toBe(
        A2A_ERROR_CODES.INVALID_PARAMS,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. The blocking flag renamed AND inverted between v0.x and v1.0
  // -----------------------------------------------------------------------

  describe('SendMessage blocking configuration', () => {
    const setup = () => {
      const run = makeRun({
        status: 'completed',
        output: 'done',
        isDone: () => true,
      });
      const runtime = {
        startRun: jest.fn().mockResolvedValue(run),
        getRun: jest.fn(),
        cancelRun: jest.fn(),
      };
      const runRepo = { findOne: jest.fn().mockResolvedValue(run) };
      return { svc: makeService(runtime, runRepo), runRepo };
    };

    const send = async (svc: any, configuration: any) => {
      const res = makeRes();
      await svc.handleJsonRpc(
        mockGateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'SendMessage',
          id: 1,
          params: { message: { parts: [{ text: 'go' }] }, configuration },
        },
        res as any,
      );
      return res;
    };

    it('waits when a v1.0 client sends returnImmediately: false', async () => {
      const { svc, runRepo } = setup();
      await send(svc, { returnImmediately: false });
      // Waiting means polling the run; returning straight away does not.
      expect(runRepo.findOne).toHaveBeenCalled();
    });

    it('does not wait when a v1.0 client sends returnImmediately: true', async () => {
      const { svc, runRepo } = setup();
      await send(svc, { returnImmediately: true });
      expect(runRepo.findOne).not.toHaveBeenCalled();
    });

    it('still honours the v0.x blocking flag', async () => {
      const { svc, runRepo } = setup();
      await send(svc, { blocking: true });
      expect(runRepo.findOne).toHaveBeenCalled();
    });

    it('returnImmediately wins over a stale blocking flag', async () => {
      const { svc, runRepo } = setup();
      await send(svc, { blocking: true, returnImmediately: true });
      expect(runRepo.findOne).not.toHaveBeenCalled();
    });
  });

  it('declares a protocol version the rest of the module actually implements', () => {
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
  });
});
