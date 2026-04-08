import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentAuditService } from './agent-audit.service';
import { Agent } from '../../entities/agent.entity';

describe('AgentAuditService', () => {
  let service: AgentAuditService;
  let txFindOne: jest.Mock;
  let txUpdate: jest.Mock;
  let transactionFn: jest.Mock;

  beforeEach(async () => {
    txFindOne = jest.fn();
    txUpdate = jest.fn().mockResolvedValue(undefined);

    // Capture the callback so each test can choose to execute it and
    // inspect what the service did inside the transaction.
    transactionFn = jest.fn(async (cb: (tx: any) => Promise<unknown>) => {
      return cb({
        findOne: txFindOne,
        update: txUpdate,
      });
    });

    const mockRepo = {
      manager: {
        transaction: transactionFn,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentAuditService,
        { provide: getRepositoryToken(Agent), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<AgentAuditService>(AgentAuditService);
  });

  describe('log()', () => {
    it('runs the read-modify-write inside a transaction (never outside)', async () => {
      txFindOne.mockResolvedValue({
        id: 'agent-1',
        organizationId: 'org-1',
        metadata: { auditLog: [] },
      });

      await service.log({
        agentId: 'agent-1',
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'updated',
      });

      // The race fix is "wrap read/append/write in a transaction with
      // a pessimistic row lock". Pin both halves of that contract:
      // (1) the service opened a transaction at all, (2) every DB op
      // it made went through the transactional manager, not the
      // outer repository.
      expect(transactionFn).toHaveBeenCalledTimes(1);
      expect(txFindOne).toHaveBeenCalledTimes(1);
      expect(txUpdate).toHaveBeenCalledTimes(1);
    });

    it('acquires a pessimistic_write row lock on the agent row inside the transaction', async () => {
      txFindOne.mockResolvedValue({
        id: 'agent-1',
        organizationId: 'org-1',
        metadata: {},
      });

      await service.log({
        agentId: 'agent-1',
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'created',
      });

      // The lock is the whole point of the race fix — without it,
      // two concurrent audit writes would both read the same initial
      // state and silently lose one entry. Pin the exact findOne
      // shape including the lock descriptor and the (id, orgId)
      // scope.
      expect(txFindOne).toHaveBeenCalledWith(
        Agent,
        expect.objectContaining({
          where: { id: 'agent-1', organizationId: 'org-1' },
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });

    it('appends the new entry onto the existing auditLog and preserves previous entries', async () => {
      const existing = [
        { action: 'created', userId: 'user-1', timestamp: '2026-01-01T00:00:00.000Z' },
        { action: 'updated', userId: 'user-1', timestamp: '2026-01-02T00:00:00.000Z' },
      ];
      txFindOne.mockResolvedValue({
        id: 'agent-1',
        organizationId: 'org-1',
        metadata: { auditLog: existing, other: 'keep-me' },
      });

      await service.log({
        agentId: 'agent-1',
        organizationId: 'org-1',
        userId: 'user-2',
        action: 'deleted',
        details: { reason: 'cleanup' },
      });

      const [, , updatePayload] = txUpdate.mock.calls[0];
      expect(updatePayload.metadata.other).toBe('keep-me');
      expect(updatePayload.metadata.auditLog).toHaveLength(3);
      expect(updatePayload.metadata.auditLog[0]).toEqual(existing[0]);
      expect(updatePayload.metadata.auditLog[1]).toEqual(existing[1]);
      expect(updatePayload.metadata.auditLog[2]).toMatchObject({
        action: 'deleted',
        userId: 'user-2',
        details: { reason: 'cleanup' },
      });
    });

    it('trims to the last 100 entries when the log overflows', async () => {
      // 100 existing entries → next append should roll the head off.
      const existing = Array.from({ length: 100 }, (_, i) => ({
        action: 'updated' as const,
        userId: 'user-1',
        timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      }));
      txFindOne.mockResolvedValue({
        id: 'agent-1',
        organizationId: 'org-1',
        metadata: { auditLog: existing },
      });

      await service.log({
        agentId: 'agent-1',
        organizationId: 'org-1',
        userId: 'user-2',
        action: 'deleted',
      });

      const [, , updatePayload] = txUpdate.mock.calls[0];
      expect(updatePayload.metadata.auditLog).toHaveLength(100);
      // Oldest entry is dropped, newest is the one we just wrote.
      expect(updatePayload.metadata.auditLog[0]).toEqual(existing[1]);
      expect(updatePayload.metadata.auditLog[99].action).toBe('deleted');
    });

    it('scopes the UPDATE by organizationId (defence in depth against cross-org writes)', async () => {
      txFindOne.mockResolvedValue({
        id: 'agent-1',
        organizationId: 'org-1',
        metadata: {},
      });

      await service.log({
        agentId: 'agent-1',
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'updated',
      });

      const [, where] = txUpdate.mock.calls[0];
      expect(where).toEqual({ id: 'agent-1', organizationId: 'org-1' });
    });

    it('returns silently when the agent is missing instead of writing an orphan row', async () => {
      txFindOne.mockResolvedValue(null);

      await service.log({
        agentId: 'missing-agent',
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'created',
      });

      expect(txUpdate).not.toHaveBeenCalled();
    });

    it('swallows DB errors so audit logging never breaks the caller', async () => {
      transactionFn.mockRejectedValueOnce(new Error('connection lost'));

      await expect(
        service.log({
          agentId: 'agent-1',
          organizationId: 'org-1',
          userId: 'user-1',
          action: 'created',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
